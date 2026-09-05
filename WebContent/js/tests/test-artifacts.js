// Тест механизма артефактов: большой результат инструмента выносится из
// переписки, а модель получает шапку и читает содержимое порциями.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? ' → ' + e : '')); } };

class FakeDB {
  constructor() { this.stores = { artifacts: new Map(), tools: new Map(), settings: new Map(), chats: new Map(), folders: new Map(), files: new Map(), skills: new Map(), llm_connections: new Map(), mcp_servers: new Map() }; }
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
  load('engines/artifacts-engine.js', 'ArtifactsEngine');
  load('engines/security-engine.js', 'SecurityEngine');
  load('core/log-guard.js', 'LogGuard');
  load('engines/folders-engine.js', 'FoldersEngine');
  load('tools/tools-engine.js', 'ToolsEngine');
  load('tools/tools-registry.js');
  load('tools/tools-executor.js');
  load('tools/tools-builtin.js');
  load('tools/tools-defs.js');
  load('tools/tools-mcp.js');
  load('tools/tools-artifacts.js');
  load('engines/skills-engine.js', 'SkillsEngine');
  ok('модули загрузились', true);
} catch (e) {
  ok('модули загрузились', false, e.message);
  process.exit(1);
}

const { ArtifactsEngine, ToolsEngine, SkillsEngine } = sandbox;

