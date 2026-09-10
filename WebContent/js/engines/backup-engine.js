// ============================================================
//  BACKUP ENGINE — полный слепок агента: содержимое и настройки
// ============================================================
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ ЭКСПОРТА РАЗДЕЛОВ. Выгрузка инструментов, навыков и
// промптов (см. ui/ui-transfer.js) отвечает на вопрос «поделиться этим
// набором». Здесь вопрос другой: «перенести агента целиком» — на другую
// машину, в другой браузер, после переустановки. Разница не в объёме, а
// в составе: перенос агента — это ещё и его имя, подключения к моделям,
// правила безопасности, лимиты, оформление, память и переписка. Ни одно
// из этих мест в разделы не попадает, и собрать их «по кусочкам»
// существующими выгрузками нельзя.
//
// ПОЧЕМУ ШИФРОВАНИЕ ЗДЕСЬ ОБЯЗАТЕЛЬНО. У выгрузки чатов пароль
// необязателен: без него получается читаемый JSON, и это осознанное
// удобство. Здесь так нельзя — в слепок входят ключи от сервисов
// моделей, токены MCP-серверов и доступы к вики. Файл без пароля был бы
// связкой ключей, лежащей в «Загрузках». Поэтому пароль спрашивается
// всегда, а сам файл — конверт ArchiveCrypto (PBKDF2-SHA256 → AES-GCM,
// см. core/crypto-utils.js).
//
// СЕКРЕТЫ ПЕРЕШИФРОВЫВАЮТСЯ, А НЕ КОПИРУЮТСЯ. В базе ключи лежат
// зашифрованными на локальном ключе браузера (SecretsVault), который
// невозможно экспортировать и который на другой машине другой. Скопировать
// шифротекст как есть — значит перенести то, что никогда не расшифруется.
// Поэтому на выгрузке секреты расшифровываются в открытый текст ВНУТРИ
// payload (который тут же целиком шифруется паролем), а на восстановлении
// шифруются заново уже локальным ключом машины-получателя.
//
// СОСТАВ ВЫБИРАЕТ ПОЛЬЗОВАТЕЛЬ. Части объявлены декларативно (PARTS
// ниже), а не зашиты в форму: список того, что можно взять, — это
// свойство данных, а не разметки, и он должен читаться в одном месте.
// Форма выгрузки, форма восстановления и отчёт строятся из одного списка.

class BackupEngine {

  // Формат конверта после расшифровки. Меняется только при несовместимом
  // изменении структуры payload — читатели проверяют его прежде, чем
  // что-либо разбирать.
  static FORMAT = 'ai-agent-backup-v1';

