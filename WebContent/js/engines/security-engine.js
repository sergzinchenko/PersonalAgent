// ============================================================
//  SECURITY ENGINE — политики безопасности операций агента
// ============================================================
//
// ЗАЧЕМ ЭТО НУЖНО.
// Агент выполняет действия сам, по решению модели. Модель может ошибиться,
// а её решение может быть подсказано враждебным текстом, попавшим в контекст
// (веб-страница через http_fetch, содержимое файла, импортированный навык).
// Проверки живут здесь, в одной точке — перед исполнением любого инструмента,
// а не размазаны по обработчикам: иначе новый инструмент легко забыть закрыть.
//
// ЧЕГО ЭТОТ МЕХАНИЗМ НЕ ДЕЛАЕТ.
// Он ограничивает то, что агент делает ЧЕРЕЗ ИНСТРУМЕНТЫ. Он не изолирует
// код инструмента: handlerCode по-прежнему исполняется в браузере и, будучи
// включённым, может обращаться к сети напрямую. Настоящая песочница требует
// Worker или sandboxed iframe. Поэтому главный барьер остаётся прежним —
// созданный моделью инструмент включает пользователь вручную.

class SecurityEngine {
  constructor() {
    // off | minimal | standard | maximum
    this.mode = 'standard';
    this.confirmFn = null;   // подставляется из UI: async (request) => bool
    this.auditLog = [];      // последние решения, для панели «Журнал»
    this.maxAudit = 200;

    // Счётчики на один ход пользователя (сбрасываются в UI перед ходом).
    this.turn = { writes: 0, network: 0, deletes: 0, mcp: 0 };

    // Домены, подтверждённые пользователем в этой сессии: повторно
    // спрашивать про тот же адрес — верный способ приучить нажимать «да».
    this.approvedHosts = new Set();

    // Максимальный режим: обращения только к этим доменам.
    this.allowedHosts = [];

    // ── Политики MCP ──
    // MCP-вызов отличается от прочих инструментов тем, что аргументы
    // уходят на чужой сервер, а ответ возвращается прямо в контекст
    // модели. Поэтому у него отдельный набор ограничений, а не общие
    // сетевые правила.
    this.mcpLimits = {
      requireHttps: true,        // токен не должен уходить открытым текстом
      allowLocalServers: false,  // localhost — обычный сценарий, но включается вручную
      timeoutSeconds: 30,
      maxResponseChars: 100000,  // ответ вытесняет историю из контекста
      markUntrusted: true,       // помечать ответ как данные, а не указания
      maxCallsPerTurn: 15,
    };
    // Разрешённые хосты MCP. Пустой список = ограничения по списку нет
    // (действуют остальные проверки). Заполненный = всё вне списка
    // запрещено, независимо от режима.
    this.allowedMcpHosts = [];
    // Хосты MCP, подтверждённые в этой сессии.
    this.approvedMcpHosts = new Set();

    // ── Лимит вызовов одного инструмента за ход ──
    // Общий счётчик writes не ловит случай, когда агент зациклился на
    // одном инструменте: сто вызовов http_fetch — это ноль записей.
    this.maxCallsPerToolPerTurn = 25;
    this.turnCalls = new Map();   // имя инструмента → счётчик за ход
  }

  configure(patch = {}) {
    if (patch.mode !== undefined) this.mode = patch.mode;
    if (patch.allowedHosts !== undefined) {
      this.allowedHosts = String(patch.allowedHosts || '')
        .split(/[\s,;]+/).map(h => h.trim().toLowerCase()).filter(Boolean);
    }
    if (patch.maxWritesPerTurn !== undefined) this.maxWritesPerTurn = patch.maxWritesPerTurn;
    if (patch.maxNetworkPerTurn !== undefined) this.maxNetworkPerTurn = patch.maxNetworkPerTurn;
    if (patch.maxCallsPerToolPerTurn !== undefined) this.maxCallsPerToolPerTurn = patch.maxCallsPerToolPerTurn;
    if (patch.mcpLimits !== undefined) this.mcpLimits = { ...this.mcpLimits, ...patch.mcpLimits };
    if (patch.allowedMcpHosts !== undefined) {
      this.allowedMcpHosts = String(patch.allowedMcpHosts || '')
        .split(/[\s,;]+/).map(h => h.trim().toLowerCase()).filter(Boolean);
    }
  }

