const http = require('http');
const https = require('https');
const { URL } = require('url');
const { Transform } = require('stream');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Все настройки — в config.js рядом с этим файлом. Здесь только их чтение.
let config;
try {
  config = require('./config.js');
} catch (e) {
  console.error('Не найден (или содержит ошибку) config.js рядом с proxy.js: ' + e.message);
  console.error('Скопируйте config.js из поставки прокси в ту же папку и перезапустите.');
  process.exit(1);
}

// Подстраховка: если в config.js забыли/удалили какое-то поле — берём
// значение по умолчанию вместо падения с непонятной ошибкой при старте.
const DEFAULT_CONFIG = {
  port: 3000,
  allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'],
  allowlist: [],
  maxRequestBodyBytes: 10 * 1024 * 1024,
  maxLogBytes: 4096,
  noColor: false,
  sso: {
    curlBin: process.platform === 'win32' ? 'curl.exe' : 'curl',
    useNtlm: true,
    useNegotiate: true,
    insecure: false,
    timeoutSec: 60,
    maxResponseBytes: 20 * 1024 * 1024,
  },
};
config = {
  ...DEFAULT_CONFIG,
  ...config,
  sso: { ...DEFAULT_CONFIG.sso, ...(config.sso || {}) },
};

const PORT = config.port;
const ALLOWED_METHODS = config.allowedMethods;
const ALLOWLIST = config.allowlist;
const MAX_LOG_BYTES = config.maxLogBytes;
const MAX_REQUEST_BODY_BYTES = config.maxRequestBodyBytes;

// ---- Цвета консоли (ANSI) ----
// Объявлены до блока SSO/curl ниже, т.к. проверка curl при старте сразу их использует.
const NO_COLOR = !!config.noColor;
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
};

function paint(text, color) {
  if (NO_COLOR) return text;
  return `${color}${text}${COLORS.reset}`;
}

// ---- Настройки SSO через curl (NTLM/Negotiate, Windows SSPI) ----
// Включается на запрос заголовком X-Use-Sso: 1 или query-параметром ?sso=1 —
// обычные запросы по умолчанию идут старым путём через http/https и curl не трогают.
const CURL_BIN = config.sso.curlBin;
const CURL_USE_NTLM = !!config.sso.useNtlm;
const CURL_USE_NEGOTIATE = !!config.sso.useNegotiate;
const CURL_INSECURE = !!config.sso.insecure; // -k, для корпоративных self-signed сертификатов
const CURL_TIMEOUT_SEC = Number(config.sso.timeoutSec || 0);
const MAX_CURL_RESPONSE_BYTES = config.sso.maxResponseBytes; // ответ curl буферизуется целиком в память

// Проверка при старте: есть ли curl.exe на этой машине (не блокирует запуск, только предупреждает).
(function checkCurlAvailable() {
  try {
    const r = spawnSync(CURL_BIN, ['--version'], { windowsHide: true });
    if (r.error || r.status !== 0) throw r.error || new Error(`exit code ${r.status}`);
    const versionLine = String(r.stdout).split('\n')[0].trim();
    console.log(paint(`curl найден: ${versionLine}`, COLORS.green));
    if (!/SSPI/i.test(String(r.stdout))) {
      console.log(paint('  Внимание: в выводе curl --version нет "SSPI" — вероятно, эта сборка curl не умеет NTLM/Negotiate SSO текущего пользователя Windows.', COLORS.yellow));
    }
  } catch (e) {
    console.log(paint(`Внимание: не удалось найти "${CURL_BIN}" (${e.message}). Режим X-Use-Sso работать не будет, пока curl недоступен на PATH или в CURL_BIN.`, COLORS.yellow));
  }
})();

