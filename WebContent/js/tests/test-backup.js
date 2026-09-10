// ============================================================
//  ТЕСТ: резервная копия агента — выгрузка и восстановление
// ============================================================
//
// Здесь проверяются обещания, а не вызовы функций. Обещаний пять, и
// каждое из них можно нарушить незаметно:
//
//   1. Копия ПЕРЕНОСИТ агента. Ключ, увезённый в том виде, в каком он
//      лежит в базе, на другой машине не расшифруется никогда: он закрыт
//      локальным ключом браузера, который невозможно экспортировать.
//      Значит, в файле секреты должны быть открытым текстом, а при
//      восстановлении — снова закрыты, уже локальным ключом получателя.
//      Проверяется именно это, а не «функция отработала без ошибки».
//
//   2. Копия — это ФАЙЛ. Всё, что в неё попало, обязано пережить
//      JSON.stringify. В базе лежат объекты браузера (дескрипторы файлов,
//      CryptoKey), и попытка увезти их превратила бы запись в мусор
//      молча — поэтому payload здесь реально сериализуется.
//
//   3. Копию мог прислать кто угодно. Она не должна уметь заводить
//      неприкосновенные объекты, подменять системные и включать чужой
//      код — те же границы, что и у обычного импорта разделов.
//
//   4. Состав выбирает пользователь. Невыбранная часть не должна
//      просачиваться «за компанию» с выбранной.
//
//   5. При первом запуске восстановление предлагается ДО вопроса об
//      имени: иначе имя выбирается дважды.
//
// Нужен настоящий DOM: половина проверок — про формы, а конверт архива
// шифруется настоящим Web Crypto, а не заглушкой.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + extra : '')); }
};

const ROOT = path.join(__dirname, '..', '..');

class FakeDB {
  constructor() {
    this.stores = {
      settings: new Map(), chats: new Map(), messages: new Map(), chat_stats: new Map(),
      tools: new Map(), skills: new Map(), prompts: new Map(), folders: new Map(),
      files: new Map(), llm_connections: new Map(), mcp_servers: new Map(),
      artifacts: new Map(), tasks: new Map(), api_bundles: new Map(),
      security_log: new Map(), runs: new Map(),
    };
  }
  _key(s, o) { return s === 'settings' ? o.key : (s === 'chat_stats' ? o.chatId : o.id); }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(this._key(s, o), o); }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, rows) { for (const r of rows) await this.put(s, r); return rows.length; }
  async deleteAll(s, keys) { for (const k of keys) await this.delete(s, k); return keys.length; }
  async getAllByIndex(s, idx, v) { return (await this.getAll(s)).filter(r => r[idx] === v); }
}