  resetTurn() {
    this.turn = { writes: 0, network: 0, deletes: 0, mcp: 0 };
    this.turnCalls.clear();
  }

  // ── Классификация операций ──
  // Категории отражают ПОСЛЕДСТВИЯ, а не техническую природу вызова:
  //   read      — только чтение, ничего не меняет
  //   write     — создаёт или изменяет объекты агента
  //   destroy   — удаляет или необратимо перезаписывает
  //   network   — обращается наружу
  //   execute   — приводит к исполнению кода или подмене поведения агента
  static CATEGORY = {
    // Чтение
    get_current_time: 'read', calculator: 'read', format_json: 'read',
    format_xml: 'read', generate_password: 'read', list_workspace: 'read',
    ask_user: 'read', explain_agent: 'read', diagnose: 'read',
    search_chats: 'read', list_files: 'read', read_file: 'read',
    search_files: 'read',

    // Запись
    create_folder: 'write', rename_folder: 'write', move_folder: 'write',
    move_item: 'write', move_chat: 'write', chat_folder: 'write',
    create_prompt: 'write', update_prompt: 'write',
    create_skill: 'write', update_skill: 'write',
    persistent_memory: 'write', export_chat: 'write', export_chats: 'write',

    // Разрушительное
    delete_folder: 'destroy',
    import_chat: 'destroy', import_chats: 'destroy',

    // Сеть
    http_fetch: 'network',

    // Исполнение / подмена поведения
    create_tool: 'execute', update_tool: 'execute',
    import_skill_from_text: 'execute',

    // Управление подключениями к модели. Чтение состояния безобидно;
    // llm_switch меняет, ЧЕМ агент думает дальше, —
    // это ближе к настройке, чем к записи данных, поэтому категория
    // своя, со своими правилами (см. check()).
    llm_list: 'read', llm_status: 'read', llm_test: 'read',
    llm_switch: 'llm',
  };

  categoryOf(toolName, tool) {
    const known = SecurityEngine.CATEGORY[toolName];
    if (known) return known;
    // Незнакомый инструмент с собственным кодом — потенциально что угодно.
    if (tool && tool.mcpServer) return 'mcp';
    if (tool && tool.handlerCode) return 'execute';
    return 'write';
  }

