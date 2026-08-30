// ============================================================
//  BUILD PROD — сборка продакшен-бандла в dist/
// ============================================================
//
// Приложение целиком построено на обычных <script> без type="module":
// все js/*.js делят один и тот же глобальный scope, порядок подключения
// в index.html важен (см. комментарии там же). Сборка не меняет это
// поведение, а лишь склеивает файлы в том же порядке в одну строку —
// это эквивалентно тому, что браузер и так делает, исполняя их подряд.
//
// Дальше склеенный бандл обфусцируется ОДНИМ проходом (а не файл за
// файлом): классы вроде ToolsEngine или UI объявляются в одном файле
// и дополняются через Object.assign(X.prototype, {...}) в остальных —
// имя класса должно остаться одинаковым между файлами. Обфускация
// файлов по отдельности почти гарантированно рассинхронизировала бы
// эти имена и сломала бы приложение тихо, без ошибки при сборке.
//
// renameGlobals оставлен выключенным (по умолчанию в javascript-obfuscator):
// верхнеуровневые имена — это не только связки между файлами, но и точка
// входа для отладки прямо в консоли браузера (agent.tools.debug = true,
// agent.llm.debug = true, см. комментарии в tools-engine.js/agent.js).
// Обфускация локальных переменных, строк и структуры внутри функций
// при этом работает как обычно и даёт основной эффект.
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.join(__dirname, '..');
const INDEX_HTML_PATH = path.join(ROOT, 'index.html');
const DIST_DIR = path.join(ROOT, 'dist');
const BUNDLE_NAME = 'app.min.js';

const SCRIPT_TAG_RE = /<script src="(js\/[^"]+\.js)"><\/script>/;

function extractScriptOrder(html) {
  const files = [];
  for (const line of html.split('\n')) {
    const m = line.match(SCRIPT_TAG_RE);
    if (m) files.push(m[1]);
  }
  return files;
}

// Заменяет весь диапазон строк от первого до последнего <script src="js/...">
// (включая поясняющие HTML-комментарии между ними — они описывают порядок
// подключения отдельных файлов, который в продакшен-версии уже не виден)
// на один тег, подключающий готовый бандл.
function buildProdHtml(html) {
  const lines = html.split('\n');
  let first = -1, last = -1;
  lines.forEach((line, i) => {
    if (SCRIPT_TAG_RE.test(line)) {
      if (first === -1) first = i;
      last = i;
    }
  });
  if (first === -1) {
    throw new Error('В index.html не найдено ни одного <script src="js/...">');
  }

  // Пояснительный HTML-комментарий прямо над первым <script> (про порядок
  // подключения подпапок js/) в продакшен-версии с одним бандлом не нужен —
  // поглощаем его в заменяемый диапазон, а не оставляем висеть перед тегом.
  let start = first;
  if (start > 0 && lines[start - 1].trim().endsWith('-->')) {
    let k = start - 1;
    while (k >= 0 && !lines[k].includes('<!--')) k--;
    if (k >= 0) start = k;
  }

  const replaced = [
    ...lines.slice(0, start),
    `<script src="${BUNDLE_NAME}"></script>`,
    ...lines.slice(last + 1),
  ];
  return replaced.join('\n');
}

function build() {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const files = extractScriptOrder(html);
  if (!files.length) throw new Error('Не нашёл ни одного скрипта в index.html');
  console.log(`Найдено ${files.length} скриптов в index.html, склеиваю в порядке подключения…`);

  // Разделитель ";\n" между файлами страхует от случайного склеивания
  // выражений через ASI на границе файлов (например, если один файл
  // заканчивается вызовом без ";", а следующий начинается с "(" или "[").
  const bundle = files.map((rel) => {
    const full = path.join(ROOT, rel);
    const code = fs.readFileSync(full, 'utf8');
    return `// ── ${rel} ──\n${code}`;
  }).join('\n;\n');

  console.log(`Обфусцирую бандл (${bundle.length} символов исходного кода)…`);
  const obfuscated = JavaScriptObfuscator.obfuscate(bundle, {
    compact: true,
    controlFlowFlattening: false, // ощутимо утяжеляет рантайм — не нужно для чата в реальном времени
    deadCodeInjection: false,
    stringArray: true,
    stringArrayThreshold: 0.75,
    stringArrayEncoding: ['base64'],
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false, // см. пояснение в шапке файла
    selfDefending: false, // ломает обычную минификацию/отладку, реальной защиты не даёт
    debugProtection: false,
  }).getObfuscatedCode();

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(path.join(DIST_DIR, BUNDLE_NAME), obfuscated, 'utf8');
  console.log(`✓ dist/${BUNDLE_NAME} записан (${obfuscated.length} символов)`);

  // CSS не обфусцируется (в этом нет смысла) — просто копируется, чтобы
  // dist/ был самодостаточной, готовой к раздаче папкой.
  fs.mkdirSync(path.join(DIST_DIR, 'css'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'css', 'styles.css'), path.join(DIST_DIR, 'css', 'styles.css'));
  console.log('✓ dist/css/styles.css скопирован');

  const prodHtml = buildProdHtml(html);
  fs.writeFileSync(path.join(DIST_DIR, 'index.html'), prodHtml, 'utf8');
  console.log('✓ dist/index.html записан');

  console.log('\nГотово. dist/ можно раздавать как есть любым статическим веб-сервером.');
}

build();
