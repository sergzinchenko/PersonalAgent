// ============================================================
//  ТЕСТ: свёртка контекста вместо потери начала переписки
// ============================================================
//
// Проверяется главное: когда история перестаёт помещаться в окно, её
// начало не исчезает, а один раз сжимается в резюме и дальше участвует
// в работе в таком виде. Плюс экономия на старых результатах
// инструментов и откат к прежнему поведению, если свернуть не удалось.
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
    this.stores = { chats: new Map(), messages: new Map(), chat_stats: new Map(), folders: new Map(), files: new Map(), artifacts: new Map(), tasks: new Map() };
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
  const MODELS = {
    // Маленькое окно, чтобы переполнение наступало на десятке сообщений,
    // а не на тысяче: проверяем поведение, а не производительность.
    'conn::m': { conn: { id: 'c', name: 'P' }, model: { id: 'm', name: 'model-m', maxTokens: 500, contextWindow: 3000 } },
    // Модель с большим окном — для проверки сокращения СТАРЫХ результатов
    // инструментов: там ничего вытесняться не должно, укорачивание работает
    // само по себе, независимо от переполнения.
    'conn::wide': { conn: { id: 'c', name: 'P' }, model: { id: 'w', name: 'model-w', maxTokens: 4096, contextWindow: 200000 } },
  };
  const fakeLlm = { model: null, maxTokens: 500, apiUrl: 'x', apiKey: 'x', isConfigured: () => true };
  const fakeModels = {
    defaultRef: 'conn::m',
    resolve(ref) { const d = MODELS[ref]; return d ? { ...d, ref } : null; },
    allModels() { return Object.keys(MODELS).map(ref => ({ ref, name: MODELS[ref].model.name, label: MODELS[ref].model.name })); },
    describe(ref) { const r = this.resolve(ref || 'conn::m'); return r ? { ref: r.ref, model: r.model.name, label: r.model.name, contextWindow: r.model.contextWindow } : null; },
    applyRef(ref) { const r = this.resolve(ref); if (!r) return false; fakeLlm.model = r.model.name; fakeLlm.maxTokens = r.model.maxTokens; return true; },
  };

  const calls = [];
  let compactionFails = false;
  fakeLlm.chat = async (messages) => {
    calls.push(messages);
    const isCompaction = /сжимаешь начало переписки/.test(messages[0].content || '');
    if (isCompaction) {
      if (compactionFails) throw new Error('провайдер недоступен');
      return { content: 'Задача: собрать отчёт. Сделано: выгружены файлы из /data/one.\nВыяснено: ключ доступа лежит в vault-42.', usage: { prompt_tokens: 100, completion_tokens: 40 } };
    }
    return { content: 'обычный ответ', usage: { prompt_tokens: 50, completion_tokens: 10 } };
  };

  const agent = {
    db, llm: fakeLlm, models: fakeModels,
    artifacts: null, tasks: null,
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

  const chat = { id: 'c1', title: 'Длинный чат', modelRef: 'conn::m', modelRefs: ['conn::m'], model: 'model-m', createdAt: 1, updatedAt: 1 };
  await db.put('chats', chat);

  // Длинная переписка: заведомо не помещается в окно 3000 токенов.
  let ts = 1000;
  for (let i = 0; i < 40; i++) {
    await db.put('messages', { id: 'u' + i, chatId: 'c1', role: 'user', content: 'Вопрос номер ' + i + '. ' + 'подробности '.repeat(30), timestamp: ts++ });
    await db.put('messages', { id: 'a' + i, chatId: 'c1', role: 'assistant', content: 'Ответ номер ' + i + '. ' + 'пояснения '.repeat(30), timestamp: ts++ });
  }

  console.log('\n── Свёртка при переполнении окна ──');
  await ui.loadChat('c1');
  document.getElementById('chat-input').value = 'Что мы выяснили в самом начале?';
  await ui.sendMessage();
  await tick(20);

  const summaries = (await db.getAllByIndex('messages', 'chatId', 'c1')).filter(m => m.kind === 'context-summary');
  ok('вытесненная часть свёрнута в резюме', summaries.length === 1, String(summaries.length));
  ok('резюме помнит, сколько сообщений покрывает', summaries[0].coveredCount > 0, String(summaries[0]?.coveredCount));
  ok('свёртка сделана отдельным запросом к модели',
     calls.some(c => /сжимаешь начало переписки/.test(c[0].content)));

  const finalRequest = calls[calls.length - 1];
  const asText = JSON.stringify(finalRequest);
  ok('резюме уехало в запрос', asText.includes('vault-42'));
  ok('свёрнутые сообщения в запрос НЕ уехали', !asText.includes('Вопрос номер 0'),
     asText.slice(0, 120));
  ok('свежие сообщения остались', asText.includes('Что мы выяснили в самом начале?'));
  ok('заглушки «попроси повторить» больше нет', !asText.includes('попроси пользователя повторить'));

  console.log('\n── Показ пользователю ──');
  await ui.loadChat('c1');
  const block = document.querySelector('.message.context-summary');
  ok('свёрнутая часть видна в переписке', !!block);
  ok('по умолчанию резюме сложено', block.querySelector('.summary-body').hidden === true);
  block.querySelector('[data-summary-toggle]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  ok('кнопка разворачивает резюме', block.querySelector('.summary-body').hidden === false);

  console.log('\n── Повторный запрос не сворачивает заново ──');
  const callsBefore = calls.filter(c => /сжимаешь начало переписки/.test(c[0].content)).length;
  document.getElementById('chat-input').value = 'Ещё вопрос';
  await ui.sendMessage();
  await tick(20);
  const callsAfter = calls.filter(c => /сжимаешь начало переписки/.test(c[0].content)).length;
  ok('уже свёрнутое второй раз не сворачивается', callsAfter === callsBefore,
     `${callsBefore} → ${callsAfter}`);

  console.log('\n── Старые результаты инструментов передаются коротко ──');
  const msgs = [];
  let t2 = 5000;
  for (let i = 0; i < 10; i++) {
    msgs.push({ id: 'ta' + i, chatId: 'c2', role: 'assistant', content: '', tool_calls: [{ id: 'x' + i, function: { name: 'read_file', arguments: '{}' } }], timestamp: t2++ });
    msgs.push({ id: 'tt' + i, chatId: 'c2', role: 'tool', name: 'read_file', tool_call_id: 'x' + i, content: 'Р'.repeat(3000), timestamp: t2++ });
  }
  const trimmed = ui._trimHistory(msgs, 'SYS', 'conn::wide');
  const toolMsgs = trimmed.messages.filter(m => m.role === 'tool');
  const shrunk = toolMsgs.filter(m => /результат сокращён/.test(m.content));
  ok('старые результаты сокращены', shrunk.length > 0, `${shrunk.length} из ${toolMsgs.length}`);
  ok('последние результаты переданы целиком',
     toolMsgs.slice(-1)[0].content.length === 3000, String(toolMsgs.slice(-1)[0].content.length));
  ok('сокращение объясняет, что делать дальше', /повтори вызов/.test(shrunk[0].content));

  console.log('\n── Если свернуть не удалось ──');
  compactionFails = true;
  const chat2 = { id: 'c3', title: 'Ещё чат', modelRef: 'conn::m', modelRefs: ['conn::m'], model: 'model-m', createdAt: 1, updatedAt: 1 };
  await db.put('chats', chat2);
  let ts3 = 9000;
  for (let i = 0; i < 40; i++) {
    await db.put('messages', { id: 'x' + i, chatId: 'c3', role: 'user', content: 'Реплика ' + i + '. ' + 'текст '.repeat(40), timestamp: ts3++ });
  }
  await ui.loadChat('c3');
  document.getElementById('chat-input').value = 'Вопрос';
  await ui.sendMessage();
  await tick(20);
  const s3 = (await db.getAllByIndex('messages', 'chatId', 'c3')).filter(m => m.kind === 'context-summary');
  ok('сбой свёртки не ломает ответ', s3.length === 0 && calls.length > 0);
  ok('пользователю сказано, что начало не передаётся',
     document.getElementById('chat-messages').textContent.includes('больше не передаётся модели'));

  console.log('\n==============================================');
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('==============================================');
  process.exit(fail ? 1 : 0);
})();
