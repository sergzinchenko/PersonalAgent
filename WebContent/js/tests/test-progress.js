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
  console.log('\n── Вызовы инструментов по умолчанию не засоряют переписку ──');
  ok('по умолчанию — режим «только общий ход»', ui.toolVerbosity === 'hidden', ui.toolVerbosity);

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

  ui._renderToolTrack('c1');
  const host = document.getElementById('tool-track-host');
  ok('лента показана над полем ввода', host && host.hidden === false);
  ok('в скрытом режиме — только общий счёт, без имён',
     host.textContent.includes('1 из 3') && !host.textContent.includes('search_files'),
     host.textContent.trim());

  ui.toolVerbosity = 'compact';
  ui._renderToolTrack('c1');
  const rows = Array.from(document.querySelectorAll('#tool-track-host .tt-row'));
  ok('в кратком режиме видна вся последовательность шага', rows.length === 3, String(rows.length));
  ok('выполненный отмечен и показывает своё время',
     rows[0].className.includes('tt-done') && rows[0].textContent.includes('120 мс'), rows[0].textContent);
  ok('текущий выделен отдельно', rows[1].className.includes('tt-running'));
  ok('предстоящий помечен как предстоящий', rows[2].className.includes('tt-pending'));

  // Обратный отсчёт: считается от таймаута ОДНОГО вызова.
  ui.limits.toolTimeoutSeconds = 30;
  ui._updateToolCountdown(run);
  const cd = document.querySelector('#tool-track-host [data-countdown]');
  ok('у текущего вызова идёт обратный отсчёт', !!cd && /\d+ с/.test(cd.textContent), cd && cd.textContent);
  ok('и он отсчитывает от таймаута вызова, а не от начала хода',
     parseInt(cd.textContent, 10) <= 30 && parseInt(cd.textContent, 10) >= 24, cd.textContent);
  ok('в подсказке сказано, что будет по исчерпании', /прерв/.test(cd.title), cd.title);

  ui.toolVerbosity = 'detailed';
  ui._renderToolTrack('c1');
  const details = document.querySelectorAll('#tool-track-host details.tt-details');
  ok('в подробном режиме вызовы разворачиваются', details.length >= 1, String(details.length));
  ok('и по умолчанию свёрнуты', Array.from(details).every(d => !d.open));
  ok('внутри — аргументы и ответ',
     details[0].textContent.includes('Аргументы') && details[0].textContent.includes('Ответ'));

  // ══════════════════════════════════════════════
  console.log('\n── Лента переезжает внутрь шага плана ──');
  const plan = await agent.tasks.create('c1', 'Собрать отчёт', ['Найти файлы', 'Прочитать', 'Свести']);
  await agent.tasks.start('c1', 2);
  await ui.renderPlanPanel();
  ok('панель плана открыта', document.getElementById('plan-panel').hidden === false);
  const slot = document.querySelector('#plan-panel .plan-step.plan-doing .plan-track');
  ok('у текущего шага есть место под ленту', !!slot);
  ok('лента переехала туда', slot.textContent.includes('read_file'), slot.textContent.trim().slice(0, 80));
  ok('и не дублируется над полем ввода', document.getElementById('tool-track-host').hidden === true);

  // Место в сетке шага задано явно — иначе лента попадает в колонку
  // отметки шириной 18px и переносится по одному-два символа на строку.
  ok('у ленты внутри шага есть своё место в сетке',
     window.getComputedStyle(slot).gridColumn === '1 / -1',
     window.getComputedStyle(slot).gridColumn);

  // В скрытом режиме внутри плана ленте не место: там одна строка общего
  // счёта, и она разрывала бы список шагов служебной вставкой.
  ui.toolVerbosity = 'hidden';
  ui._renderToolTrack('c1');
  ok('в режиме «только общий ход» лента не лезет в план',
     slot.innerHTML === '', slot.innerHTML);
  ok('и остаётся над полем ввода',
     document.getElementById('tool-track-host').hidden === false);
  ui.toolVerbosity = 'compact';
  ui._renderToolTrack('c1');
  ok('в кратком режиме возвращается в шаг плана', slot.textContent.includes('read_file'));

  // ══════════════════════════════════════════════
  console.log('\n── Управление работой из панели плана ──');
  ok('пока ход идёт — кнопка остановки', !!document.getElementById('plan-panel-stop'));
  ok('кнопки «продолжить» при этом нет', !document.getElementById('plan-panel-resume'));
  ok('прервать план можно всегда', !!document.getElementById('plan-panel-finish'));

  let stopped = false;
  ui.stopAgent = () => { stopped = true; };
  document.getElementById('plan-panel-stop').click();
  await tick();
  ok('кнопка останавливает ход', stopped === true);

  // Ход завершился, но остался продолжаемым — журнал это помнит.
  ui._chatRuns.delete('c1');
  await db.put('runs', { chatId: 'c1', status: 'interrupted', stoppedBy: 'user' });
  await ui.renderPlanPanel();
  ok('после остановки предлагается продолжить', !!document.getElementById('plan-panel-resume'));
  ok('а кнопки остановки больше нет', !document.getElementById('plan-panel-stop'));

  let resumed = null;
  ui.resumeRun = async (id) => { resumed = id; };
  document.getElementById('plan-panel-resume').click();
  await tick();
  ok('она продолжает именно этот чат', resumed === 'c1', String(resumed));

  // Прерывание плана: подтверждение обязательно.
  ui._confirm = async () => true;
  document.getElementById('plan-panel-finish').click();
  await tick(8);
  ok('план прерывается', (await agent.tasks.active('c1')) === null);

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

  console.log('\n==============================================');
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('==============================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
