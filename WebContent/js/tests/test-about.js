// ============================================================
//  ТЕСТ: имя агента, история доработок, панель плана, строка состояния
// ============================================================
//
// Четыре обещания, данные пользователю, и все четыре проверяются здесь
// не по факту вызова функций, а по наблюдаемому результату:
//   1. У агента есть имя, он его знает и не выдумывает другого.
//   2. История доработок рассказывает о ВОЗМОЖНОСТЯХ и не раскрывает
//      устройство — это требование к содержимому, а не к формату,
//      поэтому проверяется текстом, а не схемой.
//   3. План виден отдельной панелью, а служебные вызовы его ведения
//      не забивают ленту.
//   4. Строка состояния живёт вне ленты сообщений — иначе её уносит
//      вверх растущим ответом ровно тогда, когда она нужна.
//
// Нужен настоящий DOM: половина проверок — про то, где именно оказался
// элемент и что с ним стало после смены чата.
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
    this.stores = {
      settings: new Map(), tasks: new Map(), tools: new Map(), skills: new Map(),
      chats: new Map(), messages: new Map(), folders: new Map(), files: new Map(),
    };
  }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(o.key ?? o.id ?? o.chatId, o); }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, o) { for (const x of o) await this.put(s, x); return o.length; }
  async deleteAll(s, keys) { for (const k of keys) await this.delete(s, k); return keys.length; }
  async getAllByIndex(s, idx, v) { return (await this.getAll(s)).filter(r => r[idx] === v); }
}

