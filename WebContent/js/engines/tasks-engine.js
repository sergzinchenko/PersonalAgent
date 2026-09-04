// ============================================================
//  TASKS ENGINE — план задачи, живущий вне переписки
// ============================================================
//
// ЗАЧЕМ. Длинная задача держалась исключительно на переписке: агент
// перечислял шаги словами, и этот список ехал в контекст целиком, а
// после подрезки истории — исчезал вместе с ней. Достаточно было одной
// перезагрузки страницы или переполнения окна, чтобы «на чём мы
// остановились» стало неизвестно ни агенту, ни пользователю.
//
// ЧТО ВМЕСТО. План — отдельная запись в базе: цель, шаги, их состояние
// и накопленные факты. В контекст на каждом запросе идёт компактная
// сводка (digest) — десяток строк вместо всей истории обсуждения. План
// переживает и подрезку контекста, и перезагрузку, и сбой: именно он
// отвечает на вопрос «что уже сделано и что осталось».
//
// ОДИН АКТИВНЫЙ ПЛАН НА ЧАТ. Два одновременных плана означали бы два
// ответа на этот вопрос — и агенту пришлось бы выбирать между ними.
// Новый план закрывает предыдущий (тот остаётся в базе как завершённый).
class TasksEngine {
  constructor(db) {
    this.db = db;
  }

  _normalizeSteps(steps) {
    return (Array.isArray(steps) ? steps : [])
      .map(s => (typeof s === 'string' ? { title: s } : (s || {})))
      .filter(s => s.title)
      .slice(0, 30)   // план из сотни пунктов — это не план, а поток сознания
      .map((s, i) => ({
        n: i + 1,
        title: String(s.title).slice(0, 200),
        status: 'todo',
        note: null,
      }));
  }

