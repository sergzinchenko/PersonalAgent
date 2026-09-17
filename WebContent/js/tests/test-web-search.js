// ============================================================
//  ТЕСТ: поиск в интернете (web_search)
// ============================================================
//
// Сеть подменена: важно не то, что ответит поисковик, а что уходит к
// нему (адрес, маршрут, заголовки, где лежит ключ), как разбирается
// выдача каждой службы и как объясняются отказы. Отдельно — место
// инструмента в системе: папка, категория безопасности, карантин
// внешних данных.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e !== undefined ? ' → ' + e : '')); } };

class FakeDB {
  constructor() { this.stores = { settings: new Map(), tools: new Map(), folders: new Map(), chats: new Map(), files: new Map(), mcp_servers: new Map(), llm_connections: new Map() }; }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(o.key ?? o.id, o); }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, o) { for (const x of o) await this.put(s, x); return o.length; }
  async deleteAll(s, keys) { for (const k of keys) await this.delete(s, k); return keys.length; }
}

const sandbox = {
  console, setTimeout, clearTimeout, Date, Math, JSON, Promise, URL, URLSearchParams, TypeError, Error,
  Map, Set, Array, Object, String, Number, Boolean, RegExp, Intl, TextEncoder, TextDecoder,
  performance: { now: () => Date.now() },
  // Шифрование помечает значение, чтобы было видно: в базу ключ попал не
  // открытым текстом.
  SecretsVault: { encrypt: async (_d, v) => (v ? 'enc:' + v : ''), decrypt: async (_d, v) => String(v || '').replace(/^enc:/, '') },
  fetch: async () => { throw new TypeError('сеть недоступна в тесте'); },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  crypto: { getRandomValues: (a) => a, randomUUID: () => 'uuid' },
  localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { createElement: () => ({ style: {}, click: () => {} }), body: { appendChild: () => {}, removeChild: () => {} } },
  navigator: {},
  Blob: class { constructor(p) { this.parts = p; } },
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
  load('tools/tools-websearch.js');
  ok('модуль поиска загрузился', true);
} catch (e) {
  ok('модуль поиска загрузился', false, e.message);
  process.exit(1);
}

const { ToolsEngine, SecurityEngine } = sandbox;