  // ── Из чего состоит слепок ──
  // settingsKeys — записи key-value из хранилища настроек;
  // stores       — хранилища целиком;
  // folderTypes  — папки соответствующих разделов (все они лежат в одном
  //                хранилище и различаются полем type);
  // memory       — долговременная память агента (она живёт не в базе,
  //                а в localStorage — см. инструмент persistent_memory);
  // secrets      — часть содержит доступы: об этом предупреждаем в форме
  //                и это же определяет, что можно вычистить галочкой
  //                «без ключей доступа».
  static PARTS = [
    {
      id: 'identity',
      label: 'Имя агента',
      icon: '🏷',
      hint: 'Как зовут агента и до какого релиза он рассказал вам новости.',
      settingsKeys: ['identity', 'changelog'],
    },
    {
      id: 'appearance',
      label: 'Настройки приложения',
      icon: '⚙',
      hint: 'Тема, детализация вызовов, раскладка панелей, лимиты хода, окно контекста, журналирование, адрес локального прокси.',
      settingsKeys: ['theme', 'display', 'layout', 'limits', 'context', 'logging', 'proxy'],
    },
    {
      id: 'security',
      label: 'Правила безопасности',
      icon: '🛡',
      hint: 'Режим подтверждения операций, разрешённые адреса, потолки для MCP.',
      settingsKeys: ['security'],
    },
    {
      id: 'connections',
      label: 'Провайдеры и модели',
      icon: '🔌',
      hint: 'Куда обращаться, с какими моделями и какая из них по умолчанию.',
      settingsKeys: ['llm', 'llm_registry'],
      stores: ['llm_connections'],
      secrets: true,
    },
    {
      id: 'tools',
      label: 'Инструменты',
      icon: '🔧',
      hint: 'Инструменты вместе с папками. Свой код приезжает выключенным, пока вы его не проверите.',
      stores: ['tools'],
      folderTypes: ['tools'],
      secrets: true,
    },
    {
      id: 'skills',
      label: 'Навыки',
      icon: '🧩',
      hint: 'Навыки вместе с папками.',
      stores: ['skills'],
      folderTypes: ['skills'],
    },
    {
      id: 'prompts',
      label: 'Промпты',
      icon: '📋',
      hint: 'Заготовки запросов вместе с папками.',
      stores: ['prompts'],
      folderTypes: ['prompts'],
    },
    {
      id: 'mcp',
      label: 'MCP-серверы',
      icon: '🛰',
      hint: 'Подключённые серверы инструментов и токены доступа к ним.',
      stores: ['mcp_servers'],
      secrets: true,
    },
    {
      id: 'api',
      label: 'Наборы API',
      icon: '🔗',
      hint: 'Импортированные описания API: адрес, способ авторизации и её секрет.',
      stores: ['api_bundles'],
      secrets: true,
    },
    {
      id: 'wiki',
      label: 'Доступы к Confluence и xWiki',
      icon: '📚',
      hint: 'Адреса вики, учётные записи и токены.',
      settingsKeys: ['wiki_confluence', 'wiki_xwiki'],
      secrets: true,
    },
    {
      id: 'memory',
      label: 'Долговременная память',
      icon: '🧠',
      hint: 'То, что агент запомнил о вас и о работе между чатами.',
      memory: true,
    },
    {
      id: 'chats',
      label: 'Чаты и переписка',
      icon: '💬',
      hint: 'Все чаты с сообщениями, статистикой, планами задач и вынесенными результатами инструментов.',
      stores: ['chats', 'messages', 'chat_stats', 'artifacts', 'tasks'],
      folderTypes: ['chats'],
    },
    {
      id: 'files',
      label: 'Ссылки на файлы',
      icon: '📎',
      hint: 'Перечень подключённых файлов. Сами файлы остаются на диске — после восстановления их нужно выбрать заново.',
      stores: ['files'],
      folderTypes: ['files'],
    },
    {
      id: 'securityLog',
      label: 'Журнал безопасности',
      icon: '📜',
      hint: 'История решений политики: что агент выполнял, что подтверждали вы, что было отклонено.',
      stores: ['security_log'],
    },
  ];

  // ── Где в записях лежат доступы ──
  // Путь с точкой — вложенное поле (auth.secret). Список ведётся здесь, а
  // не угадывается по имени поля: «секрет» — это решение о смысле поля, и
  // ошибка в обе стороны дорога. Пропустить поле — значит увезти
  // нерасшифровываемый мусор вместо ключа; посчитать секретом лишнее —
  // значит потерять обычную настройку при выгрузке без ключей.
  static SECRET_FIELDS = {
    llm_connections: ['apiKey', 'customHeaderValue'],
    // У инструмента MCP-сервера токен продублирован в самой записи.
    tools: ['mcpToken'],
    mcp_servers: ['token'],
    api_bundles: ['auth.secret'],
  };

  // То же самое для записей настроек — ключ записи → поля.
  static SECRET_SETTINGS = {
    llm: ['apiKey', 'customHeaderValue'],
    wiki_confluence: ['secret'],
    wiki_xwiki: ['secret'],
  };

  // Хранилища, которые не попадают в слепок ни при каком составе.
  //   runs — журнал НЕЗАВЕРШЁННОГО хода: он описывает вкладку, которая
  //          не дожила до конца работы. Приехав из архива, он предложил
  //          бы «продолжить» ход, которого на этой машине не было.
  static NEVER_EXPORT_STORES = ['runs'];

  // Записи настроек, которые не выгружаются никогда.
  //   __vault_key — сам ключ шифрования секретов. Он хранится как
  //          CryptoKey и объявлен неэкспортируемым: в JSON он не
  //          сериализуется в принципе, а если бы сериализовался —
  //          выгружать его было бы худшим, что можно сделать.
  static NEVER_EXPORT_SETTINGS = ['__vault_key'];

  // Префикс, под которым инструмент persistent_memory кладёт записи
  // в localStorage. Дублируется из tools-builtin.js осознанно: там это
  // деталь одного обработчика, здесь — граница выгружаемого.
  static MEMORY_PREFIX = 'agent_memory_';

  constructor(db) {
    this.db = db;
  }

