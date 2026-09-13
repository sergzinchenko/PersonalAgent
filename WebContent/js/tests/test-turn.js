// ============================================================
//  ТЕСТ: ход с вызовами инструментов от начала до конца
// ============================================================
//
// Здесь проверяется не отрисовка (этим занят test-progress.js), а
// ПРОВОДКА: что во время настоящего хода лента наполняется, показывается
// и снимается, что переписка при режиме по умолчанию остаётся чистой, но
// история вызовов в базе сохраняется, и что на третьей итерации подряд в
// запрос добавляется просьба завести план.
//
// Модель поддельная и отвечает по сценарию: три шага с вызовами
// инструментов, затем текст. Настоящий провайдер для этого не нужен —
// проверяется собственный цикл приложения.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
let pass = 0, bad = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { bad++; console.log('  ✗ ' + n + (e !== undefined ? ' → ' + e : '')); }
};

class FakeDB {
  constructor() { this.stores = {}; }
  _s(n) { return (this.stores[n] = this.stores[n] || new Map()); }
  async get(s, k) { return this._s(s).get(k); }
  async getAll(s) { return Array.from(this._s(s).values()); }
  async put(s, o) { this._s(s).set(o.key ?? o.id ?? o.chatId, o); return o; }
  async delete(s, k) { this._s(s).delete(k); }
  async putAll(s, a) { for (const x of a) await this.put(s, x); return a.length; }
  async deleteAll(s, ks) { for (const k of ks) await this.delete(s, k); return ks.length; }
  async getAllByIndex(s, i, v) { return (await this.getAll(s)).filter(r => r[i] === v); }
}

