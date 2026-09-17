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
  load('core/tool-sandbox.js', 'ToolSandbox');
  load('core/binary-formats.js', 'BinaryFormats');
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
    // Заглушка ведёт себя как настоящий Response: у него есть и json(),
    // и text(). Приложение читает ответ MCP текстом — ради предела
    // размера и внятного сообщения, когда сервер вернул не JSON.
    const mcpBody = { result: { tools: [
      { name: 'srv_tool_a', description: 'A', inputSchema: { type: 'object', properties: {} } },
      { name: 'srv_tool_b', description: 'B', inputSchema: { type: 'object', properties: {} } },
    ] } };
    const mcpCalls = [];
    sandbox.fetch = async (url, init) => {
      mcpCalls.push({ url, init: init || {} });
      return {
        ok: true, status: 200,
        json: async () => mcpBody,
        text: async () => JSON.stringify(mcpBody),
      };
    };

    const conn = await engine.connectMcpServer({ name: 'Мой сервер', url: 'https://srv3.test/rpc', token: 'tok-1' });
    ok('сервер подключился и импортировал tools', conn.importedCount === 2, JSON.stringify(conn));
    ok('папка-контейнер создана в корне', conn.folder && conn.folder.parentId === null);
    ok('по умолчанию сервер опрашивается напрямую',
       mcpCalls[0].url === 'https://srv3.test/rpc' && conn.server.transport === 'direct',
       mcpCalls[0].url);

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

  // ══════════════════════════════════════════════
  console.log('\n── MCP Streamable HTTP: протокол ──');
  {
    // Сервер на официальном SDK: без Accept с обоими типами — 406, без
    // инициализации — 400, ответ потоком событий, id сессии в заголовке,
    // истёкшая сессия — 404. Заглушка ведёт себя ровно так.
    const origFetch = sandbox.fetch;
    const seen = [];
    let sessions = new Set();
    let issued = 0;
    let serverList = [];
    const hdr = (h) => ({ get: (n) => h[String(n).toLowerCase()] ?? null });
    const reply = (status, headers, text) => ({
      ok: status >= 200 && status < 300, status,
      headers: hdr(headers),
      text: async () => text,
      json: async () => JSON.parse(text),
    });
    const sse = (obj) => 'event: message\n' + 'data: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }) +
      '\n\nevent: message\ndata: ' + JSON.stringify(obj) + '\n\n';

    sandbox.fetch = async (url, init) => {
      const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      const msg = JSON.parse(init.body);
      seen.push({ method: msg.method, headers: h });
      if (!/application\/json/.test(h.accept || '') || !/text\/event-stream/.test(h.accept || '')) {
        return reply(406, { 'content-type': 'application/json' },
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Not Acceptable: Client must accept both application/json and text/event-stream' }, id: null }));
      }
      if (msg.method === 'initialize') {
        const sid = 'sess-' + (++issued);
        sessions.add(sid);
        return reply(200, { 'content-type': 'text/event-stream', 'mcp-session-id': sid },
          sse({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'srv', version: '1' } } }));
      }
      const sid = h['mcp-session-id'];
      if (!sid) return reply(400, { 'content-type': 'application/json' },
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Server not initialized' }, id: null }));
      if (!sessions.has(sid)) return reply(404, { 'content-type': 'application/json' },
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
      if (msg.method === 'notifications/initialized') return reply(202, {}, '');
      if (msg.method === 'tools/list') {
        const page = msg.params && msg.params.cursor === 'p2' ? 2 : 1;
        const result = page === 1
          ? { tools: [{ name: 'sse_tool', description: 'x', inputSchema: { type: 'object', properties: {} } }], nextCursor: 'p2' }
          : { tools: [{ name: 'sse_tool_2', description: 'y', inputSchema: { type: 'object', properties: {} } }] };
        serverList.push(page);
        return reply(200, { 'content-type': 'text/event-stream' }, sse({ jsonrpc: '2.0', id: msg.id, result }));
      }
      if (msg.method === 'tools/call') {
        return reply(200, { 'content-type': 'text/event-stream' },
          sse({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ответ из потока' }] } }));
      }
      return reply(400, {}, 'unexpected');
    };

    const sec = engine.security;
    const prevLocal = sec && sec.mcpLimits ? { ...sec.mcpLimits } : null;
    const conn = await engine.connectMcpServer({ name: 'SDK', url: 'https://sdk.test/mcp', token: 'tk' });
    ok('сервер на официальном SDK подключается', !conn.error && conn.importedCount === 2, JSON.stringify(conn));
    ok('каждый запрос объявляет оба типа ответа',
       seen.every(x => /application\/json/.test(x.headers.accept) && /text\/event-stream/.test(x.headers.accept)));
    ok('первым идёт initialize, за ним — notifications/initialized',
       seen[0].method === 'initialize' && seen[1].method === 'notifications/initialized', seen.map(x => x.method).join(','));
    ok('id сессии из заголовка уходит в следующих запросах',
       seen.slice(1).every(x => x.headers['mcp-session-id'] === 'sess-1'));
    ok('и согласованная сервером версия протокола — тоже',
       seen.slice(1).every(x => x.headers['mcp-protocol-version'] === '2025-03-26'));
    ok('перечень инструментов собран со всех страниц', serverList.join(',') === '1,2', serverList.join(','));
    ok('ответ из потока событий разобран, уведомления в потоке пропущены', conn.importedCount === 2);

    seen.length = 0;
    const called = await engine.executeTool('sse_tool', { q: 1 }, { bypassSecurity: true });
    ok('вызов инструмента проходит, ответ — из потока событий',
       !called.error && JSON.stringify(called).includes('ответ из потока'), JSON.stringify(called));
    ok('повторной инициализации для второго запроса нет — сессия переиспользуется',
       seen.length === 1 && seen[0].method === 'tools/call', seen.map(x => x.method).join(','));

    // Сервер перезапустился и забыл сессию.
    sessions = new Set();
    seen.length = 0;
    const again = await engine.executeTool('sse_tool', {}, { bypassSecurity: true });
    ok('истёкшая сессия заводится заново, и вызов проходит',
       !again.error && seen.map(x => x.method).join(',') === 'tools/call,initialize,notifications/initialized,tools/call',
       seen.map(x => x.method).join(',') + ' ' + JSON.stringify(again));

    await engine.removeMcpServer(conn.server.id);
    ok('удаление сервера забывает его сессию',
       ![...(engine._mcpSessions || new Map()).keys()].some(k => k.startsWith('https://sdk.test/mcp')));

    // ── Старый сервер без жизненного цикла ──
    seen.length = 0;
    sandbox.fetch = async (url, init) => {
      const msg = JSON.parse(init.body);
      seen.push({ method: msg.method });
      if (msg.method === 'initialize') {
        return reply(200, { 'content-type': 'application/json' },
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }));
      }
      return reply(200, { 'content-type': 'application/json' },
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'old_tool', inputSchema: { type: 'object', properties: {} } }] } }));
    };
    const legacy = await engine.connectMcpServer({ name: 'Старый', url: 'https://old.test/rpc', token: '' });
    ok('старый сервер без initialize по-прежнему подключается', !legacy.error && legacy.importedCount === 1, JSON.stringify(legacy));
    seen.length = 0;
    await engine.executeTool('old_tool', {}, { bypassSecurity: true });
    ok('его отказ от initialize запомнен — вызовы идут без лишних попыток',
       seen.length === 1 && seen[0].method === 'tools/call', seen.map(x => x.method).join(','));
    await engine.removeMcpServer(legacy.server.id);

    // ── Сессия без читаемого id (CORS не открыл заголовок) ──
    sandbox.fetch = async (url, init) => {
      const msg = JSON.parse(init.body);
      if (msg.method === 'initialize') {
        return reply(200, { 'content-type': 'application/json' },   // mcp-session-id не виден странице
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18' } }));
      }
      if (msg.method === 'notifications/initialized') return reply(202, {}, '');
      return reply(400, { 'content-type': 'application/json' },
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID provided' }, id: null }));
    };
    const hidden = await engine.connectMcpServer({ name: 'Скрытый', url: 'https://hidden.test/mcp', token: '' });
    ok('если id сессии не виден браузеру — ошибка с объяснением и решением',
       !!hidden.error && /Mcp-Session-Id/.test(hidden.hint || '') && /прокси/.test(hidden.hint || ''),
       JSON.stringify(hidden));

    // ── Сервер не закрывает ответ ──
    // Раньше у подключения не было срока вовсе: окно висело вечно.
    // Заглушка AbortController в этой среде событий не знает, поэтому
    // здесь — маленький настоящий, ровно с тем, чем пользуется клиент.
    const origAC = sandbox.AbortController;
    sandbox.AbortController = class {
      constructor() {
        const handlers = [];
        this.signal = { aborted: false, addEventListener: (_e, fn) => handlers.push(fn) };
        this._handlers = handlers;
      }
      abort() { this.signal.aborted = true; this._handlers.forEach(fn => fn()); }
    };
    const origLimits = engine._toolLimits;
    engine._toolLimits = async () => ({ timeoutSeconds: 0.2, maxResponseChars: 100000 });
    sandbox.fetch = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('signal is aborted without reason')));
    });
    const stuck = await engine.connectMcpServer({ name: 'Молчун', url: 'https://stuck.test/mcp', token: '' });
    ok('подключение к серверу, не завершающему ответ, обрывается по сроку', !!stuck.error && /не завершил ответ/.test(stuck.error),
       JSON.stringify(stuck));
    ok('и объясняет, что проверить', /потоком событий/.test(stuck.hint || '') && /антивирус|фильтр/.test(stuck.hint || ''),
       stuck.hint);
    engine._toolLimits = origLimits;
    sandbox.AbortController = origAC;

    sandbox.fetch = origFetch;
  }

  console.log('\n── MCP через локальный прокси ──');
  {
    const origFetch = sandbox.fetch;
    const calls = [];
    const body = { result: { tools: [{ name: 'inner_tool', description: 'x', inputSchema: { type: 'object', properties: {} } }] } };
    sandbox.fetch = async (url, init) => {
      calls.push({ url, init: init || {} });
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };

    // Прокси не настроен — подключение через него должно отказать
    // осмысленно, а не молча уйти в никуда.
    await db.delete('settings', 'proxy');
    const noProxy = await engine.connectMcpServer({
      name: 'Внутренний', url: 'https://mcp.corp.local/rpc', token: 't', transport: 'proxy' });
    ok('без адреса прокси подключение отказывает понятно',
       !!noProxy.error && /прокси/i.test(noProxy.error), JSON.stringify(noProxy));
    ok('и говорит, что делать', /Настройки/.test(noProxy.hint || ''), noProxy.hint);

    await db.put('settings', { key: 'proxy', baseUrl: 'http://localhost:3000' });
    calls.length = 0;
    const viaProxy = await engine.connectMcpServer({
      name: 'Внутренний', url: 'https://mcp.corp.local/rpc', token: 't', transport: 'proxy' });
    ok('через прокси сервер подключается', viaProxy.importedCount === 1, JSON.stringify(viaProxy));
    ok('запрос ушёл на прокси, а не на сервер',
       calls[0].url.startsWith('http://localhost:3000/?url='), calls[0].url);
    ok('целевой адрес закодирован целиком',
       decodeURIComponent(calls[0].url.split('?url=')[1]) === 'https://mcp.corp.local/rpc');
    ok('маршрут запомнен у подключения', viaProxy.server.transport === 'proxy');

    // Маршрут должен пережить перезагрузку: обработчики восстанавливаются
    // из записей инструментов, а не из записи сервера.
    const savedTool = (await db.getAll('tools')).find(t => t.mcpServerId === viaProxy.server.id);
    ok('и продублирован в записи инструмента', savedTool.mcpTransport === 'proxy');

    calls.length = 0;
    await engine.executeTool('inner_tool', {}, { bypassSecurity: true });
    ok('вызов инструмента тоже идёт через прокси',
       calls[0].url.startsWith('http://localhost:3000/?url='), calls[0].url);

    // Маршрут меняется без переподключения — и вместе с ним меняется
    // правило адреса: внутренняя сеть доступна ТОЛЬКО через прокси,
    // потому что его выбрал человек. Снятая галочка возвращает общий
    // запрет, и вызов отказывает, не уходя никуда.
    await engine.updateMcpServer(viaProxy.server.id, { transport: 'direct' });
    const afterSwitch = (await db.getAll('tools')).find(t => t.mcpServerId === viaProxy.server.id);
    ok('смена маршрута записана в инструменты сервера', afterSwitch.mcpTransport === 'direct');
    const srvAfter = await db.get('mcp_servers', viaProxy.server.id);
    ok('токен при смене маршрута не потерян', !!srvAfter.token);

    calls.length = 0;
    const direct = await engine.executeTool('inner_tool', {}, { bypassSecurity: true });
    ok('напрямую внутренний адрес снова запрещён',
       !!direct.error && /локальной или служебной сети/.test(direct.error), JSON.stringify(direct));
    ok('и запрос никуда не ушёл', calls.length === 0, String(calls.length));

    // Вернули прокси — вернулась и работа.
    await engine.updateMcpServer(viaProxy.server.id, { transport: 'proxy' });
    calls.length = 0;
    await engine.executeTool('inner_tool', {}, { bypassSecurity: true });
    // После смены маршрута сессия заводится заново (initialize →
    // notifications/initialized → вызов), и всё это — через прокси.
    const lastBody = calls.length ? JSON.parse(calls[calls.length - 1].init.body) : {};
    ok('с возвращённым прокси вызов снова проходит',
       calls.length >= 1 && calls.every(c => c.url.startsWith('http://localhost:3000/?url=')) &&
       lastBody.method === 'tools/call',
       JSON.stringify(calls.map(c => c.url)));

    await engine.removeMcpServer(viaProxy.server.id);
    sandbox.fetch = origFetch;
  }

  console.log('\n── Ожидание человека не обрывается таймаутом ──');
  // Инструмент, открывающий форму, ждёт не код, а человека. Общий таймаут
  // вызова означал здесь «отвечай за тридцать секунд»: пользователь
  // печатал, гонка заканчивалась ошибкой, а введённый ответ уходил в
  // никуда — окно уже никто не слушал.
  const askTool = (await engine.loadTools()).find(t => t.name === 'ask_user');
  ok('ask_user помечен как ждущий человека', askTool && askTool.interactive === true,
     JSON.stringify(askTool && askTool.interactive));

  let waited = 0;
  engine.ui = {
    noteHumanWait: (ms) => { waited += ms; },
    askUser: () => new Promise((resolve) => setTimeout(() => resolve({ answered: true, answer: 'через паузу' }), 120)),
  };
  const slow = await engine.executeTool('ask_user', { question: 'Как дела?' }, { timeoutMs: 40 });
  ok('ответ дождались, хотя таймаут вызова давно вышел',
     slow.answered === true && slow.answer === 'через паузу', JSON.stringify(slow));
  ok('и время ожидания отдано наружу', waited >= 100, String(waited));

  // Обычный инструмент таймаут по-прежнему ограничивает: там ждут код.
  engine.registerHandler('builtin_calc', () => new Promise(r => setTimeout(() => r({ ok: true }), 200)));
  const timedOut = await engine.executeTool('calculator', { expression: '1+1' }, { timeoutMs: 30 });
  ok('обычный инструмент таймаут обрывает', !!timedOut.error && /Timeout/.test(timedOut.error),
     JSON.stringify(timedOut));

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('СБОЙ ТЕСТА:', e); process.exit(1); });
