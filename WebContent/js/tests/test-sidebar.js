// ============================================================
//  ТЕСТ: переименование чатов и копирование названий
// ============================================================
//
// Две мелкие возможности, у которых есть неочевидные обязательства:
//   • переименованный чат не должен «переименовываться обратно» при
//     следующем сообщении — автозаголовок обязан отступить;
//   • кнопки в строке чата не должны заодно открывать этот чат: раньше
//     обработчик пропускал только кнопку удаления, и любая новая ловила
//     бы клик дважды;
//   • копирование должно работать и без защищённого контекста (http://),
//     где navigator.clipboard недоступен, и говорить, ЧТО скопировано, —
//     иначе промах мимо мелкой кнопки не отличить от успеха.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + extra : '')); }
};

const ROOT = path.join(__dirname, '..', '..');
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

class FakeDB {
  constructor() {
    this.stores = { settings: new Map(), tools: new Map(), skills: new Map(), folders: new Map(),
      prompts: new Map(), chats: new Map(), messages: new Map(), files: new Map(),
      mcp_servers: new Map(), security_log: new Map(), api_bundles: new Map(),
      artifacts: new Map(), tasks: new Map(), chat_stats: new Map(), runs: new Map() };
  }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(o.key ?? o.id ?? o.chatId, o); }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, o) { for (const x of o) await this.put(s, x); return o.length; }
  async deleteAll(s, keys) { for (const k of keys) await this.delete(s, k); return keys.length; }
  async getAllByIndex(s, i, v) { return (await this.getAll(s)).filter(r => r[i] === v); }
}

