// ============================================================
//  ТЕСТ: песочница для кода инструментов
// ============================================================
//
// Обещание одно: код, написанный моделью, не выполняется в приложении.
// У него нет доступа к данным агента и к странице, а в сеть он выходит
// только через мост, который проверяет адрес.
//
// Настоящий <iframe sandbox> в jsdom не исполняет srcdoc, поэтому
// проверяется не «строка с кодом», а обе стороны протокола по
// отдельности — и это честнее, чем сквозной прогон:
//   • рантайм кадра (ToolSandbox._runtime) выполняется здесь же, с
//     поддельным каналом сообщений: видно, что он реально возвращает,
//     чем отвечает на ошибку и что обезврежено;
//   • родительская сторона проверяется на настоящем элементе кадра:
//     атрибуты, протокол, таймаут, отбраковка чужих сообщений;
//   • мост fetch — на настоящем ToolsEngine, с политикой адресов.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + extra : '')); }
};

const ROOT = path.join(__dirname, '..', '..');
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

class FakeDB {
  constructor() {
    this.stores = { settings: new Map(), tools: new Map(), skills: new Map(), folders: new Map(),
      prompts: new Map(), chats: new Map(), messages: new Map(), files: new Map(),
      mcp_servers: new Map(), security_log: new Map(), artifacts: new Map(), tasks: new Map() };
  }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(o.key ?? o.id, o); }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, o) { for (const x of o) await this.put(s, x); return o.length; }
  async deleteAll(s, keys) { for (const k of keys) await this.delete(s, k); return keys.length; }
  async getAllByIndex(s, i, v) { return (await this.getAll(s)).filter(r => r[i] === v); }
}

