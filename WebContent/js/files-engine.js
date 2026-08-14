// ============================================================
//  FILES ENGINE — ссылки на файлы без хранения содержимого
// ============================================================
//
// ПОЧЕМУ ИМЕННО ТАК:
// Идея «запоминать расположение файла, а не сам файл» в браузере не
// реализуется хранением текстового пути: из строки «C:\docs\spec.md»
// прочитать файл невозможно — песочница это запрещает, и пути как такового
// JS вообще не видит.
//
// Рабочий механизм — File System Access API: при выборе файла браузер
// выдаёт FileSystemFileHandle, который переживает перезагрузку (его можно
// положить в IndexedDB как есть, структурным клонированием) и позволяет
// перечитать файл позже. В базе лежат только метаданные и этот дескриптор
// — содержимое не копируется, память не расходуется, а изменения в файле
// на диске видны при следующем чтении. Это и есть «ссылка на файл».
//
// ГРАНИЦЫ:
//  - API поддерживают Chrome и Edge; в Firefox и Safari его нет.
//    Для них предусмотрен запасной режим: файл берётся через обычный
//    <input type="file">, дескриптора не существует, поэтому ссылка
//    работает до перезагрузки страницы, а дальше файл нужно указать
//    заново (движок честно помечает такие записи как needsRelink).
//  - Даже с дескриптором браузер может спросить разрешение заново —
//    после перезапуска браузера это штатное поведение, а не сбой.
//  - Требуется защищённый контекст (HTTPS или localhost).

class FilesEngine {
  constructor(db) {
    this.db = db;
    // Файлы, выбранные через <input> (запасной режим): дескриптора нет,
    // держим сам File в памяти до перезагрузки страницы.
    this._transient = new Map();
  }

  static isSupported() {
    return typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';
  }

  async all() {
    const items = await this.db.getAll('files');
    return items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  async get(id) {
    return this.db.get('files', id);
  }

  // Регистрирует файл как ссылку. handle — FileSystemFileHandle (может
  // отсутствовать в запасном режиме), file — объект File для метаданных.
  async register({ handle, file, parentId = null, note = '' }) {
    const record = {
      id: 'file_' + uid(),
      name: file.name,
      size: file.size,
      mime: file.type || '',
      lastModified: file.lastModified || null,
      parentId: parentId || null,
      note: String(note || ''),
      addedAt: Date.now(),
      // Дескриптор кладём в запись как есть: IndexedDB умеет хранить
      // FileSystemFileHandle структурным клонированием.
      handle: handle || null,
      // Без дескриптора ссылка живёт только до перезагрузки.
      needsRelink: !handle,
    };
    await this.db.put('files', record);
    if (!handle) this._transient.set(record.id, file);
    return record;
  }

  async rename(id, name) {
    const f = await this.get(id);
    if (!f) return null;
    f.name = String(name || '').trim() || f.name;
    await this.db.put('files', f);
    return f;
  }

  async setNote(id, note) {
    const f = await this.get(id);
    if (!f) return null;
    f.note = String(note || '');
    await this.db.put('files', f);
    return f;
  }

  async move(id, parentId) {
    const f = await this.get(id);
    if (!f) return null;
    f.parentId = parentId || null;
    await this.db.put('files', f);
    return f;
  }

  async remove(id) {
    // Удаляется только ссылка — сам файл на диске не трогаем.
    this._transient.delete(id);
    await this.db.delete('files', id);
  }

  // Проверяет и при необходимости запрашивает разрешение на чтение.
  // Возвращает 'granted' | 'prompt' | 'denied' | 'unsupported'.
  async ensurePermission(record, { request = true } = {}) {
    if (!record || !record.handle) return 'unsupported';
    if (typeof record.handle.queryPermission !== 'function') return 'unsupported';
    const opts = { mode: 'read' };
    let state = await record.handle.queryPermission(opts);
    if (state === 'granted') return 'granted';
    if (!request) return state;
    // requestPermission обязан вызываться из обработчика жеста
    // пользователя — иначе браузер молча вернёт 'prompt'.
    state = await record.handle.requestPermission(opts);
    return state;
  }

  // Читает файл. Возвращает { name, size, mime, text } либо { error }.
  // Содержимое НЕ кэшируется: каждый раз берётся актуальная версия с диска.
  async read(id, { maxBytes = 512 * 1024, asText = true } = {}) {
    const record = await this.get(id);
    if (!record) return { error: 'Ссылка на файл не найдена' };

    let file = null;

    if (record.handle) {
      const perm = await this.ensurePermission(record, { request: false });
      if (perm !== 'granted') {
        return {
          error: 'Нет разрешения на чтение файла',
          needsPermission: true,
          id: record.id,
          name: record.name,
        };
      }
      try {
        file = await record.handle.getFile();
      } catch (e) {
        // Типичная причина — файл перемещён, переименован или удалён.
        return { error: 'Файл недоступен: ' + e.message, needsRelink: true, id: record.id, name: record.name };
      }
    } else {
      file = this._transient.get(id);
      if (!file) {
        return {
          error: 'Ссылка потеряна после перезагрузки — укажите файл заново',
          needsRelink: true,
          id: record.id,
          name: record.name,
        };
      }
    }

    // Обновляем метаданные: файл на диске мог измениться с момента
    // регистрации ссылки.
    if (file.size !== record.size || file.lastModified !== record.lastModified) {
      record.size = file.size;
      record.lastModified = file.lastModified;
      await this.db.put('files', record);
    }

    if (!asText) {
      return { name: file.name, size: file.size, mime: file.type || '', file };
    }

    if (file.size > maxBytes) {
      const slice = await file.slice(0, maxBytes).text();
      return {
        name: file.name, size: file.size, mime: file.type || '',
        text: slice, truncated: true, returnedBytes: maxBytes,
        note: `Файл больше ${maxBytes} байт — возвращено только начало.`,
      };
    }

    return { name: file.name, size: file.size, mime: file.type || '', text: await file.text(), truncated: false };
  }

  // Полный путь по дереву папок: «Проект/Спецификации/spec.md».
  async pathOf(record, folders) {
    const all = folders || await this.db.getAll('folders');
    const names = [];
    let p = record.parentId;
    const guard = new Set();
    while (p && !guard.has(p)) {
      guard.add(p);
      const f = all.find(x => x.id === p);
      if (!f) break;
      names.unshift(f.name);
      p = f.parentId;
    }
    names.push(record.name);
    return names.join('/');
  }

  // Ищет файл по id, точному имени или части пути — так на него можно
  // сослаться из чата, инструмента, навыка или промпта.
  async resolve(ref) {
    const needle = String(ref || '').trim();
    if (!needle) return null;

    const items = await this.all();
    const byId = items.find(f => f.id === needle);
    if (byId) return byId;

    const lower = needle.toLowerCase();
    const exact = items.find(f => (f.name || '').toLowerCase() === lower);
    if (exact) return exact;

    const folders = await this.db.getAll('folders');
    for (const f of items) {
      const path = (await this.pathOf(f, folders)).toLowerCase();
      if (path === lower || path.endsWith('/' + lower)) return f;
    }
    return items.find(f => (f.name || '').toLowerCase().includes(lower)) || null;
  }
}