(async () => {
  const rawHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const html = rawHtml.replace(/<script src="[^"]+"><\/script>\s*/g, '');
  const dom = new JSDOM(html, { url: 'https://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const document = window.document;
  window.performance = window.performance || { now: () => Date.now() };
  window.SecretsVault = { encrypt: async (_d, v) => v || '', decrypt: async (_d, v) => v || '' };

  const files = [
    'js/core/markdown.js', 'js/core/log-guard.js', 'js/core/tool-sandbox.js', 'js/core/binary-formats.js',
    'js/engines/folders-engine.js', 'js/engines/security-engine.js', 'js/engines/skills-engine.js',
    'js/engines/api-import-engine.js', 'js/engines/prompts-library.js',
    'js/tools/tools-engine.js', 'js/tools/tools-registry.js', 'js/tools/tools-executor.js',
    'js/tools/tools-builtin.js', 'js/tools/tools-defs.js', 'js/tools/tools-mcp.js',
    'js/ui/ui-core.js', 'js/ui/ui-about.js', 'js/ui/ui-navigation.js', 'js/ui/ui-chat.js',
    'js/ui/ui-subtask.js', 'js/ui/ui-compaction.js', 'js/ui/ui-resume.js', 'js/ui/ui-metrics.js',
    'js/ui/ui-settings.js', 'js/ui/ui-connections.js', 'js/ui/ui-editors.js', 'js/ui/ui-transfer.js',
  ];
  window.eval(files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n') +
    '\nwindow.__X = { UI, FoldersEngine, SkillsEngine, ToolsEngine, SecurityEngine, PromptsLibrary };\n');
  const X = window.__X;

  const db = new FakeDB();
  const folders = new X.FoldersEngine(db);
  await folders.ensureSeeded();
  const tools = new X.ToolsEngine(db);
  tools.folders = folders;
  tools.security = null;
  await tools.loadTools();

  // ── Данные ──
  await db.put('chats', { id: 'c1', title: 'Чат 05.09, 10:00', createdAt: 1, updatedAt: 100 });
  await db.put('chats', { id: 'c2', title: 'Разбор логов', createdAt: 2, updatedAt: 50 });
  const chatFolder = await folders.create('chats', 'Работа', null);

  const fileRec = { id: 'f1', name: 'отчёт.docx', size: 1024, mime: '', parentId: null, addedAt: 1 };
  await db.put('files', fileRec);

  const agent = {
    db, folders, tools,
    skills: new X.SkillsEngine(db),
    prompts: new X.PromptsLibrary(db),
    files: {
      all: async () => (await db.getAll('files')),
      statusOf: async () => 'ready',
      describe: async () => ({ format: 'DOCX', binary: true, textExtractable: true, size: 1024 }),
      pathOf: async (r) => r.name,
    },
    llm: { isConfigured: () => false, model: 'm' },
    models: { allModels: () => [], describe: () => null },
    tasks: { active: async () => null },
    about: { name: 'Ада', label: 'Ада', releaseCount: () => 1, unread: async () => [], latest: () => null },
    security: new X.SecurityEngine(),
  };

  const ui = new X.UI(agent);
  ui.updateChatToolbar = async () => {};
  ui.updateModelDisplay = () => {};
  ui.applyPanelDensity();

  // ══════════════════════════════════════════════
  console.log('\n── Переименование чата ──');

  // Подменяем окно ввода: сам диалог проверен в test-modals, здесь важен
  // результат переименования, а не то, как спросили.
  let answer = null;
  ui._prompt = async () => answer;

  answer = '  Разбор   логов прокси  ';
  const renamed = await ui.renameChat('c1');
  ok('чат переименован', (await db.get('chats', 'c1')).title === 'Разбор логов прокси', renamed);
  ok('лишние пробелы схлопнуты', !/\s{2}/.test((await db.get('chats', 'c1')).title));
  ok('поставлена отметка «название задал человек»',
     (await db.get('chats', 'c1')).titleSetByUser === true);

  answer = null;
  await ui.renameChat('c1');
  ok('отмена ничего не меняет', (await db.get('chats', 'c1')).title === 'Разбор логов прокси');
  answer = '    ';
  await ui.renameChat('c1');
  ok('пустое имя не применяется', (await db.get('chats', 'c1')).title === 'Разбор логов прокси');
  answer = 'я'.repeat(500);
  await ui.renameChat('c1');
  ok('длина ограничена', (await db.get('chats', 'c1')).title.length === 200);
  ok('несуществующий чат не роняет вызов', (await ui.renameChat('нет-такого')) === null);

  // Главное обязательство: автозаголовок больше не перебивает ручное имя.
  // Условие живёт в sendMessage — проверяем его на настоящей записи чата.
  const named = await db.get('chats', 'c1');
  const autoWouldRename = !named.titleSetByUser && /^Чат \d|^Новый чат$/.test(named.title || '');
  ok('следующее сообщение не переименует чат обратно', autoWouldRename === false);
  const fresh = await db.get('chats', 'c2');
  ok('а чат с автоназванием автозаголовок ещё может тронуть',
     !fresh.titleSetByUser);

  // ══════════════════════════════════════════════
  console.log('\n── Кнопки в списке чатов ──');
  answer = 'Переименовано кнопкой';
  ui.currentTab = 'chat';
  await ui.refreshSidebar();
  const chatRow = document.querySelector('.chat-item[data-id="c1"]');
  ok('строка чата отрисована', !!chatRow);
  ok('есть кнопка переименования', !!chatRow.querySelector('[data-rename-chat="c1"]'));
  ok('есть кнопка копирования названия', !!chatRow.querySelector('[data-copy-name]'));
  ok('кнопка удаления на месте', !!chatRow.querySelector('[data-delete="c1"]'));

  // Клик по кнопке не должен заодно открывать чат.
  let opened = null;
  ui.loadChat = async (id) => { opened = id; };
  chatRow.querySelector('[data-rename-chat="c1"]').click();
  await tick(10);
  ok('нажатие ✏ переименовывает', (await db.get('chats', 'c1')).title === 'Переименовано кнопкой');
  ok('и НЕ открывает чат заодно', opened === null, String(opened));

  chatRow.querySelector('[data-copy-name]').click();
  await tick();
  ok('нажатие ⧉ тоже не открывает чат', opened === null);

  // А клик по самой строке — открывает.
  document.querySelector('.chat-item[data-id="c2"] .title').click();
  await tick();
  ok('клик по строке по-прежнему открывает чат', opened === 'c2');

  await ui.refreshSidebar();
  ok('в кнопке копирования лежит АКТУАЛЬНОЕ название',
     document.querySelector('.chat-item[data-id="c1"] [data-copy-name]').dataset.copyName === 'Переименовано кнопкой');

  // ══════════════════════════════════════════════
  console.log('\n── Копирование в буфер ──');
  const clip = [];
  window.navigator.clipboard = { writeText: async (t) => { clip.push(t); } };
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });

  const okCopy = await ui.copyName('Разбор логов', { label: 'Название чата' });
  ok('копирование сообщает об успехе', okCopy === true);
  ok('текст попал в буфер', clip[clip.length - 1] === 'Разбор логов');
  const toast = document.querySelector('#toast-host .toast');
  ok('показано уведомление', !!toast);
  ok('и в нём видно, ЧТО скопировано', /Разбор логов/.test(toast.textContent), toast && toast.textContent);
  ok('и какого рода это название', /Название чата/.test(toast.textContent));

  ok('пустое имя не копируется', (await ui.copyName('')) === false);
  ok('и буфер при этом не тронут', clip[clip.length - 1] === 'Разбор логов');

  const long = 'ф'.repeat(200);
  await ui.copyName(long);
  ok('длинное название копируется целиком', clip[clip.length - 1] === long);
  const lastToast = [...document.querySelectorAll('#toast-host .toast')].pop();
  ok('но в уведомлении обрезается', lastToast.textContent.length < 120, String(lastToast.textContent.length));

  // Браузер без Clipboard API (или страница по http://): должен
  // отработать запасной путь через скрытое поле, а не молча ничего не
  // сделать. Убираем сам clipboard — это и есть тот случай.
  const savedClipboard = window.navigator.clipboard;
  delete window.navigator.clipboard;
  let execCalled = false;
  document.execCommand = () => { execCalled = true; return true; };
  const okFallback = await ui.copyName('Без Clipboard API');
  ok('без Clipboard API копирование всё равно работает', okFallback === true && execCalled);
  ok('и запасной путь не оставляет мусора в документе',
     !document.querySelector('textarea[style*="opacity"]'));

  document.execCommand = () => false;
  const failed = await ui.copyName('Не выйдет');
  ok('отказ буфера не молчит', failed === false);
  ok('и объяснён пользователю',
     /Не удалось скопировать/.test([...document.querySelectorAll('#toast-host .toast')].pop().textContent));
  window.navigator.clipboard = savedClipboard;

  // ══════════════════════════════════════════════
  console.log('\n── Кнопки копирования по разделам ──');

  const copyBtnOf = (root) => root && root.querySelector('[data-copy-name]');

  // Папка в дереве чатов.
  ui.currentTab = 'chat';
  await ui.refreshSidebar();
  const chatFolderRow = document.querySelector(`[data-folder-id="${chatFolder.id}"]`);
  ok('у папки чатов есть копирование', !!copyBtnOf(chatFolderRow));
  ok('копируется имя папки', copyBtnOf(chatFolderRow).dataset.copyName === 'Работа');

  // Папка в дереве раздела Tools.
  ui.currentTab = 'tools';
  await ui._renderSidebarTree('tools');
  const sysFolderRow = document.querySelector('[data-folder-id="folder_tools_system"]');
  ok('у системной папки тоже есть копирование', !!copyBtnOf(sysFolderRow));
  ok('и оно доступно, хотя папку нельзя ни переименовать, ни удалить',
     copyBtnOf(sysFolderRow).dataset.copyName === 'Системные' &&
     !sysFolderRow.querySelector('[data-ren]'));

  // Карточка инструмента: подробная и компактная.
  ui.folderSelection.tools = 'folder_tools_system';
  ui.panelCompact.tools = false;
  await ui.renderTools();
  const toolCard = document.querySelector('#tools-grid .tool-card');
  ok('у карточки инструмента есть копирование имени', !!copyBtnOf(toolCard));
  const toolName = toolCard.querySelector('.tool-name').textContent.replace(/[🔒🧩\s]/g, '');
  ok('копируется ровно имя инструмента, без значков',
     copyBtnOf(toolCard).dataset.copyName === toolName, copyBtnOf(toolCard).dataset.copyName);
  ok('в подписи сказано, что это имя инструмента',
     copyBtnOf(toolCard).dataset.copyLabel === 'Имя инструмента');

  ui.panelCompact.tools = true;
  await ui.renderTools();
  const compactRow = document.querySelector('#tools-grid .compact-row');
  ok('в компактном виде копирование тоже есть', !!copyBtnOf(compactRow));
  ok('и переключатель никуда не делся', !!compactRow.querySelector('input[data-toggle]'));

  // Клик по кнопке копирования в компактной строке не должен открывать
  // редактор инструмента (имя рядом кликабельно).
  let editorOpened = false;
  ui.showAddToolModal = () => { editorOpened = true; };
  copyBtnOf(compactRow).click();
  await tick();
  ok('копирование в компактной строке не открывает редактор', editorOpened === false);

  // Карточка файла.
  ui.currentTab = 'files';
  ui.folderSelection.files = null;
  await ui.renderFiles();
  const fileCard = document.querySelector('#files-container .file-card');
  ok('у карточки файла есть копирование', !!copyBtnOf(fileCard));
  ok('копируется имя файла', copyBtnOf(fileCard).dataset.copyName === 'отчёт.docx');
  ok('подпись говорит, что это имя файла', copyBtnOf(fileCard).dataset.copyLabel === 'Имя файла');

  // Обработчик один на всё приложение — проверяем, что он и правда
  // срабатывает на кнопке в панели, а не только в дереве.
  clip.length = 0;
  fileCard.querySelector('[data-copy-name]').click();
  await tick();
  ok('нажатие на карточке действительно копирует', clip[0] === 'отчёт.docx', JSON.stringify(clip));

  console.log('\n==============================================');
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('==============================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