  // ── Основная проверка ──
  // Возвращает { allow, reason, confirm } — confirm означает «нужен ответ
  // пользователя». Сам вопрос задаёт вызывающая сторона через confirmFn.
  async check(toolName, args, tool) {
    if (this.mode === 'off') return { allow: true };

    const cat = this.categoryOf(toolName, tool);
    const risks = this._risks(toolName, args, cat, tool);

    // ── Потолок на один инструмент ──
    // Проверяется раньше всего и во всех режимах: зацикливание агента
    // на одном вызове — это не про опасность операции, а про то, что
    // ход перестал сходиться. Дешёвые read-инструменты сюда тоже
    // попадают, потому что бесконечный цикл из них ничем не лучше.
    const used = this.turnCalls.get(toolName) || 0;
    if (used >= this.maxCallsPerToolPerTurn) {
      return {
        allow: false,
        reason: `Инструмент ${toolName} вызван ${used} раз за один ответ — это похоже на зацикливание. ` +
                'Предел настраивается в разделе безопасности.',
      };
    }

    // ── MCP ──
    if (cat === 'mcp') {
      const verdict = this._checkMcp(toolName, args, tool, risks);
      if (verdict) return verdict;
    }

    // ── Управление подключением к модели ──
    // Смена модели чата — обратимое действие, поэтому подтверждения в
    // обычных режимах нет. Ограничитель один и живёт не здесь:
    // инструменты llm_* выключены по умолчанию. В максимальном режиме
    // спрашиваем, потому что там подтверждается всё, что меняет
    // поведение агента.
    if (cat === 'llm') {
      if (this.mode === 'maximum') {
        return this._ask(toolName, cat, ['Смена модели, на которой работает агент'], args);
      }
      return { allow: true };
    }

    // Чтение не ограничиваем ни в одном режиме, кроме максимального
    // (там подтверждается чтение файлов — они вне агента).
    if (cat === 'read' && !risks.length) {
      if (this.mode === 'maximum' && toolName === 'read_file') {
        return this._ask(toolName, cat, ['Чтение файла с диска'], args);
      }
      return { allow: true };
    }

    // ── Минимальный: только необратимое ──
    if (this.mode === 'minimal') {
      if (cat === 'destroy') {
        return this._ask(toolName, cat, risks.length ? risks : ['Необратимая операция'], args);
      }
      // Перезапись импортом — тоже потеря данных.
      if (risks.includes('Перезапись существующих данных')) {
        return this._ask(toolName, cat, risks, args);
      }
      return { allow: true };
    }

    // ── Оптимальный: необратимое + исполнение + подозрительное ──
    if (this.mode === 'standard') {
      if (cat === 'destroy' || cat === 'execute') {
        return this._ask(toolName, cat, risks.length ? risks : ['Изменение поведения агента или удаление данных'], args);
      }
      if (cat === 'network') {
        const host = this._hostOf(args);
        if (host && this.approvedHosts.has(host)) return { allow: true };
        return this._ask(toolName, cat, risks.length ? risks : ['Обращение к внешнему адресу: ' + (host || '?')], args, host);
      }
      if (risks.length) return this._ask(toolName, cat, risks, args);
      // Лимит массовых изменений за один ход: защита от «агент увлёкся».
      // Счётчик здесь НЕ увеличиваем — это делает вызывающая сторона
      // (executeTool) один раз после всех проверок, иначе одна операция
      // считалась бы дважды и лимит срабатывал вдвое раньше.
      if (cat === 'write' && this._overLimit('writes')) {
        return this._ask(toolName, cat, [`За один ответ уже выполнено ${this.turn.writes} изменений`], args);
      }
      return { allow: true };
    }

    // ── Максимальный ──
    if (this.mode === 'maximum') {
      if (cat === 'network') {
        const host = this._hostOf(args);
        // Белый список задан — всё вне его запрещено без вопросов.
        if (this.allowedHosts.length) {
          const ok = host && this.allowedHosts.some(a => host === a || host.endsWith('.' + a));
          if (!ok) {
            return {
              allow: false,
              reason: `Адрес ${host || '(не распознан)'} не входит в список разрешённых. ` +
                      `Разрешены: ${this.allowedHosts.join(', ')}`,
            };
          }
        }
        if (host && this.approvedHosts.has(host)) return { allow: true };
        return this._ask(toolName, cat, ['Обращение к внешнему адресу: ' + (host || '?')], args, host);
      }

      // В максимальном режиме создание инструментов запрещено полностью:
      // это самая опасная операция, и в строгом режиме её место —
      // ручное создание пользователем через интерфейс.
      if (toolName === 'create_tool' || toolName === 'update_tool') {
        return {
          allow: false,
          reason: 'В максимальном режиме агент не может создавать и изменять инструменты. ' +
                  'Создайте инструмент вручную на вкладке Tools или переключите режим безопасности.',
        };
      }

      if (cat === 'read') return { allow: true };
      // Всё остальное — только с подтверждения.
      return this._ask(toolName, cat, risks.length ? risks : ['Операция изменяет данные'], args);
    }

    return { allow: true };
  }