  // Создаёт план и делает его активным в чате.
  async create(chatId, goal, steps) {
    const list = this._normalizeSteps(steps);
    if (!list.length) return { error: 'План должен содержать хотя бы один шаг' };

    // Предыдущий активный план закрываем: см. «один активный план на чат».
    const prev = await this.active(chatId);
    if (prev) {
      prev.status = 'superseded';
      prev.updatedAt = Date.now();
      await this.db.put('tasks', prev);
    }

    const plan = {
      id: 'task_' + uid(),
      chatId,
      goal: String(goal || '').slice(0, 500),
      steps: list,
      facts: [],
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.db.put('tasks', plan);
    return plan;
  }

  async active(chatId) {
    if (!chatId) return null;
    const all = await this.db.getAllByIndex('tasks', 'chatId', chatId);
    return all.filter(p => p.status === 'active')
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  async _save(plan) {
    plan.updatedAt = Date.now();
    await this.db.put('tasks', plan);
    return plan;
  }

  // Отметить шаг начатым. Одновременно «в работе» может быть только один:
  // иначе сводка перестаёт отвечать на вопрос «чем ты занят прямо сейчас».
  async start(chatId, n) {
    const plan = await this.active(chatId);
    if (!plan) return { error: 'Активного плана нет. Сначала создай его: task_plan action=create.' };
    const step = plan.steps.find(s => s.n === Number(n));
    if (!step) return { error: `Шага ${n} в плане нет` };
    for (const s of plan.steps) if (s.status === 'doing') s.status = 'todo';
    step.status = 'doing';
    return this._save(plan);
  }

  // Закрыть шаг. result — то, что должно пережить сам шаг: найденное
  // значение, путь, вывод. Именно он попадёт в сводку, а не пересказ работы.
  async done(chatId, n, result, failed = false) {
    const plan = await this.active(chatId);
    if (!plan) return { error: 'Активного плана нет' };
    const step = plan.steps.find(s => s.n === Number(n));
    if (!step) return { error: `Шага ${n} в плане нет` };
    step.status = failed ? 'failed' : 'done';
    if (result) step.note = String(result).slice(0, 400);

    // Все шаги закрыты — план закрывается сам: держать его активным
    // значило бы каждый запрос напоминать модели о законченной работе.
    if (plan.steps.every(s => s.status === 'done' || s.status === 'failed')) {
      plan.status = 'done';
    }
    return this._save(plan);
  }

  // Факт, не привязанный к конкретному шагу: узнанное по дороге, что
  // понадобится дальше и что жалко потерять при подрезке истории.
  async addFact(chatId, text) {
    const plan = await this.active(chatId);
    if (!plan) return { error: 'Активного плана нет' };
    plan.facts.push(String(text).slice(0, 300));
    if (plan.facts.length > 20) plan.facts = plan.facts.slice(-20);
    return this._save(plan);
  }

  // Дописать шаги к существующему плану: по ходу работы выясняется, что
  // нужно ещё. Переписывать план целиком ради этого — терять состояние.
  async addSteps(chatId, steps) {
    const plan = await this.active(chatId);
    if (!plan) return { error: 'Активного плана нет' };
    const extra = this._normalizeSteps(steps);
    if (!extra.length) return { error: 'Нечего добавлять' };
    let n = plan.steps.length;
    for (const s of extra) plan.steps.push({ ...s, n: ++n });
    if (plan.steps.length > 40) return { error: 'В плане слишком много шагов' };
    plan.status = 'active';
    return this._save(plan);
  }

  async finish(chatId, status = 'done') {
    const plan = await this.active(chatId);
    if (!plan) return { error: 'Активного плана нет' };
    plan.status = status === 'cancelled' ? 'cancelled' : 'done';
    return this._save(plan);
  }

  // ── Сводка для системного промпта ──
  // Компактно и по делу: цель, что сделано (с результатами), что сейчас,
  // что осталось. Ровно то, чего не хватает после подрезки истории.
  digest(plan) {
    if (!plan || plan.status !== 'active') return '';
    const line = (s) => {
      const mark = { done: '✔', doing: '▶', failed: '✖', todo: '·' }[s.status] || '·';
      return `${mark} ${s.n}. ${s.title}` + (s.note ? ` — ${s.note}` : '');
    };
    const doneCount = plan.steps.filter(s => s.status === 'done').length;
    const current = plan.steps.find(s => s.status === 'doing');
    const next = plan.steps.find(s => s.status === 'todo');

    let out = '\n\n# План текущей задачи\n' +
      `Цель: ${plan.goal}\n` +
      `Готово шагов: ${doneCount} из ${plan.steps.length}.\n` +
      plan.steps.map(line).join('\n') + '\n';

    if (plan.facts.length) {
      out += '\nВыясненное по ходу работы:\n' + plan.facts.map(f => '- ' + f).join('\n') + '\n';
    }
    out += current
      ? `\nСейчас в работе шаг ${current.n}. Закончив его, отметь: task_plan action=done, step=${current.n}, result=<что получилось>.\n`
      : (next
        ? `\nСледующий невыполненный шаг — ${next.n}. Перед работой отметь: task_plan action=start, step=${next.n}.\n`
        : '\nВсе шаги закрыты — заверши план: task_plan action=finish.\n');
    out += 'План — это состояние задачи, которое переживает подрезку контекста и перезагрузку. ' +
      'Веди его честно: отмечай шаги по мере работы, а важное для дальнейших шагов ' +
      '(пути, идентификаторы, выводы) складывай в result или task_plan action=fact.\n';
    return out;
  }

  // Короткая строка для интерфейса: «3/7 · читаю документацию».
  summary(plan) {
    if (!plan) return null;
    const done = plan.steps.filter(s => s.status === 'done').length;
    const current = plan.steps.find(s => s.status === 'doing') ||
                    plan.steps.find(s => s.status === 'todo');
    return {
      done,
      total: plan.steps.length,
      current: current ? current.title : null,
      currentN: current ? current.n : null,
      goal: plan.goal,
      status: plan.status,
    };
  }

  async removeByChat(chatId) {
    const all = await this.db.getAllByIndex('tasks', 'chatId', chatId);
    if (!all.length) return 0;
    await this.db.deleteAll('tasks', all.map(p => p.id));
    return all.length;
  }
}
