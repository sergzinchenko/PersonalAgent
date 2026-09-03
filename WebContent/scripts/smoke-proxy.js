// ============================================================
//  SMOKE PROXY — проверка собранного dist/proxy/proxy.js вживую
// ============================================================
//
// Зачем отдельно от npm test: обычные наборы проверяют исходники в
// песочнице, а здесь запускается РЕАЛЬНЫЙ процесс из dist/ — тот самый
// обфусцированный файл, который получит пользователь. После обфускации
// его уже не прочитать глазами, а сломаться в нём может то, что разбор
// не ловит: require('./config.js'), разбор заголовков, ANSI-шаблоны.
//
// Запуск: npm run build && npm run smoke:proxy
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROXY_JS = path.join(ROOT, 'dist', 'proxy', 'proxy.js');
const TARGET_PORT = 39917;   // «дальний» сервер, к которому ходит прокси
const PROXY_PORT = 39918;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + extra : '')); }
};

const request = (url, { method = 'GET', headers = {}, body = null } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(PROXY_JS)) {
    console.error('Нет dist/proxy/proxy.js — сначала «npm run build».');
    process.exit(1);
  }
  const built = fs.readFileSync(PROXY_JS, 'utf8');
  console.log('\n── Файл сборки ──');
  ok('proxy.js собран', built.length > 0);
  // Признак обфускации: шестнадцатеричные имена и отсутствие исходных
  // комментариев. Имена функций сами по себе не показатель — часть из них
  // обфускатор сохраняет.
  ok('он действительно обфусцирован, а не скопирован',
     /_0x[0-9a-f]{4,}/.test(built) && !built.includes('// ---- Цвета консоли'),
     built.slice(0, 60));
  ok('require конфига остался читаемым', built.includes("require('./config.js')") ||
     built.includes('require("./config.js")'), built.slice(0, 0));

  // ── Дальний сервер: отражает то, что до него дошло ──
  const target = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Target-Says': 'hi' });
      res.end(JSON.stringify({ method: req.method, url: req.url, body, auth: req.headers.authorization || null }));
    });
  });
  await new Promise((r) => target.listen(TARGET_PORT, r));

  // ── Собственный config.js для прокси: свой порт, чтобы не мешать
  //    настоящему, если он у пользователя уже запущен ──
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'smoke-proxy-'));
  fs.copyFileSync(PROXY_JS, path.join(tmpDir, 'proxy.js'));
  fs.writeFileSync(path.join(tmpDir, 'config.js'),
    `module.exports = { port: ${PROXY_PORT}, allowedMethods: ['GET','POST','PUT','DELETE','PATCH','HEAD'], ` +
    `allowlist: [], maxRequestBodyBytes: 1048576, maxLogBytes: 256, noColor: true };\n`, 'utf8');

  const child = spawn(process.execPath, ['proxy.js'], { cwd: tmpDir, windowsHide: true });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  // Ждём строку о старте, но не дольше пяти секунд.
  for (let i = 0; i < 50 && !/Proxy started/.test(out); i++) await wait(100);

  const cleanup = () => { try { child.kill(); } catch (_) {} target.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); };

  try {
    console.log('\n── Запуск ──');
    ok('обфусцированный прокси стартовал', /Proxy started/.test(out), out.slice(0, 400));
    ok('config.js прочитан — слушает заданный порт', out.includes(String(PROXY_PORT)), out.slice(0, 200));

    console.log('\n── Проксирование ──');
    const base = `http://127.0.0.1:${PROXY_PORT}/`;
    const targetUrl = `http://127.0.0.1:${TARGET_PORT}/hello`;

    const got = await request(base + '?url=' + encodeURIComponent(targetUrl));
    ok('GET проходит насквозь', got.status === 200, String(got.status));
    const payload = JSON.parse(got.body || '{}');
    ok('до цели дошёл верный метод и путь', payload.method === 'GET' && payload.url === '/hello', got.body);
    ok('заголовки цели вернулись клиенту', got.headers['x-target-says'] === 'hi', JSON.stringify(got.headers));
    ok('CORS-заголовок на месте', got.headers['access-control-allow-origin'] === '*');

    const posted = await request(base + '?url=' + encodeURIComponent(targetUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer probe-token' },
      body: '{"a":1}',
    });
    const pp = JSON.parse(posted.body || '{}');
    ok('POST доносит тело', pp.body === '{"a":1}', posted.body);
    ok('и заголовок Authorization', pp.auth === 'Bearer probe-token', String(pp.auth));

    const viaHeader = await request(base, { headers: { 'X-Target-Url': targetUrl } });
    ok('адрес цели через X-Target-Url тоже работает', viaHeader.status === 200, String(viaHeader.status));

    console.log('\n── Отказы ──');
    const noUrl = await request(base);
    ok('без адреса цели — 400', noUrl.status === 400, String(noUrl.status));
    const badScheme = await request(base + '?url=' + encodeURIComponent('file:///etc/passwd'));
    ok('не-http схема отклонена', badScheme.status === 400, String(badScheme.status));
    const preflight = await request(base, { method: 'OPTIONS' });
    ok('CORS preflight отвечает 204', preflight.status === 204, String(preflight.status));

    console.log('\n── Логирование ──');
    ok('прокси пишет в консоль запрос и ответ',
       /REQUEST/.test(out) && /RESPONSE/.test(out), out.slice(-300));
  } finally {
    cleanup();
  }

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('СБОЙ ПРОВЕРКИ:', e); process.exit(1); });
