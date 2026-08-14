// ============================================================
//  DATABASE LAYER — IndexedDB wrapper
// ============================================================
class AgentDB {
  constructor(name = 'ai_agent_db', version = 8) {   
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
        if (!db.objectStoreNames.contains('chat_stats')) {
          db.createObjectStore('chat_stats', { keyPath: 'chatId' });
        }
      };
      req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
      req.onerror = (e) => reject(e.target.error);
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
      req.onerror = () => reject(req.error);
    });
  }

  async delete(store, key) {
    return new Promise((resolve, reject) => {
      const req = this._tx(store, 'readwrite').delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
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