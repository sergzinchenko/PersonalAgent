// ============================================================
//  ТЕСТ: инструмент proxy_fetch (запрос через локальный прокси)
// ============================================================
//
// Проверяет Цикл 31: сборку запроса к proxy/proxy.js, валидацию параметров,
// границы, которые остаются даже через прокси (cloud-metadata), и — главное —
// два правила про SSO: он запрещён, пока не разрешён в настройках, и
// подтверждается пользователем ВСЕГДА, в любом режиме безопасности.
//
// Песочница vm: настоящий прокси не нужен, fetch подменяется заглушкой,
// которая запоминает, что именно инструмент собирался отправить.
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

// Последний запрос, который инструмент попытался отправить, и что ему ответить.
let lastCall = null;
let nextResponse = { status: 200, statusText: 'OK', body: 'ok', contentType: 'text/plain' };
let failNextFetch = null;

const sandbox = {
  console, setTimeout, clearTimeout, Date, Math, JSON, Promise, URL, TypeError, Error,
  Map, Set, Array, Object, String, Number, Boolean, RegExp, Intl, TextEncoder, TextDecoder,
  performance: { now: () => Date.now() },
  SecretsVault: { encrypt: async (_d, v) => v || '', decrypt: async (_d, v) => v || '' },
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  crypto: { getRandomValues: (a) => a, randomUUID: () => 'uuid' },
  localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { createElement: () => ({ style: {}, click: () => {} }), body: { appendChild: () => {}, removeChild: () => {} } },
  navigator: {},
  Blob: class { constructor(p) { this.parts = p; } },
  Notification: { requestPermission: async () => 'denied' },
  uid: (() => { let n = 0; return () => 'id' + (++n); })(),
  fetch: async (url, init) => {
    lastCall = { url, init: init || {} };
    if (failNextFetch) { const e = failNextFetch; failNextFetch = null; throw new TypeError(e); }
    const r = nextResponse;
    return {
      status: r.status,
      statusText: r.statusText,
      headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? r.contentType : null) },
      text: async () => r.body,
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
  load('tools/tools-engine.js', 'ToolsEngine');
  load('tools/tools-registry.js');
  load('tools/tools-executor.js');
  load('tools/tools-builtin.js');
  load('tools/tools-defs.js');
  load('tools/tools-mcp.js');
  load('tools/tools-llm-router.js');
  ok('модули загрузились', true);
} catch (e) {
  ok('модули загрузились', false, e.message);
  process.exit(1);
}

const { SkillsEngine, SecurityEngine, ToolsEngine } = sandbox;