  static partById(id) {
    return BackupEngine.PARTS.find(p => p.id === id) || null;
  }

  // Части, которые содержат доступы, — для предупреждения в форме.
  static secretParts() {
    return BackupEngine.PARTS.filter(p => p.secrets);
  }

  // ──────────────────────────────────────────────
  //  СБОР
  // ──────────────────────────────────────────────

  // partIds — какие части взять; includeSecrets — класть ли в файл сами
  // ключи и токены. Без них слепок остаётся полезным (структура, правила,
  // список провайдеров), но подключения придётся ввести заново.
  async collect(partIds, { includeSecrets = true } = {}) {
    const wanted = new Set(partIds || []);
    const parts = {};
    const counts = {};

    for (const spec of BackupEngine.PARTS) {
      if (!wanted.has(spec.id)) continue;
      const block = { settings: [], folders: [], records: {}, memory: null };
      let n = 0;

      for (const key of (spec.settingsKeys || [])) {
        if (BackupEngine.NEVER_EXPORT_SETTINGS.includes(key)) continue;
        const rec = await this.db.get('settings', key);
        if (!rec) continue;
        block.settings.push(await this._prepareSettingForExport(rec, includeSecrets));
        n++;
      }

      for (const store of (spec.stores || [])) {
        if (BackupEngine.NEVER_EXPORT_STORES.includes(store)) continue;
        const rows = await this.db.getAll(store);
        const out = [];
        for (const row of rows) {
          out.push(await this._prepareRecordForExport(store, row, includeSecrets));
        }
        block.records[store] = out;
        n += out.length;
      }

      if (spec.folderTypes && spec.folderTypes.length) {
        const all = await this.db.getAll('folders');
        block.folders = all.filter(f => spec.folderTypes.includes(f.type));
        n += block.folders.length;
      }

      if (spec.memory) {
        block.memory = this._collectMemory();
        n += Object.keys(block.memory).length;
      }

      parts[spec.id] = block;
      counts[spec.id] = n;
    }

    const identity = await this.db.get('settings', 'identity');

    return {
      format: BackupEngine.FORMAT,
      version: 1,
      createdAt: new Date().toISOString(),
      // Номер релиза приложения, в котором сделан слепок: при
      // восстановлении в другую версию это единственное, по чему можно
      // объяснить расхождение состава.
      appRelease: (typeof APP_RELEASE_COUNT === 'number') ? APP_RELEASE_COUNT : null,
      agentName: (identity && identity.name) || null,
      includesSecrets: !!includeSecrets,
      counts,
      parts,
    };
  }

  // Секреты записи расшифровываются локальным ключом и кладутся в payload
  // открытым текстом — см. пояснение в шапке файла. Сам payload сразу
  // после этого шифруется паролем пользователя и в открытом виде никуда
  // не попадает.
  async _prepareRecordForExport(store, row, includeSecrets) {
    const rec = this._plainClone(row);

    // Дескриптор файла (FileSystemFileHandle) — объект браузера, а не
    // данные: он не сериализуется в JSON и на другой машине бессмыслен.
    // Ссылка переносится как метаданные, а файл на новом месте выбирается
    // заново — это и отмечает needsRelink.
    if (store === 'files') {
      delete rec.handle;
      rec.needsRelink = true;
    }

    for (const path of (BackupEngine.SECRET_FIELDS[store] || [])) {
      const raw = this._getPath(rec, path);
      if (raw === undefined) continue;
      const plain = includeSecrets ? await SecretsVault.decrypt(this.db, raw) : '';
      this._setPath(rec, path, plain || '');
    }
    return rec;
  }

  async _prepareSettingForExport(row, includeSecrets) {
    const rec = this._plainClone(row);
    for (const field of (BackupEngine.SECRET_SETTINGS[rec.key] || [])) {
      if (rec[field] === undefined) continue;
      rec[field] = includeSecrets ? (await SecretsVault.decrypt(this.db, rec[field])) || '' : '';
    }
    return rec;
  }

