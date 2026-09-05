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
    // external — источники внешнего содержимого, попавшего в ЭТОТ ход:
    // страницы, файлы, вики, MCP-серверы. См. карантин в check().
    this.turn = { writes: 0, network: 0, deletes: 0, mcp: 0, external: [] };

    // Постоянный журнал решений (хранилище security_log). Ставится
    // из agent.js; без него журнал живёт только в памяти, как раньше.
    this.db = null;
    this.maxStored = 2000;
    this._sinceTrim = 0;

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
    // Таймаута и предела ответа здесь нет намеренно: они общие для всех
    // инструментов и живут в settings/limits (⚙ Ограничения). Свои копии
    // означали бы два разных числа на один и тот же вызов.
    this.mcpLimits = {
      requireHttps: true,        // токен не должен уходить открытым текстом
      allowLocalServers: false,  // localhost — обычный сценарий, но включается вручную
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
    if (patch.maxCallsPerToolPerTurn !== undefined) this.maxCallsPerToolPerTurn = patch.maxCallsPerToolPerTurn;
    if (patch.mcpLimits !== undefined) this.mcpLimits = { ...this.mcpLimits, ...patch.mcpLimits };
    if (patch.allowedMcpHosts !== undefined) {
      this.allowedMcpHosts = String(patch.allowedMcpHosts || '')
        .split(/[\s,;]+/).map(h => h.trim().toLowerCase()).filter(Boolean);
    }
  }

  resetTurn() {
    this.turn = { writes: 0, network: 0, deletes: 0, mcp: 0, external: [] };
    this.turnCalls.clear();
  }

  // ── Карантин после внешних данных ──
  // Инструменты, приносящие в ход содержимое, которого пользователь не
  // писал. Именно оно может нести инструкции для модели: страница, файл,
  // страница вики, ответ MCP-сервера.
  static EXTERNAL_SOURCES = new Set([
    'http_fetch', 'proxy_fetch', 'sandbox_fetch', 'read_file', 'search_files',
    'confluence_get_page', 'confluence_search',
    'xwiki_get_page', 'xwiki_search',
    'import_skill_from_text',
    // Артефакт — сохранённый результат прежнего вызова: его содержимое
    // пришло извне ровно так же, просто раньше.
    'artifact_read', 'artifact_grep',
  ]);

  // Операции, которыми агент меняет самого себя. Их и накрывает карантин.
  static SELF_MODIFYING = new Set([
    'create_tool', 'update_tool', 'create_skill', 'update_skill',
    'link_skill_tools', 'import_skill_from_text',
  ]);

  // Отмечается ПОСЛЕ успешного вызова (см. tools-executor.js): важен факт,
  // что содержимое уже в ходе, а не намерение его получить.
  noteExternal(toolName, tool) {
    const isMcp = !!(tool && tool.mcpServer);
    if (!isMcp && !SecurityEngine.EXTERNAL_SOURCES.has(toolName)) return;
    const label = isMcp ? `${toolName} (MCP)` : toolName;
    if (!this.turn.external.includes(label)) this.turn.external.push(label);
    // Перечень нужен, чтобы назвать источники в вопросе, а не для учёта:
    // десяти хватает, дальше он только удлиняет текст.
    if (this.turn.external.length > 10) this.turn.external.shift();
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
    // Чтение больших результатов, уже полученных ранее: сам вызов,
    // которым они добыты, проверку прошёл — перечитать сохранённое
    // не опаснее, чем перечитать сообщение в переписке.
    artifact_read: 'read', artifact_grep: 'read', artifact_list: 'read',
    // Подзадача сама по себе ничего не делает с данными: она лишь
    // выполняет часть работы отдельным ходом. Всё, что она вызывает
    // внутри, проходит эту же проверку по своей категории — и с теми же
    // подтверждениями. Спрашивать ещё и про запуск значило бы задавать
    // лишний вопрос за каждую часть работы.
    run_subtask: 'read',
    // План — собственное рабочее состояние агента, без внешних действий
    // и без данных пользователя: подтверждать тут нечего.
    task_plan: 'read',
    // История доработок — текст, зашитый в само приложение. Читать его
    // не опаснее, чем читать эту же страницу настроек.
    whats_new: 'read',
    // Вики: адрес задан пользователем в настройках и модели неподконтролен,
    // поэтому это не 'network' (та категория существует ради случая, когда
    // хост выбирает модель — см. http_fetch). Чтение читает, запись пишет.
    confluence_status: 'read', confluence_search: 'read', confluence_get_page: 'read',
    confluence_list_spaces: 'read',
    xwiki_status: 'read', xwiki_search: 'read', xwiki_get_page: 'read',
    xwiki_list_spaces: 'read',

    // Запись
    create_folder: 'write', rename_folder: 'write', move_folder: 'write',
    move_item: 'write', move_chat: 'write', chat_folder: 'write',
    create_prompt: 'write', update_prompt: 'write',
    create_skill: 'write', update_skill: 'write', link_skill_tools: 'write',
    confluence_configure: 'write', confluence_create_page: 'write', confluence_update_page: 'write',
    xwiki_configure: 'write', xwiki_create_page: 'write', xwiki_update_page: 'write',
    persistent_memory: 'write', export_chat: 'write', export_chats: 'write',
    // Переименование агента: меняет то, что видит пользователь, поэтому
    // не 'read'. Но это обратимая подпись, а не действие над данными —
    // в мягких режимах спрашивать не о чем.
    agent_name: 'write',

    // Разрушительное
    delete_folder: 'destroy',
    import_chat: 'destroy', import_chats: 'destroy',

    // Сеть
    http_fetch: 'network',
    // Через локальный прокси пользователя. Категория та же, но у вызова с
    // sso:true есть отдельное, более строгое правило в check().
    proxy_fetch: 'network',

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
    // ── SSO через прокси: спрашиваем ВСЕГДА ──
    // Проверка стоит до всего остального, включая режим 'off'. Причина не
    // в категории операции, а в том, ЧЕМ платят за ошибку: запрос уходит с
    // доменными правами текущего пользователя Windows (NTLM/Negotiate), а
    // адрес выбирает модель — в том числе под влиянием текста, пришедшего
    // из внешнего источника. Поэтому здесь нет ни режима, который это
    // разрешает молча, ни «больше не спрашивать про этот адрес»
    // (noRemember): один вопрос = один запрос с чужими правами.
    if (toolName === 'proxy_fetch' && args && args.sso === true) {
      const ssoHost = this._hostOf(args);
      return {
        allow: true, confirm: true, category: 'network', toolName, args,
        host: ssoHost, noRemember: true,
        risks: [
          'Запрос уйдёт с доменными правами текущего пользователя Windows (SSO)',
          'Целевой адрес: ' + (ssoHost || '(не распознан)'),
          'Отвечающий сервер увидит вашу учётную запись — разрешайте только для внутренних серверов, которым доверяете',
        ],
      };
    }

    // ── Карантин: самомодификация после внешних данных ──
    // Стоит ВЫШЕ режима, как и SSO выше: причина не в опасности самой
    // операции, а в том, что в этом ходе уже побывал чужой текст, который
    // мог эту операцию и подсказать. Классическая цепочка инъекции —
    // «прочитал страницу → создал инструмент → включил» — рвётся ровно
    // здесь, вопросом, который называет источник. Ответ не запоминается:
    // одно разрешение = одна операция.
    if (SecurityEngine.SELF_MODIFYING.has(toolName) && this.turn.external.length) {
      return {
        allow: true, confirm: true, category: 'execute', toolName, args,
        noRemember: true, quarantine: true,
        risks: [
          'Агент меняет САМ СЕБЯ: ' + toolName,
          'В этом ответе он уже получил данные извне: ' + this.turn.external.join(', '),
          'Внешний текст мог содержать инструкции для модели — проверьте, что изменение действительно нужно вам',
        ],
      };
    }

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

  // Проверяется только потолок изменений: сетевая ветка здесь была
  // мёртвой — `_overLimit('network')` не вызывался ниоткуда, поэтому
  // `maxNetworkPerTurn` выглядел настройкой, но ничего не ограничивал.
  // Сетевые вызовы и так закрыты двумя настоящими потолками: общим числом
  // вызовов за ход (⚙ Ограничения) и потолком на один инструмент.
  // Счётчик turn.network при этом остаётся — он нужен статистике хода.
  _overLimit(kind) {
    const limits = { writes: this.maxWritesPerTurn || 20 };
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

  // ── Журнал решений ──
  // Пользователь должен иметь возможность посмотреть, что агент делал и
  // что ему разрешали. Запись идёт в двух местах:
  //   в память — чтобы панель открывалась мгновенно и работала, даже
  //     если хранилище недоступно;
  //   в базу   — чтобы журнал пережил перезагрузку. Раньше он жил только
  //     в памяти: инцидент, замеченный на следующий день, разбирать было
  //     уже нечем — записи исчезали вместе со вкладкой.
  // Аргументы вызова сюда НЕ попадают намеренно: журнал выгружают наружу,
  // а в аргументах бывают адреса, тексты и, случайно, секреты.
  audit(entry) {
    const rec = {
      id: 'sec_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      at: Date.now(),
      mode: this.mode,
      tool: entry.tool || '',
      decision: entry.decision || '',
      category: entry.category || null,
      host: entry.host || null,
      risks: Array.isArray(entry.risks) ? entry.risks.slice(0, 6) : undefined,
      reason: entry.reason || undefined,
      detail: entry.detail || undefined,
    };
    this.auditLog.unshift(rec);
    if (this.auditLog.length > this.maxAudit) this.auditLog.length = this.maxAudit;
    // Сбой записи не должен ронять сам вызов, ради которого решение и
    // принималось: журнал важен, но не важнее работы.
    if (this.db) {
      this.db.put('security_log', rec)
        .then(() => this._maybeTrim())
        .catch(e => console.error('Журнал безопасности: запись не удалась', e));
    }
    return rec;
  }

  // Ротация: журнал не должен расти бесконечно в хранилище, которого и
  // так немного. Проверяем не на каждой записи — полный перебор ради
  // одной строки обошёлся бы дороже самой записи.
  async _maybeTrim() {
    if (!this.db) return 0;
    if (++this._sinceTrim < 100) return 0;
    this._sinceTrim = 0;
    try {
      const all = await this.db.getAll('security_log');
      if (all.length <= this.maxStored) return 0;
      const doomed = all.sort((a, b) => a.at - b.at).slice(0, all.length - this.maxStored);
      await this.db.deleteAll('security_log', doomed.map(r => r.id));
      return doomed.length;
    } catch (e) {
      console.error('Журнал безопасности: ротация не удалась', e);
      return 0;
    }
  }

  // Последние записи — из базы, а не из памяти: после перезагрузки в
  // памяти пусто, а в базе лежит вся история.
  async recent(limit = 300) {
    if (!this.db) return this.auditLog.slice(0, limit);
    try {
      const all = await this.db.getAll('security_log');
      return all.sort((a, b) => b.at - a.at).slice(0, limit);
    } catch (_) {
      return this.auditLog.slice(0, limit);
    }
  }

  async clearLog() {
    this.auditLog = [];
    if (!this.db) return 0;
    const all = await this.db.getAll('security_log');
    await this.db.deleteAll('security_log', all.map(r => r.id));
    return all.length;
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