(async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const document = window.document;
  window.performance = window.performance || { now: () => Date.now() };
  window.SecretsVault = { encrypt: async (_d, v) => v || '', decrypt: async (_d, v) => v || '' };

  const files = [
    'js/core/markdown.js',
    'js/core/log-guard.js',
    'js/core/tool-sandbox.js',
    'js/core/binary-formats.js',
    'js/engines/folders-engine.js',
    'js/engines/security-engine.js',
    'js/tools/tools-engine.js',
    'js/tools/tools-registry.js',
    'js/tools/tools-executor.js',
    'js/tools/tools-builtin.js',
    'js/tools/tools-defs.js',
    'js/tools/tools-mcp.js',
  ];
  window.eval(files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n') +
    '\nwindow.__X = { ToolSandbox, ToolsEngine, SecurityEngine, FoldersEngine };\n');
  const X = window.__X;

  // ══════════════════════════════════════════════
  // РАНТАЙМ КАДРА
  // ══════════════════════════════════════════════
  // Глобальным объектом для рантайма выступает НАСТОЯЩЕЕ окно теста, а не
  // заглушка: код инструмента компилируется через AsyncFunction и ищет
  // localStorage, fetch и прочее в реальной области видимости. С объектом-
  // заглушкой проверка «обезврежено» была бы самообманом — она проверяла
  // бы поле заглушки, а код смотрел бы мимо неё.
  const makeRuntime = ({ postImpl } = {}) => {
    const posted = [];
    const post = postImpl || (() => {});
    const api = X.ToolSandbox._runtime({
      global: window,
      post: (m) => { posted.push(m); return post(m); },
    });
    return { g: window, posted, api };
  };

  console.log('\n── Рантайм: запуск и результат ──');
  {
    const { posted, api } = makeRuntime();
    ok('кадр сообщает о готовности', posted.some(m => m.type === 'ready'));

    await api.handle({ __ts: 1, type: 'run', id: 'r1', code: 'return { sum: params.a + params.b };', params: { a: 2, b: 3 } });
    const res = posted.find(m => m.id === 'r1');
    ok('код выполняется и возвращает результат', res && res.type === 'result' && res.value.sum === 5,
       JSON.stringify(res));

    await api.handle({ __ts: 1, type: 'run', id: 'r2', code: 'await null; return { async: true };', params: {} });
    ok('await работает без обёрток', posted.find(m => m.id === 'r2').value.async === true);

    await api.handle({ __ts: 1, type: 'run', id: 'r3', code: 'throw new Error("так нельзя");', params: {} });
    const err = posted.find(m => m.id === 'r3');
    ok('ошибка возвращается сообщением, а не роняет кадр', err.type === 'error' && /так нельзя/.test(err.message));

    await api.handle({ __ts: 1, type: 'run', id: 'r4', code: 'return {', params: {} });
    ok('синтаксическая ошибка тоже возвращается', posted.find(m => m.id === 'r4').type === 'error');

    await api.handle({ __ts: 1, type: 'нет-такого', id: 'r5' });
    ok('незнакомое сообщение игнорируется', !posted.find(m => m.id === 'r5'));
    await api.handle({ type: 'run', id: 'r6', code: 'return 1;' });
    ok('сообщение без метки протокола игнорируется', !posted.find(m => m.id === 'r6'));
  }

  console.log('\n── Рантайм: что обезврежено ──');
  {
    const { posted, api } = makeRuntime();
    const runFor = async (id, code) => {
      await api.handle({ __ts: 1, type: 'run', id, code, params: {} });
      return posted.find(m => m.id === id);
    };
    const probe = async (id, expr) => runFor(id,
      'try { ' + expr + '; return { leaked: true }; } catch (e) { return { err: e.message }; }');

    const ls = await probe('n1', 'localStorage.getItem("x")');
    ok('localStorage недоступен', ls.value.err && /недоступен/.test(ls.value.err), JSON.stringify(ls.value));
    ok('и сказано, чем его заменить', /persistent_memory/.test(ls.value.err));

    const idb = await probe('n2', 'indexedDB.open("ai_agent_db")');
    ok('indexedDB недоступен', idb.value.err && /недоступен/.test(idb.value.err));

    const xhr = await probe('n3', 'new XMLHttpRequest()');
    ok('XMLHttpRequest обезврежен', xhr.value.err && /недоступен/.test(xhr.value.err));
    ok('и предложен fetch с проверкой адреса', /fetch/.test(xhr.value.err));

    const ws = await probe('n4', 'new WebSocket("wss://x")');
    ok('WebSocket обезврежен', ws.value.err && /недоступен/.test(ws.value.err));

    const ss = await probe('n5', 'sessionStorage.setItem("a","b")');
    ok('sessionStorage обезврежен', ss.value.err && /недоступен/.test(ss.value.err));

    // Выбор файла с диска в песочнице невозможен — важно, чтобы это было
    // сказано словами, а не «undefined is not a function».
    const picker = await probe('n6', 'showOpenFilePicker()');
    ok('выбор файла с диска объяснён, а не падает молча',
       picker.value.err && /недоступен/.test(picker.value.err), JSON.stringify(picker.value));
    ok('и указано, чем работать с файлами вместо него',
       /list_files|read_file|Файлы/.test(picker.value.err));
  }

  console.log('\n── Рантайм: мост fetch ──');
  {
    const { posted, api } = makeRuntime();
    const done = api.handle({
      __ts: 1, type: 'run', id: 'run1', params: {},
      code: 'const r = await fetch("https://example.org/a", { method: "POST", body: "тело" });' +
            'return { ok: r.ok, status: r.status, text: await r.text(), ct: r.headers.get("Content-Type") };',
    });
    await tick();
    const req = posted.find(m => m.type === 'fetch');
    ok('запрос ушёл наружу сообщением, а не в сеть', !!req && req.url === 'https://example.org/a');
    ok('метод и тело переданы', req.init.method === 'POST' && req.init.body === 'тело');

    await api.handle({ __ts: 1, type: 'fetch-result', id: req.id, ok: true, status: 200,
      body: 'привет', headers: { 'content-type': 'text/plain' } });
    await done;
    const out = posted.find(m => m.id === 'run1' && m.type === 'result');
    ok('ответ вернулся в код как Response-подобный объект',
       out.value.ok === true && out.value.status === 200 && out.value.text === 'привет');
    ok('заголовки читаются без учёта регистра', out.value.ct === 'text/plain');

    // Отказ моста должен доходить до кода обычной ошибкой.
    const done2 = api.handle({
      __ts: 1, type: 'run', id: 'run2', params: {},
      code: 'try { await fetch("http://127.0.0.1/"); return { leaked: true }; }' +
            'catch (e) { return { err: e.message }; }',
    });
    await tick();
    const req2 = posted.filter(m => m.type === 'fetch').pop();
    await api.handle({ __ts: 1, type: 'fetch-result', id: req2.id, error: 'адрес запрещён' });
    await done2;
    ok('отказ моста приходит в код ошибкой',
       posted.find(m => m.id === 'run2' && m.type === 'result').value.err === 'адрес запрещён');
  }

  console.log('\n── Рантайм: несериализуемый результат ──');
  {
    // Первая попытка отправки падает, как это делает настоящий postMessage
    // с функцией внутри, — проверяем запасной путь и честный отказ.
    let strict = true;
    const { posted, api } = makeRuntime({
      postImpl: (m) => { if (strict && m.type === 'result' && m.value && m.value.__hard) throw new Error('DataCloneError'); },
    });
    await api.handle({ __ts: 1, type: 'run', id: 's1', params: {}, code: 'return { __hard: true, fn: () => 1, n: 7 };' });
    const first = posted.filter(m => m.id === 's1');
    ok('при отказе клонирования результат уходит упрощённым',
       first.some(m => m.type === 'result' && m.value && m.value.n === 7));

    const { posted: p2, api: api2 } = makeRuntime({
      postImpl: (m) => { if (m.type === 'result') throw new Error('DataCloneError'); },
    });
    await api2.handle({ __ts: 1, type: 'run', id: 's2', params: {}, code: 'const a = {}; a.self = a; return a;' });
    const hard = p2.filter(m => m.id === 's2').pop();
    ok('совсем непередаваемый результат объяснён, а не потерян',
       hard.type === 'error' && /нельзя передать наружу/.test(hard.message));
  }

  // ══════════════════════════════════════════════
  // РОДИТЕЛЬСКАЯ СТОРОНА
  // ══════════════════════════════════════════════
  console.log('\n── Кадр: изоляция задана атрибутами ──');
  {
    const sb = new X.ToolSandbox({ doc: document });
    sb._ensureFrame().catch(() => {});
    const frame = sb.frame;
    ok('кадр создан', !!frame && frame.tagName === 'IFRAME');
    ok('песочница включена', frame.getAttribute('sandbox') === 'allow-scripts');
    ok('allow-same-origin НЕ выдан — иначе изоляции нет',
       !/allow-same-origin/.test(frame.getAttribute('sandbox')));
    ok('содержимое кадра — свой документ, а не чужой адрес',
       !frame.getAttribute('src') && typeof frame.srcdoc === 'string');
    ok('в документе кадра есть только рантайм',
       /toolSandboxRuntime|_runtime|AsyncFn/.test(X.ToolSandbox.frameSource()) &&
       !/apiKey|indexedDB\.open/.test(X.ToolSandbox.frameSource()));
    sb.destroy();
    ok('destroy убирает кадр', sb.frame === null);
  }

  console.log('\n── Кадр: протокол, таймаут и чужие сообщения ──');
  {
    const sent = [];
    const sb = new X.ToolSandbox({ doc: document });
    sb._ensureFrame().catch(() => {});
    sb._resolveReady(true);                 // кадр в jsdom не исполняется — «готов» ставим сами
    sb._send = (m) => sent.push(m);
    const fakeSource = sb.frame.contentWindow;

    const p = sb.run('return 1;', { a: 1 }, { timeoutMs: 0 });
    await tick();
    const runMsg = sent.find(m => m.type === 'run');
    ok('задание ушло в кадр', !!runMsg && runMsg.code === 'return 1;' && runMsg.params.a === 1);

    // Чужое сообщение с тем же id не должно ничего разрешать.
    sb._onMessage({ source: {}, data: { __ts: 1, type: 'result', id: runMsg.id, value: { hacked: true } } });
    await tick();
    let settled = false;
    p.then(() => { settled = true; });
    await tick();
    ok('сообщение не от кадра игнорируется', settled === false);

    sb._onMessage({ source: fakeSource, data: { __ts: 1, type: 'result', id: runMsg.id, value: { done: 1 } } });
    ok('результат от кадра принимается', (await p).done === 1);

    const p2 = sb.run('while(true){}', {}, { timeoutMs: 30 });
    const timedOut = await p2;
    ok('таймаут возвращает понятную ошибку', /Timeout/.test(timedOut.error), JSON.stringify(timedOut));
    ok('и кадр снесён — зависший код больше не занимает поток', sb.frame === null);

    const sb2 = new X.ToolSandbox({ doc: document });
    sb2._ensureFrame().catch(() => {});
    sb2._resolveReady(true);
    sb2._send = () => {};
    const p3 = sb2.run('return 1;', {}, { timeoutMs: 0 });
    sb2.destroy('остановлена');
    ok('снос песочницы не оставляет висящих ожиданий', /остановлена/.test((await p3).error));
  }

  console.log('\n── Кадр: мост fetch спрашивает разрешение у родителя ──');
  {
    const asked = [];
    const sb = new X.ToolSandbox({
      doc: document,
      fetchBridge: async (req) => { asked.push(req); return { ok: true, status: 200, body: 'ответ' }; },
    });
    sb._ensureFrame().catch(() => {});
    sb._resolveReady(true);
    const sent = [];
    sb._send = (m) => sent.push(m);
    await sb._bridgeFetch({ id: 'f1', url: 'https://example.org/', init: { method: 'GET' } });
    ok('запрос ушёл в мост родителя', asked.length === 1 && asked[0].url === 'https://example.org/');
    ok('ответ вернулся в кадр', sent.some(m => m.type === 'fetch-result' && m.body === 'ответ'));

    const noBridge = new X.ToolSandbox({ doc: document });
    noBridge._ensureFrame().catch(() => {});
    const sent2 = [];
    noBridge._send = (m) => sent2.push(m);
    await noBridge._bridgeFetch({ id: 'f2', url: 'https://example.org/' });
    ok('без моста сеть недоступна', sent2[0].error && /не разрешены/.test(sent2[0].error));
  }

  // ══════════════════════════════════════════════
  // ПОЛИТИКА АДРЕСОВ И ИСПОЛНИТЕЛЬ
  // ══════════════════════════════════════════════
  console.log('\n── Политика адресов моста ──');
  {
    const db = new FakeDB();
    const tools = new X.ToolsEngine(db);
    tools.security = new X.SecurityEngine();
    tools.security.db = db;
    tools.folders = new X.FoldersEngine(db);

    ok('не-HTTP протокол отклонён',
       !!(await tools._sandboxFetch({ url: 'file:///etc/passwd', init: {} })).error);
    ok('localhost отклонён',
       /запрещ/.test((await tools._sandboxFetch({ url: 'http://localhost:8080/', init: {} })).error || ''));
    ok('приватная сеть отклонена',
       /запрещ/.test((await tools._sandboxFetch({ url: 'http://192.168.1.1/', init: {} })).error || ''));
    ok('cloud-metadata отклонён',
       /запрещ/.test((await tools._sandboxFetch({ url: 'http://169.254.169.254/latest/', init: {} })).error || ''));
    ok('мусорный адрес отклонён', !!(await tools._sandboxFetch({ url: 'не-адрес', init: {} })).error);

    // Успешный путь: сеть подменяем, проверяем предел и журнал.
    const long = 'я'.repeat(50000);
    window.fetch = async () => ({
      ok: true, status: 200, statusText: 'OK', text: async () => long,
      headers: { forEach: (fn) => fn('text/plain', 'Content-Type') },
    });
    const good = await tools._sandboxFetch({ url: 'https://example.org/data', init: { method: 'GET' } });
    ok('разрешённый адрес выполняется', good.ok === true && good.status === 200);
    ok('ответ обрезан по общему пределу', good.body.length < long.length);
    ok('заголовки приведены к нижнему регистру', good.headers['content-type'] === 'text/plain');
    ok('запрос попал в журнал безопасности',
       tools.security.auditLog.some(e => e.tool === 'sandbox_fetch' && e.decision === 'executed'));

    // Максимальный режим с белым списком.
    tools.security.configure({ mode: 'maximum', allowedHosts: 'corp.example' });
    const blocked = await tools._sandboxFetch({ url: 'https://example.org/x', init: {} });
    ok('вне белого списка — отказ', !!blocked.error && /не входит/.test(blocked.error));
    ok('отказ записан в журнал',
       tools.security.auditLog.some(e => e.tool === 'sandbox_fetch' && e.decision === 'blocked'));
    const allowed = await tools._sandboxFetch({ url: 'https://corp.example/x', init: {} });
    ok('адрес из белого списка проходит', allowed.ok === true);
  }

  console.log('\n── Документ кадра исполняется на самом деле ──');
  {
    // Эта проверка появилась после настоящей ошибки: код кадра был
    // МЕТОДОМ класса, и toString() отдавал сокращённую запись
    // «_runtime(bootstrap) { … }» — не выражение-функцию. Подставленная
    // в «(…)()», она давала синтаксическую ошибку: кадр молча не
    // запускался, а наружу выходило «песочница не запустилась».
    // Все прочие тесты этого не ловили — они звали _runtime напрямую,
    // минуя сериализацию. Поэтому здесь исполняется именно тот текст,
    // который уходит в srcdoc.
    const doc = X.ToolSandbox.frameSource();
    ok('в документ кадра подставлено выражение-функция', /<script>\(function\s*\(/.test(doc), doc.slice(0, 80));

    const code = doc.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>$/, '');
    let parses = true, parseErr = '';
    try { new (require('vm').Script)(code); } catch (e) { parses = false; parseErr = e.message; }
    ok('документ кадра разбирается как JS', parses, parseErr);

    // Отдельное окно: рантайм обезвреживает глобальные объекты, и делать
    // это в окне остальных проверок нельзя.
    const frameDom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously', pretendToBeVisual: true });
    const w = frameDom.window;
    const got = [];
    w.addEventListener('message', (e) => got.push(e.data));
    let ran = true, runErr = '';
    try { w.eval(code); } catch (e) { ran = false; runErr = e.message; }
    await tick(10);
    ok('код кадра выполняется без ошибок', ran, runErr);
    ok('и сообщает о готовности', got.some(m => m && m.type === 'ready'));

    w.postMessage({ __ts: 1, type: 'run', id: 'z1', code: 'return { doubled: params.n * 2 };', params: { n: 21 } }, '*');
    await tick(20);
    ok('и выполняет задание, пришедшее сообщением',
       got.some(m => m && m.id === 'z1' && m.value && m.value.doubled === 42),
       JSON.stringify(got));
  }

  console.log('\n── Исполнитель отдаёт код песочнице ──');
  {
    const db = new FakeDB();
    const tools = new X.ToolsEngine(db);
    tools.security = null;
    tools.folders = new X.FoldersEngine(db);
    await tools.folders.ensureSeeded();
    await tools.loadTools();

    await db.put('tools', {
      id: 'custom_leak', name: 'leaky', description: 'd', parameters: { type: 'object', properties: {} },
      handlerCode: 'globalThis.__LEAKED = true; return { ok: 1 };', enabled: true, builtin: false,
    });

    // Настоящая песочница в jsdom не запустится — и это ровно то, что
    // нужно проверить: код НЕ выполнился в приложении, а вызов вернул
    // объяснимую ошибку вместо тихого исполнения в контексте страницы.
    const res = await tools.executeTool('leaky', {});
    ok('код инструмента не выполнился в приложении', window.__LEAKED === undefined);
    ok('вызов вернул объяснение, а не тишину', !!res.error, JSON.stringify(res));

    // А с рабочей песочницей результат доходит до вызывающей стороны.
    const seen = [];
    tools.sandbox = { run: async (code, params) => { seen.push({ code, params }); return { echoed: params.x }; } };
    const res2 = await tools.executeTool('leaky', { x: 42 });
    ok('исполнение идёт через песочницу', seen.length === 1 && seen[0].params.x === 42);
    ok('результат песочницы возвращается как результат инструмента', res2.echoed === 42);

    // Встроенный инструмент песочницы не касается — его код наш.
    const t = await tools.executeTool('calculator', { expression: '6*7' });
    ok('встроенные инструменты работают напрямую', t.result === 42 && seen.length === 1);
  }

  console.log('\n── Рантайм: файл пользователю ──');
  {
    // Кадру браузер запрещает скачивание (нет allow-downloads), а
    // File System Access в нём обезврежен. Значит, единственный
    // работающий путь — попросить приложение. Проверяем, что просьба
    // уходит наружу и её ответ доходит до кода инструмента.
    const { posted, api } = makeRuntime();
    const done = api.handle({
      __ts: 1, type: 'run', id: 'd1', params: {},
      code: 'const r = await agent_download({ name: "отчёт.csv", content: "a;b", mime: "text/csv" });' +
            'return { сохранено: r.filename, байт: r.bytes };',
    });
    await tick();
    const req = posted.find(m => m.type === 'host');
    ok('просьба о файле ушла приложению, а не в браузер', !!req && req.kind === 'download');
    ok('имя, содержимое и тип переданы',
       req.payload.name === 'отчёт.csv' && req.payload.content === 'a;b' && req.payload.mime === 'text/csv');

    await api.handle({ __ts: 1, type: 'host-result', id: req.id, value: { ok: true, filename: 'отчёт.csv', bytes: 3 } });
    await done;
    const out = posted.find(m => m.id === 'd1' && m.type === 'result');
    ok('ответ приложения вернулся в код инструмента',
       out && out.value.сохранено === 'отчёт.csv' && out.value.байт === 3, JSON.stringify(out));

    // Отказ должен доходить обычной ошибкой, а не молчанием.
    const done2 = api.handle({
      __ts: 1, type: 'run', id: 'd2', params: {},
      code: 'try { await agent_download({ name: "x", content: "y" }); return { leaked: true }; }' +
            'catch (e) { return { err: e.message }; }',
    });
    await tick();
    const req2 = posted.filter(m => m.type === 'host').pop();
    await api.handle({ __ts: 1, type: 'host-result', id: req2.id, error: 'файл слишком большой' });
    await done2;
    ok('отказ приложения приходит в код ошибкой',
       posted.find(m => m.id === 'd2' && m.type === 'result').value.err === 'файл слишком большой');

    // Позиционная форма вызова: модель пишет и так, и так.
    const done3 = api.handle({
      __ts: 1, type: 'run', id: 'd3', params: {},
      code: 'agent_download("a.txt", { поле: 1 }); return { ok: 1 };',
    });
    await tick();
    const req3 = posted.filter(m => m.type === 'host').pop();
    ok('позиционный вызов понимается так же', req3.payload.name === 'a.txt');
    ok('объект сериализуется сам, а не превращается в [object Object]',
       /"поле"/.test(req3.payload.content), req3.payload.content);
    await done3;
  }

  // jsdom не выдаёт blob-адреса сам, а без них проверять нечего:
  // подменяем ровно то, чем пользуется код инструмента.
  {
    let seq = 0;
    window.URL.createObjectURL = (blob) => 'blob:test/' + (++seq) + '?' + (blob && blob.type || '');
    window.URL.revokeObjectURL = () => {};
  }

  console.log('\n── Привычный способ скачивания больше не врёт ──');
  {
    // Ровно тот случай, из-за которого всё переделывалось: инструмент
    // собирает Blob, кликает по ссылке и рапортует об успехе. В кадре
    // это не падает — браузер запрещает скачивание из <iframe sandbox>
    // МОЛЧА, и файла просто не появляется. Теперь клик перехватывается
    // и файл уходит приложению тем же мостом, что и agent_download.
    const { posted, api } = makeRuntime();
    const done = api.handle({
      __ts: 1, type: 'run', id: 'old1', params: {},
      code: 'const blob = new Blob(["имя;цена"], { type: "text/csv" });' +
            'const url = URL.createObjectURL(blob);' +
            'const a = document.createElement("a");' +
            'a.href = url; a.download = "прайс.csv"; a.click();' +
            'URL.revokeObjectURL(url);' +
            'return { ok: true, файл: "прайс.csv" };',
    });
    await tick(10);
    const req = posted.find(m => m.type === 'host' && m.kind === 'download');
    ok('клик по ссылке превратился в просьбу к приложению', !!req, JSON.stringify(posted.map(m => m.type)));
    ok('имя файла взято из атрибута download', req && req.payload.name === 'прайс.csv');
    ok('содержимое доехало байтами', req && req.payload.base64 === true &&
       Buffer.from(req.payload.content, 'base64').toString('utf8') === 'имя;цена',
       req && req.payload.content);
    ok('и тип из Blob не потерян', req && /text\/csv/.test(req.payload.mime), req && req.payload.mime);

    await api.handle({ __ts: 1, type: 'host-result', id: req.id, value: { ok: true, filename: 'прайс.csv', bytes: 15 } });
    await done;
    const out = posted.find(m => m.id === 'old1' && m.type === 'result');
    ok('результат инструмента дошёл без изменений', out && out.value.ok === true, JSON.stringify(out));
    ok('и не помечен ошибкой, раз файл ушёл', out && out.value.download_error === undefined);
  }

  console.log('\n── Если файл не ушёл, инструмент об этом скажет ──');
  {
    const { posted, api } = makeRuntime();
    const done = api.handle({
      __ts: 1, type: 'run', id: 'old2', params: {},
      code: 'const a = document.createElement("a");' +
            'a.href = "blob:чужой-адрес"; a.download = "нет.txt"; a.click();' +
            'return { ok: true, message: "Файл скачан" };',
    });
    await tick(10);
    await done;
    const out = posted.find(m => m.id === 'old2' && m.type === 'result');
    ok('ответ инструмента дополнен правдой о файле',
       out && typeof out.value.download_error === 'string', JSON.stringify(out && out.value));
    ok('и сказано, чем это чинить',
       out && /agent_download/.test(out.value.download_error), out && out.value.download_error);

    // Отказ приложения (слишком большой файл, испорченное имя) тоже
    // обязан доехать до результата, а не потеряться по дороге.
    const done2 = api.handle({
      __ts: 1, type: 'run', id: 'old3', params: {},
      code: 'const blob = new Blob(["x"]);' +
            'const a = document.createElement("a");' +
            'a.href = URL.createObjectURL(blob); a.download = "b.txt"; a.click();' +
            'return { ok: true };',
    });
    await tick(10);
    const req2 = posted.filter(m => m.type === 'host').pop();
    await api.handle({ __ts: 1, type: 'host-result', id: req2.id, error: 'файл больше допустимых 32 МБ' });
    await done2;
    const out2 = posted.find(m => m.id === 'old3' && m.type === 'result');
    ok('отказ приложения виден в ответе инструмента',
       out2 && /32 МБ/.test(out2.value.download_error || ''), JSON.stringify(out2 && out2.value));
  }

  console.log('\n── Молчаливых тупиков не осталось ──');
  {
    const { posted, api } = makeRuntime();
    await api.handle({
      __ts: 1, type: 'run', id: 'w1', params: {},
      code: 'try { window.open("https://example.org"); return { leaked: true }; }' +
            'catch (e) { return { err: e.message }; }',
    });
    const res = posted.find(m => m.id === 'w1');
    ok('window.open не возвращает молча null', res.value.err && /недоступен/.test(res.value.err),
       JSON.stringify(res.value));
    ok('и подсказывает, чем отдать файл', /agent_download/.test(res.value.err));

    // Обычная ссылка без download кликается как раньше: перехват не
    // должен ломать навигацию внутри кадра.
    await api.handle({
      __ts: 1, type: 'run', id: 'w2', params: {},
      code: 'const a = document.createElement("a"); a.href = "#x";' +
            'let clicked = false; a.addEventListener("click", () => { clicked = true; });' +
            'a.click(); return { clicked };',
    });
    ok('ссылка без download работает по-прежнему',
       posted.find(m => m.id === 'w2').value.clicked === true);
  }

  console.log('\n── Кадр: просьба о файле уходит родителю ──');
  {
    const asked = [];
    const sb = new X.ToolSandbox({
      doc: document,
      hostBridge: async (req) => { asked.push(req); return { value: { ok: true, filename: 'f.txt' } }; },
    });
    sb._ensureFrame().catch(() => {});
    sb._resolveReady(true);
    const sent = [];
    sb._send = (m) => sent.push(m);
    await sb._bridgeHost({ id: 'h1', kind: 'download', payload: { name: 'f.txt', content: 'x' } });
    ok('просьба дошла до приложения', asked.length === 1 && asked[0].kind === 'download');
    ok('ответ вернулся в кадр', sent.some(m => m.type === 'host-result' && m.value.filename === 'f.txt'));

    const noBridge = new X.ToolSandbox({ doc: document });
    noBridge._ensureFrame().catch(() => {});
    const sent2 = [];
    noBridge._send = (m) => sent2.push(m);
    await noBridge._bridgeHost({ id: 'h2', kind: 'download', payload: {} });
    ok('без моста возможности нет — и об этом сказано', !!sent2[0].error);
    noBridge.destroy();
    sb.destroy();
  }

  console.log('\n── Приложение отдаёт файл ──');
  {
    const db = new FakeDB();
    const tools = new X.ToolsEngine(db);
    tools.security = new X.SecurityEngine();
    tools.security.db = db;

    // jsdom не умеет отдавать файлы — подменяем ровно то, чем это
    // делается в браузере, и смотрим, что именно туда попало.
    const saved = [];
    window.URL.createObjectURL = (blob) => { saved.push(blob); return 'blob:fake'; };
    window.URL.revokeObjectURL = () => {};
    const realCreate = document.createElement.bind(document);
    document.createElement = (tag) => {
      const el = realCreate(tag);
      if (tag === 'a') el.click = () => { el.__clicked = true; saved.clicked = el.download; };
      return el;
    };

    const good = await tools._sandboxHost({ kind: 'download', payload: { name: 'отчёт.csv', content: 'a;b', mime: 'text/csv' } });
    ok('файл отдан браузеру', good.value && good.value.ok === true, JSON.stringify(good));
    ok('под своим именем', saved.clicked === 'отчёт.csv', saved.clicked);
    ok('и это записано в журнал безопасности',
       tools.security.auditLog.some(e => e.tool === 'sandbox_download' && e.decision === 'executed'));

    const nasty = await tools._sandboxHost({ kind: 'download', payload: { name: '../../etc/passwd', content: 'x' } });
    ok('каталоги из имени вырезаны', !/[/]/.test(nasty.value.filename), nasty.value.filename);

    const noName = await tools._sandboxHost({ kind: 'download', payload: { content: 'x' } });
    ok('без имени файл всё равно получает имя', /^file-\d+\.txt$/.test(noName.value.filename), noName.value.filename);

    const huge = await tools._sandboxHost({ kind: 'download', payload: { name: 'big.txt', content: 'я'.repeat(X.ToolsEngine.MAX_DOWNLOAD_BYTES + 1) } });
    ok('слишком большой файл отклонён с понятной причиной',
       !!huge.error && /частями/.test(huge.error), huge.error);

    const badB64 = await tools._sandboxHost({ kind: 'download', payload: { name: 'a.png', content: '!!!не base64!!!', base64: true } });
    ok('испорченный base64 объяснён, а не проглочен', !!badB64.error, JSON.stringify(badB64));

    const unknown = await tools._sandboxHost({ kind: 'нечто', payload: {} });
    ok('неизвестная просьба отклоняется', !!unknown.error);

    document.createElement = realCreate;
  }

  console.log('\n── Кадр запускается сам по себе ──');
  {
    // Код кадра уезжает в ОТДЕЛЬНЫЙ документ строкой и не видит там
    // ничего из приложения. Проверяем это буквально: исполняем документ
    // кадра в пустом контексте — ни бандла, ни его помощников. Именно
    // это ломала обфускация в продакшен-сборке: рантайм ссылался на
    // расшифровщик строк из бандла и падал ещё до первой строки, а
    // наружу выходило «не удалось запустить песочницу инструментов».
    const vm = require('vm');
    const doc = X.ToolSandbox.frameSource();
    const code = doc.slice(doc.indexOf('<script>') + 8, doc.lastIndexOf('</' + 'script>'));
    const posted = [];
    const fakeSelf = {
      parent: { postMessage: (m) => posted.push(m) },
      addEventListener: () => {}, navigator: {},
    };
    let boom = null;
    try { vm.runInNewContext(code, { self: fakeSelf }); } catch (e) { boom = e; }
    ok('документ кадра исполняется без окружения приложения', !boom, boom && boom.message);
    ok('и сразу сообщает о готовности', posted.some(m => m && m.type === 'ready'));
  }

  console.log('\n── Осечка запуска не выключает инструменты навсегда ──');
  {
    // Кадр в jsdom не исполняется, поэтому «готов» не придёт никогда —
    // ровно тот случай, ради которого проверка и написана. Раньше
    // отклонённый промис оставался в объекте песочницы, и первая же
    // осечка выключала свои инструменты до перезагрузки страницы.
    const was = X.ToolSandbox.READY_TIMEOUT_MS;
    X.ToolSandbox.READY_TIMEOUT_MS = 20;
    const sb = new X.ToolSandbox({ doc: document });
    const res = await sb.run('return 1;', {}, { timeoutMs: 0 });
    ok('вызов вернул объяснимую ошибку', !!res.error && /песочниц/i.test(res.error), JSON.stringify(res));
    ok('и сказано, что встроенные инструменты работают', /встроенные/.test(res.error));
    ok('причина названа, а не спрятана', /кадр/.test(res.error), res.error);
    ok('состояние сброшено — следующий вызов начнёт заново',
       sb.frame === null && sb.frameReady === null);

    // А после починки среды тот же экземпляр работает: ничего
    // «залипшего» от прошлой осечки не осталось.
    sb._send = () => {};
    const p = sb.run('return 1;', {}, { timeoutMs: 0 });
    await tick();
    if (sb._resolveReady) sb._resolveReady(true);
    await tick();
    const runMsg = sb.pending.size ? Array.from(sb.pending.keys())[0] : null;
    ok('после осечки песочница снова принимает задания', !!runMsg);
    sb.destroy();
    await p;
    X.ToolSandbox.READY_TIMEOUT_MS = was;
  }

  console.log('\n==============================================');
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('==============================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