  _collectMemory() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(BackupEngine.MEMORY_PREFIX)) continue;
        out[k.slice(BackupEngine.MEMORY_PREFIX.length)] = localStorage.getItem(k);
      }
    } catch (_) {
      // Хранилище может быть недоступно (приватное окно, запрет данных
      // сайта). Память — не единственная часть слепка, и её отсутствие
      // не повод обрушить всю выгрузку.
    }
    return out;
  }

  // ──────────────────────────────────────────────
  //  ЧТЕНИЕ ЧУЖОГО ФАЙЛА
  // ──────────────────────────────────────────────

  // Что лежит в расшифрованном слепке — для формы восстановления.
  // Возвращает описание частей в том же порядке, что и PARTS: список
  // должен читаться одинаково при выгрузке и при загрузке.
  static describe(payload) {
    if (!payload || payload.format !== BackupEngine.FORMAT) {
      throw new Error('Это не резервная копия агента (ожидался формат ' + BackupEngine.FORMAT + ')');
    }
    const present = [];
    for (const spec of BackupEngine.PARTS) {
      const block = (payload.parts || {})[spec.id];
      if (!block) continue;
      present.push({
        id: spec.id,
        label: spec.label,
        icon: spec.icon,
        hint: spec.hint,
        secrets: !!spec.secrets,
        count: BackupEngine.countBlock(block),
      });
    }
    return {
      createdAt: payload.createdAt || null,
      agentName: payload.agentName || null,
      appRelease: payload.appRelease ?? null,
      includesSecrets: !!payload.includesSecrets,
      parts: present,
    };
  }

  static countBlock(block) {
    if (!block) return 0;
    let n = (block.settings || []).length + (block.folders || []).length;
    for (const rows of Object.values(block.records || {})) n += rows.length;
    if (block.memory) n += Object.keys(block.memory).length;
    return n;
  }

  // ──────────────────────────────────────────────
  //  ВОССТАНОВЛЕНИЕ
  // ──────────────────────────────────────────────

  // mode:
  //   'merge'     — добавить недостающее, существующее не трогать;
  //   'overwrite' — записи с совпадающими идентификаторами заменить.
  // enableImportedCode — включать ли восстановленные инструменты с
  //   собственным кодом. По умолчанию нет: см. пояснение у _applyStore.
  async apply(payload, { parts, mode = 'merge', enableImportedCode = false } = {}) {
    BackupEngine.describe(payload); // проверка формата — до любых записей

    // Соответствие «папка из файла → папка здесь» копится по мере разбора
    // частей и нужно содержимому следующих. Сбрасываем на каждый вызов:
    // от прошлого восстановления могли остаться идентификаторы, которых
    // в этом файле нет.
    this._folderMap = {};

    const wanted = new Set(parts && parts.length ? parts : Object.keys(payload.parts || {}));
    const report = {
      added: 0, replaced: 0, skipped: 0,
      foldersAdded: 0, foldersReused: 0,
      memoryKeys: 0,
      disabledTools: 0,
      byPart: {},
      secretsRestored: 0,
      secretsMissing: 0,
    };

    for (const spec of BackupEngine.PARTS) {
      if (!wanted.has(spec.id)) continue;
      const block = (payload.parts || {})[spec.id];
      if (!block) continue;

      const before = { added: report.added, replaced: report.replaced, skipped: report.skipped };

      // Папки — ДО содержимого: иначе восстановленный инструмент сослался
      // бы на папку, которой ещё нет, и осел бы в корне.
      if ((block.folders || []).length) await this._applyFolders(block.folders, mode, report);

      for (const rec of (block.settings || [])) await this._applySetting(rec, mode, report);

      for (const [store, rows] of Object.entries(block.records || {})) {
        if (BackupEngine.NEVER_EXPORT_STORES.includes(store)) continue;
        await this._applyStore(store, rows, mode, report, enableImportedCode);
      }

      if (block.memory) this._applyMemory(block.memory, mode, report);

      report.byPart[spec.id] = {
        label: spec.label,
        added: report.added - before.added,
        replaced: report.replaced - before.replaced,
        skipped: report.skipped - before.skipped,
      };
    }

    return report;
  }

  async _applyFolders(folders, mode, report) {
    const existing = await this.db.getAll('folders');
    const byId = new Map(existing.map(f => [f.id, f]));

    // Родитель должен быть обработан раньше ребёнка, иначе уровень
    // вложенности определится по ещё не сопоставленному идентификатору.
    const incomingById = new Map(folders.map(f => [f.id, f]));
    const depthOf = (f) => {
      let d = 0, p = f.parentId;
      const seen = new Set();
      while (p && incomingById.has(p) && !seen.has(p)) { seen.add(p); d++; p = incomingById.get(p).parentId; }
      return d;
    };
    const ordered = folders.slice().sort((a, b) => depthOf(a) - depthOf(b));
    const map = {};

    for (const f of ordered) {
      // Папки, которые приложение заводит само, у получателя уже есть и
      // имеют те же фиксированные идентификаторы — принимать их из файла
      // незачем, а перезаписывать нельзя: от их полей зависят запреты.
      if (typeof FoldersEngine !== 'undefined' && FoldersEngine.isSeededId(f.id)) {
        map[f.id] = f.id;
        report.foldersReused++;
        continue;
      }

      const rec = this._plainClone(f);
      // Флаг «системная» делает папку неприкосновенной. Принесённая
      // архивом, она стала бы участком базы, который пользователь не
      // может ни переименовать, ни удалить, — а завести его смог бы
      // любой, кто прислал файл.
      delete rec.system;
      rec.parentId = rec.parentId ? (map[rec.parentId] || rec.parentId) : null;

      const sameId = byId.get(rec.id);
      if (sameId && mode !== 'overwrite') {
        map[rec.id] = sameId.id;
        report.foldersReused++;
        continue;
      }

      // Та же по смыслу папка на другой машине имеет другой
      // идентификатор. Совпадение имени на том же уровне того же раздела
      // — это она и есть: переиспользуем, а не плодим близнеца.
      if (!sameId) {
        const twin = existing.find(e =>
          e.type === rec.type &&
          (e.parentId || null) === (rec.parentId || null) &&
          this._normName(e.name) === this._normName(rec.name));
        if (twin) {
          map[rec.id] = twin.id;
          report.foldersReused++;
          continue;
        }
      }

      await this.db.put('folders', rec);
      byId.set(rec.id, rec);
      existing.push(rec);
      map[rec.id] = rec.id;
      if (sameId) report.foldersReused++; else report.foldersAdded++;
    }

    this._folderMap = { ...(this._folderMap || {}), ...map };
    return map;
  }

  async _applySetting(rec, mode, report) {
    if (!rec || !rec.key) { report.skipped++; return; }
    if (BackupEngine.NEVER_EXPORT_SETTINGS.includes(rec.key)) { report.skipped++; return; }

    const existing = await this.db.get('settings', rec.key);
    if (existing && mode !== 'overwrite') { report.skipped++; return; }

    const out = this._plainClone(rec);
    for (const field of (BackupEngine.SECRET_SETTINGS[rec.key] || [])) {
      if (out[field] === undefined) continue;
      out[field] = await this._reseal(out[field], report);
    }
    await this.db.put('settings', out);
    if (existing) report.replaced++; else report.added++;
  }

  async _applyStore(store, rows, mode, report, enableImportedCode) {
    const existing = await this.db.getAll(store);
    const byId = new Map(existing.map(r => [this._keyOf(store, r), r]));

    // Системные объекты этой базы не подменяет никакой файл — даже в
    // режиме замены и даже при совпадении идентификатора. Иначе достаточно
    // было бы положить в слепок навык с locked, чтобы его текст попадал в
    // каждый запрос к модели и не выключался.
    const protectedIds = new Set(existing
      .filter(r => r.locked || r.protected)
      .map(r => this._keyOf(store, r)));

    const systemFolders = new Set((await this.db.getAll('folders'))
      .filter(f => f.system).map(f => f.id));

    const toWrite = [];
    for (const row of rows) {
      const rec = this._plainClone(row);
      const id = this._keyOf(store, rec);

      if (protectedIds.has(id)) { report.skipped++; continue; }

      // Признаки системности не приезжают из файла ни при каком режиме:
      // встроенные объекты этой сборки получают их сами при загрузке.
      delete rec.locked;
      delete rec.protected;

      // Ссылка на папку могла быть переназначена при сопоставлении выше.
      if (rec.parentId) rec.parentId = (this._folderMap || {})[rec.parentId] || rec.parentId;
      // В системную папку чужое содержимое не кладём: она отвечает на
      // вопрос «что здесь трогать нельзя», и посторонние записи в ней
      // делают этот ответ ложным.
      if (systemFolders.has(rec.parentId)) rec.parentId = null;

      for (const path of (BackupEngine.SECRET_FIELDS[store] || [])) {
        const raw = this._getPath(rec, path);
        if (raw === undefined) continue;
        this._setPath(rec, path, await this._reseal(raw, report));
      }

      const local = byId.get(id);

      // Встроенный инструмент существует у получателя всегда — его код
      // поставляется с приложением. Из файла берём только то, что решил
      // пользователь: включён он или нет. Описание и параметры остаются
      // локальными — они могут быть новее слепка, и именно по ним модель
      // решает, когда инструмент вызвать. Папку тоже не принимаем:
      // раскладку встроенных задаёт приложение, и она у получателя своя —
      // принятая из файла, она всё равно вернулась бы на место при
      // следующей загрузке (см. ToolsEngine.PLACEMENT).
      if (store === 'tools' && rec.builtin) {
        if (!local) { report.skipped++; continue; }
        if (typeof rec.enabled === 'boolean' && !local.locked) local.enabled = rec.enabled;
        toWrite.push(local);
        report.replaced++;
        continue;
      }

      if (local && mode !== 'overwrite') { report.skipped++; continue; }

      // Свой код инструмента приезжает выключенным, если пользователь
      // явно не решил иначе. Слепок мог быть сделан не вами, а включённый
      // инструмент исполняется по решению модели — без просмотра кода
      // это чужой код, запущенный у вас на странице.
      if (store === 'tools' && rec.handlerCode && !enableImportedCode) {
        rec.enabled = false;
        report.disabledTools++;
      }

      toWrite.push(rec);
      if (local) report.replaced++; else report.added++;
    }

    // Одной транзакцией: восстановление переписки — это тысячи записей,
    // и по одной они шли бы ощутимо дольше, а сбой посередине оставил бы
    // половину слепка (см. putAll в core/db.js).
    if (toWrite.length) await this.db.putAll(store, toWrite);
  }

  _applyMemory(memory, mode, report) {
    try {
      for (const [k, v] of Object.entries(memory || {})) {
        const full = BackupEngine.MEMORY_PREFIX + k;
        if (mode !== 'overwrite' && localStorage.getItem(full) !== null) { report.skipped++; continue; }
        localStorage.setItem(full, v);
        report.memoryKeys++;
      }
    } catch (_) {
      // Недоступное localStorage не должно рушить восстановление
      // остального: память — одна из частей, а не условие успеха.
    }
  }

  // Секрет из файла лежит открытым текстом (сам файл был зашифрован
  // паролем) — здесь он снова закрывается локальным ключом браузера.
  // Пустая строка означает, что слепок делали без ключей доступа: это не
  // ошибка, но пользователю об этом надо сказать, поэтому считаем отдельно.
  async _reseal(plain, report) {
    const text = typeof plain === 'string' ? plain : '';
    if (!text) { report.secretsMissing++; return ''; }
    report.secretsRestored++;
    return await SecretsVault.encrypt(this.db, text);
  }

  // ── Мелочи ──

  // Ключ записи различается по хранилищу: у большинства это id, у
  // статистики чата — chatId, у настроек — key.
  _keyOf(store, rec) {
    if (store === 'chat_stats') return rec.chatId;
    if (store === 'settings') return rec.key;
    return rec.id;
  }

  _normName(s) {
    return String(s || '').trim().toLowerCase();
  }

  // Копия записи — ГЛУБОКАЯ, и это не перестраховка. Секреты лежат в том
  // числе во вложенных полях (auth.secret у набора API), а выгрузка их
  // переписывает: расшифровывает для переноса или вычищает, если
  // пользователь снял галочку «включить ключи доступа». При поверхностной
  // копии вложенный объект остался бы тем же самым, что и в базе, — и
  // выгрузка без ключей стирала бы настоящие ключи из настоящей базы.
  //
  // Рекурсия идёт только по обычным объектам и массивам. Всё прочее —
  // объекты браузера (дескриптор файла, CryptoKey), Date, функции —
  // копируется ссылкой или отбрасывается: воспроизводить их незачем,
  // а разбирать по полям нечего.
  _plainClone(value) {
    if (Array.isArray(value)) return value.map(v => this._plainClone(v));
    if (!value || typeof value !== 'object') return value;
    // Простой объект отличаем по внутренней метке, а не по прототипу:
    // прототип у каждого окна свой, и запись, пришедшая из другого
    // контекста, не прошла бы проверку на равенство Object.prototype.
    if (Object.prototype.toString.call(value) !== '[object Object]') return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'function') continue;
      out[k] = this._plainClone(v);
    }
    return out;
  }

  _getPath(obj, path) {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = cur[p];
    }
    return cur;
  }

  _setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
}