  // Проверки, специфичные для MCP-вызова. Возвращает вердикт либо null,
  // если решение принимают общие правила режима.
  _checkMcp(toolName, args, tool, risks) {
    let host = null;
    try { host = new URL(String(tool && tool.mcpServer || '')).hostname.toLowerCase(); }
    catch (_) { host = null; }

    if (!host) {
      return { allow: false, reason: 'У MCP-инструмента ' + toolName + ' некорректный адрес сервера' };
    }

    // Белый список сильнее режима: если пользователь его задал, значит
    // перечислил ровно те серверы, которым доверяет.
    if (this.allowedMcpHosts.length) {
      const ok = this.allowedMcpHosts.some(a => host === a || host.endsWith('.' + a));
      if (!ok) {
        return {
          allow: false,
          reason: `MCP-сервер ${host} не входит в список разрешённых (${this.allowedMcpHosts.join(', ')})`,
        };
      }
    }

    if (this.turn.mcp >= (this.mcpLimits.maxCallsPerTurn || 15)) {
      return {
        allow: false,
        reason: `За один ответ уже сделано ${this.turn.mcp} обращений к MCP-серверам — предел исчерпан`,
      };
    }

    // Секрет в аргументах спрашивается ВСЕГДА, даже на уже одобренном
    // сервере и в минимальном режиме. Пользователь разрешил обращаться
    // к этому адресу — он не разрешал отправлять туда ключи доступа,
    // и одно из другого не следует.
    const leak = (risks || []).find(r => /ключ доступа/.test(r));
    if (leak) {
      return {
        allow: true, confirm: true, category: 'mcp', toolName, args, host, mcp: true,
        risks: [
          'В аргументах вызова есть строка, похожая на ключ доступа',
          'Она уйдёт на внешний сервер ' + host,
        ].concat((risks || []).filter(r => r !== leak)),
      };
    }

    if (this.mode === 'minimal') return { allow: true };

    // Первое обращение к серверу за сессию подтверждается всегда:
    // аргументы вызова формирует модель, и уходят они наружу.
    if (this.approvedMcpHosts.has(host)) return { allow: true };

    return {
      allow: true,
      confirm: true,
      category: 'mcp',
      toolName,
      args,
      host,
      mcp: true,
      risks: (risks || []).concat([
        'Вызов внешнего MCP-сервера ' + host,
        'Аргументы вызова уходят на этот сервер',
        'Ответ сервера попадёт в контекст диалога',
      ]),
    };
  }

