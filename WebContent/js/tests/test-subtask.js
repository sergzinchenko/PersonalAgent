// ============================================================
//  ТЕСТ: решение задачи по частям (run_subtask)
// ============================================================
//
// Главное свойство подзадачи — экономия контекста родителя: сколько бы
// шагов она ни заняла, в основную переписку возвращается ОДИН ответ, а
// промежуточные вызовы инструментов остаются в её собственном чате.
// Здесь это и проверяется — вместе с ограничениями (шаги, прерывание,
// запрет вложенности) и с тем, что переписка подзадачи не засоряет
// список чатов пользователя.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + extra : '')); }
};

const ROOT = path.join(__dirname, '..', '..');
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

class FakeDB {
  constructor() {
    this.stores = { chats: new Map(), messages: new Map(), chat_stats: new Map(), folders: new Map(), files: new Map(), artifacts: new Map() };
  }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async getAllByIndex(s, indexName, value) {
    return Array.from(this.stores[s].values()).filter(v => v[indexName] === value);
  }
  async put(s, o) { this.stores[s].set(o.id ?? o.chatId ?? o.key, o); return o; }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, arr) { for (const o of arr) await this.put(s, o); return arr.length; }
  async deleteAll(s, keys) { for (const k of keys) await this.delete(s, k); return keys.length; }
}

