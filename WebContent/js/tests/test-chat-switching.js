// ============================================================
//  ТЕСТ: переключение между чатами во время генерации ответа
// ============================================================
//
// Проверяет саму суть цикла 27 (см. readme.md → История доработок): пока чат A ждёт ответ
// модели, пользователь смотрит на чат B — вывод A не должен попасть в
// DOM чата B, сообщения A должны сохраниться под правильным chatId
// (а не под тем, что стал текущим к моменту завершения запроса), а при
// возврате в чат A должна восстановиться и панель статуса, и уже
// накопленный, но ещё не сохранённый в БД текст ответа.
//
// В отличие от test-tools.js (песочница vm без DOM), здесь нужен
// настоящий DOM — переключение чатов проверяется именно через реальные
// insertAdjacentHTML/innerHTML/querySelector, а не только через факт
// вызова функций.
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

// ── FakeDB: тот же контракт, что у AgentDB, поверх Map по хранилищам ──
class FakeDB {
  constructor() {
    this.stores = { chats: new Map(), messages: new Map(), chat_stats: new Map(), folders: new Map(), files: new Map() };
  }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async getAllByIndex(s, indexName, value) {
    // Единственный используемый индекс здесь — messages.chatId.
    return Array.from(this.stores[s].values()).filter(v => v[indexName] === value);
  }
  async put(s, o) { this.stores[s].set(o.id ?? o.chatId ?? o.key, o); return o; }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, arr) { for (const o of arr) await this.put(s, o); return arr.length; }
  async deleteAll(s, keys) { for (const k of keys) await this.delete(s, k); return keys.length; }
}

