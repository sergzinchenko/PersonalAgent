// ============================================================
//  ТЕСТ: инструменты Confluence и xWiki
// ============================================================
//
// Проверяет Цикл 35: два набора инструментов к внутренним вики. Главное,
// за чем здесь следят, — не «запрос собрался», а то, что СЕКРЕТ НЕ ТЕЧЁТ:
// ни в ответах инструментов, ни в контексте модели. Плюс маршрут через
// локальный прокси, разбор ошибок доступа и защита существующих страниц
// от перезаписи по недоразумению.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e !== undefined ? ' → ' + e : '')); } };

const ROOT = path.join(__dirname, '..', '..');

class FakeDB {
  constructor() {
    this.stores = {
      settings: new Map(), llm_connections: new Map(), tools: new Map(),
      skills: new Map(), prompts: new Map(), folders: new Map(),
      chats: new Map(), files: new Map(), mcp_servers: new Map(),
    };
  }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(o.key ?? o.id, o); return o; }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, arr) { for (const o of arr) await this.put(s, o); return arr.length; }
  async deleteAll(s, keys) { for (const k of keys) await this.delete(s, k); return keys.length; }
}

// Фейковая вики: запоминает запросы и отвечает заготовками.
let calls = [];
let responder = null;

const sandbox = {
  console, setTimeout, clearTimeout, Date, Math, JSON, Promise, URL, TypeError, Error,
  Map, Set, Array, Object, String, Number, Boolean, RegExp, Intl, TextEncoder, TextDecoder,
  performance: { now: () => Date.now() },
  // Шифрование подменяем узнаваемой обёрткой: так в тестах видно, что в БД
  // лежит именно результат шифрования, а не открытый секрет.
  SecretsVault: {
    encrypt: async (_d, v) => (v ? 'enc(' + v + ')' : ''),
    decrypt: async (_d, v) => String(v || '').replace(/^enc\((.*)\)$/, '$1'),
  },
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  unescape,
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  crypto: { getRandomValues: (a) => a, randomUUID: () => 'uuid' },
  localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { createElement: () => ({ style: {}, click: () => {} }), body: { appendChild: () => {}, removeChild: () => {} } },
  navigator: {},
  Blob: class { constructor(p) { this.parts = p; } },
  Notification: { requestPermission: async () => 'denied' },
  uid: (() => { let n = 0; return () => 'id' + (++n); })(),
  fetch: async (url, init) => {
    calls.push({ url, init: init || {} });
    const r = responder(url, init || {});
    return {
      status: r.status ?? 200,
      statusText: r.statusText || 'OK',
      ok: (r.status ?? 200) < 400,
      headers: { get: () => 'application/json' },
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
    };
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const load = (f, ...names) => vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'js', f), 'utf8') +
  (names.length ? '\n' + names.map(n => `globalThis.${n} = ${n};`).join('\n') : ''),
  sandbox, { filename: f });

console.log('\n── Загрузка модулей ──');
try {
  load('engines/skills-engine.js', 'SkillsEngine');
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
  load('tools/tools-wiki.js');
  ok('модуль вики загрузился', true);
} catch (e) {
  ok('модуль вики загрузился', false, e.message);
  process.exit(1);
}

const { SkillsEngine, SecurityEngine, ToolsEngine } = sandbox;

