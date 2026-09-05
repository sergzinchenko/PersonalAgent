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

  // Состояние каждой ссылки без запроса разрешений: нужно, чтобы панель
  // показывала реальную картину, а не только флаг из базы.
  // 'ready' — читается сразу; 'needs-permission' — дескриптор есть, но
  // браузер требует подтверждения; 'needs-relink' — дескриптора нет
  // или файл недоступен.
  async statusOf(record) {
    if (!record) return 'needs-relink';
    if (!record.handle) {
      return this._transient.has(record.id) ? 'ready' : 'needs-relink';
    }
    if (typeof record.handle.queryPermission !== 'function') return 'ready';
    try {
      const state = await record.handle.queryPermission({ mode: 'read' });
      return state === 'granted' ? 'ready' : 'needs-permission';
    } catch (_) {
      return 'needs-relink';
    }
  }

  // Пакетное восстановление доступа.
  // ВАЖНО: requestPermission() обязан вызываться из обработчика жеста
  // пользователя. Браузер учитывает «активацию» — один клик позволяет
  // запросить разрешение, поэтому проходим файлы последовательно в рамках
  // одного нажатия. Часть браузеров прерывает серию после первого диалога;
  // тогда оставшиеся файлы просто вернутся в списке failed, и пользователь
  // повторит нажатие. Это лучше, чем спрашивать по одному файлу вручную.
  async restoreAccess(records) {
    const granted = [];
    const failed = [];
    for (const record of records) {
      if (!record.handle) { failed.push({ record, reason: 'нет дескриптора — нужен повторный выбор' }); continue; }
      try {
        const state = await record.handle.requestPermission({ mode: 'read' });
        if (state === 'granted') {
          if (record.needsRelink) {
            record.needsRelink = false;
            await this.db.put('files', record);
          }
          granted.push(record);
        } else {
          failed.push({ record, reason: 'разрешение не выдано' });
        }
      } catch (e) {
        failed.push({ record, reason: e.message });
      }
    }
    return { granted, failed };
  }

  // Возвращает объект File по ссылке, разобравшись с разрешениями.
  // Вынесено из read(): двоичные режимы читают байты, а не текст, но
  // добираются до файла ровно так же — и ошибки у них те же.
  async _openFile(id) {
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

    return { record, file };
  }

  // Сырые байты файла (или его части). Отдельный метод: текстовое чтение
  // здесь не подходит вовсе — TextDecoder на двоичных данных возвращает
  // символы замены, из которых уже ничего не восстановить.
  async readBytes(id, { offset = 0, length = 64 * 1024 } = {}) {
    const opened = await this._openFile(id);
    if (opened.error) return opened;
    const { file } = opened;
    const from = Math.max(0, Math.min(offset, file.size));
    const to = Math.min(file.size, from + Math.max(1, length));
    const buf = await file.slice(from, to).arrayBuffer();
    return {
      name: file.name, size: file.size, mime: file.type || '',
      offset: from, bytes: new Uint8Array(buf),
      eof: to >= file.size,
    };
  }

  // Что это за файл: формат по сигнатуре, размеры изображения, состав
  // архива. Расширению не верим — оно врёт чаще, чем первые байты.
  async describe(id) {
    const head = await this.readBytes(id, { offset: 0, length: 8192 });
    if (head.error) return head;

    const info = BinaryFormats.describe(head.bytes, { name: head.name, mime: head.mime, size: head.size });
    const out = { name: head.name, size: head.size, mime: info.mime || head.mime, ...info };

    // ZIP уточняем по содержимому: docx, xlsx, epub и jar — это всё ZIP,
    // и разница между ними только внутри.
    if (info.format === 'ZIP') {
      const whole = await this.readBytes(id, { offset: 0, length: head.size });
      if (!whole.error) {
        const zip = BinaryFormats.zipEntries(whole.bytes);
        if (!zip.error) {
          const flavor = BinaryFormats.zipFlavor(zip.entries);
          if (flavor) Object.assign(out, flavor);
          out.entries = zip.entries.length;
          out.contains = zip.entries.slice(0, 25).map(e => e.name);
        }
      }
    }
    out.textExtractable = BinaryFormats.TEXT_EXTRACTABLE.includes(out.format);
    return out;
  }

  // Текст из двоичного документа: docx, xlsx, pptx, odt/ods, epub, pdf.
  // Возвращает { text, approximate?, truncated? } либо { error }.
  async extractText(id, { maxChars = 200000 } = {}) {
    const info = await this.describe(id);
    if (info.error) return info;

    const whole = await this.readBytes(id, { offset: 0, length: info.size });
    if (whole.error) return whole;

    if (info.format === 'PDF') {
      const res = await BinaryFormats.pdfText(whole.bytes, { maxChars });
      return res.error ? res : { ...res, format: info.format, name: info.name };
    }
    if (['DOCX', 'XLSX', 'PPTX', 'ODF', 'EPUB'].includes(info.format)) {
      const res = await BinaryFormats.officeText(whole.bytes, info.format, { maxChars });
      return res.error ? res : { ...res, format: info.format, name: info.name };
    }
    return {
      error: 'Из формата ' + info.format + ' текст извлекать нечем',
      hint: 'Понимаются docx, xlsx, pptx, odt/ods, epub и pdf. Сырые байты можно посмотреть режимом hex.',
      format: info.format,
    };
  }

  // Читает файл. Возвращает { name, size, mime, text } либо { error }.
  // Содержимое НЕ кэшируется: каждый раз берётся актуальная версия с диска.
  async read(id, { maxBytes = 512 * 1024, asText = true } = {}) {
    const opened = await this._openFile(id);
    if (opened.error) return opened;
    const { file } = opened;

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
  // folders можно передать заранее загруженным списком, чтобы не читать
  // базу на каждый файл. Индекс по id строится один раз и кэшируется:
  // раньше для каждого файла шёл линейный поиск find() по всем папкам,
  // то есть при сотне файлов — сотни обходов дерева.
  async pathOf(record, folders) {
    const all = folders || await this.db.getAll('folders');
    const index = this._folderIndex(all);
    const names = [];
    let p = record.parentId;
    const guard = new Set();
    while (p && !guard.has(p)) {
      guard.add(p);
      const f = index.get(p);
      if (!f) break;
      names.unshift(f.name);
      p = f.parentId;
    }
    names.push(record.name);
    return names.join('/');
  }

  // Кэш «массив папок → Map по id». Ключом служит сам массив, поэтому
  // повторные вызовы с тем же списком переиспользуют индекс.
  _folderIndex(folders) {
    if (this._idxSource === folders && this._idxMap) return this._idxMap;
    const map = new Map();
    for (const f of folders) map.set(f.id, f);
    this._idxSource = folders;
    this._idxMap = map;
    return map;
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