(async () => {
  // Вырезаем <script src="js/...">: с runScripts:"dangerously" jsdom сам
  // пытается их подгрузить как настоящие HTTP-запросы к несуществующему
  // серверу и зависает. Подключаем те же файлы вручную через window.eval
  // ниже — сама разметка (все id, на которые опирается UI) остаётся как есть.
  const rawHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const html = rawHtml.replace(/<script src="[^"]+"><\/script>\s*/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const document = window.document;

  // Браузерные API, которых в jsdom нет вовсе.
  window.AbortController = window.AbortController || class {
    constructor() { this.signal = {}; }
    abort() {}
  };
  window.performance = window.performance || { now: () => Date.now() };
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = undefined;
  window.Notification = { requestPermission: async () => 'granted' };
  window.localStorage = window.localStorage || { getItem() { return null; }, setItem() {}, removeItem() {} };

  // Все файлы — в ОДИН window.eval(): class UI и Object.assign(UI.prototype,
  // {...}) из разных файлов должны видеть одну и ту же лексическую
  // привязку UI. jsdom-реализация window.eval (в отличие от vm.runInContext)
  // не гарантированно делит глобальную лексическую область между отдельными
  // вызовами — один общий eval снимает вопрос целиком.
  const files = [
    'js/core/markdown.js',
    'js/ui/ui-core.js',
    'js/ui/ui-navigation.js',
    'js/ui/ui-chat.js',
    'js/ui/ui-subtask.js',
    'js/ui/ui-metrics.js',
    'js/ui/ui-settings.js',
    'js/ui/ui-connections.js',
    'js/ui/ui-editors.js',
    'js/ui/ui-transfer.js',
  ];
  const combined = files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n')
    + '\nwindow.__UI = UI;\n';
  window.eval(combined);
  const UI = window.__UI;
  ok('класс UI собрался из примесей в реальном DOM', typeof UI === 'function');

  const db = new FakeDB();

  // ── Фейковый реестр моделей: две модели, чтобы проверить и гонку за
  // общий шлюз (см. Цикл 27) ──
  const MODEL_DEFS = {
    'conn::a': { conn: { id: 'conn', name: 'Provider' }, model: { id: 'a', name: 'model-a', maxTokens: 4096, contextWindow: 8000, temperature: 0.7 } },
    'conn::b': { conn: { id: 'conn', name: 'Provider' }, model: { id: 'b', name: 'model-b', maxTokens: 2048, contextWindow: 4000, temperature: 0.7 } },
  };
  const fakeLlm = { model: null, maxTokens: 4096, apiUrl: 'x', apiKey: 'x', debug: false, isConfigured: () => true };
  const fakeModels = {
    defaultRef: 'conn::a',
    resolve(ref) { const d = MODEL_DEFS[ref]; return d ? { ...d, ref } : null; },
    describe(ref) {
      const r = this.resolve(ref || this.currentRef || this.defaultRef);
      if (!r) return null;
      return { ref: r.ref, provider: r.conn.name, model: r.model.name, label: r.model.name, contextWindow: r.model.contextWindow, maxTokens: r.model.maxTokens, temperature: r.model.temperature };
    },
    applyRef(ref) {
      const r = this.resolve(ref);
      if (!r) return false;
      this.currentRef = ref;
      fakeLlm.model = r.model.name;
      fakeLlm.maxTokens = r.model.maxTokens;
      return true;
    },
  };

  // ── Контролируемый "чат с моделью": тест сам решает, когда прилетит
  // очередной чанк и когда запрос завершится — без этого сценарий
  // "переключились ровно посреди стриминга" нельзя было бы воспроизвести
  // детерминированно.
  let activeCall = null;
  fakeLlm.chat = (apiMessages, opts) => new Promise((resolve) => {
    activeCall = { opts, resolve, modelAtCallTime: fakeLlm.model, apiMessages };
  });

  const agent = {
    db,
    llm: fakeLlm,
    models: fakeModels,
    skills: { buildSystemPrompt: async () => 'SYSTEM' },
    tools: { getEnabledToolsForAPI: async () => [], executeTool: async () => ({ ok: true }) },
    files: { all: async () => [] },
    security: { resetTurn() {} },
  };

  const ui = new UI(agent);
  // Сайдбар/тулбар не входят в фокус этого теста и требуют полноценных
  // agent.folders/agent.skills — гасим их до безопасных no-op.
  ui.refreshSidebar = async () => {};
  ui.updateChatToolbar = () => {};
  ui.updateModelDisplay = () => {};

  const chatA = { id: 'chatA', title: 'Чат A', modelRef: 'conn::a', modelRefs: ['conn::a'], model: 'model-a', createdAt: 1, updatedAt: 1 };
  const chatB = { id: 'chatB', title: 'Чат B', modelRef: 'conn::b', modelRefs: ['conn::b'], model: 'model-b', createdAt: 2, updatedAt: 2 };
  await db.put('chats', chatA);
  await db.put('chats', chatB);

  console.log('\n── Переключение чата во время стриминга ──');

  await ui.loadChat('chatA');
  document.getElementById('chat-input').value = 'Привет из чата A';
  const sendPromise = ui.sendMessage();
  await tick();

  ok('запрос ушёл именно с моделью чата A', activeCall && activeCall.modelAtCallTime === 'model-a',
     activeCall && activeCall.modelAtCallTime);

  // Первый чанк приходит, пока пользователь ещё смотрит на чат A.
  activeCall.opts.onChunk('Первая часть ответа A. ');
  await tick();
  const msgsInA = document.getElementById('chat-messages').innerHTML;
  ok('стримящийся текст виден в чате A', msgsInA.includes('Первая часть ответа A.'));

  // ── Переключаемся на чат B ПОСРЕДИ стриминга чата A ──
  await ui.loadChat('chatB');
  ok('после переключения показан чат B (пуст)', document.getElementById('chat-messages').textContent.includes('Начните диалог'));
  ok('кнопка отправки в чате B разблокирована — B ничего не генерирует', !document.getElementById('send-btn').disabled);
  ok('кнопка остановки в чате B скрыта', document.getElementById('stop-btn').hidden);

  // Ещё один чанк чата A прилетает, пока на экране чат B.
  activeCall.opts.onChunk('Вторая часть, пришедшая пока открыт B.');
  await tick();
  const bHtmlDuringAStream = document.getElementById('chat-messages').innerHTML;
  ok('чанк чата A НЕ просочился в DOM чата B',
     !bHtmlDuringAStream.includes('Вторая часть, пришедшая пока открыт B'));

  // ── Пробуем отправить сообщение в чате B, пока A ещё отвечает ──
  document.getElementById('chat-input').value = 'Сообщение из B';
  await ui.sendMessage();
  await tick();
  const bMsgsAfterAttempt = await db.getAllByIndex('messages', 'chatId', 'chatB');
  ok('сообщение в чат B не отправлено, пока общий шлюз занят чатом A', bMsgsAfterAttempt.length === 0,
     JSON.stringify(bMsgsAfterAttempt));
  ok('в чате B показано понятное объяснение, а не тишина',
     document.getElementById('chat-messages').textContent.includes('Дождитесь ответа'));

  // ── Возвращаемся в чат A — визуализация должна восстановиться ──
  await ui.loadChat('chatA');
  const restoredHtml = document.getElementById('chat-messages').innerHTML;
  ok('после возврата в чат A виден накопленный текст стриминга',
     restoredHtml.includes('Первая часть ответа A.') && restoredHtml.includes('Вторая часть, пришедшая пока открыт B'));
  ok('индикатор хода восстановлен в чате A', !!document.getElementById('agent-status'));
  ok('кнопка отправки в чате A задизейблена — он всё ещё отвечает', document.getElementById('send-btn').disabled);
  ok('кнопка остановки в чате A видна', !document.getElementById('stop-btn').hidden);

  // ── Ещё один чанк — теперь снова на экране чат A ──
  activeCall.opts.onChunk(' И третья часть.');
  await tick();
  ok('третий чанк дописался в тот же видимый узел, без дублей',
     document.getElementById('chat-messages').innerHTML.includes('Первая часть ответа A. Вторая часть, пришедшая пока открыт B. И третья часть.'));

  // ── Переключаемся на B и завершаем ответ модели, пока A не виден ──
  await ui.loadChat('chatB');
  activeCall.resolve({ content: 'Первая часть ответа A. Вторая часть, пришедшая пока открыт B И третья часть.', finish_reason: 'stop' });
  await sendPromise;
  await tick();

  const aMsgs = await db.getAllByIndex('messages', 'chatId', 'chatA');
  const assistantMsgs = aMsgs.filter(m => m.role === 'assistant');
  ok('финальный ответ сохранён под chatId=chatA (а не под тем, что стал текущим)',
     assistantMsgs.length === 1 && assistantMsgs[0].chatId === 'chatA', JSON.stringify(assistantMsgs));
  ok('модель в сохранённом сообщении — именно модель чата A (не подменилась моделью B)',
     assistantMsgs[0].model === 'model-a', assistantMsgs[0].model);
  ok('вывод чата A не появился в видимом сейчас чате B',
     !document.getElementById('chat-messages').innerHTML.includes('Вторая часть, пришедшая пока открыт B'));

  // ── Индикатор в списке чатов ──
  ok('run для chatA снят по завершении хода', !ui._chatRuns.has('chatA'));

  console.log('\n── Индикатор занятости чата в списке (this._chatRuns) ──');
  document.getElementById('chat-input').value = 'Ещё один вопрос в A';
  await ui.loadChat('chatA');
  const sendPromise2 = ui.sendMessage();
  await tick();
  ok('во время генерации chatA числится занятым', ui._chatRuns.has('chatA'));
  activeCall.resolve({ content: 'ok', finish_reason: 'stop' });
  await sendPromise2;
  await tick();
  ok('после завершения ответа chatA больше не занят', !ui._chatRuns.has('chatA'));

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('Необработанная ошибка теста:', e);
  process.exit(1);
});
