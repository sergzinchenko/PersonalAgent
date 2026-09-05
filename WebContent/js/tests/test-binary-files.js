// ============================================================
//  ТЕСТ: работа с двоичными файлами из вкладки «Файлы»
// ============================================================
//
// Обещание: файл в списке можно использовать, а не только увидеть.
// Проверяется по слоям, от дешёвого к дорогому:
//   • ЧТО ЭТО — формат по сигнатуре (не по расширению), размеры картинки,
//     состав архива;
//   • ЧТО ВНУТРИ — текст из docx/xlsx/pptx/odt и pdf;
//   • СЫРЫЕ БАЙТЫ — hex и base64 порциями;
//   • и что всё это доступно агенту через read_file и search_files.
//
// ZIP в тесте собирается вручную, байт в байт: так проверяется настоящий
// разборщик центрального каталога, а не заглушка вокруг него.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + extra : '')); }
};

const ROOT = path.join(__dirname, '..', '..');

class FakeDB {
  constructor() {
    this.stores = { settings: new Map(), tools: new Map(), skills: new Map(), folders: new Map(),
      prompts: new Map(), chats: new Map(), messages: new Map(), files: new Map(),
      mcp_servers: new Map(), security_log: new Map(), api_bundles: new Map(),
      artifacts: new Map(), tasks: new Map() };
  }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(o.key ?? o.id, o); }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, o) { for (const x of o) await this.put(s, x); return o.length; }
  async deleteAll(s, keys) { for (const k of keys) await this.delete(s, k); return keys.length; }
  async getAllByIndex(s, i, v) { return (await this.getAll(s)).filter(r => r[i] === v); }
}