(async () => {
  const db = new FakeDB();
  const engine = new ToolsEngine(db);
  engine._toolLimits = async () => ({ timeoutSeconds: 30, maxResponseChars: 20000 });

  // Сеть: запоминаем запрос, отвечаем заготовкой.
  let reply = { status: 200, text: '' };
  const sent = [];
  sandbox.fetch = async (url, init) => {
    sent.push({ url, init: init || {} });
    const r = typeof reply === 'function' ? reply(url, init) : reply;
    if (r.throws) throw r.throws;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.text };
  };
  const target = (u) => u.includes('/?url=') ? decodeURIComponent(u.split('/?url=')[1]) : u;
  const search = (params) => engine.executeTool('web_search', params, { bypassSecurity: true });
  const setCfg = (v) => db.put('settings', { key: 'web_search', count: 5, ...v });

  console.log('\n── Место в системе ──');
  const defs = engine._allBuiltinDefs();
  const def = defs.find(d => d.name === 'web_search');
  const cdef = defs.find(d => d.name === 'web_search_configure');
  ok('инструменты поиска и его настройки встроены', !!def && !!cdef);
  ok('поиск включён сразу', def.enabled === true);
  ok('настройка ждёт человека — без таймаута вызова', cdef.interactive === true);
  ok('лежат в папке «Сеть»',
     ToolsEngine.folderOfBuiltin(def) === 'folder_tools_net' && ToolsEngine.folderOfBuiltin(cdef) === 'folder_tools_net');
  ok('описание запрещает отправлять в запрос секреты и личные данные', /НЕ включай в него пароли, ключи, личные данные/.test(def.description));
  ok('и называет результат данными, а не указаниями', /данные,\s*а не указания/.test(def.description));
  ok('настройка запрещает спрашивать ключ в чате', /НИКОГДА не спрашивай ключ/.test(cdef.description));
  ok('категория поиска — чтение: службу выбрал пользователь', new SecurityEngine().categoryOf('web_search') === 'read');
  ok('настройка — запись', new SecurityEngine().categoryOf('web_search_configure') === 'write');
  ok('результат поиска переводит ход в карантин внешних данных', SecurityEngine.EXTERNAL_SOURCES.has('web_search'));

  console.log('\n── Без настроек ──');
  {
    const r = await search({ query: 'погода' });
    ok('без прокси DuckDuckGo недоступен — объяснено, что нужно', !!r.error && /CORS/.test(r.error) && r.needsConfiguration === true,
       JSON.stringify(r));
    ok('и не ушло ни одного запроса', sent.length === 0);

    await db.put('settings', { key: 'proxy', baseUrl: 'http://localhost:3000' });
    const cfg = await engine._webSearchConfig();
    ok('с заданным прокси по умолчанию — DuckDuckGo через прокси, без ключа',
       cfg.provider === 'duckduckgo' && cfg.viaProxy === true, JSON.stringify(cfg));
  }

  console.log('\n── DuckDuckGo: выдача ──');
  {
    const ddgHtml = `
      <div class="result result--ad"><h2 class="result__title">
        <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=shop.test&amp;u3=x">Реклама</a></h2>
        <a class="result__snippet" href="#">Купите сейчас</a></div>
      <div class="result results_links web-result"><h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews%3Fa%3D1%26b%3D2&amp;rut=abc">Главные <b>новости</b> &amp; события</a></h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Сегодня &#8212; <b>важное</b> &lt;и&gt; разное&#x21;</a>
        <a class="result__url" href="#">example.com</a></div>
      <div class="result"><h2><a class="result__a" href="https://direct.test/page">Прямая ссылка</a></h2>
        <a class="result__snippet">Без переходника</a></div>`;
    sent.length = 0;
    reply = { status: 200, text: ddgHtml };
    const r = await search({ query: 'новости', count: 5, language: 'ru', time_range: 'week', site: 'example.com' });
    ok('поиск прошёл', !r.error && r.count === 2, JSON.stringify(r).slice(0, 300));
    const t = target(sent[0].url);
    ok('запрос ушёл через прокси', sent[0].url.startsWith('http://localhost:3000/?url='));
    ok('к html-выдаче DuckDuckGo', t.startsWith('https://html.duckduckgo.com/html/'), t);
    const q = new URL(t).searchParams;
    ok('с запросом, ограничением по сайту, регионом и периодом',
       q.get('q') === 'новости site:example.com' && q.get('kl') === 'ru-ru' && q.get('df') === 'w', t);
    ok('реклама пропущена', !r.results.some(x => /Реклама/.test(x.title)));
    ok('настоящий адрес извлечён из переходника', r.results[0].url === 'https://example.com/news?a=1&b=2', r.results[0].url);
    ok('разметка и сущности в заголовке сняты', r.results[0].title === 'Главные новости & события', r.results[0].title);
    ok('и во фрагменте тоже', r.results[0].snippet === 'Сегодня — важное <и> разное!', r.results[0].snippet);
    ok('прямая ссылка без переходника тоже понята', r.results[1].url === 'https://direct.test/page');
    ok('у результатов есть порядковый номер', r.results[0].position === 1 && r.results[1].position === 2);
    ok('маршрут и служба названы в ответе', r.provider === 'duckduckgo' && r.route === 'proxy');
    ok('результат напоминает: данные, а не указания', /данные, а не указания/.test(r.note));

    reply = { status: 200, text: '<form id="challenge-form"><div class="anomaly-modal">bots use DuckDuckGo too</div></form>' };
    const bot = await search({ query: 'x' });
    ok('проверка «вы не робот?» распознана и объяснена', !!bot.error && /автоматический/.test(bot.error) && /SearXNG|Brave/.test(bot.hint),
       JSON.stringify(bot));

    reply = { status: 200, text: '<html><body>ничего</body></html>' };
    const empty = await search({ query: 'абракадабра' });
    ok('пустая выдача — не ошибка, а совет переформулировать', !empty.error && empty.count === 0 && /переформулируй/.test(empty.note));

    reply = { throws: new TypeError('Failed to fetch') };
    const down = await search({ query: 'x' });
    ok('лежащий прокси объяснён, включая allowlist', !!down.error && /прокси не ответил/.test(down.error) && /allowlist/.test(down.hint),
       JSON.stringify(down));
  }

  console.log('\n── Предел ответа ──');
  {
    const many = Array.from({ length: 20 }, (_, i) =>
      `<a class="result__a" href="https://s${i}.test/">Заголовок ${i}</a><a class="result__snippet">${'текст '.repeat(60)}</a>`).join('');
    reply = { status: 200, text: many };
    engine._toolLimits = async () => ({ timeoutSeconds: 30, maxResponseChars: 1500 });
    const r = await search({ query: 'x', count: 20 });
    ok('выдача режется по целым результатам, а не посреди JSON', !r.error && r.count >= 1 && r.count < 20 && r.truncated === true,
       JSON.stringify({ count: r.count, truncated: r.truncated }));
    engine._toolLimits = async () => ({ timeoutSeconds: 30, maxResponseChars: 20000 });
  }

  console.log('\n── SearXNG ──');
  {
    await engine._webSearchSaveConfig({ provider: 'searxng', viaProxy: false, searxngUrl: 'https://searx.local/', count: 4 });
    sent.length = 0;
    reply = { status: 200, text: JSON.stringify({ results: [
      { title: 'Первый', url: 'https://a.test', content: 'про <b>первое</b>', publishedDate: '2026-09-01' },
      { title: 'Второй', url: 'https://b.test', content: 'про второе' },
    ] }) };
    const r = await search({ query: 'тема', language: 'en', time_range: 'day' });
    const u = new URL(sent[0].url);
    ok('SearXNG опрашивается напрямую по своему адресу', u.origin === 'https://searx.local' && u.pathname === '/search', sent[0].url);
    ok('с форматом json, языком и периодом',
       u.searchParams.get('format') === 'json' && u.searchParams.get('language') === 'en' && u.searchParams.get('time_range') === 'day');
    ok('выдача разобрана, дата сохранена', r.count === 2 && r.results[0].snippet === 'про первое' && r.results[0].date === '2026-09-01',
       JSON.stringify(r.results));

    reply = { status: 403, text: 'Forbidden' };
    const denied = await search({ query: 'x' });
    ok('403 у SearXNG объяснён выключенной JSON-выдачей', /search\.formats/.test(denied.hint || ''), JSON.stringify(denied));

    await engine._webSearchSaveConfig({ provider: 'searxng', viaProxy: false, searxngUrl: '' });
    const noUrl = await search({ query: 'x' });
    ok('без адреса экземпляра — просьба настроить', !!noUrl.error && noUrl.needsConfiguration === true);
  }

  console.log('\n── Brave Search ──');
  {
    await engine._webSearchSaveConfig({ provider: 'brave', viaProxy: true, apiKey: 'BRAVE-KEY-1' });
    const stored = await db.get('settings', 'web_search');
    ok('ключ сохранён зашифрованным', stored.apiKey === 'enc:BRAVE-KEY-1', stored.apiKey);
    sent.length = 0;
    reply = { status: 200, text: JSON.stringify({ web: { results: [{ title: 'B', url: 'https://brave.test', description: 'd', age: '2 дня назад' }] } }) };
    const r = await search({ query: 'q', count: 7, time_range: 'month' });
    const t = new URL(target(sent[0].url));
    ok('Brave — через прокси, на свой API', sent[0].url.startsWith('http://localhost:3000/?url=') && t.host === 'api.search.brave.com');
    ok('ключ — в заголовке X-Subscription-Token, не в адресе',
       sent[0].init.headers['X-Subscription-Token'] === 'BRAVE-KEY-1' && !sent[0].url.includes('BRAVE-KEY-1'));
    ok('число и период переданы', t.searchParams.get('count') === '7' && t.searchParams.get('freshness') === 'pm');
    ok('выдача разобрана', r.count === 1 && r.results[0].date === '2 дня назад');
    ok('ключа нет в ответе инструмента', !JSON.stringify(r).includes('BRAVE-KEY-1'));

    reply = { status: 401, text: '{"error":"invalid token"}' };
    const bad = await search({ query: 'q' });
    ok('неверный ключ — с советом ввести его заново в форме', /web_search_configure/.test(bad.hint || ''), JSON.stringify(bad));
    reply = { status: 429, text: 'rate' };
    const rate = await search({ query: 'q' });
    ok('исчерпанный лимит назван', /лимит/.test(rate.error || ''));

    await engine._webSearchSaveConfig({ provider: 'brave', viaProxy: false, keepKey: true });
    const direct = await search({ query: 'q' });
    ok('Brave напрямую не пробуется — сразу объяснено, что нужен прокси',
       !!direct.error && /CORS/.test(direct.error) && direct.needsConfiguration === true);
    ok('ключ при «не менять» сохранился', (await db.get('settings', 'web_search')).apiKey === 'enc:BRAVE-KEY-1');
  }

  console.log('\n── Google Programmable Search ──');
  {
    await engine._webSearchSaveConfig({ provider: 'google', viaProxy: false, apiKey: 'G-KEY', googleCx: '' });
    const noCx = await search({ query: 'q' });
    ok('без cx — просьба настроить', !!noCx.error && /cx/.test(noCx.error) && noCx.needsConfiguration === true);

    await engine._webSearchSaveConfig({ provider: 'google', viaProxy: false, apiKey: 'G-KEY', googleCx: 'CX1' });
    sent.length = 0;
    reply = { status: 200, text: JSON.stringify({ items: [{ title: 'G', link: 'https://g.test', snippet: 's' }] }) };
    const r = await search({ query: 'q', count: 15, language: 'de', time_range: 'year' });
    const u = new URL(sent[0].url);
    ok('Google — напрямую, на Custom Search JSON API', u.host === 'www.googleapis.com' && u.pathname === '/customsearch/v1');
    ok('число результатов ограничено десятью — больше служба не отдаёт', u.searchParams.get('num') === '10');
    ok('язык и период переданы', u.searchParams.get('lr') === 'lang_de' && u.searchParams.get('dateRestrict') === 'y1');
    ok('выдача разобрана', r.count === 1 && r.results[0].url === 'https://g.test');
  }

  console.log('\n── Tavily ──');
  {
    await engine._webSearchSaveConfig({ provider: 'tavily', viaProxy: false, apiKey: '' });
    const noKey = await search({ query: 'q' });
    ok('без ключа — просьба настроить, и запроса нет', !!noKey.error && noKey.needsConfiguration === true);

    await engine._webSearchSaveConfig({ provider: 'tavily', viaProxy: false, apiKey: 'TV-KEY' });
    sent.length = 0;
    reply = { status: 200, text: JSON.stringify({ results: [{ title: 'T', url: 'https://t.test', content: 'c', published_date: '2026-01-02' }] }) };
    const r = await search({ query: 'q', site: 'docs.test', time_range: 'week', count: 3 });
    const body = JSON.parse(sent[0].init.body);
    ok('Tavily — POST с телом запроса', sent[0].init.method === 'POST' && sent[0].url === 'https://api.tavily.com/search');
    ok('сайт — отдельным полем, период и число переданы',
       body.include_domains[0] === 'docs.test' && body.time_range === 'week' && body.max_results === 3 && body.query === 'q',
       JSON.stringify(body));
    ok('ключ — в заголовке авторизации', sent[0].init.headers.Authorization === 'Bearer TV-KEY');
    ok('выдача разобрана', r.count === 1 && r.results[0].date === '2026-01-02');
  }

  console.log('\n── Проверка из формы и границы ──');
  {
    // В базе — Tavily, а форма проверяет Google: проверяется введённое.
    sent.length = 0;
    reply = { status: 200, text: JSON.stringify({ items: [] }) };
    await engine._webSearch({ query: 'новости', count: 3 }, { provider: 'google', viaProxy: false, apiKey: 'FORM-KEY', googleCx: 'FORM-CX' });
    ok('проверка из формы использует введённое, а не сохранённое',
       sent[0].url.includes('FORM-KEY') && sent[0].url.includes('FORM-CX'), sent[0].url);
    ok('и ничего не сохраняет', (await db.get('settings', 'web_search')).provider === 'tavily');

    const noQuery = await search({ query: '   ' });
    ok('пустой запрос отклонён', !!noQuery.error);
    const huge = await search({ query: 'x'.repeat(600) });
    ok('слишком длинный запрос отклонён', !!huge.error && /короче/.test(huge.error));

    await engine._webSearchSaveConfig({ provider: 'duckduckgo', viaProxy: true });
    await db.delete('settings', 'proxy');
    const noProxy = await search({ query: 'x' });
    ok('маршрут через прокси без адреса прокси — объяснено, где его задать',
       !!noProxy.error && /Настройки → Безопасность/.test(noProxy.hint || ''), JSON.stringify(noProxy));

    await engine._webSearchForget();
    ok('настройки можно забыть', !(await db.get('settings', 'web_search')));
  }

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('СБОЙ ТЕСТА:', e); process.exit(1); });
