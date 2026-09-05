// ============================================================
//  BINARY FORMATS — что это за файл и как достать из него смысл
// ============================================================
//
// ЗАЧЕМ. Ссылки на файлы (вкладка «Файлы») до сих пор работали только с
// текстом: агент звал file.text(), и для docx, pdf или картинки получал
// кашу из символов замены. Пользователь при этом видел файл в списке и
// разумно ожидал, что с ним можно работать.
//
// ЧТО ЗДЕСЬ. Три уровня понимания двоичного файла, от дешёвого к дорогому:
//   1. ЧТО ЭТО — формат по сигнатуре (первые байты), а не по расширению:
//      расширение врёт, а сигнатура нет. Плюс размеры изображения и
//      состав архива — это дёшево и почти всегда именно то, что нужно.
//   2. ЧТО ВНУТРИ — извлечение текста из docx/xlsx/pptx, odt/ods и pdf.
//      Офисные форматы — это ZIP с XML внутри, и распаковать их можно
//      штатным DecompressionStream, без внешних библиотек.
//   3. СЫРЫЕ БАЙТЫ — hex-дамп и base64 порциями, когда нужно разобраться
//      в формате руками или передать файл дальше.
//
// ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. Ни одной внешней библиотеки: приложение
// принципиально работает без сборки и без зависимостей в рантайме, а
// тянуть в него распаковщик и разборщик PDF ради удобства — значит
// поменять это свойство на функцию, которая нужна не каждому.
// Извлечение текста из PDF поэтому честно приблизительное: оно берёт
// текстовые операторы из распакованных потоков и не притворяется
// вёрсткой. Про это прямо сказано в ответе — модель не должна считать
// такой текст точной копией документа.
const BinaryFormats = (() => {

  // ── Сигнатуры ──
  // Порядок важен: более специфичные раньше. ZIP-контейнеры (docx и
  // прочие) отличаются от простого ZIP не сигнатурой, а содержимым,
  // поэтому уточняются отдельно — см. describe().
  const SIGNATURES = [
    { format: 'PNG',  kind: 'image',    mime: 'image/png',  bytes: [0x89, 0x50, 0x4E, 0x47] },
    { format: 'JPEG', kind: 'image',    mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
    { format: 'GIF',  kind: 'image',    mime: 'image/gif',  bytes: [0x47, 0x49, 0x46, 0x38] },
    { format: 'BMP',  kind: 'image',    mime: 'image/bmp',  bytes: [0x42, 0x4D] },
    { format: 'PDF',  kind: 'document', mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
    { format: 'ZIP',  kind: 'archive',  mime: 'application/zip', bytes: [0x50, 0x4B, 0x03, 0x04] },
    { format: 'ZIP',  kind: 'archive',  mime: 'application/zip', bytes: [0x50, 0x4B, 0x05, 0x06] },
    { format: 'GZIP', kind: 'archive',  mime: 'application/gzip', bytes: [0x1F, 0x8B] },
    { format: 'RAR',  kind: 'archive',  mime: 'application/vnd.rar', bytes: [0x52, 0x61, 0x72, 0x21] },
    { format: '7Z',   kind: 'archive',  mime: 'application/x-7z-compressed', bytes: [0x37, 0x7A, 0xBC, 0xAF] },
    { format: 'DOC (старый формат Office)', kind: 'document', mime: 'application/msword',
      bytes: [0xD0, 0xCF, 0x11, 0xE0] },
    { format: 'RTF',  kind: 'document', mime: 'application/rtf', bytes: [0x7B, 0x5C, 0x72, 0x74, 0x66] },
    { format: 'SQLite', kind: 'data',   mime: 'application/vnd.sqlite3',
      bytes: [0x53, 0x51, 0x4C, 0x69, 0x74, 0x65] },
    { format: 'MP3',  kind: 'audio',    mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
    { format: 'WAV',  kind: 'audio',    mime: 'audio/wav',  bytes: [0x52, 0x49, 0x46, 0x46] },
    { format: 'OGG',  kind: 'audio',    mime: 'audio/ogg',  bytes: [0x4F, 0x67, 0x67, 0x53] },
    { format: 'ELF',  kind: 'binary',   mime: 'application/x-elf', bytes: [0x7F, 0x45, 0x4C, 0x46] },
    { format: 'EXE/DLL', kind: 'binary', mime: 'application/vnd.microsoft.portable-executable',
      bytes: [0x4D, 0x5A] },
    { format: 'CLASS (Java)', kind: 'binary', mime: 'application/java-vm',
      bytes: [0xCA, 0xFE, 0xBA, 0xBE] },
  ];

  const starts = (bytes, sig) => sig.every((b, i) => bytes[i] === b);

  // WEBP и MP4 узнаются не по началу, а по метке в четвёртом слове:
  // первые байты у них заняты длиной или контейнером RIFF.
  function detect(bytes) {
    if (!bytes || bytes.length < 2) return null;
    const ascii = (from, len) => String.fromCharCode(...bytes.slice(from, from + len));

    if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
      return { format: 'WEBP', kind: 'image', mime: 'image/webp' };
    }
    if (bytes.length >= 12 && ascii(4, 4) === 'ftyp') {
      const brand = ascii(8, 4);
      if (brand.startsWith('hei') || brand.startsWith('mif')) {
        return { format: 'HEIC', kind: 'image', mime: 'image/heic' };
      }
      return { format: 'MP4', kind: 'video', mime: 'video/mp4' };
    }
    for (const s of SIGNATURES) {
      if (bytes.length >= s.bytes.length && starts(bytes, s.bytes)) {
        return { format: s.format, kind: s.kind, mime: s.mime };
      }
    }
    return null;
  }

  // ── Двоичный или текстовый ──
  // По содержимому, а не по типу: сервер отдаёт «application/octet-stream»
  // и для XML, и для картинки, а расширения у файлов на диске бывают
  // какие угодно. Нулевой байт в первых килобайтах — самый надёжный
  // признак; дальше смотрим на долю управляющих символов.
  function looksBinary(bytes) {
    if (!bytes || !bytes.length) return false;
    const n = Math.min(bytes.length, 4096);
    let control = 0;
    for (let i = 0; i < n; i++) {
      const b = bytes[i];
      if (b === 0) return true;
      // Печатные, перевод строки, возврат каретки, табуляция, перевод
      // страницы и всё, что выше 0x7F (UTF-8), считаем нормальным.
      if (b < 0x09 || (b > 0x0D && b < 0x20)) control++;
    }
    return control / n > 0.05;
  }

  // ── Размеры изображения ──
  // Читаются из заголовка, без декодирования картинки: декодировать её
  // ради двух чисел — это мегабайты памяти и асинхронность на пустом месте.
  function imageSize(bytes, format) {
    try {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (format === 'PNG' && bytes.length > 24) {
        return { width: dv.getUint32(16), height: dv.getUint32(20) };
      }
      if (format === 'GIF' && bytes.length > 10) {
        return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
      }
      if (format === 'BMP' && bytes.length > 26) {
        return { width: dv.getInt32(18, true), height: Math.abs(dv.getInt32(22, true)) };
      }
      if (format === 'WEBP' && bytes.length > 30) {
        const chunk = String.fromCharCode(...bytes.slice(12, 16));
        if (chunk === 'VP8X') return { width: 1 + (bytes[24] | bytes[25] << 8 | bytes[26] << 16),
          height: 1 + (bytes[27] | bytes[28] << 8 | bytes[29] << 16) };
        if (chunk === 'VP8 ') return { width: dv.getUint16(26, true) & 0x3FFF, height: dv.getUint16(28, true) & 0x3FFF };
      }
      if (format === 'JPEG') {
        // Идём по маркерам до SOF — там лежат размеры. Маркеры без
        // полезной нагрузки (0xD0–0xD9) пропускаем по одному байту.
        let i = 2;
        while (i < bytes.length - 9) {
          if (bytes[i] !== 0xFF) { i++; continue; }
          const marker = bytes[i + 1];
          if (marker >= 0xD0 && marker <= 0xD9) { i += 2; continue; }
          const len = dv.getUint16(i + 2);
          if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
          }
          i += 2 + len;
        }
      }
    } catch (_) { /* заголовок обрезан или испорчен — размеров просто не будет */ }
    return null;
  }

  // ── ZIP ──
  // Разбирается центральный каталог (в конце файла), а не поток записей:
  // так видно ВСЕ файлы архива и их смещения, не читая архив целиком.
  function zipEntries(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // End of central directory: сигнатура PK\5\6, ищем с конца — в хвосте
    // может быть комментарий архива.
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65536; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return { error: 'Это не ZIP или архив обрезан: не найден центральный каталог' };

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < count && p + 46 <= bytes.length; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compressedSize = dv.getUint32(p + 20, true);
      const size = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = new TextDecoder('utf-8').decode(bytes.slice(p + 46, p + 46 + nameLen));
      entries.push({ name, size, compressedSize, method, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries };
  }

  // Содержимое одной записи архива. Требует DecompressionStream —
  // штатного механизма браузера; без него распаковать deflate нечем,
  // и мы говорим об этом прямо, а не возвращаем мусор.
  async function zipRead(bytes, entry) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const p = entry.localOffset;
    if (dv.getUint32(p, true) !== 0x04034b50) return { error: 'Запись архива не найдена' };
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const start = p + 30 + nameLen + extraLen;
    const raw = bytes.slice(start, start + (entry.compressedSize || entry.size));

    if (entry.method === 0) return { data: raw };
    if (entry.method !== 8) return { error: 'Способ сжатия ' + entry.method + ' не поддерживается' };
    if (typeof DecompressionStream === 'undefined') {
      return { error: 'Браузер не умеет распаковывать deflate (нет DecompressionStream)' };
    }
    try {
      const ds = new DecompressionStream('deflate-raw');
      const stream = new Blob([raw]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return { data: new Uint8Array(buf) };
    } catch (e) {
      return { error: 'Не удалось распаковать запись архива: ' + (e && e.message || e) };
    }
  }

  // ── Что это за ZIP ──
  // docx, xlsx, pptx, odt, ods, jar и epub — всё это ZIP. Отличаются они
  // содержимым, поэтому уточняем по именам записей.
  function zipFlavor(entries) {
    const names = entries.map(e => e.name);
    const has = (n) => names.includes(n);
    if (has('word/document.xml')) return { format: 'DOCX', kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    if (has('xl/workbook.xml')) return { format: 'XLSX', kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    if (names.some(n => n.startsWith('ppt/slides/'))) return { format: 'PPTX', kind: 'document', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
    if (has('mimetype') && names.includes('content.xml')) return { format: 'ODF', kind: 'document', mime: 'application/vnd.oasis.opendocument.text' };
    if (has('META-INF/container.xml')) return { format: 'EPUB', kind: 'document', mime: 'application/epub+zip' };
    if (has('META-INF/MANIFEST.MF')) return { format: 'JAR', kind: 'archive', mime: 'application/java-archive' };
    return null;
  }

  // ── Текст из XML ──
  // Разметку офисных форматов разбираем строкой, а не DOMParser: нужны
  // не узлы, а текст с границами абзацев, и на файле в мегабайты
  // построение дерева стоит заметно дороже.
  const xmlText = (xml, breakTags) => {
    let s = String(xml);
    for (const t of breakTags) s = s.replace(new RegExp('</' + t + '>', 'g'), '\n');
    return s.replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  };

  // Текст из офисного контейнера. Возвращает { text, parts } либо { error }.
  async function officeText(bytes, flavor, { maxChars = 200000 } = {}) {
    const zip = zipEntries(bytes);
    if (zip.error) return zip;
    const dec = new TextDecoder('utf-8');
    const pick = (re) => zip.entries.filter(e => re.test(e.name));

    let files = [];
    let breaks = ['w:p'];
    if (flavor === 'DOCX') { files = pick(/^word\/(document|footnotes|endnotes)\.xml$/); breaks = ['w:p', 'w:tr']; }
    else if (flavor === 'PPTX') { files = pick(/^ppt\/slides\/slide\d+\.xml$/); breaks = ['a:p']; }
    else if (flavor === 'ODF') { files = pick(/^content\.xml$/); breaks = ['text:p', 'text:h', 'table:table-row']; }
    else if (flavor === 'EPUB') { files = pick(/\.x?html?$/i).slice(0, 40); breaks = ['p', 'div', 'h1', 'h2', 'h3']; }
    else if (flavor === 'XLSX') return xlsxText(bytes, zip, { maxChars });

    if (!files.length) return { error: 'Внутри контейнера нет ожидаемых частей документа' };

    const out = [];
    let chars = 0;
    for (const f of files.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))) {
      const res = await zipRead(bytes, f);
      if (res.error) return res;
      const text = xmlText(dec.decode(res.data), breaks).trim();
      if (!text) continue;
      out.push(files.length > 1 ? `--- ${f.name} ---\n${text}` : text);
      chars += text.length;
      if (chars > maxChars) break;
    }
    const text = out.join('\n\n');
    return {
      text: text.length > maxChars ? text.slice(0, maxChars) : text,
      truncated: text.length > maxChars,
      parts: files.length,
    };
  }

  // XLSX разбирается отдельно: значения ячеек лежат в одном файле, а сами
  // строки — в общей таблице строк, и без неё в листе видны только номера.
  async function xlsxText(bytes, zip, { maxChars = 200000 } = {}) {
    const dec = new TextDecoder('utf-8');

    let shared = [];
    const sharedEntry = zip.entries.find(e => e.name === 'xl/sharedStrings.xml');
    if (sharedEntry) {
      const res = await zipRead(bytes, sharedEntry);
      if (res.error) return res;
      const xml = dec.decode(res.data);
      shared = [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m =>
        [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''));
      shared = shared.map(v => xmlText(v, []));
    }

    const sheets = zip.entries.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    if (!sheets.length) return { error: 'В книге нет листов' };

    const out = [];
    let chars = 0;
    for (const sheet of sheets) {
      const res = await zipRead(bytes, sheet);
      if (res.error) return res;
      const xml = dec.decode(res.data);
      const rows = [];
      for (const rowM of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        // Атрибуты ячейки и её содержимое разбираем ПОРОЗНЬ. Одним
        // выражением с необязательной группой t="s" тип регулярно
        // съедался соседним [^>]*, и строки из общего словаря
        // подставлялись номерами вместо текста.
        for (const cm of rowM[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const tAttr = /\bt="([^"]+)"/.exec(cm[1] || '');
          const type = tAttr ? tAttr[1] : '';
          const vm = /<v>([\s\S]*?)<\/v>/.exec(cm[2]);
          const tm = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cm[2]);
          let value = '';
          if (type === 's' && vm) value = shared[parseInt(vm[1], 10)] ?? '';
          else if (tm) value = xmlText(tm[1], []);
          else if (vm) value = vm[1];
          cells.push(value);
        }
        // Пустые строки листа не несут смысла и раздувают вывод.
        if (cells.some(c => c !== '')) rows.push(cells.join('\t'));
      }
      if (!rows.length) continue;
      const text = `--- ${sheet.name.replace(/^xl\/worksheets\//, '')} ---\n` + rows.join('\n');
      out.push(text);
      chars += text.length;
      if (chars > maxChars) break;
    }
    const text = out.join('\n\n');
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars, parts: sheets.length };
  }

  // Строка из PDF — это набор байтов, и кодировка у неё бывает разной.
  // Кириллица встречается в двух видах: UTF-16BE с меткой FEFF (так её
  // пишет большинство генераторов) и обычный UTF-8. Без разбора русский
  // текст превращался в «Ð¡Ñ‡Ñ‘Ñ‚» — то есть в мусор, который модель
  // приняла бы за содержимое документа.
  function decodePdfString(raw) {
    if (raw.length >= 2 && raw.charCodeAt(0) === 0xFE && raw.charCodeAt(1) === 0xFF) {
      let out = '';
      for (let i = 2; i + 1 < raw.length; i += 2) {
        out += String.fromCharCode((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
      }
      return out;
    }
    // Строгий декодер UTF-8: если это была однобайтовая кодировка, он
    // бросит исключение — тогда оставляем строку как есть.
    if ([...raw].some(c => c.charCodeAt(0) > 0x7F)) {
      try {
        const bytes = new Uint8Array([...raw].map(c => c.charCodeAt(0) & 0xFF));
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (_) { /* не UTF-8 — значит однобайтовая кодировка */ }
    }
    return raw;
  }

  // ── PDF ──
  // Приблизительно и честно: распаковываем потоки со сжатием Flate и
  // берём из них текстовые операторы Tj/TJ. Порядок слов сохраняется,
  // вёрстка — нет; шрифты с нестандартной кодировкой дадут мусор.
  // Полноценный разбор PDF — это отдельная библиотека, а её здесь нет
  // намеренно (см. шапку файла).
  async function pdfText(bytes, { maxChars = 200000 } = {}) {
    const latin = binaryString(bytes);
    const chunks = [];
    let chars = 0;

    // Потоки ищем по маркерам stream/endstream; смещения считаем в той же
    // однобайтовой кодировке, поэтому индексы совпадают с байтовыми.
    const re = /stream\r?\n?/g;
    let m;
    while ((m = re.exec(latin)) !== null && chars < maxChars) {
      const start = m.index + m[0].length;
      const end = latin.indexOf('endstream', start);
      if (end < 0) break;
      re.lastIndex = end;

      const header = latin.slice(Math.max(0, m.index - 400), m.index);
      let data = bytes.slice(start, end);

      if (/\/FlateDecode/.test(header)) {
        if (typeof DecompressionStream === 'undefined') continue;
        try {
          const ds = new DecompressionStream('deflate');
          const stream = new Blob([data]).stream().pipeThrough(ds);
          data = new Uint8Array(await new Response(stream).arrayBuffer());
        } catch (_) { continue; }   // не текстовый поток или другой фильтр
      } else if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|RunLengthDecode|LZWDecode)/.test(header)) {
        continue;   // картинки и неподдерживаемые фильтры пропускаем
      }

      const content = binaryString(data);
      if (!/(Tj|TJ)/.test(content)) continue;

      const pieces = [];
      for (const t of content.matchAll(/\((?:\\.|[^\\()])*\)\s*Tj|\[[\s\S]*?\]\s*TJ/g)) {
        for (const lit of t[0].matchAll(/\((?:\\.|[^\\()])*\)/g)) {
          pieces.push(decodePdfString(lit[0].slice(1, -1)
            .replace(/\\([()\\])/g, '$1')
            .replace(/\\(\d{1,3})/g, (s, o) => String.fromCharCode(parseInt(o, 8)))));
        }
        pieces.push(' ');
      }
      const text = pieces.join('').replace(/[ ]{2,}/g, ' ').trim();
      if (text) { chunks.push(text); chars += text.length; }
    }

    if (!chunks.length) {
      return {
        error: 'Текст из PDF извлечь не удалось',
        hint: 'Скорее всего это скан (страницы — картинки) или шрифт с нестандартной кодировкой. ' +
              'Метаданные и структуру файла можно посмотреть режимом hex.',
      };
    }
    const text = chunks.join('\n');
    return {
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
      approximate: true,
    };
  }

  // ── Сырые байты ──
  function hexDump(bytes, { offset = 0, width = 16 } = {}) {
    const lines = [];
    for (let i = 0; i < bytes.length; i += width) {
      const row = bytes.slice(i, i + width);
      const hex = [...row].map(b => b.toString(16).padStart(2, '0')).join(' ');
      const ascii = [...row].map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('');
      lines.push((offset + i).toString(16).padStart(8, '0') + '  ' + hex.padEnd(width * 3 - 1) + '  |' + ascii + '|');
    }
    return lines.join('\n');
  }

  // Байты как строка, где код каждого символа РАВЕН значению байта.
  // Именно так, а не TextDecoder('latin1'): по стандарту «latin1» — это
  // алиас windows-1252, и байты 0x80–0x9F он превращает в другие символы
  // (€, ‚, „ и прочие). Соответствие «байт ↔ код символа» при этом
  // ломается, а вместе с ним — и обратное восстановление байтов, на
  // котором держится разбор строк PDF.
  function binaryString(bytes) {
    let bin = '';
    // Порциями: спред в String.fromCharCode на мегабайтном массиве
    // переполняет стек аргументов.
    const step = 8192;
    for (let i = 0; i < bytes.length; i += step) {
      bin += String.fromCharCode(...bytes.slice(i, i + step));
    }
    return bin;
  }

  function toBase64(bytes) {
    return btoa(binaryString(bytes));
  }

  // ── Описание файла одним объектом ──
  // Принимает НАЧАЛО файла (несколько килобайт) — этого достаточно для
  // сигнатуры и размеров изображения. Для состава архива нужен весь файл,
  // поэтому он разбирается отдельно, когда действительно нужен.
  function describe(head, { name = '', mime = '', size = 0 } = {}) {
    const sig = detect(head);
    const binary = looksBinary(head);

    if (!sig) {
      return {
        kind: binary ? 'binary' : 'text',
        format: binary ? 'неизвестный двоичный' : 'текст',
        mime: mime || (binary ? 'application/octet-stream' : 'text/plain'),
        binary,
        readable: !binary,
      };
    }

    const out = { kind: sig.kind, format: sig.format, mime: sig.mime, binary: true, readable: false };
    if (sig.kind === 'image') {
      const dim = imageSize(head, sig.format);
      if (dim && dim.width) out.image = dim;
    }
    // RTF — двоичный по сигнатуре, но по сути размеченный текст.
    if (sig.format === 'RTF') { out.binary = false; out.readable = true; out.kind = 'document'; }
    return out;
  }

  return {
    detect, looksBinary, imageSize, zipEntries, zipRead, zipFlavor,
    officeText, xlsxText, pdfText, hexDump, toBase64, describe, xmlText,
    // Форматы, из которых умеем доставать текст.
    TEXT_EXTRACTABLE: ['DOCX', 'XLSX', 'PPTX', 'ODF', 'EPUB', 'PDF'],
  };
})();
