// ============================================================
//  ТЕСТ: видимость работы — лента вызовов, план, время сообщений
// ============================================================
//
// Одна тема: пользователь должен понимать, что происходит, не заглядывая
// в консоль. Проверяется то, что раньше приходилось выяснять по
// косвенным признакам:
//
//   • вызовы инструментов по умолчанию не пишутся в переписку — значит,
//     их ход обязан быть виден иначе: лентой над полем ввода, а при
//     открытом плане — внутри его текущего шага;
//   • у текущего вызова идёт обратный отсчёт до таймаута: пауза без
//     отсчёта неотличима от зависания;
//   • работу можно остановить и продолжить, а план — прервать;
//   • время сообщений читается: разделители дней, секунды, полная дата
//     в подсказке.
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
      mcp_servers: new Map(), security_log: new Map(), api_bundles: new Map(),
      artifacts: new Map(), tasks: new Map(), chat_stats: new Map(), runs: new Map() };
  }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(o.key ?? o.id ?? o.chatId, o); return o; }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, o) { for (const x of o) await this.put(s, x); return o.length; }
  async deleteAll(s, keys) { for (const k of keys) await this.delete(s, k); return keys.length; }
  async getAllByIndex(s, i, v) { return (await this.getAll(s)).filter(r => r[i] === v); }
}

