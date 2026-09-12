// ============================================================
//  ТЕСТ: вызовы инструментов ложатся в свои шаги плана
// ============================================================
//
// Проверка на живом ходе: поддельная модель ведёт план и работает внутри
// шагов, а тест смотрит, куда попали вызовы. Три вещи, каждая из которых
// уже ломалась:
//
//   • у шага показываются ТОЛЬКО его вызовы, а не общий список за ход;
//   • вызов виден у своего шага СРАЗУ, ещё в очереди, — иначе он сначала
//     показывался вне шагов и потом перепрыгивал, и это выглядело как
//     «мини-план попал не туда»;
//   • ведение плана (task_plan) в ленту не идёт вовсе: сам план виден
//     рядом, а его служебные вызовы собирались отдельной кучей «вне
//     шагов» — с виду ещё один мини-план неизвестно чего.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

let pass = 0, bad = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { bad++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + extra : '')); }
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
  const tasks = new X.TasksEngine(db);
  const MODELS = { 'c::a': { conn: { id: 'c', name: 'P' }, model: { id: 'a', name: 'm', maxTokens: 4096, contextWindow: 100000 } } };
  const fakeLlm = { model: 'm', maxTokens: 4096, apiUrl: 'x', apiKey: 'x', isConfigured: () => true };
  const fakeModels = {
    defaultRef: 'c::a',
    resolve(ref) { const d = MODELS[ref]; return d ? { ...d, ref } : null; },
    allModels() { return [{ ref: 'c::a', name: 'm', label: 'm' }]; },
    describe(ref) { const r = this.resolve(ref || 'c::a'); return r ? { ref: r.ref, model: 'm', label: 'm', contextWindow: 100000, maxTokens: 4096 } : null; },
    applyRef() { return true; },
    learnContextWindow: async () => ({ changed: false }),
  };

  // Сценарий: план на два шага, в каждом — свои вызовы.
  const script = [
    [{ name: 'task_plan', args: { action: 'create', goal: 'Свести отчёт', steps: ['Прочитать файлы', 'Составить сводку'] } }],
    [{ name: 'task_plan', args: { action: 'start', step: 1 } }],
    [{ name: 'list_files', args: {} }, { name: 'read_file', args: { file: 'a.txt' } }],
    [{ name: 'task_plan', args: { action: 'done', step: 1, result: 'прочитано' } },
     { name: 'task_plan', args: { action: 'start', step: 2 } }],
    [{ name: 'calculator', args: { expression: '2+2' } }],
    [{ name: 'format_json', args: { json: '{}' } }],
    null,
  ];
  let step = 0;
  fakeLlm.chat = async (messages, opts) => {
    const batch = script[step++];
    if (!batch) { if (opts && opts.onChunk) opts.onChunk('Готово.'); return { content: 'Готово.', usage: null, finish_reason: 'stop' }; }
    return {
      content: '', usage: null,
      tool_calls: batch.map((b, i) => ({ id: 't' + step + '_' + i, function: { name: b.name, arguments: JSON.stringify(b.args) } })),
    };
  };

  const agent = {
    db, llm: fakeLlm, models: fakeModels, tasks,
    artifacts: new X.ArtifactsEngine(db),
    skills: { buildSystemPrompt: async () => 'SYSTEM', loadSkills: async () => [] },
    tools: {
      getEnabledToolsForAPI: async () => [{ type: 'function', function: { name: 'calculator' } }],
      // task_plan исполняем по-настоящему: именно он двигает шаги.
      executeTool: async (name, argsRaw) => {
        if (name !== 'task_plan') return { ok: true };
        const p = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw;
        if (p.action === 'create') return await tasks.create('c1', p.goal, p.steps);
        if (p.action === 'start') return await tasks.start('c1', p.step);
        if (p.action === 'done') return await tasks.done('c1', p.step, p.result);
        return { ok: true };
      },
    },
    files: { all: async () => [] },
    folders: { all: async () => [] },
    security: { resetTurn() {} },
  };

  const ui = new X.UI(agent);
  ui.refreshSidebar = async () => {};
  ui.updateModelDisplay = () => {};
  ui.toolVerbosity = 'compact';

  // Снимок ленты и панели на каждой перерисовке: после хода run уже нет.
  const snaps = [];
  const origTrack = ui._renderToolTrack.bind(ui);
  ui._renderToolTrack = (chatId) => {
    origTrack(chatId);
    const r = ui._chatRuns.get(chatId);
    if (!r || !r.track.length) return;
    const slots = Array.from(document.querySelectorAll('#plan-panel .plan-track'))
      .map(el => (el.dataset.step ? 'шаг ' + el.dataset.step : 'вне шагов') + '=[' +
                 el.textContent.replace(/\s+/g, ' ').trim() + ']');
    snaps.push({
      track: r.track.map(t => (t.planStep === null || t.planStep === undefined ? '—' : t.planStep) + ':' + t.name + ':' + t.status),
      slots,
    });
  };

  await db.put('chats', { id: 'c1', title: 'Чат', modelRef: 'c::a', modelRefs: ['c::a'], model: 'm', createdAt: 1, updatedAt: 1 });
  await ui.loadChat('c1');
  document.getElementById('chat-input').value = 'Сделай';
  await ui.sendMessage();
  await tick(30);

  const last = snaps[snaps.length - 1] || { track: [], slots: [] };
  const stepOf = (name) => (last.track.find(r => r.includes(':' + name + ':')) || '').split(':')[0];
  const slotText = (label) => (last.slots.find(x => x.startsWith(label)) || '').replace(/^[^=]+=/, '');

  console.log('\n── Каждый вызов — в своём шаге ──');
  ok('работа первого шага приписана первому шагу',
     stepOf('list_files') === '1' && stepOf('read_file') === '1', last.track.join(' | '));
  ok('работа второго — второму',
     stepOf('calculator') === '2' && stepOf('format_json') === '2', last.track.join(' | '));

  console.log('\n── В шаге видно только его ──');
  const s1 = slotText('шаг 1'), s2 = slotText('шаг 2');
  ok('у первого шага нет чужих вызовов',
     s1.includes('list_files') && s1.includes('read_file') && !s1.includes('calculator'), s1);
  ok('у второго — тоже', s2.includes('calculator') && !s2.includes('list_files'), s2);
  ok('счёт в шаге считает вызовы шага, а не весь ход',
     s1.includes('2 из 2') && s2.includes('2 из 2'), s1 + ' | ' + s2);

  console.log('\n── Ведение плана не засоряет ленту ──');
  ok('вызовов task_plan в ленте нет', !last.track.some(r => r.includes('task_plan')), last.track.join(' | '));
  ok('и куча «вне шагов» не появляется', slotText('вне шагов').trim() === '[]', slotText('вне шагов'));

  console.log('\n── Вызов не прыгает между шагами ──');
  // В очереди («pending») вызов уже должен стоять у своего шага: раньше
  // он появлялся вне шагов и переезжал только в момент исполнения.
  const pendings = [];
  for (const sn of snaps) {
    for (const r of sn.track) {
      if (r.endsWith(':pending')) pendings.push(r);
    }
  }
  ok('поставленный в очередь вызов сразу знает свой шаг',
     pendings.length > 0 && pendings.every(r => !r.startsWith('—')), pendings.join(' | '));

  const plan0 = await tasks.active('c1');
  ok('план при этом жив и на втором шаге',
     !!plan0 && plan0.steps.find(st => st.n === 2).status === 'doing',
     plan0 ? plan0.steps.map(st => st.n + ':' + st.status).join(' ') : 'нет');

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${bad}`);
  console.log('='.repeat(46));
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