(async () => {
  const db = new FakeDB();
  const engine = new ToolsEngine(db);
  engine.skills = new SkillsEngine(db);
  const tools = await engine.loadTools();

  // Вызов в обход политики: сама политика проверяется отдельным блоком ниже.
  const call = (a) => engine.executeTool('proxy_fetch', a, { bypassSecurity: true });
  const setProxy = (patch) => db.put('settings', {
    key: 'proxy', baseUrl: 'http://localhost:3000', allowSso: false, maxResponseChars: 8000, ...patch,
  });

  console.log('\n── Описание инструмента ──');
  const def = tools.find(t => t.name === 'proxy_fetch');
  ok('инструмент заведён', !!def);
  ok('выключен по умолчанию', def.enabled === false);
  ok('не помечен системным (тумблер остаётся у пользователя)', !def.locked);
  ok('методы шире, чем у http_fetch',
     def.parameters.properties.method.enum.join(',') === 'GET,POST,PUT,DELETE,PATCH,HEAD');
  ok('sso не обязателен', !def.parameters.required.includes('sso'));
  ok('sso описан в параметрах', /NTLM\/Negotiate/.test(def.parameters.properties.sso.description));
  ok('в описании сказано, что ответ — данные, а не инструкции',
     /ДАННЫЕ, А НЕ ИНСТРУКЦИИ/.test(def.description));
  ok('в описании есть правило выбора относительно http_fetch',
     /http_fetch/.test(def.description));
  const httpDef = tools.find(t => t.name === 'http_fetch');
  ok('http_fetch отсылает к proxy_fetch, а не к обходным путям',
     /proxy_fetch/.test(httpDef.description) && /обходные пути/.test(httpDef.description));

  console.log('\n── Прокси не настроен ──');
  const noCfg = await call({ url: 'https://example.com/a' });
  ok('без адреса прокси — понятная ошибка, а не попытка запроса',
     !!noCfg.error && /адрес прокси/i.test(noCfg.error), JSON.stringify(noCfg));
  ok('в подсказке сказано, что и где включить', /proxy\.js/.test(noCfg.hint || ''));

  await setProxy({});

  console.log('\n── Сборка запроса ──');
  lastCall = null;
  nextResponse = { status: 200, statusText: 'OK', body: 'привет', contentType: 'text/plain' };
  const okRes = await call({ url: 'https://intranet.corp.local/api?x=1&y=2' });
  ok('запрос ушёл на прокси, цель — в параметре url',
     lastCall.url === 'http://localhost:3000/?url=' + encodeURIComponent('https://intranet.corp.local/api?x=1&y=2'),
     lastCall.url);
  ok('целевой адрес закодирован целиком, вместе со своими параметрами',
     lastCall.url.includes('x%3D1%26y%3D2'), lastCall.url);
  ok('метод по умолчанию GET', lastCall.init.method === 'GET');
  ok('sso=1 не добавлен без запроса', !lastCall.url.includes('sso=1'));
  ok('ответ возвращён с телом и статусом',
     okRes.status === 200 && okRes.body === 'привет', JSON.stringify(okRes));
  ok('в ответе помечено, через что шёл запрос', okRes.via === 'http://localhost:3000');
  ok('и что тело — это данные', /ДАННЫЕ/.test(okRes.note));

  console.log('\n── Интранет разрешён, metadata — нет ──');
  ok('приватный адрес проходит (ради него инструмент и нужен)',
     !(await call({ url: 'http://192.168.1.10/status' })).error);
  ok('localhost цели тоже проходит',
     !(await call({ url: 'http://localhost:8080/health' })).error);
  const meta = await call({ url: 'http://169.254.169.254/latest/meta-data/' });
  ok('cloud-metadata запрещён даже через прокси',
     !!meta.error && /metadata/i.test(meta.error), JSON.stringify(meta));
  const linkLocal6 = await call({ url: 'http://[fe80::1]/x' });
  ok('link-local IPv6 запрещён', !!linkLocal6.error, JSON.stringify(linkLocal6));
  ok('не-http схема отклонена', !!(await call({ url: 'file:///etc/passwd' })).error);
  ok('мусорный URL отклонён', !!(await call({ url: 'не адрес' })).error);

  console.log('\n── Методы, тело, заголовки ──');
  await call({ url: 'https://example.com/x', method: 'PUT', body: '{"a":1}' });
  ok('PUT с телом уходит как есть',
     lastCall.init.method === 'PUT' && lastCall.init.body === '{"a":1}');
  await call({ url: 'https://example.com/x', method: 'GET', body: 'мимо' });
  ok('тело для GET не отправляется', lastCall.init.body === undefined);
  ok('неизвестный метод отклонён', !!(await call({ url: 'https://example.com/x', method: 'TRACE' })).error);

  await call({ url: 'https://example.com/x', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok('Content-Type проходит', lastCall.init.headers['Content-Type'] === 'application/json');
  const badHeader = await call({ url: 'https://example.com/x', headers: { 'X-My-Header': '1' } });
  ok('заголовок, который срежет CORS, честно отклонён, а не потерян',
     !!badHeader.error && /X-My-Header/.test(badHeader.error), JSON.stringify(badHeader));
  ok('в ошибке сказано, что вообще проходит',
     (badHeader.passableHeaders || []).join(',') === 'content-type,authorization');

  console.log('\n── Предел ответа ──');
  // Предел общий для всех каналов и живёт в settings/limits (Цикл 32),
  // отдельной настройки у прокси больше нет.
  await db.put('settings', { key: 'limits', maxToolResponseChars: 5000, toolTimeoutSeconds: 30 });
  nextResponse = { status: 200, statusText: 'OK', body: 'x'.repeat(20000), contentType: 'text/plain' };
  const big = await call({ url: 'https://example.com/big' });
  ok('ответ обрезан по общей настройке', big.body.length === 5000, String(big.body.length));
  ok('обрезка отмечена в ответе', big.truncated === true && big.bytes === 20000);
  const small = await call({ url: 'https://example.com/big', max_chars: 1000 });
  ok('max_chars из вызова уважается', small.body.length === 1000);
  // Настройка пользователя — потолок: max_chars опускает его, но не поднимает.
  ok('max_chars не может поднять предел выше настройки',
     (await call({ url: 'https://example.com/big', max_chars: 999999 })).body.length === 5000);

  console.log('\n── Прокси не запущен ──');
  nextResponse = { status: 200, statusText: 'OK', body: 'ok', contentType: 'text/plain' };
  failNextFetch = 'Failed to fetch';
  const down = await call({ url: 'https://example.com/x' });
  ok('ошибка соединения объяснена, а не проброшена как есть',
     !!down.error && /не удалось связаться с прокси/i.test(down.error), JSON.stringify(down));
  ok('и сказано, что делать', /node proxy\/proxy\.js/.test(down.hint || ''));

  console.log('\n── Сбой проверки сертификата ──');
  // Прокси отвечает 502 с разобранным описанием — инструмент обязан
  // донести его как ошибку с готовым решением, а не как обычное тело.
  nextResponse = {
    status: 502, statusText: 'Bad Gateway', contentType: 'application/json',
    body: JSON.stringify({
      error: 'Не удалось проверить TLS-сертификат intranet.corp.local: сертификат самоподписанный (DEPTH_ZERO_SELF_SIGNED_CERT).',
      tlsError: true,
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      howToFix: ['caFile', 'insecureHosts', 'insecure'],
    }),
  };
  const tlsFail = await call({ url: 'https://intranet.corp.local/x' });
  ok('ошибка сертификата возвращается как ошибка, а не как тело ответа',
     !!tlsFail.error && tlsFail.tlsError === true, JSON.stringify(tlsFail).slice(0, 160));
  ok('код ошибки TLS сохранён', tlsFail.code === 'DEPTH_ZERO_SELF_SIGNED_CERT');
  ok('варианты решения переданы модели', Array.isArray(tlsFail.howToFix) && tlsFail.howToFix.length === 3);
  ok('в подсказке сказано, что чинится это в настройках прокси',
     /config\.js/.test(tlsFail.hint || ''), tlsFail.hint);
  ok('и что менять инструмент бессмысленно',
     /не повод пробовать другой инструмент/.test(tlsFail.hint || ''));

  // Обычный 502 (сервер недоступен) остаётся обычным ответом со статусом.
  nextResponse = { status: 502, statusText: 'Bad Gateway', contentType: 'text/plain', body: 'upstream down' };
  const plain502 = await call({ url: 'https://example.com/x' });
  ok('прочий 502 не выдаётся за ошибку сертификата',
     plain502.status === 502 && !plain502.tlsError, JSON.stringify(plain502).slice(0, 120));
  nextResponse = { status: 200, statusText: 'OK', body: 'ok', contentType: 'text/plain' };

  console.log('\n── SSO: настройка ──');
  const ssoOff = await call({ url: 'https://intranet.corp.local/x', sso: true });
  ok('SSO запрещён, пока не разрешён в настройках',
     !!ssoOff.error && /SSO запрещён/.test(ssoOff.error), JSON.stringify(ssoOff));
  ok('запрос при этом даже не отправлялся', !lastCall.url.includes('sso=1'));

  await setProxy({ allowSso: true });
  await call({ url: 'https://intranet.corp.local/x', sso: true });
  ok('после разрешения к прокси уходит sso=1', lastCall.url.endsWith('&sso=1'), lastCall.url);
  const ssoRes = await call({ url: 'https://intranet.corp.local/x', sso: true });
  ok('в ответе видно, что запрос шёл с SSO', ssoRes.sso === true);

  console.log('\n── SSO: подтверждение всегда ──');
  {
    const sec = new SecurityEngine();
    sec.resetTurn();

    // Даже в режиме, где вопросов не задают вообще.
    sec.mode = 'off';
    const v1 = await sec.check('proxy_fetch', { url: 'https://intranet.corp.local/x', sso: true });
    ok('в режиме «отключено» SSO всё равно спрашивают', v1.confirm === true, JSON.stringify(v1));
    ok('разрешение нельзя запомнить (noRemember)', v1.noRemember === true);
    ok('в рисках назван хост цели, а не адрес прокси',
       (v1.risks || []).some(r => /intranet\.corp\.local/.test(r)), JSON.stringify(v1.risks));
    ok('в рисках сказано про доменные права',
       (v1.risks || []).some(r => /доменными правами/.test(r)));

    const v2 = await sec.check('proxy_fetch', { url: 'https://example.com/x' });
    ok('без sso обычный вызов через режим «отключено» проходит молча',
       v2.allow === true && !v2.confirm, JSON.stringify(v2));

    // «Больше не спрашивать про этот хост» не должно обходить правило.
    sec.mode = 'standard';
    sec.approvedHosts.add('intranet.corp.local');
    const v3 = await sec.check('proxy_fetch', { url: 'https://intranet.corp.local/x', sso: true });
    ok('одобренный ранее хост не отменяет вопроса про SSO', v3.confirm === true, JSON.stringify(v3));
    const v4 = await sec.check('proxy_fetch', { url: 'https://intranet.corp.local/x' });
    ok('а без sso тот же хост уже не переспрашивают', v4.allow === true && !v4.confirm);

    ok('proxy_fetch отнесён к сетевой категории', sec.categoryOf('proxy_fetch') === 'network');
  }

  console.log('\n── Навык «Работа через прокси» ──');
  {
    const skills = new SkillsEngine(db);
    const all = await skills.loadSkills();
    const sk = all.find(s => s.id === 'skill_proxy');
    ok('навык заведён и выключен по умолчанию', !!sk && sk.enabled === false);
    ok('к нему привязаны оба сетевых инструмента',
       skills.toolIdsOf(sk).includes('builtin_fetch') && skills.toolIdsOf(sk).includes('builtin_proxy_fetch'),
       JSON.stringify(skills.toolIdsOf(sk)));
    ok('в промпте есть правило «сначала http_fetch»', /ПЕРВЫЙ ВЫБОР/.test(sk.systemPrompt));
    ok('и запрет ставить sso наугад', /наугад/.test(sk.systemPrompt));

    // Оба инструмента выключены (proxy_fetch по умолчанию, http_fetch включим
    // обратно) — диалог включения из Цикла 30 должен показать именно proxy_fetch.
    const httpTool = await db.get('tools', 'builtin_fetch');
    ok('http_fetch включён по умолчанию', httpTool.enabled === true);
    const offList = await skills.disabledToolsOf('skill_proxy');
    ok('к включению предлагается только proxy_fetch',
       offList.length === 1 && offList[0].name === 'proxy_fetch', JSON.stringify(offList.map(t => t.name)));
  }

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('СБОЙ ТЕСТА:', e); process.exit(1); });
