// Тесты на доработки, закрывающие рассогласования между старым UI и
// новым пулом подключений.
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? ' → ' + e : '')); } };

class FakeDB {
  constructor() { this.stores = { settings: new Map(), llm_connections: new Map(), tools: new Map(), files: new Map(), chats: new Map(), skills: new Map(), prompts: new Map(), chat_stats: new Map(), folders: new Map() }; }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(o.key ?? o.id, o); }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, o) { for (const x of o) await this.put(s, x); return o.length; }
}

const sandbox = {
  console, setTimeout, clearTimeout, Date, Math, JSON, Promise, URL, TypeError, Error,
  Map, Set, Array, Object, String, Number, Boolean, RegExp, Intl, TextEncoder, TextDecoder,
  performance: { now: () => Date.now() },
  SecretsVault: { encrypt: async (_d, v) => v || '', decrypt: async (_d, v) => v || '' },
  fetch: async () => { throw new TypeError('сеть недоступна в тесте'); },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  crypto: { getRandomValues: (a) => a },
  localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {} },
  document: { createElement: () => ({ style: {}, click: () => {} }), getElementById: () => null, body: {} },
  navigator: {},
  Blob: class {},
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

load('llm/llm-registry.js', 'LLMRegistry');
load('engines/security-engine.js', 'SecurityEngine');
load('core/log-guard.js', 'LogGuard');
  load('core/tool-sandbox.js', 'ToolSandbox');
load('engines/folders-engine.js', 'FoldersEngine');
load('tools/tools-engine.js', 'ToolsEngine');
['tools-registry.js','tools-executor.js','tools-builtin.js','tools-defs.js','tools-mcp.js','tools-llm-router.js'].forEach(f => load('tools/' + f));

const { LLMRegistry, SecurityEngine, ToolsEngine } = sandbox;

(async () => {
  console.log('\n── Диагностика знает о реестре ──');
  {
    const db = new FakeDB();
    const reg = new LLMRegistry(db, { configure() {} });
    const engine = new ToolsEngine(db);
    engine.llmRegistry = reg;
    engine.ui = { agent: { llm: { model: 'm-a', maxTokens: 8192 } }, effectiveContextLimit: () => 128000 };
    await reg.init();
    await db.putAll('tools', engine._allBuiltinDefs());

    const run = async () => {
      const d = await engine.executeTool('diagnose', {}, { bypassSecurity: true });
      return d.findings.map(f => f.what).join(' | ');
    };

    ok('пустой реестр замечен', /Провайдеров нет/.test(await run()));

    const p = await reg.saveConnection({ name: 'P', apiUrl: 'https://a.test/v1', apiKey: 'k' });
    await reg.load();
    ok('провайдер без моделей замечен', /ни одной модели/.test(await run()));

    const m = await reg.saveModel(p.id, { name: 'm-a', contextWindow: 0 });
    await reg.load();
    ok('модель без окна контекста замечена', /окно контекста/i.test(await run()), await run());
    ok('отсутствие модели по умолчанию замечено', /по умолчанию/.test(await run()));

    await reg.setDefault(reg.refOf(p.id, m.id));
    await reg.saveModel(p.id, { id: m.id, name: 'm-a', contextWindow: 128000 });
    await reg.load();
    const clean = await run();
    ok('после настройки замечаний по моделям нет',
      !/Провайдеров нет|ни одной модели|окно контекста|по умолчанию/.test(clean), clean);

    await reg.saveConnection({ id: p.id, name: 'P', apiUrl: 'https://a.test/v1', apiKey: '' });
    await reg.load();
    ok('провайдер без ключа замечен', /без ключа доступа/.test(await run()));
  }

  console.log('\n── Справка о моделях ──');
  {
    const db = new FakeDB();
    const engine = new ToolsEngine(db);
    await db.putAll('tools', engine._allBuiltinDefs());
    const defs = engine._allBuiltinDefs();
    const explain = defs.find(d => d.name === 'explain_agent');
    ok('тема models объявлена в схеме',
      explain.parameters.properties.topic.enum.includes('models'),
      JSON.stringify(explain.parameters.properties.topic.enum));

    const r = await engine.executeTool('explain_agent', { topic: 'models' }, { bypassSecurity: true });
    ok('тема models возвращает содержимое', Array.isArray(r.points) && r.points.length > 3, JSON.stringify(r).slice(0, 100));
    ok('объяснено, что модель у чата своя',
      r.points.some(p => /в каждом чате свой набор/i.test(p)), JSON.stringify(r.points));
    ok('объяснено, что смена действует со следующего запроса',
      r.points.some(p => /следующего запроса/.test(p)));
    ok('сказано, что автопереключения нет',
      r.points.some(p => /Автоматического переключения.*нет/.test(p)));
    const bad = await engine.executeTool('explain_agent', { topic: 'нет такой' }, { bypassSecurity: true });
    ok('неизвестная тема откатывается на обзор', bad.title === 'Из чего состоит агент');
  }

  console.log('\n── Настройки политик сохраняются и применяются ──');
  {
    const sec = new SecurityEngine();
    sec.resetTurn();
    sec.configure({
      allowedMcpHosts: 'a.test, b.test',
      maxCallsPerToolPerTurn: 5,
      mcpLimits: { requireHttps: false, allowLocalServers: true, maxCallsPerTurn: 3 },
    });
    ok('белый список MCP разобран', sec.allowedMcpHosts.join(',') === 'a.test,b.test');
    ok('лимит вызовов применён', sec.maxCallsPerToolPerTurn === 5);
    ok('частичный патч mcpLimits не затирает остальные поля',
      sec.mcpLimits.maxCallsPerTurn === 3 && sec.mcpLimits.markUntrusted === true &&
      sec.mcpLimits.allowLocalServers === true,
      JSON.stringify(sec.mcpLimits));
    // Таймаут и предел ответа у MCP свои больше не хранятся (Цикл 32).
    ok('у MCP нет собственных таймаута и предела ответа',
      sec.mcpLimits.timeoutSeconds === undefined && sec.mcpLimits.maxResponseChars === undefined,
      JSON.stringify(sec.mcpLimits));

    // Настройка адреса должна влиять на проверку в клиенте MCP.
    const db = new FakeDB();
    const engine = new ToolsEngine(db);
    engine.security = sec;
    ok('после разрешения localhost адрес проходит',
      !engine._checkMcpAddress('http://localhost:3000/rpc').error);
    sec.mcpLimits.allowLocalServers = false;
    ok('после запрета localhost адрес отклоняется',
      !!engine._checkMcpAddress('http://localhost:3000/rpc').error);
  }

  console.log('\n── Подсказки режимов упоминают MCP и смену модели ──');
  {
    const M = SecurityEngine.MODES;
    ok('минимальный режим объясняет поведение с MCP', /MCP/.test(M.minimal.hint), M.minimal.hint);
    ok('оптимальный режим объясняет подтверждение MCP', /MCP/.test(M.standard.hint));
    ok('максимальный режим упоминает смену модели', /Смена модели/.test(M.maximum.hint));
  }

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('СБОЙ ТЕСТА:', e); process.exit(1); });