// ── Сборка ZIP вручную ──
// deflate берём из zlib, чтобы проверить и путь со сжатием: именно так
// устроены настоящие docx, и именно он ломается, если распаковка
// недоступна.
function makeZip(files, { compress = false } = {}) {
  const enc = new TextEncoder();
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };

  const chunks = [];
  const central = [];
  let offset = 0;
  const u16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
  const u32 = (v) => [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF];

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = typeof content === 'string' ? enc.encode(content) : content;
    const data = compress ? new Uint8Array(zlib.deflateRawSync(Buffer.from(raw))) : raw;
    const method = compress ? 8 : 0;
    const crc = crc32(raw);

    const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(raw.length), ...u16(nameBytes.length), ...u16(0)];
    chunks.push(new Uint8Array(local), nameBytes, data);

    central.push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(data.length), ...u32(raw.length), ...u16(nameBytes.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)], nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }

  const centralStart = offset;
  const centralChunks = [];
  let centralSize = 0;
  for (let i = 0; i < central.length; i += 2) {
    const head = new Uint8Array(central[i]);
    centralChunks.push(head, central[i + 1]);
    centralSize += head.length + central[i + 1].length;
  }
  const eocd = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(Object.keys(files).length), ...u16(Object.keys(files).length),
    ...u32(centralSize), ...u32(centralStart), ...u16(0)]);

  const all = [...chunks, ...centralChunks, eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

const DOCX_XML = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
  '<w:p><w:r><w:t>Договор поставки</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>Сумма: 100 руб.</w:t></w:r></w:p>' +
  '</w:body></w:document>';

const XLSX_SHARED = '<?xml version="1.0"?><sst><si><t>Товар</t></si><si><t>Цена</t></si><si><t>Гвозди</t></si></sst>';
const XLSX_SHEET = '<?xml version="1.0"?><worksheet><sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
  '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>' +
  '<row r="3"></row></sheetData></worksheet>';

(async () => {
  const rawHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const html = rawHtml.replace(/<script src="[^"]+"><\/script>\s*/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  window.performance = window.performance || { now: () => Date.now() };
  window.SecretsVault = { encrypt: async (_d, v) => v || '', decrypt: async (_d, v) => v || '' };
  // Распаковка — штатный механизм браузера; в jsdom его нет, приносим
  // из Node. Node 20 знает 'deflate' и 'gzip', но не 'deflate-raw' —
  // именно тот, в котором лежат записи ZIP (в браузерах он есть с
  // Chrome 103 / Firefox 113 / Safari 16.4). Поэтому при его отсутствии
  // подставляем равнозначную обёртку над zlib: проверяется наш путь
  // разбора, а не поддержка формата в конкретной сборке Node.
  const rawSupported = (() => {
    try { new DecompressionStream('deflate-raw'); return true; } catch (_) { return false; }
  })();
  window.DecompressionStream = rawSupported ? DecompressionStream : class {
    constructor(format) {
      const parts = [];
      const inflate = format === 'deflate-raw' ? zlib.inflateRawSync
        : format === 'gzip' ? zlib.gunzipSync : zlib.inflateSync;
      const ts = new TransformStream({
        transform(chunk) { parts.push(Buffer.from(chunk)); },
        flush(ctrl) { ctrl.enqueue(new Uint8Array(inflate(Buffer.concat(parts)))); },
      });
      this.readable = ts.readable;
      this.writable = ts.writable;
    }
  };
  // jsdom не приносит эти глобальные объекты в окно, а разбор двоичных
  // данных без них невозможен: в браузере они есть всегда.
  window.TextDecoder = window.TextDecoder || TextDecoder;
  window.TextEncoder = window.TextEncoder || TextEncoder;
  window.DataView = window.DataView || DataView;
  // Blob у jsdom без stream(), а распаковка идёт именно через поток —
  // берём реализацию Node (в браузере stream() есть у Blob всегда).
  window.Blob = Blob;
  window.Response = Response;
  window.File = File;   // у jsdom slice() возвращает Blob без arrayBuffer()
  window.btoa = window.btoa || ((s) => Buffer.from(s, 'binary').toString('base64'));

  const files = [
    'js/core/markdown.js', 'js/core/log-guard.js', 'js/core/tool-sandbox.js', 'js/core/binary-formats.js',
    'js/engines/folders-engine.js', 'js/engines/files-engine.js', 'js/engines/security-engine.js',
    'js/engines/skills-engine.js',
    'js/tools/tools-engine.js', 'js/tools/tools-registry.js', 'js/tools/tools-executor.js',
    'js/tools/tools-builtin.js', 'js/tools/tools-defs.js', 'js/tools/tools-mcp.js',
  ];
  window.eval(files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n') +
    '\nwindow.__X = { BinaryFormats, FilesEngine, FoldersEngine, ToolsEngine };\n');
  const X = window.__X;
  const BF = X.BinaryFormats;

  const bytes = (...b) => new Uint8Array(b);

  // ══════════════════════════════════════════════
  console.log('\n── Формат по сигнатуре, а не по расширению ──');
  ok('PNG узнан', BF.detect(bytes(0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10)).format === 'PNG');
  ok('JPEG узнан', BF.detect(bytes(0xFF, 0xD8, 0xFF, 0xE0)).format === 'JPEG');
  ok('GIF узнан', BF.detect(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)).format === 'GIF');
  ok('PDF узнан', BF.detect(bytes(0x25, 0x50, 0x44, 0x46, 0x2D)).format === 'PDF');
  ok('ZIP узнан', BF.detect(bytes(0x50, 0x4B, 0x03, 0x04)).format === 'ZIP');
  ok('EXE узнан', BF.detect(bytes(0x4D, 0x5A, 0x90)).format === 'EXE/DLL');
  const webp = new Uint8Array(16);
  webp.set([...'RIFF'].map(c => c.charCodeAt(0)), 0);
  webp.set([...'WEBP'].map(c => c.charCodeAt(0)), 8);
  ok('WEBP узнан по метке, а не по началу', BF.detect(webp).format === 'WEBP');
  const mp4 = new Uint8Array(16);
  mp4.set([...'ftypisom'].map(c => c.charCodeAt(0)), 4);
  ok('MP4 узнан по ftyp', BF.detect(mp4).format === 'MP4');
  ok('обычный текст сигнатуры не имеет', BF.detect(new TextEncoder().encode('привет, мир')) === null);

  console.log('\n── Двоичный или текстовый ──');
  ok('текст не считается двоичным', BF.looksBinary(new TextEncoder().encode('строка\nвторая\tтабуляция')) === false);
  ok('нулевой байт выдаёт двоичный', BF.looksBinary(bytes(1, 2, 0, 3)) === true);
  ok('UTF-8 с кириллицей — текст', BF.looksBinary(new TextEncoder().encode('Ёжик в тумане')) === false);
  ok('поток управляющих байтов — двоичный',
     BF.looksBinary(new Uint8Array(200).fill(0x01)) === true);

  console.log('\n── Размеры изображения из заголовка ──');
  const png = new Uint8Array(30);
  png.set([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10]);
  new DataView(png.buffer).setUint32(16, 1920);
  new DataView(png.buffer).setUint32(20, 1080);
  ok('размеры PNG прочитаны', JSON.stringify(BF.imageSize(png, 'PNG')) === '{"width":1920,"height":1080}');
  const gif = new Uint8Array(16);
  gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  new DataView(gif.buffer).setUint16(6, 640, true);
  new DataView(gif.buffer).setUint16(8, 480, true);
  ok('размеры GIF прочитаны', JSON.stringify(BF.imageSize(gif, 'GIF')) === '{"width":640,"height":480}');
  ok('обрезанный заголовок не роняет разбор', BF.imageSize(bytes(0x89, 0x50), 'PNG') === null);

  // ══════════════════════════════════════════════
  console.log('\n── ZIP: состав и чтение записей ──');
  const zipStored = makeZip({ 'a.txt': 'первый файл', 'dir/b.txt': 'второй' });
  const parsed = BF.zipEntries(zipStored);
  ok('записи найдены', !parsed.error && parsed.entries.length === 2, JSON.stringify(parsed.error || ''));
  ok('имена с путями сохранены', parsed.entries.map(e => e.name).join(',') === 'a.txt,dir/b.txt');
  const readA = await BF.zipRead(zipStored, parsed.entries[0]);
  ok('несжатая запись читается', new TextDecoder().decode(readA.data) === 'первый файл');

  const zipDeflated = makeZip({ 'c.txt': 'сжатое содержимое'.repeat(20) }, { compress: true });
  const parsedD = BF.zipEntries(zipDeflated);
  const readC = await BF.zipRead(zipDeflated, parsedD.entries[0]);
  ok('сжатая запись распаковывается',
     !readC.error && new TextDecoder().decode(readC.data).startsWith('сжатое содержимое'),
     JSON.stringify(readC.error || ''));
  ok('обрезанный архив объяснён', !!BF.zipEntries(bytes(0x50, 0x4B, 0x03, 0x04, 1, 2, 3)).error);

  console.log('\n── Что за ZIP ──');
  const docx = makeZip({ '[Content_Types].xml': '<x/>', 'word/document.xml': DOCX_XML }, { compress: true });
  ok('docx отличается от простого архива',
     BF.zipFlavor(BF.zipEntries(docx).entries).format === 'DOCX');
  const xlsx = makeZip({ 'xl/workbook.xml': '<x/>', 'xl/sharedStrings.xml': XLSX_SHARED,
    'xl/worksheets/sheet1.xml': XLSX_SHEET }, { compress: true });
  ok('xlsx отличается', BF.zipFlavor(BF.zipEntries(xlsx).entries).format === 'XLSX');
  ok('обычный ZIP не притворяется документом', BF.zipFlavor(parsed.entries) === null);

  console.log('\n── Текст из документов ──');
  const docxText = await BF.officeText(docx, 'DOCX');
  ok('текст docx извлечён', /Договор поставки/.test(docxText.text), JSON.stringify(docxText).slice(0, 200));
  ok('абзацы разделены', /Договор поставки\n[\s\S]*Сумма/.test(docxText.text));
  ok('разметка выброшена', !/<w:/.test(docxText.text));

  const xlsxText = await BF.xlsxText(xlsx, BF.zipEntries(xlsx));
  ok('строки таблицы подставлены из общего словаря', /Товар\tЦена/.test(xlsxText.text), xlsxText.text);
  ok('числовые ячейки сохранены', /Гвозди\t42/.test(xlsxText.text));
  ok('пустые строки не выводятся', !/\n\n/.test(xlsxText.text.split('---')[1] || ''));

  const pptx = makeZip({ 'ppt/slides/slide1.xml': '<p:sld><a:t>Заголовок слайда</a:t></p:sld>' }, { compress: true });
  ok('текст pptx извлечён', /Заголовок слайда/.test((await BF.officeText(pptx, 'PPTX')).text));

  const odt = makeZip({ 'mimetype': 'application/vnd.oasis.opendocument.text',
    'content.xml': '<office><text:p>Открытый формат</text:p></office>' });
  ok('текст odt извлечён', /Открытый формат/.test((await BF.officeText(odt, 'ODF')).text));

  console.log('\n── PDF ──');
  const pdfSrc = '%PDF-1.4\n1 0 obj\n<< /Length 60 >>\nstream\n' +
    'BT /F1 12 Tf (Счёт на оплату) Tj [(номер) -20 (17)] TJ ET\n' +
    'endstream\nendobj\ntrailer\n%%EOF';
  const pdfText = await BF.pdfText(new TextEncoder().encode(pdfSrc));
  ok('текст из несжатого PDF извлечён', /Счёт на оплату/.test(pdfText.text || ''), JSON.stringify(pdfText).slice(0, 200));
  ok('извлечение помечено как приблизительное', pdfText.approximate === true);
  const emptyPdf = await BF.pdfText(new TextEncoder().encode('%PDF-1.4\n%%EOF'));
  ok('скан объяснён, а не отдан пустым', !!emptyPdf.error && /скан/.test(emptyPdf.hint || ''));

  console.log('\n── Сырые байты ──');
  const dump = BF.hexDump(bytes(0x50, 0x4B, 0x03, 0x04, 0x41, 0x42));
  ok('hex-дамп содержит смещение, байты и ascii',
     /^00000000  50 4b 03 04 41 42/.test(dump) && /\|PK\.\.AB\|/.test(dump), dump);
  ok('base64 считается', BF.toBase64(new TextEncoder().encode('привет')) ===
     Buffer.from('привет', 'utf8').toString('base64'));
  ok('большой массив не роняет base64', BF.toBase64(new Uint8Array(100000)).length > 100000);

  // ══════════════════════════════════════════════
  console.log('\n── Ссылки на файлы: описание и чтение ──');
  const db = new FakeDB();
  const filesEngine = new X.FilesEngine(db);

  const addFile = async (name, data, mime) => {
    const file = new window.File([data], name, { type: mime || '' });
    const rec = await filesEngine.register({ file, note: '' });
    return rec;
  };

  const recDocx = await addFile('договор.docx', docx,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const recPng = await addFile('схема.png', png, 'image/png');
  const recTxt = await addFile('заметки.txt', new TextEncoder().encode('обычный текст, читается как есть'), 'text/plain');
  const recBin = await addFile('данные.bin', new Uint8Array([0, 1, 2, 3, 0, 255, 128]), '');

  const infoDocx = await filesEngine.describe(recDocx.id);
  ok('docx распознан как документ', infoDocx.format === 'DOCX' && infoDocx.kind === 'document',
     JSON.stringify(infoDocx).slice(0, 200));
  ok('и помечен как «текст извлекается»', infoDocx.textExtractable === true);
  ok('виден состав контейнера', Array.isArray(infoDocx.contains) && infoDocx.contains.includes('word/document.xml'));

  const infoPng = await filesEngine.describe(recPng.id);
  ok('png распознан с размерами', infoPng.format === 'PNG' && infoPng.image.width === 1920);
  ok('и помечен как двоичный без текста', infoPng.binary === true && infoPng.textExtractable === false);

  const infoTxt = await filesEngine.describe(recTxt.id);
  ok('текстовый файл не считается двоичным', infoTxt.binary === false && infoTxt.readable === true);

  const infoBin = await filesEngine.describe(recBin.id);
  ok('неизвестный двоичный назван честно', infoBin.binary === true && /неизвестн/.test(infoBin.format));

  const chunk = await filesEngine.readBytes(recBin.id, { offset: 2, length: 3 });
  ok('байты читаются с середины', Array.from(chunk.bytes).join(',') === '2,3,0');
  ok('и видно, что файл не кончился', chunk.eof === false);

  const ex = await filesEngine.extractText(recDocx.id);
  ok('текст docx достаётся по ссылке', /Договор поставки/.test(ex.text));
  const exPng = await filesEngine.extractText(recPng.id);
  ok('из картинки текст не выдумывается', !!exPng.error && /PNG/.test(exPng.error));

  // ══════════════════════════════════════════════
  console.log('\n── Инструмент read_file ──');
  const folders = new X.FoldersEngine(db);
  await folders.ensureSeeded();
  const tools = new X.ToolsEngine(db);
  tools.files = filesEngine;
  tools.folders = folders;
  tools.security = null;
  tools.ui = { refreshSidebar() {}, renderTools() {}, renderSkills() {}, renderPrompts() {}, updateChatToolbar() {} };
  await tools.loadTools();

  const rInfo = await tools.executeTool('read_file', { file: 'схема.png', mode: 'info' });
  ok('mode=info возвращает формат и размеры', rInfo.format === 'PNG' && rInfo.image.width === 1920);

  const rAutoBin = await tools.executeTool('read_file', { file: 'данные.bin' });
  ok('двоичный файл не отдаётся мусорным текстом', rAutoBin.content === undefined && rAutoBin.mode === 'info');
  ok('и сказано, чем его смотреть', /hex|base64/.test(rAutoBin.note || ''));

  const rAutoDoc = await tools.executeTool('read_file', { file: 'договор.docx' });
  ok('документ сам отдаётся извлечённым текстом',
     /Договор поставки/.test(rAutoDoc.content || ''), JSON.stringify(rAutoDoc).slice(0, 200));
  ok('и помечен, что это извлечение', rAutoDoc.mode === 'extract' && /извлечён/.test(rAutoDoc.note));

  const rText = await tools.executeTool('read_file', { file: 'заметки.txt' });
  ok('текстовый файл читается как прежде', /обычный текст/.test(rText.content || ''));

  const rHex = await tools.executeTool('read_file', { file: 'данные.bin', mode: 'hex' });
  ok('mode=hex даёт дамп', /00 01 02 03/.test(rHex.hex || ''), rHex.hex);
  ok('видно, что файл кончился', rHex.eof === true);

  const rB64 = await tools.executeTool('read_file', { file: 'заметки.txt', mode: 'base64', maxBytes: 8 });
  ok('mode=base64 отдаёт кусок', typeof rB64.base64 === 'string' && rB64.returnedBytes === 8);
  ok('и подсказывает, как продолжить', /offset=8/.test(rB64.note || ''));

  const rBad = await tools.executeTool('read_file', { file: 'схема.png', mode: 'extract' });
  ok('принудительное извлечение из картинки объяснено', !!rBad.error && /hex/.test(rBad.hint || ''));

  const rForce = await tools.executeTool('read_file', { file: 'заметки.txt', mode: 'text' });
  ok('mode=text работает как раньше', /обычный текст/.test(rForce.content || ''));

  console.log('\n── Поиск внутри документов ──');
  const found = await tools.executeTool('search_files', { query: 'Договор' });
  ok('текст найден внутри docx', found.matches === 1 && /docx/i.test(found.results[0].file), JSON.stringify(found).slice(0, 300));
  ok('помечено, что искали в извлечённом тексте', found.results[0].extracted === true);
  ok('формат указан', found.results[0].format === 'DOCX');

  const foundTxt = await tools.executeTool('search_files', { query: 'обычный текст' });
  ok('в текстовых файлах поиск работает как прежде', foundTxt.matches === 1);
  ok('картинки пропущены с указанием причины',
     (foundTxt.skipped || []).some(s => /двоичный/.test(s.reason)));

  const noDocs = await tools.executeTool('search_files', { query: 'Договор', includeDocuments: false });
  ok('документы можно исключить из поиска', noDocs.matches === 0);

  console.log('\n==============================================');
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('==============================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