(async () => {
  const db = new FakeDB();
  const eng = new ArtifactsEngine(db);

  console.log('\n── Разделение результата на шапку и тело ──');
  const bigBody = 'строка данных\n'.repeat(5000);
  const rec = await eng.store({
    chatId: 'chat1',
    toolName: 'http_fetch',
    args: { url: 'https://example.com/big' },
    result: { status: 200, url: 'https://example.com/big', body: bigBody },
  });
  ok('тело взято из доминирующего поля', rec.field === 'body' && rec.text === bigBody);
  ok('второстепенные поля остались в шапке', rec.meta.status === 200 && rec.meta.url === 'https://example.com/big');
  ok('размер и строки посчитаны', rec.chars === bigBody.length && rec.lines === bigBody.split('\n').length);

  const digest = eng.digest(rec);
  ok('в шапке есть идентификатор', digest.artifact_id === rec.id);
  ok('шапка кратно меньше содержимого', JSON.stringify(digest).length < rec.chars / 10,
    JSON.stringify(digest).length + ' против ' + rec.chars);
  ok('шапка сохраняет метаданные вызова', digest.status === 200);
  ok('шапка называет инструменты чтения', /artifact_read/.test(digest.hint) && /artifact_grep/.test(digest.hint));

  console.log('\n── Результат без доминирующего поля ──');
  const many = await eng.store({
    chatId: 'chat1', toolName: 'search_files', args: {},
    result: { a: 'x'.repeat(300), b: 'y'.repeat(300), c: 'z'.repeat(300) },
  });
  ok('сохраняется целиком как JSON', many.field === null && many.text.startsWith('{'));
  ok('структура определена', /JSON-объект/.test(many.outline), many.outline);

  console.log('\n── Чтение порциями ──');
  const p1 = await eng.read(rec.id, { offset: 0, limit: 100 });
  ok('вернулся кусок нужного размера', p1.text.length === 100);
  ok('указан следующий offset', p1.next_offset === 100 && p1.eof === false);
  const last = await eng.read(rec.id, { offset: rec.chars - 10, limit: 4000 });
  ok('конец помечен eof', last.eof === true && last.next_offset === null);
  ok('порция ограничена сверху 20000', (await eng.read(rec.id, { offset: 0, limit: 999999 })).returned === 20000);
  ok('несуществующий артефакт объяснён', /не найден/.test((await eng.read('af_nope')).error));

  console.log('\n── Поиск ──');
  const withNeedle = await eng.store({
    chatId: 'chat1', toolName: 'read_file', args: {},
    result: { text: 'первая\nвторая ИГОЛКА тут\nтретья\n' + 'мусор\n'.repeat(100) },
  });
  const g = await eng.grep(withNeedle.id, 'иголка');
  ok('нашлось совпадение без учёта регистра', g.matches.length === 1 && g.matches[0].line === 2);
  ok('вернулся номер строки и текст', /ИГОЛКА/.test(g.matches[0].text));
  ok('битое выражение не роняет инструмент', /Некорректное/.test((await eng.grep(withNeedle.id, '[')).error));
  const gc = await eng.grep(withNeedle.id, 'ИГОЛКА', { context: 1 });
  ok('контекст вокруг совпадения возвращается', /первая/.test(gc.matches[0].text) && /третья/.test(gc.matches[0].text));

  console.log('\n── Перечень и удаление вместе с чатом ──');
  await eng.store({ chatId: 'chat2', toolName: 'http_fetch', args: {}, result: { body: 'чужой чат '.repeat(50) } });
  const listed = await eng.list('chat1');
  ok('перечень только своего чата', listed.length === 3, 'получено ' + listed.length);
  ok('в перечне нет содержимого', !JSON.stringify(listed).includes('строка данных'));
  const removed = await eng.removeByChat('chat1');
  ok('удалены все артефакты чата', removed === 3 && (await eng.list('chat1')).length === 0);
  ok('чужие не тронуты', (await eng.list('chat2')).length === 1);

  console.log('\n── Инструменты ──');
  const engine = new ToolsEngine(db);
  engine.artifacts = eng;
  engine.security = null;
  engine.ui = { currentChatId: 'chat2' };
  const defs = engine._allBuiltinDefs();
  const names = defs.map(d => d.name);
  for (const n of ['artifact_read', 'artifact_grep', 'artifact_list']) {
    ok('описан инструмент ' + n, names.includes(n));
  }
  ok('инструменты артефактов системные и включены',
    defs.filter(d => d.name.startsWith('artifact_')).every(d => d.locked === true && d.enabled === true));

  await engine.loadTools();
  const listRes = await engine.executeTool('artifact_list', {});
  ok('artifact_list отдаёт артефакты текущего чата', listRes.count === 1);
  const target = listRes.artifacts[0].artifact_id;
  const readRes = await engine.executeTool('artifact_read', { id: target, limit: 5 });
  ok('artifact_read работает через движок инструментов', readRes.text === 'чужой');
  const grepRes = await engine.executeTool('artifact_grep', { id: target, pattern: 'чат' });
  ok('artifact_grep работает через движок инструментов', grepRes.matches.length === 1);
  ok('без id инструмент объясняет, чего не хватает',
    /Не указан id/.test((await engine.executeTool('artifact_read', {})).error));

  console.log('\n── Системный навык ──');
  const skills = new SkillsEngine(db);
  const sys = skills._defaultSkills().find(s => s.id === 'skill_system');
  ok('промпт объясняет артефакты', /artifact_id/.test(sys.systemPrompt) && /artifact_read/.test(sys.systemPrompt));
  ok('инструменты привязаны к системному навыку',
    ['builtin_artifact_read', 'builtin_artifact_grep', 'builtin_artifact_list'].every(id => sys.toolIds.includes(id)));

  // Навык, заведённый в базе до появления артефактов, должен получить
  // новый текст промпта при загрузке — иначе механизм есть, а объяснения нет.
  await db.put('skills', { id: 'skill_system', name: 'Системный', systemPrompt: 'старый текст',
    description: 'старое', enabled: true, locked: true, toolIds: ['builtin_memory'] });
  await skills.loadSkills();
  const stored = await db.get('skills', 'skill_system');
  ok('старая запись системного навыка обновилась', stored.systemPrompt === sys.systemPrompt);
  ok('и получила новые привязки', stored.toolIds.includes('builtin_artifact_read'));

  console.log('\n==============================================');
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('==============================================');
  process.exit(fail ? 1 : 0);
})();