function now() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${String(d.getMilliseconds()).padStart(3, '0')}`
  );
}

function statusColor(code) {
  if (code >= 500) return COLORS.red;
  if (code >= 400) return COLORS.red;
  if (code >= 300) return COLORS.yellow;
  if (code >= 200) return COLORS.green;
  return COLORS.gray;
}

function section(label) {
  console.log(
    '\n' +
      paint('[', COLORS.gray) +
      paint(label, COLORS.cyan) +
      paint(']', COLORS.gray) +
      ' ' +
      paint(now(), COLORS.gray)
  );
}

function logHeaders(headers) {
  for (const [name, value] of Object.entries(headers)) {
    const val = Array.isArray(value) ? value.join(', ') : value;
    console.log(`  ${paint(name + ':', COLORS.blue)} ${val}`);
  }
}

function isText(buf) {
  const sample = buf.subarray(0, 1024);
  if (!sample.length) return true;
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
  }
  return printable / sample.length > 0.9;
}

function logBody(label, buf) {
  if (!buf.length) return;
  const truncated = buf.length > MAX_LOG_BYTES;
  const preview = buf.subarray(0, MAX_LOG_BYTES);
  const note = `${buf.length} bytes${truncated ? ` (showing first ${MAX_LOG_BYTES})` : ''}`;
  console.log(`  ${paint(label + ':', COLORS.gray)} ${note}`);
  if (isText(preview)) {
    console.log(paint(preview.toString('utf8'), COLORS.dim));
  } else {
    const hex = preview.toString('hex');
    console.log(paint(`  [binary] ${hex.slice(0, 256)}${preview.length > 128 ? '…' : ''}`, COLORS.dim));
  }
}

// Перехватывает поток, накапливая превью для лога, и пропускает данные дальше.
function createCaptureStream(label) {
  const chunks = [];
  let size = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (size < MAX_LOG_BYTES) {
        const take = Math.min(chunk.length, MAX_LOG_BYTES - size);
        chunks.push(chunk.subarray(0, take));
        size += take;
      }
      cb(null, chunk);
    },
    flush(cb) {
      logBody(label, Buffer.concat(chunks));
      cb();
    },
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-Target-Url, Authorization, X-Custom-Headers, X-Use-Sso'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendError(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message }));
}

// ---- Разбор дампа заголовков, который curl пишет через -D ----
// При NTLM/Negotiate-хендшейке curl может внутренне сходить на сервер несколько раз
// (получить 401 с challenge, отправить финальный токен) — все промежуточные и
// финальный блок заголовков попадают в один и тот же файл друг за другом.
// Нас интересует только последний блок — это и есть настоящий ответ на запрос.
function parseCurlHeaderDump(dump) {
  const blocks = dump
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (!blocks.length) return null;
  const lastBlock = blocks[blocks.length - 1];
  const lines = lastBlock.split(/\r?\n/);
  const statusLine = lines[0] || '';
  const m = statusLine.match(/^HTTP\/\S+\s+(\d+)\s*(.*)$/);
  if (!m) return null;
  const statusCode = parseInt(m[1], 10);
  const statusMessage = (m[2] || '').trim();
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i].indexOf(':');
    if (idx === -1) continue;
    const name = lines[i].slice(0, idx).trim().toLowerCase();
    const value = lines[i].slice(idx + 1).trim();
    if (headers[name] === undefined) headers[name] = value;
    else if (Array.isArray(headers[name])) headers[name].push(value);
    else headers[name] = [headers[name], value];
  }
  return { statusCode, statusMessage, headers };
}

// ---- Выполняет запрос через curl.exe с NTLM/Negotiate SSO (-u : => текущий пользователь Windows) ----
function runCurlRequest({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const tmpHeaderFile = path.join(os.tmpdir(), `proxy-sso-headers-${crypto.randomUUID()}.txt`);
    const cleanup = () => fs.unlink(tmpHeaderFile, () => {});

    const args = ['-s', '-S', '--http1.1', '-D', tmpHeaderFile, '-o', '-', '-X', method];

    if (CURL_INSECURE) args.push('-k');
    if (CURL_TIMEOUT_SEC) args.push('--max-time', String(CURL_TIMEOUT_SEC));

    const authMechanisms = [];
    if (CURL_USE_NTLM) authMechanisms.push('--ntlm');
    if (CURL_USE_NEGOTIATE) authMechanisms.push('--negotiate');
    if (authMechanisms.length) {
      args.push(...authMechanisms);
      args.push('-u', ':'); // пустые user:pass => SSPI берёт креды текущего залогиненного пользователя
    }

    for (const [name, value] of Object.entries(headers)) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) args.push('-H', `${name}: ${v}`);
    }

    const hasBody = body && body.length > 0;
    if (hasBody) args.push('--data-binary', '@-');

    args.push(url);

    const child = spawn(CURL_BIN, args, { windowsHide: true });

    const stdoutChunks = [];
    let stdoutSize = 0;
    let stderrData = '';
    let killedForSize = false;

    child.stdout.on('data', (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > MAX_CURL_RESPONSE_BYTES) {
        killedForSize = true;
        child.kill();
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      cleanup();
      reject(new Error(`Не удалось запустить curl (${CURL_BIN}): ${err.message}. Проверьте, что curl есть в PATH, либо задайте полный путь через переменную окружения CURL_BIN.`));
    });

    child.on('close', (code) => {
      // Важно: сначала прочитать файл заголовков и только потом его удалять —
      // fs.unlink асинхронный, и вызов cleanup() до чтения — гонка, из-за
      // которой файл иногда успевает исчезнуть раньше readFileSync (ENOENT).
      if (killedForSize) {
        cleanup();
        return reject(new Error(`Ответ цели превысил лимит ${MAX_CURL_RESPONSE_BYTES} байт, соединение прервано`));
      }
      if (code !== 0) {
        cleanup();
        return reject(new Error(`curl завершился с кодом ${code}: ${stderrData.trim() || '(нет stderr)'}`));
      }
      let headerDump = '';
      try {
        headerDump = fs.readFileSync(tmpHeaderFile, 'utf8');
      } catch (e) {
        cleanup();
        return reject(new Error(`Не удалось прочитать файл заголовков curl: ${e.message}`));
      }
      cleanup();
      const parsed = parseCurlHeaderDump(headerDump);
      if (!parsed) {
        return reject(new Error(`Не удалось разобрать заголовки ответа curl (stderr: ${stderrData.trim()})`));
      }
      resolve({ ...parsed, body: Buffer.concat(stdoutChunks) });
    });

    if (hasBody) child.stdin.end(body);
    else child.stdin.end();
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  section('REQUEST');
  console.log(paint(`${req.method} ${req.url}`, COLORS.yellow + COLORS.bold));
  logHeaders(req.headers);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let target = reqUrl.searchParams.get('url') || req.headers['x-target-url'];
  if (!target) {
    return sendError(res, 400, 'Specify the target URL: /proxy?url=... or the X-Target-Url header');
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return sendError(res, 400, 'Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return sendError(res, 400, 'Only http and https are supported');
  }
  if (!ALLOWED_METHODS.includes(req.method)) {
    return sendError(res, 405, `Method not allowed. Supported: ${ALLOWED_METHODS.join(', ')}`);
  }
  if (ALLOWLIST.length && !ALLOWLIST.includes(parsed.hostname)) {
    return sendError(res, 403, `Domain ${parsed.hostname} is not allowed`);
  }

  const useSso = req.headers['x-use-sso'] === '1' || reqUrl.searchParams.get('sso') === '1';

  console.log(
    paint('→ target: ', COLORS.gray) +
      paint(target, COLORS.yellow) +
      (useSso ? paint('  [SSO via curl: NTLM/Negotiate]', COLORS.magenta) : '')
  );

  // Читаем тело для всех методов, у которых оно может быть (не только POST).
  let body = Buffer.alloc(0);
  if (!['GET', 'HEAD'].includes(req.method)) {
    try {
      body = await readBody(req);
    } catch (err) {
      return sendError(res, 413, err.message);
    }
  }
  logBody('Request body', body);

  // Заголовки для исходящего запроса: убираем служебные/hop-by-hop.
  // В SSO-режиме дополнительно убираем Authorization — аутентификацию к цели
  // ведёт сам curl (NTLM/Negotiate), и клиентский заголовок Authorization
  // тут не при делах и может сломать хендшейк, если случайно попадёт в запрос.
  const skipHeaders = new Set([
    'host', 'connection', 'content-length', 'origin', 'referer',
    // служебные заголовки самого прокси — не предназначены для целевого сервера
    'x-target-url', 'x-use-sso',
  ]);
  if (useSso) skipHeaders.add('authorization');

  const headers = {};
  for (const key of Object.keys(req.headers)) {
    if (skipHeaders.has(key.toLowerCase())) continue;
    headers[key] = req.headers[key];
  }

  if (useSso) {
    // ---- Путь через curl.exe (NTLM/Negotiate SSO текущего пользователя Windows) ----
    try {
      const upstreamResp = await runCurlRequest({ method: req.method, url: target, headers, body });

      section('RESPONSE (curl SSO)');
      console.log(
        paint(`HTTP ${upstreamResp.statusCode} ${upstreamResp.statusMessage}`, statusColor(upstreamResp.statusCode) + COLORS.bold)
      );
      logHeaders(upstreamResp.headers);
      logBody('Response body', upstreamResp.body);

      const respHeaders = { ...upstreamResp.headers };
      ['transfer-encoding', 'connection', 'keep-alive'].forEach((h) => delete respHeaders[h]);
      res.writeHead(upstreamResp.statusCode, respHeaders);
      res.end(upstreamResp.body);
    } catch (err) {
      section('ERROR (curl SSO)');
      console.log(paint(err.message, COLORS.red));
      sendError(res, 502, `SSO request via curl failed: ${err.message}`);
    }
    return;
  }

  // ---- Обычный путь: напрямую через http/https (без SSO) ----
  headers['Host'] = parsed.host;
  // Node.js для GET/HEAD/DELETE по умолчанию считает, что тела не будет, и не
  // проставляет ни Content-Length, ни Transfer-Encoding, даже если мы всё равно
  // пишем body в сокет — на выходе получается некорректный HTTP-запрос, который
  // сервер вправе отклонить с 400 (легко словить именно на DELETE с телом).
  // Явно считаем длину сами, чтобы framing был корректным при любом методе.
  if (body.length) headers['Content-Length'] = String(body.length);
  else delete headers['content-length'];

  const lib = parsed.protocol === 'https:' ? https : http;
  const options = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: req.method,
    headers,
  };

  const upstream = lib.request(options, (upRes) => {
    const code = upRes.statusCode || 502;
    const statusLine = `HTTP/${upRes.httpVersion} ${code} ${upRes.statusMessage || ''}`;

    section('RESPONSE');
    console.log(paint(statusLine, statusColor(code) + COLORS.bold));
    logHeaders(upRes.headers);

    const respHeaders = { ...upRes.headers };
    ['transfer-encoding', 'connection', 'keep-alive'].forEach((h) => delete respHeaders[h]);
    res.writeHead(code, respHeaders);

    const capture = createCaptureStream('Response body');
    upRes.pipe(capture).pipe(res);
  });

  upstream.on('error', (err) => {
    section('ERROR');
    console.log(paint(`Error contacting target: ${err.message}`, COLORS.red));
    sendError(res, 502, `Error contacting the target server: ${err.message}`);
  });

  if (body.length) upstream.write(body);
  upstream.end();
});

server.listen(PORT, () => {
  console.log(`Proxy started: http://localhost:${PORT}`);
  console.log('Example (обычный запрос): http://localhost:' + PORT + '/?url=https://api.example.com/data');
  console.log('Example (через SSO/curl): http://localhost:' + PORT + '/?url=https://intranet.corp.local/data&sso=1');
  console.log('  или заголовком: X-Use-Sso: 1');
});