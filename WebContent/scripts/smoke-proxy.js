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

// ── Доверие к сертификатам ──
// Самая частая причина 502 у внутренних серверов. Проверяем на НАСТОЯЩЕМ
// самоподписанном сертификате: он выпускается тут же, на время прогона, и
// нигде не сохраняется — держать в репозитории приватный ключ, пусть и
// тестовый, не стоит. Если openssl недоступен, блок пропускается: это
// проверка сборки, а не повод уронить её на чужой машине.
async function checkTls() {
  const https = require('https');
  const { spawnSync } = require('child_process');
  console.log('\n── TLS: доверие к сертификату ──');

  const probe = spawnSync('openssl', ['version'], { windowsHide: true });
  if (probe.error || probe.status !== 0) {
    console.log('  ⚠ openssl недоступен — проверка TLS пропущена');
    return;
  }

  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'smoke-tls-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const gen = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { windowsHide: true });
  if (gen.status !== 0 || !fs.existsSync(certPath)) {
    console.log('  ⚠ не удалось выпустить тестовый сертификат — проверка пропущена');
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }

  const TLS_TARGET_PORT = 39919;
  const tlsTarget = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('secure-ok'); });
  await new Promise((r) => tlsTarget.listen(TLS_TARGET_PORT, r));
  const targetUrl = `https://localhost:${TLS_TARGET_PORT}/x`;

  // Поднимает прокси со своим config.js и делает один запрос.
  const through = async (tls, port) => {
    const d = fs.mkdtempSync(path.join(require('os').tmpdir(), 'smoke-p-'));
    fs.copyFileSync(PROXY_JS, path.join(d, 'proxy.js'));
    fs.writeFileSync(path.join(d, 'config.js'),
      `module.exports = { port: ${port}, allowedMethods: ['GET'], allowlist: [], ` +
      `maxRequestBodyBytes: 1048576, maxLogBytes: 200, noColor: true, tls: ${JSON.stringify(tls)} };\n`);
    const ch = spawn(process.execPath, ['proxy.js'], { cwd: d, windowsHide: true });
    let log = '';
    ch.stdout.on('data', (c) => { log += c; });
    ch.stderr.on('data', (c) => { log += c; });
    for (let i = 0; i < 50 && !/Proxy started/.test(log); i++) await wait(100);
    let res;
    try {
      res = await request(`http://127.0.0.1:${port}/?url=` + encodeURIComponent(targetUrl));
    } catch (e) {
      res = { status: 0, body: e.message };
    }
    ch.kill();
    await wait(150);
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    return { res, log };
  };

  try {
    // 1. По умолчанию — сертификат неизвестен, но ошибка должна быть внятной.
    const strict = await through({}, 39920);
    ok('неизвестный сертификат отвергается', strict.res.status === 502, String(strict.res.status));
    let body = {};
    try { body = JSON.parse(strict.res.body); } catch (_) {}
    ok('502 объясняет, что дело в сертификате', body.tlsError === true, strict.res.body.slice(0, 160));
    ok('назван код ошибки TLS', /SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET/.test(body.code || ''), String(body.code));
    ok('предложены варианты решения', Array.isArray(body.howToFix) && body.howToFix.length === 3);
    ok('первым предложен CA-файл, а не отключение проверки',
       /caFile/.test((body.howToFix || [])[0] || ''), (body.howToFix || [])[0]);

    // 2. Правильный путь: свой CA — проверка остаётся включённой.
    const withCa = await through({ caFile: certPath }, 39921);
    ok('с указанным CA запрос проходит', withCa.res.status === 200 && withCa.res.body === 'secure-ok',
       `${withCa.res.status} ${withCa.res.body.slice(0, 80)}`);
    ok('о загрузке CA сказано при старте', /CA-файл загружен/.test(withCa.log), withCa.log.slice(0, 200));

    // 3. Компромисс: исключение для одного хоста.
    const perHost = await through({ insecureHosts: ['localhost'] }, 39922);
    ok('исключение для хоста снимает проверку', perHost.res.status === 200, String(perHost.res.status));
    ok('прокси предупреждает о снятой проверке', /Проверка TLS отключена для хостов/.test(perHost.log));

    // Хост вне списка при этом остаётся защищённым.
    const otherHost = await through({ insecureHosts: ['example.com'] }, 39923);
    ok('чужой хост в списке не открывает дверь этому', otherHost.res.status === 502, String(otherHost.res.status));

    // 4. Крайний случай: отключение проверки везде + громкое предупреждение.
    const insecure = await through({ insecure: true }, 39924);
    ok('глобальное отключение работает', insecure.res.status === 200, String(insecure.res.status));
    ok('и сопровождается предупреждением в консоли',
       /отключена для ВСЕХ адресов/.test(insecure.log), insecure.log.slice(0, 200));
  } finally {
    tlsTarget.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

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

  await checkTls();

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('СБОЙ ПРОВЕРКИ:', e); process.exit(1); });