(async () => {
  const rawHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const html = rawHtml.replace(/<script src="[^"]+"><\/script>\s*/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const document = window.document;

  window.AbortController = window.AbortController || class {
    constructor() { this.signal = {}; } abort() {}
  };
  window.performance = window.performance || { now: () => Date.now() };
  window.Notification = { requestPermission: async () => 'granted' };
  window.localStorage = window.localStorage || { getItem() { return null; }, setItem() {}, removeItem() {} };

  const files = [
    'js/core/markdown.js',
    'js/core/log-guard.js',
    'js/core/tool-sandbox.js',
    'js/engines/folders-engine.js',
    'js/engines/artifacts-engine.js',
    'js/ui/ui-core.js',
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
  const combined = files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n')
    + '\nwindow.__UI = UI; window.__Artifacts = ArtifactsEngine; window.__FORBIDDEN = SUBTASK_FORBIDDEN_TOOLS;\n';
  window.eval(combined);
  const UI = window.__UI;
  const ArtifactsEngine = window.__Artifacts;

  console.log('\n── Сборка ──');
  ok('UI и движок артефактов собрались', typeof UI === 'function' && typeof ArtifactsEngine === 'function');
  ok('вложенные подзадачи запрещены на уровне списка инструментов',
     window.__FORBIDDEN.has('run_subtask'));

  const db = new FakeDB();
  const MODELS = {
    'conn::big': { conn: { id: 'c', name: 'P' }, model: { id: 'big', name: 'model-big', maxTokens: 4096, contextWindow: 100000 } },
    'conn::small': { conn: { id: 'c', name: 'P' }, model: { id: 'small', name: 'model-small', maxTokens: 2048, contextWindow: 40000 } },
  };
  const fakeLlm = { model: null, maxTokens: 4096, apiUrl: 'x', apiKey: 'x', isConfigured: () => true };
  const fakeModels = {
    defaultRef: 'conn::big',
    resolve(ref) { const d = MODELS[ref]; return d ? { ...d, ref } : null; },
    allModels() { return Object.entries(MODELS).map(([ref, d]) => ({ ref, name: d.model.name, label: d.model.name, connName: 'P' })); },
    describe(ref) { const r = this.resolve(ref || this.currentRef || this.defaultRef); return r ? { ref: r.ref, model: r.model.name, label: r.model.name, contextWindow: r.model.contextWindow } : null; },
    applyRef(ref) {
      const r = this.resolve(ref); if (!r) return false;
      this.currentRef = ref; fakeLlm.model = r.model.name; fakeLlm.maxTokens = r.model.maxTokens; return true;
    },
  };

  // Сценарий ответов модели: очередь, из которой берётся ответ на каждый
  // запрос. Так тест управляет тем, сколько шагов сделает подзадача.
  let script = [];
  const seen = [];
  fakeLlm.chat = async (messages, opts) => {
    seen.push({ messages: JSON.parse(JSON.stringify(messages.map(m => ({ role: m.role, content: m.content })))), opts, model: fakeLlm.model });
    const next = script.shift();
    if (!next) return { content: 'пусто', usage: { prompt_tokens: 10, completion_tokens: 5 } };
    if (typeof next === 'function') return next();
    return next;
  };

  const toolCallsMade = [];
  const agent = {
    db,
    llm: fakeLlm,
    models: fakeModels,
    artifacts: new ArtifactsEngine(db),
    skills: { buildSystemPrompt: async () => 'SYSTEM' },
    tools: {
      getEnabledToolsForAPI: async () => ([
        { type: 'function', function: { name: 'read_file', description: '', parameters: {} } },
        { type: 'function', function: { name: 'run_subtask', description: '', parameters: {} } },
      ]),
      executeTool: async (name, args) => { toolCallsMade.push({ name, args }); return { ok: true, text: 'x'.repeat(50) }; },
    },
    files: { all: async () => [] },
    folders: { all: async () => [] },
    security: { resetTurn() {} },
  };

  const ui = new UI(agent);
  ui.updateChatToolbar = () => {};
  ui.updateModelDisplay = () => {};

  const parent = { id: 'main', title: 'Основной чат', modelRef: 'conn::big', modelRefs: ['conn::big'], model: 'model-big', createdAt: 1, updatedAt: 1 };
  await db.put('chats', parent);
  await ui.loadChat('main');

  console.log('\n── Подзадача из нескольких шагов возвращает один ответ ──');
  script = [
    { content: '', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a"}' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
    { content: '', tool_calls: [{ id: 'c2', function: { name: 'read_file', arguments: '{"path":"b"}' } }], usage: { prompt_tokens: 300, completion_tokens: 20 } },
    { content: 'Итог: в файлах a и b по 50 символов.', usage: { prompt_tokens: 500, completion_tokens: 30 } },
  ];
  const res = await ui.runSubtask('main', { goal: 'Прочитать файлы a и b', context: 'пути известны' });

  ok('подзадача выполнена', res.ok === true, JSON.stringify(res).slice(0, 200));
  ok('вернулся только итоговый текст', res.result === 'Итог: в файлах a и b по 50 символов.');
  ok('посчитаны шаги и вызовы', res.steps === 3 && res.tool_calls === 2, `${res.steps}/${res.tool_calls}`);
  ok('инструменты действительно вызывались', toolCallsMade.length === 2);
  ok('в ответе есть ссылка на переписку подзадачи', typeof res.subtask_chat_id === 'string');

  const subId = res.subtask_chat_id;
  const subMsgs = await db.getAllByIndex('messages', 'chatId', subId);
  ok('вся черновая работа осталась в под-чате', subMsgs.filter(m => m.role === 'tool').length === 2,
     JSON.stringify(subMsgs.map(m => m.role)));
  const mainMsgs = await db.getAllByIndex('messages', 'chatId', 'main');
  ok('в родительский чат не попало ни одного сообщения подзадачи', mainMsgs.length === 0,
     JSON.stringify(mainMsgs.map(m => m.role)));

  console.log('\n── Подзадача не видит переписку родителя и не может звать подзадачи ──');
  const firstCall = seen[0];
  ok('в запросе подзадачи только системный промпт и задание', firstCall.messages.length === 2);
  ok('системный промпт объясняет, что это подзадача', /ПОДЗАДАЧУ/.test(firstCall.messages[0].content));
  ok('переданный контекст дошёл до исполнителя', /пути известны/.test(firstCall.messages[1].content));
  ok('инструмент run_subtask внутри подзадачи не предлагается',
     !firstCall.opts.tools.some(t => t.function.name === 'run_subtask'));
  ok('остальные инструменты доступны',
     firstCall.opts.tools.some(t => t.function.name === 'read_file'));

  console.log('\n── Своя модель у подзадачи ──');
  seen.length = 0;
  script = [{ content: 'готово', usage: { prompt_tokens: 10, completion_tokens: 5 } }];
  await ui.runSubtask('main', { goal: 'мелочь', model: 'model-small' });
  ok('запрос подзадачи ушёл на указанную модель', seen[0].model === 'model-small', seen[0].model);
  ok('после подзадачи шлюзу возвращена модель родителя', fakeLlm.model === 'model-big', fakeLlm.model);

  console.log('\n── Ограничение шагов ──');
  script = [];
  for (let i = 0; i < 10; i++) {
    script.push({ content: '', tool_calls: [{ id: 'x' + i, function: { name: 'read_file', arguments: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  }
  const limited = await ui.runSubtask('main', { goal: 'бесконечная работа', max_steps: 3 });
  ok('подзадача остановлена по лимиту шагов', limited.ok === false && limited.steps === 3, JSON.stringify(limited).slice(0, 160));
  ok('причина названа понятным текстом', /не уложилась в 3 шаг/.test(limited.error), limited.error);
  ok('модель предупреждена не выдумывать итог', /не выдавай за результат/.test(limited.hint));

  console.log('\n── Большой результат внутри подзадачи ──');
  agent.tools.executeTool = async () => ({ ok: true, text: 'ц'.repeat(9000) });
  script = [
    { content: '', tool_calls: [{ id: 'big', function: { name: 'read_file', arguments: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { content: 'прочитал', usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  const withArtifact = await ui.runSubtask('main', { goal: 'большой файл' });
  const arts = await db.getAllByIndex('artifacts', 'chatId', withArtifact.subtask_chat_id);
  ok('большой результат вынесен в артефакт подзадачи', arts.length === 1, String(arts.length));
  const subToolMsg = (await db.getAllByIndex('messages', 'chatId', withArtifact.subtask_chat_id)).find(m => m.role === 'tool');
  ok('в переписке подзадачи вместо содержимого — шапка',
     subToolMsg.content.length < 2000 && subToolMsg.content.includes('artifact_id'), String(subToolMsg.content.length));
  agent.tools.executeTool = async (name, args) => { toolCallsMade.push({ name, args }); return { ok: true, text: 'x'.repeat(50) }; };

  console.log('\n── Прерывание пользователем ──');
  const run = { startedAt: Date.now(), stopRequested: false, subtaskAbort: null, turnToolCalls: 0 };
  ui._chatRuns.set('main', run);
  script = [
    { content: '', tool_calls: [{ id: 's1', function: { name: 'read_file', arguments: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    () => { run.stopRequested = true; return { content: '', tool_calls: [{ id: 's2', function: { name: 'read_file', arguments: '{}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }; },
    { content: 'не должно дойти', usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  const stoppedRes = await ui.runSubtask('main', { goal: 'долгая работа' });
  ok('подзадача остановлена по кнопке', stoppedRes.ok === false && /прервана пользователем/.test(stoppedRes.error),
     JSON.stringify(stoppedRes).slice(0, 160));
  ui._chatRuns.delete('main');

  console.log('\n── Переписки подзадач не засоряют список чатов ──');
  await ui.refreshSidebar();
  const sidebar = document.getElementById('sidebar-list').textContent;
  ok('основной чат в списке есть', sidebar.includes('Основной чат'));
  ok('под-чаты в списке скрыты', !sidebar.includes('Прочитать файлы a и b'), sidebar.slice(0, 200));

  console.log('\n── Вход в подзадачу и возврат ──');
  await ui.openSubtaskChat(subId);
  ok('переписка подзадачи открылась', ui.currentChatId === subId);
  const banner = document.querySelector('.subtask-banner');
  ok('показана плашка с объяснением и возвратом', !!banner && /переписка подзадачи/.test(banner.textContent));
  banner.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  ok('кнопка вернула в основной чат', ui.currentChatId === 'main', ui.currentChatId);

  console.log('\n── Удаление чата уносит его подзадачи ──');
  const beforeChats = (await db.getAll('chats')).length;
  await ui.deleteChat('main');
  const afterChats = await db.getAll('chats');
  ok('удалены и родитель, и все его подзадачи', afterChats.length === 0, `${beforeChats} → ${afterChats.length}`);
  ok('сообщения подзадач тоже удалены', (await db.getAllByIndex('messages', 'chatId', subId)).length === 0);
  ok('артефакты подзадач тоже удалены', (await db.getAll('artifacts')).length === 0);

  console.log('\n==============================================');
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('==============================================');
  process.exit(fail ? 1 : 0);
})();
