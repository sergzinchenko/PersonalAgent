// ============================================================
//  DATABASE LAYER — IndexedDB wrapper
// ============================================================
class AgentDB {
  constructor(name = 'ai_agent_db', version = 12) {
    this.name = name;
    this.version = version;
    this.db = null;
  }

  async open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, this.version);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('chats')) {
          const s = db.createObjectStore('chats', { keyPath: 'id' });
          s.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('messages')) {
          const s = db.createObjectStore('messages', { keyPath: 'id' });
          s.createIndex('chatId', 'chatId');
          s.createIndex('chatId_ts', ['chatId', 'timestamp']);
        }
        if (!db.objectStoreNames.contains('tools')) {
          db.createObjectStore('tools', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('skills')) {
          db.createObjectStore('skills', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('prompts')) {
          const s = db.createObjectStore('prompts', { keyPath: 'id' });
          s.createIndex('category', 'category');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('folders')) {
          const s = db.createObjectStore('folders', { keyPath: 'id' });
          s.createIndex('type', 'type');
          s.createIndex('parentId', 'parentId');
        }
        // Техническая статистика чата: израсходованные токены и агрегаты
        // по вызовам инструментов. Хранится отдельно от 'chats', чтобы
        // частые обновления счётчиков не переписывали саму запись чата.
        // Ссылки на файлы: метаданные + FileSystemFileHandle.
        // Содержимое файлов НЕ хранится — только дескриптор, по которому
        // файл перечитывается с диска при обращении.
        if (!db.objectStoreNames.contains('files')) {
          const s = db.createObjectStore('files', { keyPath: 'id' });
          s.createIndex('parentId', 'parentId');
          s.createIndex('name', 'name');
        }
        // Набор подключений к LLM. Отдельное хранилище, а не запись в
        // settings: подключений много, они перебираются при отказе и
        // сортируются по приоритету — для этого нужен индекс, которого
        // у key-value записи в settings быть не может.
        //
        // Секреты (apiKey, customHeaderValue) лежат здесь зашифрованными
        // через SecretsVault. Остальные поля — открытым текстом: они
        // нужны, чтобы построить список и выбрать подключение, а
        // расшифровывать всю таблицу на каждый выбор бессмысленно.
        if (!db.objectStoreNames.contains('llm_connections')) {
          const s = db.createObjectStore('llm_connections', { keyPath: 'id' });
          s.createIndex('priority', 'priority');
          s.createIndex('enabled', 'enabled');
        }
        if (!db.objectStoreNames.contains('chat_stats')) {
          db.createObjectStore('chat_stats', { keyPath: 'chatId' });
        }
        // MCP-серверы как отдельная сущность (раньше сервер существовал
        // только неявно — как повторённое на каждом его tool поле mcpServer).
        // Имя и токен здесь общие для всех tools сервера — редактируются
        // один раз, а не на каждом инструменте по отдельности. Адрес не
        // хранится дублем: он совпадает с mcpServer у tools этого сервера.
        if (!db.objectStoreNames.contains('mcp_servers')) {
          db.createObjectStore('mcp_servers', { keyPath: 'id' });
        }
        // Большие результаты инструментов, вынесенные из переписки
        // (см. engines/artifacts-engine.js). Индекс по чату нужен и для
        // перечня артефактов чата, и для удаления их вместе с чатом.
        if (!db.objectStoreNames.contains('artifacts')) {
          const s = db.createObjectStore('artifacts', { keyPath: 'id' });
          s.createIndex('chatId', 'chatId');
        }
        // Планы задач (см. engines/tasks-engine.js): состояние длинной
        // работы, которое не должно зависеть от переписки и переживает
        // и подрезку контекста, и перезагрузку страницы.
        if (!db.objectStoreNames.contains('tasks')) {
          const s = db.createObjectStore('tasks', { keyPath: 'id' });
          s.createIndex('chatId', 'chatId');
        }
        // Журнал активного хода (см. ui/ui-resume.js). Запись живёт
        // только пока ход идёт: оставшаяся после запуска означает, что
        // вкладка не дожила до конца работы, и её можно продолжить.
        if (!db.objectStoreNames.contains('runs')) {
          db.createObjectStore('runs', { keyPath: 'chatId' });
        }
      };
      req.onsuccess = (e) => {
        this.db = e.target.result;
        // Другая вкладка с более новой версией схемы закрывает эту базу —
        // без обработчика приложение продолжило бы работать с мёртвым
        // соединением и падать на каждой операции.
        this.db.onversionchange = () => {
          this.db.close();
          alert('Приложение обновилось в другой вкладке. Эта страница будет перезагружена.');
          location.reload();
        };
        resolve(this.db);
      };
      req.onerror = (e) => reject(e.target.error);
      // Апгрейд схемы блокируется, если база открыта в другой вкладке:
      // без этого обработчика open() просто зависал бы молча.
      req.onblocked = () => reject(new Error(
        'База данных открыта в другой вкладке и мешает обновлению схемы. ' +
        'Закройте остальные вкладки с приложением и перезагрузите страницу.'));
    });
  }

  _tx(store, mode = 'readonly') {
    return this.db.transaction(store, mode).objectStore(store);
  }

  async getAll(store) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async get(store, key) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async put(store, obj) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readwrite').put(obj);
      req.onsuccess = () => resolve(req.result);
      // QuotaExceededError сам по себе ничего не объясняет пользователю —
      // подменяем на понятную формулировку с указанием, что делать.
      req.onerror = () => reject(AgentDB._friendlyError(req.error, store));
    });
  }

  static _friendlyError(err, store) {
    if (err && err.name === 'QuotaExceededError') {
      return new Error(
        'Закончилось место в локальном хранилище браузера. Удалите ненужные чаты ' +
        '(особенно с большими результатами инструментов) или очистите данные сайта. ' +
        'Хранилище: ' + store);
    }
    return err || new Error('Неизвестная ошибка хранилища: ' + store);
  }

  async delete(store, key) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readwrite').delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ── Пакетные операции ──
  // Каждая из put/delete выше открывает СВОЮ транзакцию. При импорте
  // архива на 50 чатов это тысячи транзакций подряд — операция занимала
  // ощутимое время. Здесь всё выполняется в одной транзакции, что и
  // быстрее, и атомарнее: при сбое откатывается целиком.
  async putAll(store, objects) {
    const items = Array.from(objects || []);
    if (!items.length) return 0;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const obj of items) os.put(obj);
      tx.oncomplete = () => resolve(items.length);
      tx.onerror = () => reject(AgentDB._friendlyError(tx.error, store));
      tx.onabort = () => reject(AgentDB._friendlyError(tx.error, store));
    });
  }

  async deleteAll(store, keys) {
    const list = Array.from(keys || []);
    if (!list.length) return 0;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const k of list) os.delete(k);
      tx.oncomplete = () => resolve(list.length);
      tx.onerror = () => reject(AgentDB._friendlyError(tx.error, store));
      tx.onabort = () => reject(AgentDB._friendlyError(tx.error, store));
    });
  }

  async getAllByIndex(store, indexName, value) {
    return new Promise((resolve, reject) => {
      const index = this._tx(store).index(indexName);
      const req = index.getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
}