// Интеграционный тест: проверяем, что разбитый на модули ToolsEngine
// собирается в работающий класс, встроенные инструменты на месте, а
// инструменты llm_* делают то, что заявлено.
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? ' → ' + e : '')); } };

class FakeDB {
  constructor() { this.stores = { settings: new Map(), llm_connections: new Map(), tools: new Map(), folders: new Map(), chats: new Map(), files: new Map(), mcp_servers: new Map() }; }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(o.key ?? o.id, o); }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, o) { for (const x of o) await this.put(s, x); return o.length; }
  async deleteAll(s, keys) { for (const k of keys) await this.delete(s, k); return keys.length; }
}

const sandbox = {
  console, setTimeout, clearTimeout, Date, Math, JSON, Promise, URL, TypeError, Error,
  Map, Set, Array, Object, String, Number, Boolean, RegExp, Intl, TextEncoder, TextDecoder,
  performance: { now: () => Date.now() },
  SecretsVault: { encrypt: async (_d, v) => v || '', decrypt: async (_d, v) => v || '' },
  fetch: async () => { throw new TypeError('сеть недоступна в тесте'); },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  crypto: { getRandomValues: (a) => a, randomUUID: () => 'uuid' },
  localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { createElement: () => ({ style: {}, click: () => {} }), body: { appendChild: () => {}, removeChild: () => {} } },
  navigator: {},
  Blob: class { constructor(p) { this.parts = p; } },
  URL_createObjectURL: () => 'blob:',
  Notification: { requestPermission: async () => 'denied' },
  uid: () => 'id_' + Math.random().toString(36).slice(2),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.URL.createObjectURL = () => 'blob:';
sandbox.URL.revokeObjectURL = () => {};
vm.createContext(sandbox);

const load = (f, ...names) => vm.runInContext(
  fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8') +
  (names.length ? '\n' + names.map(n => `globalThis.${n} = ${n};`).join('\n') : ''),
  sandbox, { filename: f });

console.log('\n── Загрузка модулей в порядке index.html ──');
try {
  load('llm/llm-registry.js', 'LLMRegistry');
  load('engines/security-engine.js', 'SecurityEngine');
  load('core/log-guard.js', 'LogGuard');
  load('engines/folders-engine.js', 'FoldersEngine');
  load('tools/tools-engine.js', 'ToolsEngine');
  load('tools/tools-registry.js');
  load('tools/tools-executor.js');
  load('tools/tools-builtin.js');
  load('tools/tools-defs.js');
  load('tools/tools-mcp.js');
  load('tools/tools-llm-router.js');
  load('tools/tools-artifacts.js');
  load('tools/tools-subtask.js');
  ok('все модули загрузились без ошибок', true);
} catch (e) {
  ok('все модули загрузились без ошибок', false, e.message);
  process.exit(1);
}

const { ToolsEngine, LLMRegistry, SecurityEngine } = sandbox;

(async () => {
  console.log('\n── Сборка класса из примесей ──');
  const need = ['_initBuiltinTools', '_builtinDefs', '_allBuiltinDefs', 'registerHandler',
                'unregisterHandler', 'loadTools', 'getEnabledToolsForAPI', 'executeTool',
                '_registerMcpHandler', '_checkMcpAddress', 'listMcpServers',
                '_buildChatExport', '_isBlockedFetchHost', '_resolveFolderId'];
  for (const m of need) {
    ok('метод ' + m + ' на месте', typeof ToolsEngine.prototype[m] === 'function');
  }

  const db = new FakeDB();
  const engine = new ToolsEngine(db);
  const sec = new SecurityEngine();
  sec.resetTurn();
  engine.security = sec;

  console.log('\n── Встроенные инструменты ──');
  const defs = engine._allBuiltinDefs();
  const names = defs.map(d => d.name);
  ok('описания собраны', defs.length > 30, 'найдено ' + defs.length);
  ok('прежние инструменты не потерялись',
    ['get_current_time', 'calculator', 'http_fetch', 'create_tool', 'export_chat', 'read_file']
      .every(n => names.includes(n)));
  ok('инструменты llm_* добавлены модулем',
    ['llm_list', 'llm_status', 'llm_switch', 'llm_test'].every(n => names.includes(n)));
  ok('нет дублей имён', new Set(names).size === names.length);
  ok('нет дублей id', new Set(defs.map(d => d.id)).size === defs.length);

  const llmDefs = defs.filter(d => d.name.startsWith('llm_'));
  ok('все инструменты llm_* выключены по умолчанию', llmDefs.every(d => d.enabled === false));
  ok('обработчики llm_* зарегистрированы',
    llmDefs.every(d => engine.registry.has(d.id)), 
    llmDefs.filter(d => !engine.registry.has(d.id)).map(d => d.id).join(','));

  console.log('\n── Инструменты выбора модели ──');
  const reg = new LLMRegistry(db, { configure() {} });
  engine.llmRegistry = reg;
  await reg.init();

  const pA = await reg.saveConnection({ name: 'OpenAI', apiUrl: 'https://a.test/v1', apiKey: 'k1' });
  const mBig = await reg.saveModel(pA.id, { name: 'gpt-4o', tier: 'advanced', contextWindow: 128000 });
  const mSmall = await reg.saveModel(pA.id, { name: 'gpt-4o-mini', label: 'Мини', tier: 'light', contextWindow: 16000 });
  const pB = await reg.saveConnection({ name: 'Локальный', apiUrl: 'https://b.test/v1', apiKey: 'k2' });
  await reg.saveModel(pB.id, { name: 'qwen2.5:14b', tier: 'balanced' });
  await reg.load();
  await reg.setDefault(reg.refOf(pA.id, mBig.id));
  await db.putAll('tools', defs);

  const call = (n, a) => engine.executeTool(n, a || {}, { bypassSecurity: true });

  // Заглушка интерфейса: инструменты меняют модель текущего чата.
  await db.put('chats', { id: 'chat1', modelRefs: [reg.refOf(pA.id, mBig.id)], modelRef: reg.refOf(pA.id, mBig.id) });
  engine.ui = {
    currentChatId: 'chat1',
    async setChatModel(ref) {
      const c = await db.get('chats', 'chat1');
      c.modelRefs = Array.from(new Set([...(c.modelRefs || []), ref]));
      c.modelRef = ref;
      await db.put('chats', c);
      reg.applyRef(ref);
    },
  };

  const list = await call('llm_list');
  ok('llm_list перечисляет провайдеров', list.providers.length === 2, JSON.stringify(list.providers));
  ok('llm_list перечисляет модели', list.models.length === 3);
  // Ключ ищем именно как ЗНАЧЕНИЕ ("k1" в кавычках), а не как подстроку:
  // id провайдера начинается с Date.now().toString(36), и в отдельные
  // получасовые окна времени он сам содержит "k1" — проверка по подстроке
  // ложно срабатывала на нём (и только на нём: ключа в ответе нет).
  ok('llm_list не отдаёт ключи', !JSON.stringify(list).includes('"k1"'), JSON.stringify(list));
  ok('в списке есть класс сложности', list.models.every(m => !!m.tierLabel));

  const st = await call('llm_status');
  ok('llm_status показывает текущую модель', st.current && st.current.model === 'gpt-4o', JSON.stringify(st.current));
  ok('llm_status показывает модели чата', st.chatModels.length === 1);

  const sw = await call('llm_switch', { model: 'Мини', reason: 'задача простая' });
  ok('llm_switch находит модель по названию', sw.ok === true && sw.model === 'gpt-4o-mini', JSON.stringify(sw));
  ok('llm_switch предупреждает об окне контекста', /контекста уменьшилось/.test(sw.contextWarning || ''), sw.contextWarning);
  ok('llm_switch напоминает про следующий запрос', /следующего запроса/.test(sw.note || ''));
  ok('смена попала в журнал', sec.auditLog.some(e => e.tool === 'llm_switch'));

  const chatRec = await db.get('chats', 'chat1');
  ok('модель записана в чат', chatRec.modelRef === reg.refOf(pA.id, mSmall.id));
  ok('модель добавлена в набор чата', chatRec.modelRefs.length === 2);

  const byId = await call('llm_switch', { model: 'qwen2.5:14b' });
  ok('llm_switch находит модель по идентификатору', byId.ok === true, JSON.stringify(byId));
  ok('смена модели меняет и провайдера', byId.provider === 'Локальный', byId.provider);

  const missing = await call('llm_switch', { model: 'такой нет' });
  ok('неизвестная модель — понятная ошибка', !!missing.error && Array.isArray(missing.available));
  ok('в ошибке перечислено доступное', missing.available.length === 3);

  const tested = await call('llm_test', { provider: 'OpenAI' });
  ok('llm_test проверяет провайдера', tested.results[0].ok === false, JSON.stringify(tested));

  console.log('\n── Проверка адреса MCP ──');
  ok('https разрешён', !engine._checkMcpAddress('https://mcp.example.com/rpc').error);
  ok('http наружу запрещён', /http/.test(engine._checkMcpAddress('http://mcp.example.com/rpc').error || ''));
  ok('ftp отклонён', !!engine._checkMcpAddress('ftp://x.test/rpc').error);
  ok('мусорный адрес отклонён', !!engine._checkMcpAddress('не адрес').error);
  ok('внутренняя сеть запрещена', !!engine._checkMcpAddress('https://192.168.1.10/rpc').error);
  ok('metadata-эндпоинт запрещён', !!engine._checkMcpAddress('https://169.254.169.254/rpc').error);
  ok('localhost по умолчанию запрещён', !!engine._checkMcpAddress('http://localhost:3000/rpc').error);
  sec.mcpLimits.allowLocalServers = true;
  sec.mcpLimits.requireHttps = false;
  ok('localhost разрешается настройкой', !engine._checkMcpAddress('http://localhost:3000/rpc').error,
     JSON.stringify(engine._checkMcpAddress('http://localhost:3000/rpc')));

  console.log('\n── Учёт MCP-серверов ──');
  await db.putAll('tools', [
    { id: 'm1', name: 'mcp_a', mcpServer: 'https://srv1.test/rpc', enabled: true },
    { id: 'm2', name: 'mcp_b', mcpServer: 'https://srv1.test/rpc', enabled: false },
    { id: 'm3', name: 'mcp_c', mcpServer: 'https://srv2.test/rpc', enabled: true },
  ]);
  const servers = await engine.listMcpServers();
  ok('серверы сгруппированы по хосту', servers.length === 2, JSON.stringify(servers.map(s => s.host)));
  const s1 = servers.find(s => s.host === 'srv1.test');
  ok('инструменты сервера собраны вместе', s1.tools.length === 2);
  ok('включённые считаются отдельно', s1.enabledCount === 1);
  ok('токены наружу не отдаются', !JSON.stringify(servers).includes('mcpToken'));

  console.log('\n── Жизненный цикл именованного MCP-сервера ──');
  {
    const origFetch = sandbox.fetch;
    sandbox.fetch = async () => ({
      ok: true,
      json: async () => ({ result: { tools: [
        { name: 'srv_tool_a', description: 'A', inputSchema: { type: 'object', properties: {} } },
        { name: 'srv_tool_b', description: 'B', inputSchema: { type: 'object', properties: {} } },
      ] } }),
    });

    const conn = await engine.connectMcpServer({ name: 'Мой сервер', url: 'https://srv3.test/rpc', token: 'tok-1' });
    ok('сервер подключился и импортировал tools', conn.importedCount === 2, JSON.stringify(conn));
    ok('папка-контейнер создана в корне', conn.folder && conn.folder.parentId === null);

    const named = (await engine.listMcpServers()).find(s => s.id === conn.server.id);
    ok('именованный сервер виден в списке под своим именем', named && named.name === 'Мой сервер');
    ok('его tools привязаны к папке сервера', named.tools.length === 2);

    // Вложенная подпапка внутри сервера — разрешённая иерархия.
    const subFolder = { id: 'sub1', type: 'tools', name: 'подпапка', parentId: conn.folder.id, createdAt: Date.now() };
    await db.put('folders', subFolder);
    const movedTool = (await db.getAll('tools')).find(t => t.mcpServerId === conn.server.id);
    movedTool.parentId = subFolder.id;
    await db.put('tools', movedTool);

    await engine.updateMcpServer(conn.server.id, { name: 'Переименованный сервер', token: '' });
    const renamed = await db.get('mcp_servers', conn.server.id);
    ok('пустой токен при правке не меняет авторизацию', renamed.name === 'Переименованный сервер');
    const renamedFolder = await db.get('folders', conn.folder.id);
    ok('имя папки-контейнера следует за именем сервера', renamedFolder.name === 'Переименованный сервер');

    await engine.updateMcpServer(conn.server.id, { name: '', token: 'tok-2' });
    const afterTokenChange = (await db.getAll('tools')).filter(t => t.mcpServerId === conn.server.id);
    ok('смена токена обновляет его у всех tools сервера', afterTokenChange.every(t => t.mcpToken === 'tok-2'));
    ok('имя не трогается, если поле оставили пустым', (await db.get('mcp_servers', conn.server.id)).name === 'Переименованный сервер');

    const removed = await engine.removeMcpServer(conn.server.id);
    ok('удаление сервера сообщает об успехе', removed === true);
    ok('все tools сервера удалены, включая унесённый в подпапку',
       (await db.getAll('tools')).every(t => t.mcpServerId !== conn.server.id));
    ok('папка сервера и вложенная подпапка удалены',
       !(await db.get('folders', conn.folder.id)) && !(await db.get('folders', subFolder.id)));
    ok('запись сервера удалена', !(await db.get('mcp_servers', conn.server.id)));

    sandbox.fetch = origFetch;
  }

  console.log('\n── Шлюз безопасности в executeTool ──');
  sec.mode = 'standard';
  sec.resetTurn();
  let asked = null;
  sec.confirmFn = async (req) => { asked = req; return { approved: false }; };
  const blocked = await engine.executeTool('llm_switch', { connection: 'Основной' }, {});
  ok('обычный вызов проходит через проверки', true);
  sec.mode = 'maximum';
  const denied2 = await engine.executeTool('llm_switch', { connection: 'Основной' }, {});
  ok('в максимальном режиме спрашивают подтверждение', asked !== null, JSON.stringify(asked));
  ok('отказ пользователя останавливает вызов', denied2.denied === true, JSON.stringify(denied2));

  console.log('\n── Выключенный инструмент недоступен для вызова ──');
  {
    // Проверяем именно исполнителя, а не политику безопасности — иначе
    // не понятно, какая из двух проверок сработала.
    const savedSecurity = engine.security;
    engine.security = null;
    const tool = await db.get('tools', 'builtin_llm_switch');
    tool.enabled = false;
    await db.put('tools', tool);
    const disabledCall = await engine.executeTool('llm_switch', { connection: 'Основной' }, {});
    ok('вызов выключенного инструмента отклонён', !!disabledCall.error && /отключ/.test(disabledCall.error),
       JSON.stringify(disabledCall));
    tool.enabled = true;
    await db.put('tools', tool);
    engine.security = savedSecurity;
  }

  {
    console.log('\n── Инструменты экономии контекста ──');
    const defs = engine._allBuiltinDefs();
    const byName = new Map(defs.map(d => [d.name, d]));
    for (const n of ['artifact_read', 'artifact_grep', 'artifact_list', 'run_subtask']) {
      const d = byName.get(n);
      ok(`${n} описан, включён и неотключаем`, !!d && d.enabled === true && d.locked === true,
         d ? JSON.stringify({ enabled: d.enabled, locked: d.locked }) : 'нет описания');
    }
    ok('run_subtask объясняет, что промежуточные вызовы не попадают в разговор',
       /НЕ попадают/.test(byName.get('run_subtask').description));

    // Подзадача выполняется в интерфейсе: без него инструмент обязан
    // объяснить отказ, а не упасть.
    const savedUi = engine.ui;
    engine.ui = null;
    const noUi = await engine.executeTool('run_subtask', { goal: 'x' }, {});
    ok('без интерфейса run_subtask отвечает понятной ошибкой', /недоступны/.test(noUi.error || ''),
       JSON.stringify(noUi));
    engine.ui = savedUi;
  }

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('СБОЙ ТЕСТА:', e); process.exit(1); });