(async () => {
  const rawHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const html = rawHtml.replace(/<script src="[^"]+"><\/script>\s*/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const document = window.document;

  window.AbortController = window.AbortController || class { constructor() { this.signal = {}; } abort() {} };
  window.performance = window.performance || { now: () => Date.now() };
  window.Notification = { requestPermission: async () => 'denied' };
  window.SecretsVault = { encrypt: async (_d, v) => v || '', decrypt: async (_d, v) => v || '' };

  const files = [
    'js/core/markdown.js',
    'js/core/log-guard.js',
    'js/core/tool-sandbox.js',
    'js/engines/folders-engine.js',
    'js/core/changelog.js',
    'js/engines/about-engine.js',
    'js/engines/tasks-engine.js',
    'js/engines/security-engine.js',
    'js/engines/skills-engine.js',
    'js/tools/tools-engine.js',
    'js/tools/tools-registry.js',
    'js/tools/tools-executor.js',
    'js/tools/tools-builtin.js',
    'js/tools/tools-defs.js',
    'js/tools/tools-mcp.js',
    'js/tools/tools-tasks.js',
    'js/tools/tools-about.js',
    'js/ui/ui-core.js',
    'js/ui/ui-about.js',
    'js/ui/ui-navigation.js',
    'js/ui/ui-chat.js',
    'js/ui/ui-subtask.js',
    'js/ui/ui-compaction.js',
    'js/ui/ui-resume.js',
    'js/ui/ui-metrics.js',
    'js/ui/ui-settings.js',
    'js/ui/ui-connections.js',
    'js/ui/ui-editors.js',
    'js/ui/ui-transfer.js',
  ];
  window.eval(files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n') +
    '\nwindow.__X = { UI, AboutEngine, SkillsEngine, TasksEngine, ToolsEngine, SecurityEngine,' +
    ' APP_RELEASES, APP_RELEASE_COUNT, releasesSince };\n');
  const X = window.__X;

  // ══════════════════════════════════════════════
  console.log('\n── Имя агента: чистка и границы ──');
  const N = X.AboutEngine.normalizeName;
  ok('пробелы по краям убираются', N('  Ада  ') === 'Ада');
  ok('перевод строки не создаёт многострочного имени', N('Ада\nЛавлейс') === 'Ада Лавлейс');
  ok('повторные пробелы схлопываются', N('Ада    Л') === 'Ада Л');
  ok('длина ограничена', N('я'.repeat(200)).length === X.AboutEngine.MAX_NAME);
  ok('эмодзи в имени сохраняются', N('🦊 Лис') === '🦊 Лис');
  ok('пустой ввод даёт пустую строку, а не «undefined»', N(undefined) === '' && N(null) === '');

  const db = new FakeDB();
  const about = new X.AboutEngine(db);
  await about.load();
  ok('до первого запуска имени нет', about.name === null);
  ok('но подпись для интерфейса есть всегда', about.label === X.AboutEngine.FALLBACK_LABEL);
  ok('пустое имя не сохраняется', !!(await about.setName('   ')).error);
  ok('имени по-прежнему нет', about.name === null);

  const set = await about.setName('  Пятница ');
  ok('имя сохраняется очищенным', set.ok === true && set.name === 'Пятница');
  const about2 = new X.AboutEngine(db);
  await about2.load();
  ok('имя переживает перезапуск', about2.name === 'Пятница');

  // ══════════════════════════════════════════════
  console.log('\n── Имя в системном промпте ──');
  const skills = new X.SkillsEngine(db);
  await skills.loadSkills();
  const promptNoName = await skills.buildSystemPrompt();
  ok('без имени промпт честно говорит, что имени нет', /[Ии]мени тебе пока не дали/.test(promptNoName));
  ok('и не выдаёт подпись интерфейса за имя', !/зовут «AI Agent»/.test(promptNoName));

  skills.about = about2;
  const promptNamed = await skills.buildSystemPrompt();
  ok('с именем промпт называет его', promptNamed.includes('Тебя зовут «Пятница»'));
  ok('и запрещает выдумывать другое', /не придумывай себе другое/.test(promptNamed));
  ok('системный навык объясняет, чем менять имя', /agent_name/.test(promptNamed));
  ok('и чем рассказывать о новом', /whats_new/.test(promptNamed));

  // ══════════════════════════════════════════════
  console.log('\n── История доработок: содержимое ──');
  const rel = X.APP_RELEASES;
  ok('релизы пронумерованы подряд с единицы', rel.every((r, i) => r.n === i + 1));
  ok('счётчик совпадает с числом релизов', X.APP_RELEASE_COUNT === rel.length);
  ok('у каждого релиза есть заголовок', rel.every(r => typeof r.title === 'string' && r.title.length > 5));
  ok('и непустой перечень возможностей', rel.every(r => Array.isArray(r.items) && r.items.length));
  ok('заголовки не повторяются', new Set(rel.map(r => r.title)).size === rel.length);

  // Главная проверка требования «без раскрытия принципов реализации»:
  // это про слова, а не про структуру, поэтому и проверяется словами.
  const leaks = /IndexedDB|localStorage|prototype|systemPrompt|\.js\b|store\b|хранилищ|таблиц|индекс|обработчик|модул|класс[еа]?\b|исходник|код[еа]?\b/i;
  const leaking = [];
  for (const r of rel) {
    for (const item of [r.title, ...r.items]) if (leaks.test(item)) leaking.push(item);
  }
  ok('в истории нет технических подробностей устройства', leaking.length === 0, leaking.join(' | '));

  // ══════════════════════════════════════════════
  console.log('\n── Непрочитанное ──');
  ok('пока отметки нет, непрочитано всё', (await about2.unread()).length === rel.length);
  ok('отметки действительно нет', (await about2.lastSeenRelease()) === null);
  await about2.markRead(3);
  ok('после отметки остаётся только новое', (await about2.unread()).length === rel.length - 3);
  await about2.markRead(1);
  ok('отметка не откатывается назад', (await about2.lastSeenRelease()) === 3);
  await about2.markRead();
  ok('без номера отмечается всё', (await about2.unread()).length === 0);
  ok('releasesSince(0) отдаёт всю историю', X.releasesSince(0).length === rel.length);

  // ══════════════════════════════════════════════
  console.log('\n── Инструменты ──');
  const tools = new X.ToolsEngine(db);
  tools.about = about2;
  tools.security = null;
  tools.tasks = new X.TasksEngine(db);
  const defs = tools._allBuiltinDefs();
  const nameDef = defs.find(d => d.name === 'agent_name');
  const newsDef = defs.find(d => d.name === 'whats_new');
  ok('agent_name — системный инструмент', !!nameDef && nameDef.locked === true && nameDef.enabled === true);
  ok('whats_new — системный инструмент', !!newsDef && newsDef.locked === true && newsDef.enabled === true);
  ok('описание whats_new запрещает раскрывать устройство', /НЕ объясняй, как они устроены/.test(newsDef.description));

  await tools.loadTools();
  const got = await tools.executeTool('agent_name', { action: 'get' });
  ok('agent_name get возвращает текущее имя', got.name === 'Пятница' && got.has_name === true);
  const renamed = await tools.executeTool('agent_name', { action: 'set', name: 'Ада' });
  ok('agent_name set переименовывает', renamed.ok === true && renamed.name === 'Ада');
  ok('прежнее имя названо — есть что откатить', renamed.previous === 'Пятница');
  ok('пустое имя инструментом не проходит', !!(await tools.executeTool('agent_name', { action: 'set', name: ' ' })).error);
  ok('неизвестное действие объяснено', /Неизвестное действие/.test(
    (await tools.executeTool('agent_name', { action: 'нет-такого' })).error || ''));

  const count = await tools.executeTool('whats_new', { action: 'count' });
  ok('whats_new count знает число релизов', count.releases === rel.length);
  const all = await tools.executeTool('whats_new', { action: 'all', limit: 3 });
  ok('whats_new all отдаёт запрошенное число последних релизов', all.releases.length === 3);
  ok('и честно предупреждает, что показал не всё', /не вся|Показаны последние/.test(all.note));
  const one = await tools.executeTool('whats_new', { action: 'release', n: 1 });
  ok('whats_new release отдаёт конкретный релиз', one.release && one.release.n === 1);
  ok('несуществующий релиз объяснён', !!(await tools.executeTool('whats_new', { action: 'release', n: 999 })).error);
  await about2.markRead(0);
  db.stores.settings.set('changelog', { key: 'changelog', lastSeen: rel.length - 1 });
  const unread = await tools.executeTool('whats_new', {});
  ok('по умолчанию инструмент показывает непрочитанное', unread.unread === 1);
  ok('и напоминает отметить рассказанное', /mark_read/.test(unread.note));
  ok('в каждом ответе есть запрет на пересказ устройства', /Не объясняй, как это устроено/.test(unread.guidance));
  await tools.executeTool('whats_new', { action: 'mark_read' });
  ok('mark_read закрывает непрочитанное', (await about2.unread()).length === 0);

  console.log('\n── Безопасность ──');
  const sec = new X.SecurityEngine();
  ok('чтение истории не требует подтверждения', sec.categoryOf('whats_new') === 'read');
  ok('переименование отнесено к записи, а не к чтению', sec.categoryOf('agent_name') === 'write');

  // ══════════════════════════════════════════════
  console.log('\n── Навык «Эксперт по агенту» ──');
  const expert = (await skills.loadSkills()).find(s => s.id === 'skill_agent_expert');
  ok('навык умеет рассказывать о новом', (expert.toolIds || []).includes('builtin_whats_new'));
  ok('и знает, чем переименоваться', (expert.toolIds || []).includes('builtin_agent_name'));
  ok('в тексте навыка есть граница рассказа', /ГРАНИЦА РАССКАЗА/.test(expert.systemPrompt));
  ok('навык остаётся выключаемым (не системный)', !expert.locked);

  // Запись, заведённая до появления умения, обновляется…
  const stale = { ...expert, systemPrompt: 'старый текст', toolIds: ['builtin_diagnose'] };
  delete stale.builtinRev;
  db.stores.skills.set(stale.id, stale);
  const afterRefresh = (await skills.loadSkills()).find(s => s.id === 'skill_agent_expert');
  ok('устаревшее определение встроенного навыка обновляется',
     afterRefresh.systemPrompt !== 'старый текст' && (afterRefresh.toolIds || []).includes('builtin_whats_new'));

  // …а отредактированная пользователем — нет.
  const mine = { ...expert, systemPrompt: 'мой текст', editedByUser: true, builtinRev: 1 };
  db.stores.skills.set(mine.id, mine);
  const afterMine = (await skills.loadSkills()).find(s => s.id === 'skill_agent_expert');
  ok('отредактированный пользователем навык не затирается', afterMine.systemPrompt === 'мой текст');

  // Системный навык обновляется всегда — он неприкосновенен для правки.
  const sys = (await skills.loadSkills()).find(s => s.id === 'skill_system');
  db.stores.skills.set(sys.id, { ...sys, systemPrompt: 'подмена', editedByUser: true });
  const sysAfter = (await skills.loadSkills()).find(s => s.id === 'skill_system');
  ok('системный навык восстанавливается даже с отметкой о правке', sysAfter.systemPrompt !== 'подмена');

  // ══════════════════════════════════════════════
  console.log('\n── Интерфейс: имя и счётчик релизов ──');
  const tasks = new X.TasksEngine(db);
  const agent = {
    db,
    about: about2,
    tasks,
    llm: { isConfigured: () => false, model: 'test-model' },
    models: { allModels: () => [], describe: () => null },
    skills: { loadSkills: async () => [], toolIdsOf: () => [] },
    tools: { loadTools: async () => [] },
    files: { all: async () => [] },
  };
  const ui = new X.UI(agent);
  ui.refreshSidebar = async () => {};
  ui.updateModelDisplay = () => {};

  ui.applyAgentName('Ада');
  ok('имя видно в шапке', document.getElementById('agent-name').textContent === 'Ада');
  ok('и в заголовке вкладки', document.title.startsWith('Ада'));
  ui.applyAgentName(null);
  ok('без имени в шапке подпись по умолчанию',
     document.getElementById('agent-name').textContent === X.AboutEngine.FALLBACK_LABEL);
  ui.applyAgentName('Ада');

  await ui.updateReleaseBadge();
  const badge = document.getElementById('release-badge');
  ok('счётчик релизов виден и совпадает с историей', badge.textContent === 'r' + rel.length);
  ok('прочитанное не подсвечивается', !badge.classList.contains('has-unread'));
  db.stores.settings.set('changelog', { key: 'changelog', lastSeen: 1 });
  await ui.updateReleaseBadge();
  ok('непрочитанное подсвечивается', badge.classList.contains('has-unread'));
  ok('и сказано, сколько его', /Непрочитанных доработок: \d+/.test(badge.title));

  console.log('\n── Интерфейс: окно «Что нового» ──');
  await ui.showWhatsNewModal({ onlyUnread: true, markRead: true });
  await tick();
  const modalText = document.querySelector('.modal')?.textContent || '';
  ok('окно показывает непрочитанные релизы', modalText.includes('Релиз ' + rel.length));
  ok('прочитанного в нём нет', !/Релиз 1 —/.test(modalText));
  document.querySelector('.modal-actions .btn-primary').click();
  await tick();
  ok('после показа непрочитанного не остаётся', (await about2.unread()).length === 0);
  await ui.updateReleaseBadge();
  ok('подсветка счётчика снята', !badge.classList.contains('has-unread'));

  console.log('\n── Что показывать при запуске ──');
  // Новичку окно не показывают: догонять ему нечего, для него всё
  // приложение — одна новость. Отметка при этом ставится молча.
  db.stores.settings.delete('changelog');
  const beforeModals = document.getElementById('modals').innerHTML;
  await ui.checkWhatsNew();
  await tick();
  ok('новичку окно «Что нового» не показывается',
     document.getElementById('modals').innerHTML === beforeModals);
  ok('но история помечена прочитанной молча', (await about2.lastSeenRelease()) === rel.length);

  // Вернувшемуся — показывают, и ровно то, чего он не видел.
  db.stores.settings.set('changelog', { key: 'changelog', lastSeen: rel.length - 2 });
  await ui.checkWhatsNew();
  await tick();
  ok('вернувшемуся окно показывается само', !!document.querySelector('.modal-overlay'));
  const backText = document.querySelector('.modal').textContent;
  // Номера берём из самой истории: захардкоженные устаревают с каждым релизом.
  ok('и показывает только новое',
     backText.includes('Релиз ' + rel.length) && !backText.includes('Релиз ' + (rel.length - 3)));
  document.querySelector('.modal-actions .btn-primary').click();
  await tick();
  ok('после показа непрочитанного не остаётся (2)', (await about2.unread()).length === 0);
  await ui.checkWhatsNew();
  await tick();
  ok('второй раз то же самое не показывается', !document.querySelector('.modal-overlay'));

  console.log('\n── Интерфейс: знакомство при первом запуске ──');
  await about2.setName('');           // имя не сбрасывается пустым — проверяем это же
  ok('пустым именем сброс не делается', about2.name === 'Ада');
  db.stores.settings.delete('identity');
  const fresh = new X.AboutEngine(db);
  await fresh.load();
  agent.about = fresh;
  const asked = ui.askAgentName({ first: true });
  await tick();
  ok('окно знакомства открылось', !!document.querySelector('.modal-overlay'));
  ok('и объясняет, зачем имя нужно', /отзываться на него/.test(document.querySelector('.modal').textContent));
  document.getElementById('agent_name_input').value = 'Фрида';
  document.querySelector('.modal-actions .btn-primary').click();
  ok('имя принято и применено', (await asked) === 'Фрида' && fresh.name === 'Фрида');
  ok('шапка обновлена сразу', document.getElementById('agent-name').textContent === 'Фрида');

  // ══════════════════════════════════════════════
  console.log('\n── Панель плана ──');
  agent.about = about2;
  ui.currentTab = 'chat';
  ui.currentChatId = 'chatA';
  const app = document.getElementById('app');
  const panel = document.getElementById('plan-panel');

  await ui.renderPlanPanel();
  ok('без плана панели нет', panel.hidden === true && !app.classList.contains('plan-open'));

  const plan = await tasks.create('chatA', 'Собрать отчёт', ['Выгрузить', 'Свести', 'Написать']);
  await tasks.start('chatA', 1);
  await tasks.done('chatA', 1, 'выгружено 3 файла');
  await tasks.start('chatA', 2);
  await tasks.addFact('chatA', 'данные только за прошлый год');
  await ui.renderPlanPanel();
  const body = document.getElementById('plan-panel-body').textContent;
  ok('с планом панель появляется', panel.hidden === false && app.classList.contains('plan-open'));
  ok('в панели видна цель', body.includes('Собрать отчёт'));
  ok('видно, сколько сделано', /1 из 3/.test(body));
  ok('видны все шаги', body.includes('Выгрузить') && body.includes('Свести') && body.includes('Написать'));
  ok('виден результат закрытого шага', body.includes('выгружено 3 файла'));
  ok('видны факты, выясненные по дороге', body.includes('прошлый год'));
  ok('текущий шаг выделен', !!document.querySelector('#plan-panel-body .plan-step.plan-doing'));

  ui.hidePlanPanel();
  await tick();
  ok('крестик убирает панель', panel.hidden === true && !app.classList.contains('plan-open'));
  await ui.renderPlanPanel();
  ok('и она не возвращается сама для того же плана', panel.hidden === true);

  ui._planPanelDismissed = null;
  ui.currentTab = 'tools';
  await ui.renderPlanPanel();
  ok('вне вкладки чатов панели плана нет', panel.hidden === true);
  ui.currentTab = 'chat';
  await ui.renderPlanPanel();
  ok('на вкладке чатов возвращается', panel.hidden === false);

  await tasks.finish('chatA', 'cancelled');
  await ui.renderPlanPanel();
  ok('после закрытия плана панель исчезает', panel.hidden === true && !app.classList.contains('plan-open'));

  console.log('\n── Вызовы ведения плана в ленте ──');
  ui.toolVerbosity = 'detailed';
  const planBlock = ui._renderToolCallBlock(
    'task_plan', JSON.stringify({ action: 'done', step: 2, result: 'готово' }),
    JSON.stringify({ ok: true, plan: { done: 2, total: 3 } }), 12, false);
  ok('при подробной детализации вызов плана всё равно одна строка', !/<pre/.test(planBlock));
  ok('и сказано, что именно сделано', /закрыл шаг 2/.test(planBlock));
  ok('со счётчиком выполненного', /2\/3/.test(planBlock));

  const otherBlock = ui._renderToolCallBlock('calculator', '{"expression":"2+2"}', '{"result":4}', 3, false);
  ok('остальные инструменты подробный режим не теряют', /<pre/.test(otherBlock));

  const failBlock = ui._renderToolCallBlock(
    'task_plan', JSON.stringify({ action: 'start', step: 9 }),
    JSON.stringify({ error: 'Шага 9 в плане нет' }), 5, true);
  ok('ошибка ведения плана видна, а не спрятана', /Шага 9 в плане нет/.test(failBlock));

  // ══════════════════════════════════════════════
  console.log('\n── Строка состояния ──');
  ui.limits.maxTurnSeconds = 180;
  const run = { startedAt: Date.now() - 5000, stage: null, statusTimer: null };
  ui._chatRuns.set('chatA', run);
  ui._showStatus('chatA', 'Выполняю инструмент: http_fetch', 'вызов 3 из 5');
  const status = document.getElementById('agent-status');
  ok('строка состояния появилась', !!status);
  ok('она НЕ внутри ленты сообщений', !document.getElementById('chat-messages').contains(status));
  ok('а закреплена над полем ввода',
     document.getElementById('chat-input-area').contains(status));
  ok('хозяин строки показан', document.getElementById('agent-status-host').hidden === false);
  ok('видна стадия работы', status.querySelector('.status-text').textContent.includes('http_fetch'));
  ok('видны подробности шага', status.querySelector('.status-detail').textContent === 'вызов 3 из 5');
  ok('видно время работы и его предел', /\d+ с из 180/.test(status.querySelector('.status-timer').textContent));

  ui.limits.maxTurnSeconds = 0;
  ui._chatRuns.set('chatB', { startedAt: Date.now() - 2000, stage: null, statusTimer: null });
  ui._hideStatusBar();
  ui.currentChatId = 'chatB';
  ui._showStatus('chatB', 'Жду ответ модели…', '');
  ok('без заданного предела показано только время',
     /^\d+ с$/.test(document.querySelector('#agent-status .status-timer').textContent));

  clearInterval(run.statusTimer);
  clearInterval(ui._chatRuns.get('chatB').statusTimer);
  ui._chatRuns.clear();
  ui._hideStatusBar();
  const host = document.getElementById('agent-status-host');
  ok('снятая строка спрятана и очищена', host.hidden === true && host.innerHTML === '');
  ok('и в документе её больше нет', !document.getElementById('agent-status'));

  console.log('\n==============================================');
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('==============================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