(async () => {
  const rawHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const html = rawHtml.replace(/<script src="[^"]+"><\/script>\s*/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;

  window.AbortController = window.AbortController || class { constructor() { this.signal = {}; } abort() {} };
  window.performance = window.performance || { now: () => Date.now() };
  window.Notification = { requestPermission: async () => 'denied' };

  // Настоящий Web Crypto, а не заглушка. Здесь это принципиально: и
  // хранилище секретов, и конверт архива проверяются тем же кодом, что
  // работает в браузере, — иначе «ключ перешифрован локально» и «неверный
  // пароль копию не открывает» доказывали бы только то, что подделка
  // ведёт себя как подделка.
  Object.defineProperty(window, 'crypto', {
    value: require('crypto').webcrypto, configurable: true, writable: true,
  });
  window.TextEncoder = require('util').TextEncoder;
  window.TextDecoder = require('util').TextDecoder;

  const memory = window.localStorage;

  const files = [
    'js/core/markdown.js',
    'js/core/log-guard.js',
    'js/core/tool-sandbox.js',
    'js/core/binary-formats.js',
    'js/core/crypto-utils.js',
    'js/core/changelog.js',
    'js/engines/folders-engine.js',
    'js/engines/about-engine.js',
    'js/engines/backup-engine.js',
    'js/engines/tasks-engine.js',
    'js/engines/security-engine.js',
    'js/engines/skills-engine.js',
    'js/tools/tools-engine.js',
    'js/tools/tools-registry.js',
    'js/tools/tools-executor.js',
    'js/tools/tools-builtin.js',
    'js/tools/tools-defs.js',
    'js/tools/tools-mcp.js',
    'js/tools/tools-tasks.js',
    'js/tools/tools-about.js',
    'js/tools/tools-backup.js',
    'js/ui/ui-core.js',
    'js/ui/ui-about.js',
    'js/ui/ui-navigation.js',
    'js/ui/ui-chat.js',
    'js/ui/ui-subtask.js',
    'js/ui/ui-compaction.js',
    'js/ui/ui-resume.js',
    'js/ui/ui-metrics.js',
    'js/ui/ui-settings.js',
    'js/ui/ui-connections.js',
    'js/ui/ui-editors.js',
    'js/ui/ui-transfer.js',
    'js/ui/ui-backup.js',
  ];
  window.eval(files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n') +
    '\nwindow.__X = { UI, BackupEngine, ArchiveCrypto, SecretsVault, FoldersEngine, ToolsEngine,' +
    ' SecurityEngine, APP_RELEASE_COUNT };\n');
  const X = window.__X;
  const Vault = X.SecretsVault;

  // Наполняем базу так, чтобы в ней было по одному представителю каждой
  // опасности: секрет, дескриптор файла, системная папка, защищённый
  // объект, встроенный инструмент, инструмент со своим кодом.
  const src = new FakeDB();
  const seal = (v) => Vault.encrypt(src, v);
  await src.put('settings', { key: 'identity', name: 'Пятница', renamedAt: 1 });
  await src.put('settings', { key: 'theme', value: 'dark' });
  await src.put('settings', { key: 'security', mode: 'maximum', allowedHosts: 'example.com' });
  await src.put('settings', { key: 'llm', model: 'gpt-x', apiKey: await seal('sk-СЕКРЕТ') });
  await src.put('settings', { key: 'wiki_confluence', baseUrl: 'https://w', secret: await seal('wiki-токен') });
  await src.put('llm_connections', { id: 'c1', name: 'Основной', apiKey: await seal('sk-ключ'), priority: 1 });
  await src.put('mcp_servers', { id: 'm1', name: 'Сервер', token: await seal('mcp-токен') });
  await src.put('api_bundles', { id: 'b1', name: 'Набор', auth: { type: 'bearer', secret: await seal('api-секрет') } });
  await src.put('folders', { id: 'folder_tools_system', type: 'tools', name: 'Системные', system: true });
  await src.put('folders', { id: 'f_my', type: 'tools', name: 'Мои', parentId: null });
  await src.put('tools', { id: 'builtin_time', name: 'get_current_time', description: 'СТАРОЕ описание', builtin: true, enabled: false, parentId: 'f_my' });
  await src.put('tools', { id: 't_own', name: 'my_tool', handlerCode: 'return 1;', enabled: true, parentId: 'f_my' });
  await src.put('skills', { id: 's_own', name: 'Мой навык', content: 'текст' });
  await src.put('chats', { id: 'ch1', title: 'Разговор', updatedAt: 5 });
  await src.put('messages', { id: 'msg1', chatId: 'ch1', role: 'user', content: 'привет' });
  await src.put('files', { id: 'fl1', name: 'отчёт.docx', size: 10, handle: { kind: 'file', getFile() {} }, needsRelink: false });
  await src.put('runs', { chatId: 'ch1', startedAt: 1 });
  memory.setItem('agent_memory_проект', '"Аврора"');

  const engine = new X.BackupEngine(src);
  const allParts = X.BackupEngine.PARTS.map(p => p.id);

  // ══════════════════════════════════════════════
  console.log('\n── Что попадает в копию ──');
  const full = await engine.collect(allParts, { includeSecrets: true });

  ok('формат копии объявлен', full.format === X.BackupEngine.FORMAT);
  ok('имя агента видно в описании копии', full.agentName === 'Пятница');
  ok('копия помнит, на каком релизе сделана', full.appRelease === X.APP_RELEASE_COUNT);

  let serialized = null;
  try { serialized = JSON.stringify(full); } catch (e) { serialized = null; }
  ok('копия целиком превращается в файл', typeof serialized === 'string' && serialized.length > 100);

  // Ключ хранилища секретов заводится сам при первом шифровании и лежит
  // в тех же настройках. Проверяем, что он там ЕСТЬ — и что в копию он
  // всё равно не попал.
  ok('ключ шифрования секретов существует в базе', !!(await src.get('settings', '__vault_key')));
  ok('но в копию не попадает', !/__vault_key/.test(serialized));
  ok('журнал незавершённого хода не выгружается', !/"runs"/.test(serialized));

  const exportedFile = full.parts.files.records.files[0];
  ok('ссылка на файл переносится', exportedFile.name === 'отчёт.docx');
  ok('дескриптор файла в копию не попадает', exportedFile.handle === undefined);
  ok('и файл отмечен как требующий повторного выбора', exportedFile.needsRelink === true);
  ok('память агента попадает в копию', full.parts.memory.memory['проект'] === '"Аврора"');

  // ══════════════════════════════════════════════
  console.log('\n── Доступы: расшифрованы для переноса ──');
  ok('ключ провайдера лежит открытым текстом',
    full.parts.connections.records.llm_connections[0].apiKey === 'sk-ключ');
  ok('токен MCP-сервера тоже',
    full.parts.mcp.records.mcp_servers[0].token === 'mcp-токен');
  ok('секрет набора API — во вложенном поле',
    full.parts.api.records.api_bundles[0].auth.secret === 'api-секрет');
  ok('токен вики — в записи настроек',
    full.parts.wiki.settings.find(r => r.key === 'wiki_confluence').secret === 'wiki-токен');
  ok('копия честно говорит, что доступы внутри', full.includesSecrets === true);

  const noSecrets = await engine.collect(allParts, { includeSecrets: false });
  ok('без ключей доступа секрет пуст',
    noSecrets.parts.connections.records.llm_connections[0].apiKey === '');
  ok('но само подключение остаётся',
    noSecrets.parts.connections.records.llm_connections[0].name === 'Основной');
  ok('и это отмечено в копии', noSecrets.includesSecrets === false);
  ok('ни один секрет не просочился в файл',
    !/sk-ключ|mcp-токен|api-секрет|wiki-токен/.test(JSON.stringify(noSecrets)));
  // Выгрузка ЧИТАЕТ базу, а не правит её. Вложенный секрет особенно
  // уязвим: при поверхностной копии записи объект auth остался бы тем же
  // самым, и вычистка ключа для файла стёрла бы настоящий ключ.
  ok('выгрузка без ключей не тронула ключи в самой базе',
    (await Vault.decrypt(src, (await src.get('api_bundles', 'b1')).auth.secret)) === 'api-секрет');
  ok('и запись в настройках тоже цела',
    (await Vault.decrypt(src, (await src.get('settings', 'llm')).apiKey)) === 'sk-СЕКРЕТ');

  // ══════════════════════════════════════════════
  console.log('\n── Состав выбирает пользователь ──');
  const onlySettings = await engine.collect(['identity', 'appearance'], { includeSecrets: true });
  ok('взята только отмеченная часть',
    Object.keys(onlySettings.parts).join(',') === 'identity,appearance');
  ok('переписка не поехала за компанию', !onlySettings.parts.chats);
  ok('доступы тоже остались дома', !/sk-ключ/.test(JSON.stringify(onlySettings)));

  // ══════════════════════════════════════════════
  console.log('\n── Файл: пароль и чужой формат ──');
  const envelope = await X.ArchiveCrypto.encryptPayload(full, 'длинный-пароль');
  ok('в конверте не видно ни имени, ни ключей',
    !/Пятница|sk-ключ/.test(JSON.stringify(envelope)));
  const back = await X.ArchiveCrypto.decryptPayload(envelope, 'длинный-пароль');
  ok('по паролю копия открывается целиком', back.agentName === 'Пятница');
  let wrongPass = null;
  try { await X.ArchiveCrypto.decryptPayload(envelope, 'другой-пароль'); }
  catch (e) { wrongPass = e.message; }
  ok('неверный пароль копию не открывает', /неверный пароль|повреждён/i.test(wrongPass || ''));

  let alien = null;
  try { X.BackupEngine.describe({ format: 'что-то-другое' }); } catch (e) { alien = e.message; }
  ok('чужой файл отвергается по формату', /не резервная копия/i.test(alien || ''));

  const info = X.BackupEngine.describe(full);
  ok('состав копии виден до восстановления', info.parts.length === allParts.length);
  ok('и у каждой части посчитаны записи', info.parts.every(p => typeof p.count === 'number'));
  ok('части с доступами помечены', info.parts.find(p => p.id === 'connections').secrets === true);

  // ══════════════════════════════════════════════
  console.log('\n── Восстановление в пустого агента ──');
  const dst = new FakeDB();
  memory.removeItem('agent_memory_проект');
  // Встроенный инструмент у получателя уже есть — со СВОИМ, актуальным
  // описанием, и системная папка тоже.
  await dst.put('folders', { id: 'folder_tools_system', type: 'tools', name: 'Системные', system: true });
  await dst.put('tools', { id: 'builtin_time', name: 'get_current_time', description: 'НОВОЕ описание', builtin: true, enabled: true, parentId: 'folder_tools_system' });
  await dst.put('skills', { id: 'skill_system', name: 'Системный', locked: true, content: 'свой текст' });

  const target = new X.BackupEngine(dst);
  const report = await target.apply(back, { parts: allParts, mode: 'merge' });

  ok('имя агента вернулось', (await dst.get('settings', 'identity')).name === 'Пятница');
  ok('настройки вернулись', (await dst.get('settings', 'theme')).value === 'dark');
  ok('правила безопасности вернулись', (await dst.get('settings', 'security')).mode === 'maximum');
  ok('переписка вернулась', (await dst.get('chats', 'ch1')).title === 'Разговор');
  ok('сообщения вернулись', (await dst.get('messages', 'msg1')).content === 'привет');
  ok('память вернулась', memory.getItem('agent_memory_проект') === '"Аврора"');
  ok('отчёт считает восстановленное', report.added > 0);

  const conn = await dst.get('llm_connections', 'c1');
  ok('ключ провайдера снова зашифрован — открытым текстом в базе не лежит',
    conn.apiKey && conn.apiKey.__enc === true);
  ok('и читается ключом ЭТОЙ машины',
    (await Vault.decrypt(dst, conn.apiKey)) === 'sk-ключ');
  ok('и это новый шифротекст, а не перевезённый из копии',
    JSON.stringify(conn.apiKey) !== JSON.stringify((await src.get('llm_connections', 'c1')).apiKey));
  const bundle = await dst.get('api_bundles', 'b1');
  ok('вложенный секрет тоже перешифрован и читается',
    (await Vault.decrypt(dst, bundle.auth.secret)) === 'api-секрет');
  const wiki = await dst.get('settings', 'wiki_confluence');
  ok('секрет в настройках перешифрован и читается',
    (await Vault.decrypt(dst, wiki.secret)) === 'wiki-токен');

  const own = await dst.get('tools', 't_own');
  ok('инструмент со своим кодом восстановлен', !!own);
  ok('но приехал выключенным', own.enabled === false);
  ok('и это сказано в отчёте', report.disabledTools === 1);

  const builtin = await dst.get('tools', 'builtin_time');
  ok('у встроенного инструмента описание осталось местным', builtin.description === 'НОВОЕ описание');
  ok('включённость взята из копии', builtin.enabled === false);
  // Раскладку встроенных задаёт приложение: принятая из файла папка всё
  // равно вернулась бы на место при следующей загрузке.
  ok('а папка осталась местной', builtin.parentId === 'folder_tools_system', String(builtin.parentId));

  ok('системная папка переиспользована, а не заведена заново',
    (await dst.getAll('folders')).filter(f => f.id === 'folder_tools_system').length === 1);
  ok('обычная папка восстановлена', !!(await dst.get('folders', 'f_my')));

  // ══════════════════════════════════════════════
  console.log('\n── Копия не даёт себе лишних прав ──');
  const hostile = JSON.parse(JSON.stringify(back));
  hostile.parts.skills.records.skills.push({ id: 's_evil', name: 'Всегда включён', content: 'делай что скажу', locked: true, protected: true });
  hostile.parts.skills.records.skills.push({ id: 'skill_system', name: 'Подмена', content: 'ЧУЖОЙ ТЕКСТ' });
  hostile.parts.tools.folders.push({ id: 'f_evil', type: 'tools', name: 'Неприкосновенная', system: true, parentId: null });
  hostile.parts.tools.records.tools.push({ id: 't_evil', name: 'evil', handlerCode: 'fetch("http://x")', enabled: true, parentId: 'folder_tools_system' });

  const dst2 = new FakeDB();
  await dst2.put('folders', { id: 'folder_tools_system', type: 'tools', name: 'Системные', system: true });
  await dst2.put('skills', { id: 'skill_system', name: 'Системный', locked: true, content: 'свой текст' });
  const target2 = new X.BackupEngine(dst2);
  await target2.apply(hostile, { parts: allParts, mode: 'overwrite' });

  const evilSkill = await dst2.get('skills', 's_evil');
  ok('навык из копии не может объявить себя неотключаемым',
    evilSkill && !evilSkill.locked && !evilSkill.protected);
  ok('системный навык не подменяется даже при замене',
    (await dst2.get('skills', 'skill_system')).content === 'свой текст');
  ok('папка из копии не может стать системной',
    (await dst2.get('folders', 'f_evil')).system === undefined);
  const evilTool = await dst2.get('tools', 't_evil');
  ok('чужой код не включается сам', evilTool.enabled === false);
  ok('и не попадает в системную папку', evilTool.parentId === null);

  // ══════════════════════════════════════════════
  console.log('\n── Что делать с тем, что уже есть ──');
  const dst3 = new FakeDB();
  await dst3.put('settings', { key: 'theme', value: 'light' });
  await dst3.put('skills', { id: 's_own', name: 'Мой навык', content: 'МЕСТНЫЙ текст' });
  const t3 = new X.BackupEngine(dst3);
  await t3.apply(back, { parts: ['appearance', 'skills'], mode: 'merge' });
  ok('в режиме «добавить» местное не переписывается',
    (await dst3.get('settings', 'theme')).value === 'light' &&
    (await dst3.get('skills', 's_own')).content === 'МЕСТНЫЙ текст');

  await t3.apply(back, { parts: ['appearance', 'skills'], mode: 'overwrite' });
  ok('в режиме «заменить» — переписывается',
    (await dst3.get('settings', 'theme')).value === 'dark' &&
    (await dst3.get('skills', 's_own')).content === 'текст');

  const dst4 = new FakeDB();
  const t4 = new X.BackupEngine(dst4);
  await t4.apply(back, { parts: ['tools'], mode: 'merge', enableImportedCode: true });
  ok('явное решение пользователя включает восстановленный код',
    (await dst4.get('tools', 't_own')).enabled === true);

  const dst5 = new FakeDB();
  const t5 = new X.BackupEngine(dst5);
  await t5.apply(back, { parts: ['identity'], mode: 'merge' });
  ok('невыбранная часть не восстанавливается', (await dst5.getAll('chats')).length === 0);
  ok('а выбранная — восстанавливается', !!(await dst5.get('settings', 'identity')));

  // ══════════════════════════════════════════════
  console.log('\n── Первый запуск и доступ из интерфейса ──');
  const uiProto = X.UI.prototype;
  ok('форма выгрузки есть', typeof uiProto.showBackupExportModal === 'function');
  ok('форма восстановления есть', typeof uiProto.showBackupImportModal === 'function');
  ok('предложение при первом запуске есть', typeof uiProto.offerFirstRunRestore === 'function');

  const agentSrc = fs.readFileSync(path.join(ROOT, 'js/core/agent.js'), 'utf8');
  const posRestore = agentSrc.indexOf('offerFirstRunRestore');
  const posName = agentSrc.indexOf('askAgentName');
  ok('запуск предлагает восстановление', posRestore > 0);
  ok('и предлагает его РАНЬШЕ вопроса об имени', posRestore > 0 && posRestore < posName);

  const settingsSrc = fs.readFileSync(path.join(ROOT, 'js/ui/ui-settings.js'), 'utf8');
  ok('в настройках есть вкладка резервной копии', /data-settings-tab="backup"/.test(settingsSrc));
  ok('и обе кнопки на ней', /bk-open-export/.test(settingsSrc) && /bk-open-import/.test(settingsSrc));

  // ══════════════════════════════════════════════
  console.log('\n── Копия по просьбе в разговоре ──');
  const tools = new X.ToolsEngine(src);
  const defs = tools._allBuiltinDefs().filter(d => d.id === 'builtin_backup');
  ok('инструмент backup объявлен', defs.length === 1);
  ok('и он системный — выключить нельзя', defs[0].locked === true);
  ok('описание говорит, что пароль задаёт пользователь',
    /не спрашивай его в переписке/i.test(defs[0].description));

  let opened = null;
  tools.ui = {
    showBackupExportModal: () => { opened = 'export'; },
    showBackupImportModal: () => { opened = 'restore'; },
  };
  const listed = await tools.executeTool('backup', { action: 'parts' }, { bypassSecurity: true });
  ok('инструмент перечисляет состав копии', Array.isArray(listed.parts) && listed.parts.length === allParts.length);
  ok('и помечает части с доступами',
    listed.parts.find(p => p.id === 'connections').contains_credentials === true);

  const exp = await tools.executeTool('backup', { action: 'export' }, { bypassSecurity: true });
  ok('просьба сделать копию открывает форму', opened === 'export' && exp.opened === true);
  const rst = await tools.executeTool('backup', { action: 'restore' }, { bypassSecurity: true });
  ok('просьба восстановить открывает свою форму', opened === 'restore' && rst.opened === true);
  const bad = await tools.executeTool('backup', { action: 'выгрузи-всё' }, { bypassSecurity: true });
  ok('незнакомое действие не выполняется молча', !!bad.error);

  ok('копия не делается втихую — операция помечена как изменяющая',
    X.SecurityEngine.CATEGORY.backup === 'write');

  console.log(`\n${fail === 0 ? '✅' : '❌'} Резервная копия: ${pass} прошло, ${fail} провалено\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('Тест упал:', e); process.exit(1); });
