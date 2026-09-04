// ============================================================
//  TOOLS TASKS — план задачи как инструмент
// ============================================================
//
// Один инструмент с несколькими действиями вместо шести отдельных:
// описания инструментов уходят в КАЖДЫЙ запрос, и шесть почти
// одинаковых описаний стоили бы контекста больше, чем сам план.
//
// Инструмент системный (locked): сводка плана подставляется в системный
// промпт автоматически, и если бы вести план было нечем, в промпте
// оказались бы отсылки к несуществующему механизму.

ToolsEngine.HANDLER_CONTRIBUTORS.push(function registerTaskHandlers() {

  this.registerHandler('builtin_task_plan', async (params) => {
    const eng = this.tasks;
    if (!eng) return { error: 'Планы задач недоступны' };

    // План принадлежит чату, который сейчас ведёт ход (он один на
    // приложение); вне хода — просматриваемому чату.
    const ui = this.ui;
    const chatId = (ui && ui._chatRuns && ui._chatRuns.size)
      ? ui._chatRuns.keys().next().value
      : (ui ? ui.currentChatId : null);
    if (!chatId) return { error: 'Нет активного чата' };

    const p = params || {};
    const action = String(p.action || 'show').toLowerCase();
    const refresh = () => { try { ui?.updateChatToolbar?.(); } catch (_) {} };

    const result = async () => {
      switch (action) {
        case 'create': {
          const plan = await eng.create(chatId, p.goal, p.steps);
          if (plan.error) return plan;
          return { ok: true, plan: eng.summary(plan), steps: plan.steps,
            note: 'План создан. Отмечай шаги по мере работы — он переживёт подрезку контекста и перезагрузку.' };
        }
        case 'show': {
          const plan = await eng.active(chatId);
          return plan
            ? { ok: true, plan: eng.summary(plan), steps: plan.steps, facts: plan.facts }
            : { ok: true, plan: null, note: 'Активного плана нет.' };
        }
        case 'start': {
          const plan = await eng.start(chatId, p.step);
          return plan.error ? plan : { ok: true, plan: eng.summary(plan) };
        }
        case 'done': {
          const plan = await eng.done(chatId, p.step, p.result, false);
          return plan.error ? plan : { ok: true, plan: eng.summary(plan), status: plan.status };
        }
        case 'fail': {
          const plan = await eng.done(chatId, p.step, p.result, true);
          return plan.error ? plan : { ok: true, plan: eng.summary(plan), status: plan.status };
        }
        case 'fact': {
          const plan = await eng.addFact(chatId, p.result || p.fact || '');
          return plan.error ? plan : { ok: true, facts: plan.facts };
        }
        case 'add_steps': {
          const plan = await eng.addSteps(chatId, p.steps);
          return plan.error ? plan : { ok: true, plan: eng.summary(plan), steps: plan.steps };
        }
        case 'finish': {
          const plan = await eng.finish(chatId, 'done');
          return plan.error ? plan : { ok: true, status: plan.status };
        }
        case 'cancel': {
          const plan = await eng.finish(chatId, 'cancelled');
          return plan.error ? plan : { ok: true, status: plan.status };
        }
        default:
          return { error: `Неизвестное действие "${action}". Доступны: create, show, start, done, fail, fact, add_steps, finish, cancel.` };
      }
    };

    const out = await result();
    refresh();
    return out;
  });

});

ToolsEngine.DEF_CONTRIBUTORS.push(function taskDefs() {
  return [
    {
      id: 'builtin_task_plan',
      name: 'task_plan',
      description:
        'План задачи, который живёт вне переписки и переживает подрезку контекста, перезагрузку страницы и сбой. ' +
        'Заводи его для работы в несколько этапов: сводка плана автоматически попадает в каждый твой запрос, ' +
        'поэтому «на чём мы остановились» не теряется, даже когда начало разговора уже вытеснено.\n' +
        'Действия: create (goal + steps) — составить план; show — посмотреть; start (step) — взяться за шаг; ' +
        'done (step, result) — закрыть шаг результатом; fail (step, result) — шаг не удался; ' +
        'fact (result) — запомнить попутно выясненное; add_steps (steps) — дописать шаги; ' +
        'finish / cancel — закрыть план.\n' +
        'В result клади то, что понадобится дальше: значения, пути, идентификаторы, вывод. Не пересказ работы.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'show', 'start', 'done', 'fail', 'fact', 'add_steps', 'finish', 'cancel'],
            description: 'Что сделать с планом. По умолчанию show.',
          },
          goal: { type: 'string', description: 'Цель задачи — для action=create' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Шаги плана строками — для create и add_steps. От 2 до 10 шагов: слишком дробный план сам съедает контекст.',
          },
          step: { type: 'number', description: 'Номер шага — для start, done, fail' },
          result: { type: 'string', description: 'Результат шага (done/fail) или факт (fact). Коротко и конкретно.' },
        },
        required: [],
      },
      enabled: true,
      builtin: true,
      locked: true,
    },
  ];
});