(async () => {
  const db = new FakeDB();
  const engine = new ToolsEngine(db);
  engine.skills = new SkillsEngine(db);
  const tools = await engine.loadTools();
  const call = (n, a) => engine.executeTool(n, a || {}, { bypassSecurity: true });
  const reset = () => { calls = []; };

  console.log('\n── Описания инструментов ──');
  const names = tools.map(t => t.name);
  ok('заведены все инструменты Confluence',
     ['confluence_configure', 'confluence_status', 'confluence_search', 'confluence_get_page',
      'confluence_create_page', 'confluence_update_page', 'confluence_list_spaces'].every(n => names.includes(n)));
  ok('заведены все инструменты xWiki',
     ['xwiki_configure', 'xwiki_status', 'xwiki_search', 'xwiki_get_page',
      'xwiki_create_page', 'xwiki_update_page', 'xwiki_list_spaces'].every(n => names.includes(n)));
  const wikiTools = tools.filter(t => /^(confluence|xwiki)_/.test(t.name));
  ok('все выключены по умолчанию', wikiTools.every(t => t.enabled === false));
  ok('в описаниях запрещено спрашивать секрет в чате',
     wikiTools.filter(t => /_configure$/.test(t.name)).every(t => /НИКОГДА не спрашивай/.test(t.description)));
  ok('у правки предупреждение о перезаписи целиком',
     /ЦЕЛИКОМ/.test(tools.find(t => t.name === 'confluence_update_page').description) &&
     /ЦЕЛИКОМ/.test(tools.find(t => t.name === 'xwiki_update_page').description));

  console.log('\n── Пока не настроено ──');
  const cold = await call('confluence_search', { text: 'отпуск' });
  ok('поиск честно говорит, что доступ не настроен',
     cold.needsConfiguration === true, JSON.stringify(cold));
  const coldX = await call('xwiki_get_page', { space: 'Main', page: 'WebHome' });
  ok('то же у xWiki', coldX.needsConfiguration === true);

  console.log('\n── Сохранение доступа ──');
  await engine._wikiSaveConfig('confluence', { baseUrl: 'https://conf.corp.local/', secret: 'PAT-СЕКРЕТ' });
  await engine._wikiSaveConfig('xwiki', { baseUrl: 'https://xwiki.corp.local', user: 'ivanov', secret: 'ПАРОЛЬ' });

  const rec = await db.get('settings', 'wiki_confluence');
  ok('секрет лёг в БД зашифрованным, а не текстом',
     rec.secret === 'enc(PAT-СЕКРЕТ)' && !JSON.stringify(rec).includes('"PAT-СЕКРЕТ"'), JSON.stringify(rec));
  ok('хвостовой слэш в адресе убран', rec.baseUrl === 'https://conf.corp.local');
  ok('настройки переживают перезапуск (лежат в БД, а не в памяти движка)',
     (await new ToolsEngine(db)._wikiConfig('confluence')).configured === true);

  console.log('\n── Секрет не попадает в ответы ──');
  responder = () => ({ body: { results: [] } });
  const st = await call('confluence_status');
  ok('confluence_status не отдаёт токен', !JSON.stringify(st).includes('PAT-СЕКРЕТ'), JSON.stringify(st));
  ok('но подтверждает, что настроено', st.configured === true && st.baseUrl === 'https://conf.corp.local');
  const stx = await call('xwiki_status');
  ok('xwiki_status не отдаёт пароль', !JSON.stringify(stx).includes('ПАРОЛЬ'), JSON.stringify(stx));
  ok('имя учётной записи при этом видно', stx.user === 'ivanov');

  console.log('\n── Авторизация в запросе ──');
  reset();
  responder = () => ({ body: { results: [], size: 0 } });
  await call('confluence_search', { text: 'отпуск' });
  ok('Confluence получает Bearer с токеном',
     calls[0].init.headers.Authorization === 'Bearer PAT-СЕКРЕТ', calls[0].init.headers.Authorization);
  reset();
  responder = () => ({ body: { searchResults: [] } });
  await call('xwiki_search', { query: 'отпуск' });
  const basic = calls[0].init.headers.Authorization;
  ok('xWiki получает Basic из логина и пароля',
     basic.startsWith('Basic ') &&
     Buffer.from(basic.slice(6), 'base64').toString('utf8') === 'ivanov:ПАРОЛЬ', basic);

  console.log('\n── Маршрут через прокси ──');
  reset();
  responder = () => ({ body: { results: [], size: 0 } });
  await call('confluence_search', { text: 'x' });
  ok('без прокси запрос идёт напрямую',
     calls[0].url.startsWith('https://conf.corp.local/rest/api/'), calls[0].url);

  await db.put('settings', { key: 'proxy', baseUrl: 'http://localhost:3000', allowSso: false });
  reset();
  await call('confluence_search', { text: 'x' });
  ok('с настроенным прокси — через него',
     calls[0].url.startsWith('http://localhost:3000/?url='), calls[0].url);
  ok('целевой адрес закодирован целиком',
     decodeURIComponent(calls[0].url.split('?url=')[1]).startsWith('https://conf.corp.local/rest/api/'));

  console.log('\n── Чтение страниц ──');
  responder = () => ({ body: {
    id: '123', title: 'Отпуска', space: { key: 'HR' }, version: { number: 4 },
    body: { storage: { value: '<p>Первый абзац</p><ul><li>пункт</li></ul><p>Второй</p>' } },
  } });
  const page = await call('confluence_get_page', { page_id: '123' });
  ok('страница прочитана', page.id === '123' && page.title === 'Отпуска' && page.version === 4);
  ok('разметка превращена в текст',
     page.content.includes('Первый абзац') && page.content.includes('• пункт') && !page.content.includes('<p>'),
     JSON.stringify(page.content));

  responder = () => ({ body: { space: 'Main', name: 'WebHome', title: 'Главная', version: '2.1', content: '= Заголовок =' } });
  const xp = await call('xwiki_get_page', { space: 'Main', page: 'WebHome' });
  ok('страница xWiki прочитана', xp.page === 'WebHome' && xp.content.includes('Заголовок'));

  console.log('\n── Правка ──');
  // Confluence сам подставляет следующую версию: если бы номер придумывала
  // модель, правка молча уходила бы в конфликт.
  let seen = [];
  responder = (url, init) => {
    seen.push({ url, method: init.method || 'GET', body: init.body });
    if ((init.method || 'GET') === 'GET') return { body: { id: '7', title: 'Старое', space: { key: 'HR' }, version: { number: 9 } } };
    return { body: { id: '7', title: 'Новое', version: { number: 10 } } };
  };
  const upd = await call('confluence_update_page', { page_id: '7', content: '<p>текст</p>', title: 'Новое' });
  ok('правка прошла', upd.success === true && upd.version === 10, JSON.stringify(upd));
  const sent = JSON.parse(seen.find(s => s.method === 'PUT').body);
  ok('номер версии взят с сервера и увеличен на единицу', sent.version.number === 10, String(sent.version.number));
  ok('пространство сохранено из текущей страницы', sent.space.key === 'HR');

  // xWiki: создание не должно перезаписывать существующее.
  responder = (url, init) => ((init.method || 'GET') === 'GET'
    ? { body: { space: 'Main', name: 'Есть', content: 'старое' } }   // страница существует
    : { body: { space: 'Main', name: 'Есть', version: '2.1' } });
  const dup = await call('xwiki_create_page', { space: 'Main', page: 'Есть', content: 'новое' });
  ok('создание не перезаписывает существующую страницу',
     !!dup.error && /уже существует/.test(dup.error), JSON.stringify(dup));
  ok('и подсказывает правильный инструмент', /xwiki_update_page/.test(dup.hint || ''));

  reset();
  const updX = await call('xwiki_update_page', { space: 'Main', page: 'Есть', content: 'новое', title: 'Т' });
  ok('обновление существующей проходит', updX.success === true, JSON.stringify(updX));
  const put = calls.find(c => (c.init.method || '') === 'PUT');
  ok('содержимое ушло формой', /content=%D0%BD%D0%BE%D0%B2%D0%BE%D0%B5/.test(put.init.body), put.init.body);

  console.log('\n── Ошибки доступа ──');
  responder = () => ({ status: 401, body: 'unauthorized' });
  const denied = await call('confluence_search', { text: 'x' });
  ok('401 объяснён по-человечески', /отклонил доступ/.test(denied.error || ''), JSON.stringify(denied));
  ok('и предложено перенастроить доступ', /confluence_configure/.test(denied.hint || ''));
  ok('в тексте ошибки нет токена', !JSON.stringify(denied).includes('PAT-СЕКРЕТ'));

  responder = () => ({ status: 502, body: JSON.stringify({ tlsError: true, code: 'DEPTH_ZERO_SELF_SIGNED_CERT', error: 'сертификат', howToFix: ['a'] }) });
  const tls = await call('xwiki_search', { query: 'x' });
  ok('сбой сертификата от прокси доносится как есть', tls.tlsError === true && tls.code === 'DEPTH_ZERO_SELF_SIGNED_CERT');

  console.log('\n── Категории безопасности ──');
  const sec = new SecurityEngine();
  ok('чтение — read', sec.categoryOf('confluence_search') === 'read' && sec.categoryOf('xwiki_get_page') === 'read');
  ok('запись — write', sec.categoryOf('confluence_update_page') === 'write' && sec.categoryOf('xwiki_create_page') === 'write');
  ok('настройка — write', sec.categoryOf('confluence_configure') === 'write');

  console.log('\n── Навыки ──');
  const skills = new SkillsEngine(db);
  const all = await skills.loadSkills();
  const sc = all.find(s => s.id === 'skill_confluence');
  const sx = all.find(s => s.id === 'skill_xwiki');
  ok('навык Confluence заведён и выключен', !!sc && sc.enabled === false);
  ok('к нему привязаны все семь инструментов', skills.toolIdsOf(sc).length === 7, String(skills.toolIdsOf(sc).length));
  ok('навык xWiki заведён и выключен', !!sx && sx.enabled === false);
  ok('к нему привязаны все семь инструментов', skills.toolIdsOf(sx).length === 7);
  ok('промпт запрещает принимать токен сообщением',
     /не проси прислать токен/.test(sc.systemPrompt) && /не проси прислать пароль/.test(sx.systemPrompt));
  ok('промпт требует согласовывать правку', /дождись согласия|с его согласия/.test(sx.systemPrompt + sc.systemPrompt));
  ok('сказано, что содержимое страниц — данные, а не указания',
     /данные, а не указания/.test(sc.systemPrompt) && /данные, а не указания/.test(sx.systemPrompt));

  // Диалог включения инструментов навыка (Цикл 30) должен предложить именно их.
  const off = await skills.disabledToolsOf('skill_confluence');
  ok('при включении навыка предложат включить его инструменты', off.length === 7, String(off.length));

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('СБОЙ ТЕСТА:', e); process.exit(1); });
