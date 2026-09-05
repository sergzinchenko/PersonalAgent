// ============================================================
//  ТЕСТ: план задачи (task_plan)
// ============================================================
//
// План существует ради одного свойства: состояние длинной работы не
// должно зависеть от переписки. Здесь проверяется и сам движок, и то,
// что сводка плана компактна, честно отражает ход работы и говорит
// агенту, что делать дальше.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? ' → ' + e : '')); } };

class FakeDB {
  constructor() { this.stores = { tasks: new Map(), tools: new Map(), settings: new Map(), chats: new Map(), folders: new Map(), files: new Map(), skills: new Map(), llm_connections: new Map(), mcp_servers: new Map(), artifacts: new Map() }; }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(o.key ?? o.id, o); }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, o) { for (const x of o) await this.put(s, x); return o.length; }
  async deleteAll(s, keys) { for (const k of keys) await this.delete(s, k); return keys.length; }
  async getAllByIndex(s, idx, v) { return (await this.getAll(s)).filter(r => r[idx] === v); }
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
  Notification: { requestPermission: async () => 'denied' },
  uid: () => 'id_' + Math.random().toString(36).slice(2),
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const load = (f, ...names) => vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', f), 'utf8') +
  (names.length ? '\n' + names.map(n => `globalThis.${n} = ${n};`).join('\n') : ''),
  sandbox, { filename: f });

console.log('\n── Загрузка модулей ──');
try {
  load('engines/tasks-engine.js', 'TasksEngine');
  load('engines/security-engine.js', 'SecurityEngine');
  load('core/log-guard.js', 'LogGuard');
  load('core/tool-sandbox.js', 'ToolSandbox');
  load('engines/folders-engine.js', 'FoldersEngine');
  load('tools/tools-engine.js', 'ToolsEngine');
  load('tools/tools-registry.js');
  load('tools/tools-executor.js');
  load('tools/tools-builtin.js');
  load('tools/tools-defs.js');
  load('tools/tools-mcp.js');
  load('tools/tools-tasks.js');
  ok('модули загрузились', true);
} catch (e) {
  ok('модули загрузились', false, e.message);
  process.exit(1);
}

const { TasksEngine, ToolsEngine, SecurityEngine } = sandbox;

(async () => {
  const db = new FakeDB();
  const eng = new TasksEngine(db);

  console.log('\n── Создание плана ──');
  const plan = await eng.create('chat1', 'Собрать отчёт по трём источникам',
    ['Выгрузить данные', 'Свести таблицу', 'Написать выводы']);
  ok('план создан и активен', plan.status === 'active' && plan.steps.length === 3);
  ok('шаги пронумерованы и не начаты', plan.steps.every((s, i) => s.n === i + 1 && s.status === 'todo'));
  ok('план без шагов отклонён', !!(await eng.create('chat1', 'ничего', [])).error);

  console.log('\n── Ход работы ──');
  await eng.start('chat1', 1);
  let cur = await eng.active('chat1');
  ok('шаг отмечен как выполняемый', cur.steps[0].status === 'doing');
  await eng.start('chat1', 2);
  cur = await eng.active('chat1');
  ok('одновременно в работе только один шаг',
     cur.steps.filter(s => s.status === 'doing').length === 1 && cur.steps[1].status === 'doing');

  await eng.done('chat1', 1, 'выгружено 3 файла в /data');
  cur = await eng.active('chat1');
  ok('закрытый шаг хранит результат', cur.steps[0].status === 'done' && /3 файла/.test(cur.steps[0].note));
  ok('несуществующий шаг — понятная ошибка', /Шага 99/.test((await eng.done('chat1', 99, 'x')).error));

  await eng.addFact('chat1', 'у источника B данные за прошлый год');
  cur = await eng.active('chat1');
  ok('факт сохранён отдельно от шагов', cur.facts.length === 1);

  console.log('\n── Сводка для системного промпта ──');
  const digest = eng.digest(cur);
  ok('в сводке есть цель', digest.includes('Собрать отчёт'));
  ok('видно, что сделано, с результатом', /✔ 1\..*3 файла/.test(digest));
  ok('видно, что в работе сейчас', /▶ 2\./.test(digest));
  ok('сказано, чем отметить завершение шага', /action=done/.test(digest));
  ok('факты попали в сводку', digest.includes('прошлый год'));
  ok('сводка компактна', digest.length < 1200, String(digest.length));

  console.log('\n── Дописывание шагов и завершение ──');
  await eng.addSteps('chat1', ['Проверить цифры у коллеги']);
  cur = await eng.active('chat1');
  ok('шаг дописан в конец с новым номером', cur.steps.length === 4 && cur.steps[3].n === 4);
  ok('состояние прежних шагов не сброшено', cur.steps[0].status === 'done');

  for (const n of [2, 3, 4]) await eng.done('chat1', n, 'ок');
  cur = await eng.active('chat1');
  ok('план закрывается сам, когда закрыты все шаги', cur === null);
  ok('сводка закрытого плана пуста', eng.digest(await db.get('tasks', plan.id)) === '');

  console.log('\n── Один активный план на чат ──');
  const p1 = await eng.create('chat2', 'Первый', ['a', 'b']);
  const p2 = await eng.create('chat2', 'Второй', ['c']);
  const active2 = await eng.active('chat2');
  ok('активным остаётся последний план', active2.id === p2.id);
  ok('предыдущий помечен как заменённый', (await db.get('tasks', p1.id)).status === 'superseded');
  ok('план чужого чата не виден', (await eng.active('chat3')) === null);

  console.log('\n── Инструмент ──');
  const engine = new ToolsEngine(db);
  engine.tasks = eng;
  engine.security = null;
  engine.ui = { currentChatId: 'chat4', _chatRuns: new Map(), updateChatToolbar() {} };
  const defs = engine._allBuiltinDefs();
  const def = defs.find(d => d.name === 'task_plan');
  ok('инструмент описан, включён и неотключаем', !!def && def.enabled === true && def.locked === true);
  ok('описание объясняет, зачем план нужен', /переж/.test(def.description));

  await engine.loadTools();
  const created = await engine.executeTool('task_plan', { action: 'create', goal: 'Цель', steps: ['раз', 'два'] });
  ok('план создаётся через инструмент', created.ok === true && created.plan.total === 2);
  const shown = await engine.executeTool('task_plan', { action: 'show' });
  ok('план читается через инструмент', shown.plan.goal === 'Цель');
  const started = await engine.executeTool('task_plan', { action: 'start', step: 1 });
  ok('шаг начат через инструмент', started.plan.currentN === 1);
  const finished = await engine.executeTool('task_plan', { action: 'done', step: 1, result: 'сделано' });
  ok('шаг закрыт через инструмент', finished.ok === true);
  const bad = await engine.executeTool('task_plan', { action: 'нет-такого' });
  ok('неизвестное действие объяснено и перечислены доступные',
     /Неизвестное действие/.test(bad.error) && /create/.test(bad.error));

  console.log('\n── Безопасность ──');
  const sec = new SecurityEngine();
  ok('план не требует подтверждения', sec.categoryOf('task_plan') === 'read');

  console.log('\n── Удаление вместе с чатом ──');
  const removed = await eng.removeByChat('chat2');
  ok('планы чата удалены', removed === 2 && (await eng.active('chat2')) === null);
  ok('планы других чатов целы', (await db.getAllByIndex('tasks', 'chatId', 'chat4')).length > 0);

  console.log('\n==============================================');
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('==============================================');
  process.exit(fail ? 1 : 0);
})();