  // Признаки, делающие конкретный вызов подозрительным.
  _risks(toolName, args, cat, tool) {
    const out = [];
    const a = args || {};

    if (toolName === 'delete_folder') out.push('Удаление папки');
    if ((toolName === 'import_chats' || toolName === 'import_chat') && a.mode === 'overwrite') {
      out.push('Перезапись существующих данных');
    }

    if (toolName === 'create_tool' || toolName === 'update_tool') {
      const code = String(a.handlerCode || '');
      if (code) {
        // Ищем в коде инструмента признаки выхода за рамки задачи.
        const patterns = [
          [/indexedDB|openDatabase/i, 'Код обращается к базе данных приложения'],
          [/localStorage|sessionStorage/i, 'Код обращается к хранилищу браузера'],
          [/fetch\s*\(|XMLHttpRequest/i, 'Код отправляет сетевые запросы'],
          [/document\.|window\.|location/i, 'Код обращается к странице приложения'],
          [/eval\s*\(|new Function/i, 'Код исполняет строки как код'],
          [/apiKey|api_key|token|password|secret|credential/i, 'Код упоминает ключи или пароли'],
          // Ниже — признаки, найденные уже после первой версии проверки.
          [/SecretsVault|__vault_key/i, 'Код обращается к хранилищу секретов приложения'],
          [/llm_connections|settings\s*,\s*['\"]llm/i, 'Код читает настройки подключения к модели'],
          [/importScripts|createElement\s*\(\s*['"]script/i, 'Код подгружает сторонний скрипт'],
          [/atob\s*\(|fromCharCode|unescape\s*\(/i, 'Код декодирует строки — возможно, скрывает своё содержимое'],
          [/navigator\.(sendBeacon|clipboard)/i, 'Код обращается к буферу обмена или отправляет данные фоном'],
          [/postMessage|BroadcastChannel|SharedWorker/i, 'Код обменивается сообщениями с другими контекстами'],
        ];
        for (const [re, label] of patterns) if (re.test(code)) out.push(label);
      }
    }

    if (toolName === 'import_skill_from_text') {
      out.push('Импорт чужих инструкций, управляющих поведением агента');
    }

    if (cat === 'network' || cat === 'mcp') {
      const host = this._hostOf(a) || this._hostOf({ url: tool && tool.mcpServer });
      if (host && /\d+\.\d+\.\d+\.\d+/.test(host)) out.push('Обращение по IP-адресу, а не по имени');
    }

    // Аргументы, похожие на секреты. Проверка грубая и даёт ложные
    // срабатывания, но цена ошибки несимметрична: лишний вопрос
    // раздражает, утёкший наружу ключ — нет.
    if (cat === 'mcp' || cat === 'network') {
      const flat = (() => { try { return JSON.stringify(a || {}); } catch (_) { return ''; } })();
      if (/sk-[A-Za-z0-9_\-]{16,}|Bearer\s+[A-Za-z0-9._\-]{20,}/.test(flat)) {
        out.push('В аргументах есть строка, похожая на ключ доступа');
      }
    }

    return out;
  }

  _hostOf(args) {
    try {
      const u = (args && (args.url || args.server || args.mcpServer)) || '';
      return u ? new URL(String(u)).hostname.toLowerCase() : null;
    } catch (_) { return null; }
  }

  _overLimit(kind) {
    const limits = {
      writes: this.maxWritesPerTurn || 20,
      network: this.maxNetworkPerTurn || 10,
    };
    return this.turn[kind] >= (limits[kind] || Infinity);
  }

  // Счётчики за ход. Вызывается один раз из executeTool после всех
  // проверок — иначе одна операция считалась бы дважды.
  _count(cat, toolName) {
    if (cat === 'write') this.turn.writes++;
    else if (cat === 'network') this.turn.network++;
    else if (cat === 'destroy') this.turn.deletes++;
    else if (cat === 'mcp') { this.turn.mcp++; this.turn.network++; }

    if (toolName) this.turnCalls.set(toolName, (this.turnCalls.get(toolName) || 0) + 1);
  }

  _ask(toolName, cat, risks, args, host) {
    return { allow: true, confirm: true, category: cat, risks, toolName, args, host };
  }

  // Фиксируем решения — пользователь должен иметь возможность посмотреть,
  // что агент делал и что ему разрешали.
  audit(entry) {
    this.auditLog.unshift({ ...entry, at: Date.now() });
    if (this.auditLog.length > this.maxAudit) this.auditLog.length = this.maxAudit;
  }

  static MODES = {
    off: { label: 'Отключено', hint: 'Проверок нет. Агент выполняет любые операции сразу.' },
    minimal: {
      label: 'Минимальный',
      hint: 'Подтверждение только для необратимых операций: удаление папок, перезапись данных при импорте. ' +
            'Обращения к MCP-серверам не переспрашиваются — кроме случая, когда в аргументах замечен ключ доступа.',
    },
    standard: {
      label: 'Оптимальный',
      hint: 'Подтверждение для удаления, создания и изменения инструментов, импорта навыков, ' +
            'обращений к внешним адресам и подозрительных операций. Повторные обращения к тому же ' +
            'адресу в этой сессии не переспрашиваются. Первое обращение к каждому MCP-серверу ' +
            'подтверждается отдельно.',
    },
    maximum: {
      label: 'Максимальный',
      hint: 'Подтверждение любой операции, изменяющей данные, и чтения файлов. ' +
            'Агенту запрещено создавать и изменять инструменты. Обращения к сети — только к адресам ' +
            'из белого списка (если он задан). Смена модели, на которой работает агент, ' +
            'тоже требует подтверждения.',
    },
  };
}
