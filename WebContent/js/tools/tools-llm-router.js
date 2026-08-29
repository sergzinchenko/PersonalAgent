// ============================================================
//  TOOLS LLM ROUTER — инструменты выбора модели
// ============================================================
//
// Позволяют агенту посмотреть, какие провайдеры и модели заведены, и
// сменить рабочую модель текущего чата. Смысл в том, чтобы на просьбу
// «переключись на модель посильнее» агент мог что-то сделать, а не
// только объяснить, где это лежит в настройках.
//
// ЧТО СДЕРЖИВАЕТ АГЕНТА:
//   1. Навык «Выбор модели» и сами инструменты по умолчанию ВЫКЛЮЧЕНЫ.
//   2. Смена действует со СЛЕДУЮЩЕГО запроса: текущий ответ дописывает
//      та модель, которая его начала.
//   3. Каждая смена попадает в журнал безопасности.
//
// Секреты не отдаются: наружу уходит только то, что собрал describe().

ToolsEngine.HANDLER_CONTRIBUTORS.push(function registerLlmRouterHandlers() {

  const reg = () => this.llmRegistry;
  const noReg = { error: 'Реестр моделей недоступен' };

  // ── Что заведено ──
  this.registerHandler('builtin_llm_list', async () => {
    const r = reg();
    if (!r) return noReg;

    const models = r.allModels();
    if (!models.length) {
      return { providers: [], models: [], note: 'Моделей нет. Их заводит пользователь в ⚙ Настройки → Провайдеры и модели.' };
    }
    return {
      providers: r.connections.map(c => ({
        name: c.name,
        enabled: c.enabled !== false,
        modelCount: (c.models || []).length,
      })),
      models: models.map(m => ({
        ref: m.ref,
        provider: m.connName,
        label: m.label || m.name,
        model: m.name,
        tier: m.tier,
        tierLabel: m.tierInfo.label,
        contextWindow: m.contextWindow || null,
        notes: m.notes || null,
      })),
      defaultRef: r.defaultRef,
    };
  });

  // ── Что используется сейчас ──
  this.registerHandler('builtin_llm_status', async () => {
    const r = reg();
    if (!r) return noReg;

    const ui = this.ui;
    const chat = (ui && ui.currentChatId) ? await this.db.get('chats', ui.currentChatId) : null;
    const inChat = (chat && Array.isArray(chat.modelRefs) ? chat.modelRefs : [])
      .map(ref => r.describe(ref)).filter(Boolean);

    return {
      current: r.describe(),
      chatModels: inChat.map(d => ({ ref: d.ref, label: d.label, tierLabel: d.tierLabel })),
      defaultRef: r.defaultRef,
      note: 'Смена модели действует со следующего запроса — текущий ответ дописывает та модель, которая его начала.',
    };
  });

  // ── Смена рабочей модели чата ──
  this.registerHandler('builtin_llm_switch', async (params) => {
    const r = reg();
    if (!r) return noReg;

    // Ищем по ссылке, затем по названию — модель проще назвать словами,
    // чем воспроизвести внутренний идентификатор.
    const all = r.allModels();
    const q = String(params.model || '').trim().toLowerCase();
    const found = r.resolve(params.model)
      ? { ref: params.model }
      : all.find(m => (m.label || '').toLowerCase() === q)
        || all.find(m => m.name.toLowerCase() === q)
        || all.find(m => (m.label || m.name).toLowerCase().includes(q) && q.length > 2);

    if (!found) {
      return {
        error: 'Модель не найдена: ' + (params.model || '(пусто)'),
        available: all.map(m => ({ ref: m.ref, label: m.label || m.name, provider: m.connName, tier: m.tierLabel })),
      };
    }

    const ui = this.ui;
    if (!ui || !ui.currentChatId) {
      // Без открытого чата менять нечему — но можно сменить умолчание.
      await r.setDefault(found.ref);
      const d = r.describe(found.ref);
      return { ok: true, scope: 'default', to: d.label, model: d.model };
    }

    const before = r.describe();
    await ui.setChatModel(found.ref);
    const after = r.describe(found.ref);

    if (this.security) {
      this.security.audit({
        tool: 'llm_switch',
        decision: 'executed',
        detail: (before ? before.label : '—') + ' → ' + after.label +
                (params.reason ? ' (' + params.reason + ')' : ''),
      });
    }

    // Меньшее окно контекста означает более агрессивную подрезку истории —
    // об этом стоит сказать, а не выяснять потом по обрывкам в диалоге.
    const warn = (after.contextWindow && before && before.contextWindow && after.contextWindow < before.contextWindow)
      ? `Окно контекста уменьшилось: ${before.contextWindow} → ${after.contextWindow} токенов. ` +
        'Длинная история будет подрезаться сильнее.'
      : null;

    return {
      ok: true,
      scope: 'chat',
      from: before ? before.label : null,
      to: after.label,
      model: after.model,
      provider: after.provider,
      tier: after.tierLabel,
      contextWarning: warn,
      note: 'Смена вступит в силу со следующего запроса.',
    };
  });

  // ── Проверка провайдера ──
  this.registerHandler('builtin_llm_test', async (params) => {
    const r = reg();
    if (!r) return noReg;

    const targets = params.provider
      ? r.connections.filter(c => c.name.toLowerCase() === String(params.provider).toLowerCase() || c.id === params.provider)
      : r.connections.filter(c => c.enabled !== false);

    if (!targets.length) return { error: 'Подходящих провайдеров нет' };

    const results = [];
    for (const c of targets) results.push(await r.testConnection(c.id));
    return { checked: results.length, results };
  });

});

// ── Описания ──
// Инструменты создаются ВЫКЛЮЧЕННЫМИ: выбор модели — решение
// пользователя, и передавать его агенту нужно осознанно.
ToolsEngine.DEF_CONTRIBUTORS.push(function llmRouterDefs() {
  return [
    {
      id: 'builtin_llm_list',
      name: 'llm_list',
      description: 'Список провайдеров и заведённых моделей с классом сложности, окном контекста и заметками. Ключи не возвращаются.',
      parameters: { type: 'object', properties: {}, required: [] },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_llm_status',
      name: 'llm_status',
      description: 'Какая модель используется сейчас и какие добавлены в текущий чат.',
      parameters: { type: 'object', properties: {}, required: [] },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_llm_switch',
      name: 'llm_switch',
      description: 'Сменить рабочую модель текущего чата. Действует со следующего запроса: ' +
                   'текущий ответ дописывает та модель, которая его начала.',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Название модели или ссылка на неё из llm_list' },
          reason: { type: 'string', description: 'Зачем меняешь — попадёт в журнал' },
        },
        required: ['model'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_llm_test',
      name: 'llm_test',
      description: 'Проверить доступность провайдера (или всех) запросом списка моделей. Возвращает задержку и текст ошибки.',
      parameters: {
        type: 'object',
        properties: { provider: { type: 'string', description: 'Название провайдера; без него проверяются все включённые' } },
        required: [],
      },
      enabled: false, builtin: true,
    },
  ];
});