(async () => {
  const rawHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const srcs = [...rawHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  const html = rawHtml.replace(/<script src="[^"]+"><\/script>\s*/g, '');
  const dom = new JSDOM(html, { url: 'https://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const document = window.document;
  window.performance = window.performance || { now: () => Date.now() };
  const skip = new Set(['js/app.js', 'js/core/db.js', 'js/core/agent.js']);
  window.eval(srcs.filter(f => !skip.has(f)).map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n') +
    '\nwindow.__X = { UI, TasksEngine, ArtifactsEngine };\n');
  const X = window.__X;

  const db = new FakeDB();
  const MODELS = { 'c::a': { conn: { id: 'c', name: 'P' }, model: { id: 'a', name: 'model-a', maxTokens: 4096, contextWindow: 100000 } } };
  const fakeLlm = { model: 'model-a', maxTokens: 4096, apiUrl: 'x', apiKey: 'x', isConfigured: () => true };
  const fakeModels = {
    defaultRef: 'c::a',
    resolve(ref) { const d = MODELS[ref]; return d ? { ...d, ref } : null; },
    allModels() { return [{ ref: 'c::a', name: 'model-a', label: 'model-a' }]; },
    describe(ref) { const r = this.resolve(ref || 'c::a'); return r ? { ref: r.ref, model: r.model.name, label: r.model.name, contextWindow: r.model.contextWindow, maxTokens: r.model.maxTokens } : null; },
    applyRef() { return true; },
    learnContextWindow: async () => ({ changed: false }),
  };

  // Ответы модели по порядку: сначала два вызова, потом текст.
  const prompts = [];
  let step = 0;
  fakeLlm.chat = async (messages, opts) => {
    prompts.push(messages[0] && messages[0].content);
    step++;
    if (step === 1) {
      return {
        content: '', usage: null,
        tool_calls: [
          { id: 'tc1', function: { name: 'get_current_time', arguments: '{}' } },
          { id: 'tc2', function: { name: 'calculator', arguments: '{"expression":"2+2"}' } },
        ],
      };
    }
    if (step === 2) {
      return { content: '', usage: null, tool_calls: [{ id: 'tc3', function: { name: 'calculator', arguments: '{"expression":"3+3"}' } }] };
    }
    if (step === 3) {
      return { content: '', usage: null, tool_calls: [{ id: 'tc4', function: { name: 'calculator', arguments: '{"expression":"4+4"}' } }] };
    }
    if (opts && opts.onChunk) opts.onChunk('Готово.');
    return { content: 'Готово.', usage: null, finish_reason: 'stop' };
  };

  const calls = [];
  const agent = {
    db, llm: fakeLlm, models: fakeModels,
    artifacts: new X.ArtifactsEngine(db),
    tasks: new X.TasksEngine(db),
    skills: { buildSystemPrompt: async () => 'SYSTEM', loadSkills: async () => [] },
    tools: {
      getEnabledToolsForAPI: async () => [{ type: 'function', function: { name: 'calculator' } }],
      executeTool: async (name) => { calls.push(name); return { ok: true, value: name }; },
    },
    files: { all: async () => [] },
    folders: { all: async () => [] },
    security: { resetTurn() {} },
  };

  const ui = new X.UI(agent);
  ui.refreshSidebar = async () => {};
  ui.updateModelDisplay = () => {};
  // Панель хода выключена: здесь проверяется лента над полем ввода —
  // одна строка общего счёта. Сама панель со всем деревом проверяется
  // в test-progress и test-plan-steps.
  ui.panelDepth = "off";

  await db.put('chats', { id: 'c1', title: 'Чат', modelRef: 'c::a', modelRefs: ['c::a'], model: 'model-a', createdAt: 1, updatedAt: 1 });
  await ui.loadChat('c1');

  // Подглядываем за лентой в момент работы: после хода она снимается.
  const seen = [];
  const origRender = ui._renderToolTrack.bind(ui);
  ui._renderToolTrack = (chatId) => {
    origRender(chatId);
    const host = document.getElementById('tool-track-host');
    if (host && !host.hidden) seen.push(host.textContent.replace(/\s+/g, ' ').trim());
  };

  document.getElementById('chat-input').value = 'Посчитай';
  await ui.sendMessage();
  await tick(20);

  console.log('\n── Режим по умолчанию: переписка чистая ──');
  ok('инструменты вызывались', calls.length === 4, calls.join(', '));
  ok('лента показывалась во время хода', seen.length > 0, String(seen.length));
  ok('в ней был общий счёт', seen.some(t => /Инструменты/.test(t) && /из/.test(t)), seen[0]);
  ok('имён вызовов в скрытом режиме не было', !seen.some(t => /calculator/.test(t)), seen.find(t => /calculator/.test(t)) || '');
  ok('после хода лента снята', document.getElementById('tool-track-host').hidden === true);

  const feed = document.getElementById('chat-messages').innerHTML;
  ok('в переписке нет блоков вызовов', !/tool-call/.test(feed));
  ok('ответ модели в переписке есть', /Готово\./.test(feed));

  const msgs = (await db.getAllByIndex('messages', 'chatId', 'c1'));
  ok('но сами вызовы сохранены в истории', msgs.filter(m => m.role === 'tool').length === 4,
     String(msgs.filter(m => m.role === 'tool').length));

  console.log('\n── Многошаговая работа требует плана ──');
  const nudged = prompts.filter(p => p && /стала многошаговой/.test(p));
  ok('на третьей итерации подряд появилась просьба завести план', nudged.length >= 1, String(prompts.length));
  ok('в первых двух запросах её не было', !/стала многошаговой/.test(prompts[0] || '') && !/стала многошаговой/.test(prompts[1] || ''));

  console.log('\n── Краткий режим пишет вызовы в переписку ──');
  ui.toolVerbosity = 'compact';
  step = 0; calls.length = 0;
  document.getElementById('chat-input').value = 'Ещё раз';
  await ui.sendMessage();
  await tick(20);
  ok('в кратком режиме блоки вызовов в переписке есть',
     /tool-call/.test(document.getElementById('chat-messages').innerHTML));

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${bad}`);
  console.log('='.repeat(46));
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