(async () => {
  const rawHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // Стили подключаем настоящие: часть проверок ниже — про место элемента
  // в сетке, а без CSS такой дефект не виден в принципе. Дважды уже
  // ловили: пропущенное grid-column уводило элемент в чужую колонку.
  const css = fs.readFileSync(path.join(ROOT, 'css/styles.css'), 'utf8');
  const html = rawHtml
    .replace(/<script src="[^"]+"><\/script>\s*/g, '')
    .replace('</head>', '<style>' + css + '</style></head>');
  const dom = new JSDOM(html, { url: 'https://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const document = window.document;
  window.performance = window.performance || { now: () => Date.now() };
  window.SecretsVault = { encrypt: async (_d, v) => v || '', decrypt: async (_d, v) => v || '' };

  const files = [
    'js/core/markdown.js', 'js/core/log-guard.js', 'js/core/tool-sandbox.js', 'js/core/binary-formats.js',
    'js/core/limits-advisor.js',
    'js/engines/folders-engine.js', 'js/engines/security-engine.js', 'js/engines/skills-engine.js',
    'js/engines/api-import-engine.js', 'js/engines/prompts-library.js', 'js/engines/tasks-engine.js',
    'js/tools/tools-engine.js', 'js/tools/tools-registry.js', 'js/tools/tools-executor.js',
    'js/tools/tools-builtin.js', 'js/tools/tools-defs.js', 'js/tools/tools-mcp.js',
    'js/ui/ui-core.js', 'js/ui/ui-about.js', 'js/ui/ui-navigation.js', 'js/ui/ui-chat.js',
    'js/ui/ui-subtask.js', 'js/ui/ui-compaction.js', 'js/ui/ui-resume.js', 'js/ui/ui-metrics.js',
    'js/ui/ui-settings.js', 'js/ui/ui-connections.js', 'js/ui/ui-editors.js', 'js/ui/ui-transfer.js',
  ];
  window.eval(files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n') +
    '\nwindow.__X = { UI, FoldersEngine, SkillsEngine, ToolsEngine, SecurityEngine, PromptsLibrary, TasksEngine };\n');
  const X = window.__X;

  const db = new FakeDB();
  const folders = new X.FoldersEngine(db);
  await folders.ensureSeeded();
  const tools = new X.ToolsEngine(db);
  tools.folders = folders;
  await tools.loadTools();

  await db.put('chats', { id: 'c1', title: 'Работа', createdAt: 1, updatedAt: 2 });

  const agent = {
    db, folders, tools,
    skills: new X.SkillsEngine(db),
    prompts: new X.PromptsLibrary(db),
    tasks: new X.TasksEngine(db),
    files: { all: async () => [], statusOf: async () => 'ready' },
    llm: { isConfigured: () => true, model: 'm', maxTokens: 4096 },
    models: { allModels: () => [], describe: () => null, resolve: () => null },
    about: { name: 'Ада', label: 'Ада', releaseCount: () => 1, unread: async () => [], latest: () => null },
    security: new X.SecurityEngine(),
  };

  const ui = new X.UI(agent);
  ui.updateModelDisplay = () => {};
  ui.currentTab = 'chat';
  ui.currentChatId = 'c1';

  // ══════════════════════════════════════════════
  console.log('\n── Настройки по умолчанию ──');
  ok('в переписку вызовы по умолчанию не пишутся', ui.toolVerbosity === 'hidden', ui.toolVerbosity);
  // Глубина панели — своя настройка: переписку держат чистой, а за
  // работой при этом следят подробно.
  ok('а панель хода по умолчанию показывает вызовы', ui.panelDepth === 'tools', ui.panelDepth);

  // ══════════════════════════════════════════════
  console.log('\n── Лента вызовов ──');

  // Ход, как его заводит sendMessage: лента — часть состояния хода.
  const run = {
    startedAt: Date.now(), stage: null, partialContent: '', streamEl: null,
    turnToolCalls: 3, turnUserMsgId: null, stopRequested: false, abortCtl: null,
    subtaskAbort: null, statusTimer: null, track: [], trackStep: 1,
  };
  ui._chatRuns.set('c1', run);

  run.track = [
    { id: '1', name: 'list_files', step: 1, status: 'done', ms: 120, args: '{}', result: '{"files":[]}' },
    { id: '2', name: 'read_file', step: 1, status: 'running', ms: null, args: '{"file":"a.txt"}', result: null, startedAt: Date.now() - 4000 },
    { id: '3', name: 'search_files', step: 1, status: 'pending', ms: null, args: '{}', result: null },
  ];

  // Панель выключена — лента живёт над полем ввода одной строкой счёта.
  ui.panelDepth = 'off';
  ui._renderToolTrack('c1');
  const host = document.getElementById('tool-track-host');
  ok('при выключенной панели лента над полем ввода', host && host.hidden === false);
  // Счёт идёт по всему списку: выполняется второй из трёх — значит
  // «2 из 3», а не «1 из 3» (сделано из всего). Человеку нужен ответ на
  // вопрос «где мы сейчас», а не «сколько позади».
  ok('и это только общий счёт, без имён',
     host.textContent.includes('2 из 3') && !host.textContent.includes('search_files'),
     host.textContent.trim());
  ok('счётчик показывает текущий вызов, а не число выполненных',
     !host.textContent.includes('1 из 3'), host.textContent.trim());

  // ── Кратко и подробно: лента уходит в правую панель ──
  // Ход работы должен быть в одном месте, а не в двух углах экрана:
  // там же, где план задачи. Плана ещё нет — панель показывает одну
  // ленту и открывается сама.
  ui.panelDepth = 'tools';
  ui._renderToolTrack('c1');
  await tick(6);
  ok('панель открылась сама, чтобы показать вызовы',
     document.getElementById('plan-panel').hidden === false);
  ok('и назвалась по содержимому',
     document.querySelector('#plan-panel .plan-panel-title').textContent.includes('Ход работы'),
     document.querySelector('#plan-panel .plan-panel-title').textContent);
  ok('над полем ввода ленты при этом нет',
     document.getElementById('tool-track-host').hidden === true);

  const rows = Array.from(document.querySelectorAll('#plan-panel .tt-row'));
  ok('в кратком режиме видна вся последовательность шага', rows.length === 3, String(rows.length));
  ok('выполненный отмечен и показывает своё время',
     rows[0].className.includes('tt-done') && rows[0].textContent.includes('120 мс'), rows[0].textContent);
  ok('текущий выделен отдельно', rows[1].className.includes('tt-running'));
  ok('предстоящий помечен как предстоящий', rows[2].className.includes('tt-pending'));

  // Обратный отсчёт: считается от таймаута ОДНОГО вызова.
  ui.limits.toolTimeoutSeconds = 30;
  ui._updateToolCountdown(run);
  const cd = document.querySelector('#plan-panel [data-countdown]');
  ok('у текущего вызова идёт обратный отсчёт', !!cd && /\d+ с/.test(cd.textContent), cd && cd.textContent);
  ok('и он отсчитывает от таймаута вызова, а не от начала хода',
     parseInt(cd.textContent, 10) <= 30 && parseInt(cd.textContent, 10) >= 24, cd.textContent);
  ok('в подсказке сказано, что будет по исчерпании', /прерв/.test(cd.title), cd.title);

  ui.panelDepth = 'io';
  ui._renderToolTrack('c1');
  const details = document.querySelectorAll('#plan-panel details.tt-details');
  ok('в подробном режиме вызовы разворачиваются', details.length >= 1, String(details.length));
  ok('и по умолчанию свёрнуты', Array.from(details).every(d => !d.open));
  ok('внутри — аргументы и ответ',
     details[0].textContent.includes('Аргументы') && details[0].textContent.includes('Ответ'));

  // ══════════════════════════════════════════════
  console.log('\n── Лента переезжает внутрь шага плана ──');
  const plan = await agent.tasks.create('c1', 'Собрать отчёт', ['Найти файлы', 'Прочитать', 'Свести']);
  await agent.tasks.start('c1', 2);

  // Вызовы приписаны шагам: первый сделан на шаге 1, два других — на
  // шаге 2. Именно так их и расставляет цикл вызовов (см. planStep).
  run.track[0].planStep = 1;
  run.track[1].planStep = 2;
  run.track[2].planStep = 2;

  await ui.renderPlanPanel();
  ok('панель плана открыта', document.getElementById('plan-panel').hidden === false);
  ok('и теперь называется планом',
     document.querySelector('#plan-panel .plan-panel-title').textContent.includes('План'),
     document.querySelector('#plan-panel .plan-panel-title').textContent);

  const slot = document.querySelector('#plan-panel .plan-step.plan-doing .plan-track');
  ok('у текущего шага есть место под ленту', !!slot);
  ok('и оно помечено номером шага', slot.dataset.step === '2', slot.dataset.step);
  ok('лента переехала туда', slot.textContent.includes('read_file'), slot.textContent.trim().slice(0, 80));
  ok('и не дублируется над полем ввода', document.getElementById('tool-track-host').hidden === true);

  // Главное: у каждого шага — СВОИ вызовы, а не общий список за ход.
  const slot1 = document.querySelector('#plan-panel .plan-track[data-step="1"]');
  ok('у первого шага — только его вызов',
     slot1.textContent.includes('list_files') && !slot1.textContent.includes('read_file'),
     slot1.textContent.trim().slice(0, 80));
  ok('а у текущего — только его',
     !slot.textContent.includes('list_files') && slot.textContent.includes('search_files'),
     slot.textContent.trim().slice(0, 80));
  ok('счёт в шаге считает вызовы этого шага', slot.textContent.includes('1 из 2'),
     slot.textContent.trim().slice(0, 60));
  const slot3 = document.querySelector('#plan-panel .plan-track[data-step="3"]');
  ok('у шага без вызовов место пустует', slot3 && slot3.innerHTML === '');

  // Вызов вне шагов плана виден отдельно, а не приписывается чужому шагу.
  run.track[2].planStep = null;
  ui._renderToolTrack('c1');
  const loose = document.querySelector('#plan-panel .plan-list ~ .plan-track');
  ok('вызов вне шагов ушёл в общее место',
     loose && loose.textContent.includes('search_files'), loose && loose.textContent.trim());
  run.track[2].planStep = 2;
  ui._renderToolTrack('c1');

  // Место в сетке шага задано явно — иначе лента попадает в колонку
  // отметки шириной 18px и переносится по одному-два символа на строку.
  ok('у ленты внутри шага есть своё место в сетке',
     window.getComputedStyle(slot).gridColumn === '1 / -1',
     window.getComputedStyle(slot).gridColumn);

  // В скрытом режиме внутри плана ленте не место: там одна строка общего
  // счёта, и она разрывала бы список шагов служебной вставкой.
  ui.panelDepth = 'off';
  ui._renderToolTrack('c1');
  ok('при выключенной панели лента не лезет в план',
     slot.innerHTML === '', slot.innerHTML);
  ok('и возвращается к полю ввода',
     document.getElementById('tool-track-host').hidden === false);
  ui.panelDepth = 'tools';
  ui._renderToolTrack('c1');
  ok('и возвращается в шаг плана',
     document.querySelector('#plan-panel .plan-track[data-step="2"]').textContent.includes('read_file'));

  // ══════════════════════════════════════════════
  console.log('\n── Третий уровень: подзадача и её вызовы ──');
  run.track.push({
    id: 's1', name: 'run_subtask', step: 1, planStep: 2, status: 'running',
    kind: 'subtask', goal: 'Разобрать 10 файлов', subSteps: 3, subMaxSteps: 10,
    startedAt: Date.now(), ms: null, args: '{}', result: null,
    children: [
      { id: 'k1', name: 'read_file', status: 'done', ms: 900, args: '{}', result: '{}' },
      { id: 'k2', name: 'read_file', status: 'running', startedAt: Date.now(), ms: null, args: '{}', result: null },
    ],
  });
  ui._renderToolTrack('c1');
  const step2 = document.querySelector('#plan-panel .plan-track[data-step="2"]');
  ok('подзадача названа своей целью, а не именем инструмента',
     step2.textContent.includes('Разобрать 10 файлов') && !step2.textContent.includes('run_subtask'),
     step2.textContent.trim().slice(0, 120));
  ok('виден её прогресс', step2.textContent.includes('шаг 3 из 10'), step2.textContent.trim().slice(0, 120));
  ok('вызовы подзадачи показаны вложенно',
     !!step2.querySelector('.tt-children .tt-row'), step2.innerHTML.slice(0, 200));
  ok('у подзадачи есть кнопка прерывания', !!step2.querySelector('[data-stop-subtask]'));

  ui.panelDepth = 'subtasks';
  ui._renderToolTrack('c1');
  const step2b = document.querySelector('#plan-panel .plan-track[data-step="2"]');
  ok('на глубине «шаги и подзадачи» внутренности скрыты',
     step2b.textContent.includes('Разобрать 10 файлов') && !step2b.querySelector('.tt-children'),
     step2b.textContent.trim().slice(0, 120));
  ui.panelDepth = 'tools';
  ui._renderToolTrack('c1');

  // ══════════════════════════════════════════════
  console.log('\n── Управление работой из панели плана ──');
  ok('пока ход идёт — кнопки паузы и остановки',
     !!document.getElementById('run-pause') && !!document.getElementById('run-stop'));
  ok('кнопки «продолжить» при этом нет', !document.getElementById('run-continue'));
  ok('прервать план можно всегда', !!document.getElementById('plan-panel-finish'));

  let stopped = false;
  // Оригинал сохраняем: ниже проверяется НАСТОЯЩАЯ остановка — она должна
  // снимать паузу, иначе приостановленный ход остался бы ждать вечно.
  const realStopAgent = ui.stopAgent;
  ui.stopAgent = () => { stopped = true; };
  document.getElementById('run-stop').click();
  await tick();
  ok('кнопка останавливает ход', stopped === true);

  // Пауза меняет набор кнопок и объясняет, что теперь можно делать.
  ui._chatRuns.get('c1').paused = true;
  await ui.renderPlanPanel();
  ok('во время паузы предлагается продолжить', !!document.getElementById('run-resume'));
  ok('и сказано, что можно менять настройки',
     /ограничения/i.test(document.querySelector('#plan-panel .run-paused-text').textContent),
     document.querySelector('#plan-panel .run-paused-text').textContent.trim().slice(0, 80));
  ok('рядом — дорога к ним',
     !!document.querySelector('#plan-panel [data-open-limits]') &&
     !!document.querySelector('#plan-panel [data-open-tab="skills"]'));
  ui._chatRuns.get('c1').paused = false;
  ui.stopAgent = realStopAgent;

  // Ход завершился, но остался продолжаемым — журнал это помнит.
  ui._chatRuns.delete('c1');
  await db.put('runs', { chatId: 'c1', status: 'interrupted', stoppedBy: 'user' });
  await ui.renderPlanPanel();
  ok('после остановки предлагается продолжить', !!document.getElementById('run-continue'));
  ok('а кнопок паузы и остановки больше нет',
     !document.getElementById('run-pause') && !document.getElementById('run-stop'));

  let resumed = null;
  ui.resumeRun = async (id) => { resumed = id; };
  document.getElementById('run-continue').click();
  await tick();
  ok('она продолжает именно этот чат', resumed === 'c1', String(resumed));

  // Прерывание плана: подтверждение обязательно.
  ui._confirm = async () => true;
  document.getElementById('plan-panel-finish').click();
  await tick(8);
  ok('план прерывается', (await agent.tasks.active('c1')) === null);

  // ══════════════════════════════════════════════
  console.log('\n── Мягкая пауза ──');
  const run2 = {
    startedAt: Date.now() - 10000, stage: null, partialContent: '', streamEl: null,
    turnToolCalls: 1, turnUserMsgId: null, stopRequested: false, abortCtl: null,
    subtaskAbort: null, statusTimer: null, track: [], trackStep: 1,
    paused: false, pausedAt: 0, pausedMs: 0, resumeWaiters: [],
  };
  ui._chatRuns.set('c1', run2);

  const startedBefore = run2.startedAt;
  ui.pauseRun('c1');
  ok('ход помечен приостановленным', run2.paused === true);

  // Ожидающий должен проснуться ровно на продолжении, не раньше.
  let resumedFlag = false;
  const waiting = ui._awaitIfPaused('c1').then(() => { resumedFlag = true; });
  await tick(4);
  ok('работа действительно ждёт', resumedFlag === false);

  await new Promise(r => setTimeout(r, 30));
  ui.resumeRunPause('c1');
  await waiting;
  ok('продолжение будит ожидающего', resumedFlag === true);
  ok('пауза не съела бюджет времени хода', run2.startedAt > startedBefore,
     String(run2.startedAt - startedBefore));
  ok('и учтена отдельно', run2.pausedMs >= 20, String(run2.pausedMs));

  // Остановка во время паузы не должна оставить ход висеть.
  ui.pauseRun('c1');
  let woke = false;
  const waiting2 = ui._awaitIfPaused('c1').then(() => { woke = true; });
  ui.stopAgent();
  await waiting2;
  ok('остановка во время паузы будит ожидающего', woke === true);
  ok('и паузу снимает', run2.paused === false);
  ui._chatRuns.delete('c1');

  // ══════════════════════════════════════════════
  console.log('\n── Время сообщений ──');
  const day = 86400000;
  const now = Date.now();
  const msgs = [
    { id: 'm1', chatId: 'c1', role: 'user', content: 'позавчера', timestamp: now - 2 * day },
    { id: 'm2', chatId: 'c1', role: 'assistant', content: 'ответ', timestamp: now - 2 * day + 1000, model: 'm', durationMs: 900 },
    { id: 'm3', chatId: 'c1', role: 'user', content: 'вчера', timestamp: now - day },
    { id: 'm4', chatId: 'c1', role: 'user', content: 'сегодня', timestamp: now },
  ];
  const listHtml = ui._renderMessageList(msgs);
  const dividers = (listHtml.match(/day-divider/g) || []).length;
  ok('день отделён от дня', dividers === 3, String(dividers));
  ok('сегодняшний день назван словом', listHtml.includes('Сегодня'));
  ok('вчерашний тоже', listHtml.includes('Вчера'));
  ok('позавчерашний — датой', /\d+\s+\S+/.test(listHtml.split('day-divider')[1] || ''));

  const footer = ui._msgFooterInner(msgs[1]);
  ok('в подписи есть секунды', /\d{2}:\d{2}:\d{2}/.test(footer), footer);
  ok('и полная дата в подсказке', /title="[^"]*\d{2}\.\d{2}\.\d{4}/.test(footer), footer);

  const toolMsg = { id: 't1', chatId: 'c1', role: 'tool', name: 'read_file', content: '{}', timestamp: now };
  ok('у вызова инструмента в переписке тоже есть время',
     /msg-time/.test(ui._renderMessage(toolMsg)), ui._renderMessage(toolMsg));

  // ══════════════════════════════════════════════
  console.log('\n── Краткая строка вызова: чем вызвали ──');
  const label = ui._toolArgsLabel('{"file":"очень-длинное-имя-файла-которое-не-влезет.docx","mode":"text"}');
  ok('параметры перечислены парами «имя: значение»', /file: "/.test(label) && /mode: "text"/.test(label), label);
  ok('значение обрезано до 20 символов', /очень-длинное-имя-фа…/.test(label), label);
  ok('пустые параметры не показываются', ui._toolArgsLabel('{"a":"","b":null,"c":"да"}') === ' (c: "да")',
     ui._toolArgsLabel('{"a":"","b":null,"c":"да"}'));
  ok('не JSON — не ломает строку', ui._toolArgsLabel('не json') === '');

  const withArgs = { id: 't2', chatId: 'c1', role: 'tool', name: 'read_file',
    content: '{"ok":true}', argsLabel: ' (file: "a.txt")', timestamp: now };
  const rendered = ui._renderMessage(withArgs);
  ok('в переписке видно имя и параметры, а не начало ответа',
     rendered.includes('read_file') && /file: .?a\.txt/.test(rendered) && !rendered.includes('ok'),
     rendered);

  console.log('\n==============================================');
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('==============================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
