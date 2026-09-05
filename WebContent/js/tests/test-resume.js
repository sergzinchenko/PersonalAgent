// ============================================================
//  ТЕСТ: устойчивость к сбою и возобновление хода
// ============================================================
//
// Ход агента живёт в памяти вкладки. Проверяем, что её потеря (закрытие,
// перезагрузка, падение) больше не означает потерю работы: журнал хода
// переживает сбой, недописанный ответ сохраняется, оборванная цепочка
// вызовов чинится (иначе чат становится нерабочим совсем), а продолжить
// можно с того места, докуда дошли, — не повторяя сделанного.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + extra : '')); }
};

const ROOT = path.join(__dirname, '..', '..');
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

class FakeDB {
  constructor() {
    this.stores = { chats: new Map(), messages: new Map(), chat_stats: new Map(), folders: new Map(), files: new Map(), artifacts: new Map(), tasks: new Map(), runs: new Map() };
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

  window.AbortController = window.AbortController || class { constructor() { this.signal = {}; } abort() {} };
  window.performance = window.performance || { now: () => Date.now() };
  window.Notification = { requestPermission: async () => 'granted' };
  window.localStorage = window.localStorage || { getItem() { return null; }, setItem() {}, removeItem() {} };

  const files = [
    'js/core/markdown.js',
    'js/core/log-guard.js',
    'js/engines/folders-engine.js',
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
  window.eval(files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n') + '\nwindow.__UI = UI;\n');
  const UI = window.__UI;

  const db = new FakeDB();
  const MODELS = { 'conn::a': { conn: { id: 'c', name: 'P' }, model: { id: 'a', name: 'model-a', maxTokens: 4096, contextWindow: 100000 } } };
  const fakeLlm = { model: null, maxTokens: 4096, apiUrl: 'x', apiKey: 'x', isConfigured: () => true };
  const fakeModels = {
    defaultRef: 'conn::a',
    resolve(ref) { const d = MODELS[ref]; return d ? { ...d, ref } : null; },
    allModels() { return [{ ref: 'conn::a', name: 'model-a', label: 'model-a' }]; },
    describe(ref) { const r = this.resolve(ref || 'conn::a'); return r ? { ref: r.ref, model: r.model.name, label: r.model.name, contextWindow: r.model.contextWindow } : null; },
    applyRef(ref) { const r = this.resolve(ref); if (!r) return false; fakeLlm.model = r.model.name; return true; },
  };

  let pending = null;              // управляемый ответ модели
  const requests = [];
  fakeLlm.chat = (messages, opts) => new Promise((resolve, reject) => {
    requests.push({ messages, opts });
    pending = { resolve, reject, opts };
  });

  const agent = {
    db, llm: fakeLlm, models: fakeModels, artifacts: null, tasks: null,
    skills: { buildSystemPrompt: async () => 'SYSTEM', loadSkills: async () => [] },
    tools: { getEnabledToolsForAPI: async () => [], executeTool: async () => ({ ok: true }) },
    files: { all: async () => [] },
    folders: { all: async () => [] },
    security: { resetTurn() {} },
  };

  const ui = new UI(agent);
  ui.refreshSidebar = async () => {};
  ui.updateChatToolbar = async () => {};
  ui.updateModelDisplay = () => {};

  await db.put('chats', { id: 'c1', title: 'Чат', modelRef: 'conn::a', modelRefs: ['conn::a'], model: 'model-a', createdAt: 1, updatedAt: 1 });

  console.log('\n── Журнал хода ведётся во время работы ──');
  await ui.loadChat('c1');
  document.getElementById('chat-input').value = 'Задача';
  const sending = ui.sendMessage();
  await tick();
  let journal = await db.get('runs', 'c1');
  ok('запись о ходе появилась сразу', !!journal && journal.status === 'running', JSON.stringify(journal));
  ok('в журнале записана стадия', !!journal.stage, journal && journal.stage);

  pending.resolve({ content: 'Готовый ответ', usage: { prompt_tokens: 10, completion_tokens: 5 } });
  await sending;
  await tick();
  ok('после штатного завершения журнал очищен', !(await db.get('runs', 'c1')));

  console.log('\n── Обрыв посреди цепочки инструментов ──');
  // Воспроизводим состояние после падения вкладки: в базе остались
  // сообщение с вызовом инструмента без результата, запись «ход идёт»
  // и накопленный, но не сохранённый текст ответа.
  await db.put('messages', {
    id: 'm_call', chatId: 'c1', role: 'assistant', content: '',
    tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{}' } },
                 { id: 'call_2', function: { name: 'http_fetch', arguments: '{}' } }],
    timestamp: 5000,
  });
  await db.put('messages', {
    id: 'm_res1', chatId: 'c1', role: 'tool', tool_call_id: 'call_1', name: 'read_file',
    content: '{"ok":true}', timestamp: 5001,
  });
  await db.put('runs', {
    chatId: 'c1', status: 'running', startedAt: 4000, updatedAt: 5500,
    stage: 'после read_file', toolCalls: 1, model: 'model-a',
    partialContent: 'Начал отвечать, но вкладку закрыли',
  });

  const found = await ui.checkInterruptedRuns();
  ok('прерванный ход найден при запуске', found === 1, String(found));

  const msgs = await db.getAllByIndex('messages', 'chatId', 'c1');
  const repaired = msgs.filter(m => m.role === 'tool' && m.interrupted);
  ok('незавершённый вызов закрыт записью о прерывании', repaired.length === 1 && repaired[0].tool_call_id === 'call_2',
     JSON.stringify(repaired.map(m => m.tool_call_id)));
  ok('уже выполненный вызов не тронут', msgs.filter(m => m.tool_call_id === 'call_1').length === 1);
  const partial = msgs.find(m => m.interrupted && m.role === 'assistant');
  ok('недописанный ответ сохранён', !!partial && /вкладку закрыли/.test(partial.content));

  journal = await db.get('runs', 'c1');
  ok('ход помечен как прерванный', journal.status === 'interrupted');
  ok('накопленный текст из журнала убран, чтобы не задвоиться', !journal.partialContent);

  console.log('\n── Предложение продолжить ──');
  await ui.loadChat('c1');
  let offer = document.getElementById('resume-offer');
  ok('в чате показано предложение продолжить', !!offer);
  ok('объяснено, что произошло', /прервал/.test(offer.textContent));
  ok('сказано, что сделанное сохранено', /сохранено/.test(offer.textContent));
  ok('видно, на чём остановились', /после read_file/.test(offer.textContent), offer.textContent.slice(0, 200));

  console.log('\n── Продолжение с места обрыва ──');
  const msgsBefore = (await db.getAllByIndex('messages', 'chatId', 'c1')).length;
  document.getElementById('resume-continue').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();

  ok('предложение убрано', !document.getElementById('resume-offer'));
  ok('ход снова идёт', ui._chatRuns.has('c1'));
  ok('журнал снова в состоянии «выполняется»', (await db.get('runs', 'c1')).status === 'running');
  ok('нового сообщения пользователя не создано',
     (await db.getAllByIndex('messages', 'chatId', 'c1')).length === msgsBefore,
     `${msgsBefore} → ${(await db.getAllByIndex('messages', 'chatId', 'c1')).length}`);

  const resumeReq = requests[requests.length - 1];
  const sent = JSON.stringify(resumeReq.messages);
  ok('в запрос ушла уже проделанная работа', sent.includes('call_1'));
  ok('и отметка о прерванном вызове', sent.includes('Выполнение прервано'));

  pending.resolve({ content: 'Продолжил и закончил', usage: { prompt_tokens: 20, completion_tokens: 5 } });
  await tick(20);
  ok('ход завершился штатно', !ui._chatRuns.has('c1'));
  ok('журнал очищен после успешного завершения', !(await db.get('runs', 'c1')));
  const last = (await db.getAllByIndex('messages', 'chatId', 'c1')).sort((a, b) => a.timestamp - b.timestamp).pop();
  ok('ответ сохранён', last.content === 'Продолжил и закончил', last.content);

  console.log('\n── Отказ продолжать ──');
  await db.put('runs', { chatId: 'c1', status: 'interrupted', updatedAt: Date.now(), stage: 'шаг 2' });
  await ui.loadChat('c1');
  offer = document.getElementById('resume-offer');
  ok('предложение показано снова', !!offer);
  document.getElementById('resume-dismiss').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  ok('после отказа запись убрана', !(await db.get('runs', 'c1')));
  ok('и предложение больше не висит', !document.getElementById('resume-offer'));

  console.log('\n── Оборванная цепочка чинится и при обычной отправке ──');
  await db.put('messages', {
    id: 'm_call2', chatId: 'c1', role: 'assistant', content: '',
    tool_calls: [{ id: 'call_9', function: { name: 'read_file', arguments: '{}' } }],
    timestamp: 9000,
  });
  document.getElementById('chat-input').value = 'Ещё вопрос';
  const sending2 = ui.sendMessage();
  await tick();
  const answered = (await db.getAllByIndex('messages', 'chatId', 'c1')).some(m => m.tool_call_id === 'call_9');
  ok('незакрытый вызов из прошлого сбоя закрыт перед новым запросом', answered);
  pending.resolve({ content: 'ок', usage: { prompt_tokens: 5, completion_tokens: 1 } });
  await sending2;
  await tick();

  console.log('\n── Ход, идущий в другой вкладке ──');
  // Свежая запись «выполняется» принадлежит вкладке, которая работает
  // прямо сейчас. Объявить такой ход прерванным значит починить его
  // цепочку и предложить продолжить работу, которая не прерывалась.
  await db.put('chats', { id: 'c9', title: 'Другая вкладка', modelRef: 'conn::a', modelRefs: ['conn::a'], createdAt: 3, updatedAt: 3 });
  await db.put('messages', {
    id: 'm_live', chatId: 'c9', role: 'assistant', content: '',
    tool_calls: [{ id: 'live_1', function: { name: 'read_file', arguments: '{}' } }],
    timestamp: 12000,
  });
  await db.put('runs', {
    chatId: 'c9', status: 'running', startedAt: Date.now() - 20000, updatedAt: Date.now(),
    stage: 'шаг 3', partialContent: 'пишется прямо сейчас',
  });
  const touched = await ui.checkInterruptedRuns();
  ok('живой ход другой вкладки не тронут', touched === 0, String(touched));
  ok('его статус остался «выполняется»', (await db.get('runs', 'c9')).status === 'running');
  ok('его незакрытый вызов не помечен прерванным',
     !(await db.getAllByIndex('messages', 'chatId', 'c9')).some(m => m.tool_call_id === 'live_1'));
  ok('его недописанный ответ не задвоен в переписке',
     !(await db.getAllByIndex('messages', 'chatId', 'c9')).some(m => m.content === 'пишется прямо сейчас'));

  // А та же запись, замолчавшая надолго, — уже брошенная.
  await db.put('runs', {
    chatId: 'c9', status: 'running', startedAt: Date.now() - 300000,
    updatedAt: Date.now() - 5 * 60 * 1000, stage: 'шаг 3',
  });
  ok('замолчавший надолго ход считается прерванным', (await ui.checkInterruptedRuns()) === 1);
  await ui._runJournalClear('c9');

  console.log('\n── Чат без прерванного хода ──');
  await db.put('chats', { id: 'c2', title: 'Чистый', modelRef: 'conn::a', modelRefs: ['conn::a'], createdAt: 2, updatedAt: 2 });
  await ui.loadChat('c2');
  ok('в чате без обрывов ничего не предлагается', !document.getElementById('resume-offer'));

  console.log('\n==============================================');
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('==============================================');
  process.exit(fail ? 1 : 0);
})();
