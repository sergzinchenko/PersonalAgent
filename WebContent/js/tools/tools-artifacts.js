// ============================================================
//  TOOLS ARTIFACTS — доступ к большим результатам вне контекста
// ============================================================
//
// Три инструмента поверх ArtifactsEngine (engines/artifacts-engine.js).
// Они СИСТЕМНЫЕ (locked): большой результат инструмента подменяется
// шапкой автоматически, и если бы читать его было нечем, механизм из
// экономии контекста превратился бы в потерю данных.
//
// Артефакты привязаны к чату: инструменты работают с чатом, который
// сейчас ведёт ход (ui.currentChatId). Чужие артефакты не отдаются —
// не из соображений секретности (данные и так все свои), а чтобы
// модель не тащила в текущую задачу материал из другой.

ToolsEngine.HANDLER_CONTRIBUTORS.push(function registerArtifactHandlers() {

  const eng = () => this.artifacts;
  const noEng = { error: 'Хранилище артефактов недоступно' };

  this.registerHandler('builtin_artifact_read', async (params) => {
    const e = eng();
    if (!e) return noEng;
    if (!params || !params.id) return { error: 'Не указан id артефакта' };
    return e.read(String(params.id), {
      offset: Number(params.offset) || 0,
      limit: Number(params.limit) || 4000,
    });
  });

  this.registerHandler('builtin_artifact_grep', async (params) => {
    const e = eng();
    if (!e) return noEng;
    if (!params || !params.id) return { error: 'Не указан id артефакта' };
    if (!params.pattern) return { error: 'Не указан шаблон поиска (pattern)' };
    return e.grep(String(params.id), String(params.pattern), {
      ignoreCase: params.ignore_case !== false,
      context: Number(params.context) || 0,
      max: Number(params.max) || 20,
    });
  });

  this.registerHandler('builtin_artifact_list', async () => {
    const e = eng();
    if (!e) return noEng;
    const chatId = this.ui ? this.ui.currentChatId : null;
    const items = await e.list(chatId);
    return {
      count: items.length,
      artifacts: items,
      note: items.length ? null : 'В этом чате пока нет сохранённых больших результатов.',
    };
  });

});

ToolsEngine.DEF_CONTRIBUTORS.push(function artifactDefs() {
  return [
    {
      id: 'builtin_artifact_read',
      name: 'artifact_read',
      description: 'Читает участок большого результата, сохранённого вне контекста (артефакта). ' +
        'Вызывай, когда в ответе инструмента пришла шапка с artifact_id вместо содержимого. ' +
        'Читай порциями и только то, что нужно для задачи: весь текст в контекст не помещается.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'artifact_id из шапки результата' },
          offset: { type: 'number', description: 'С какого символа читать. По умолчанию 0; следующий вызов делай с next_offset.' },
          limit: { type: 'number', description: 'Сколько символов вернуть, максимум 20000. По умолчанию 4000.' },
        },
        required: ['id'],
      },
      enabled: true,
      builtin: true,
      locked: true,
    },
    {
      id: 'builtin_artifact_grep',
      name: 'artifact_grep',
      description: 'Ищет строки по регулярному выражению внутри артефакта и возвращает совпадения с номерами строк. ' +
        'Дешевле последовательного чтения: используй, когда знаешь, что именно ищешь.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'artifact_id из шапки результата' },
          pattern: { type: 'string', description: 'Регулярное выражение JavaScript' },
          ignore_case: { type: 'boolean', description: 'Не различать регистр. По умолчанию true.' },
          context: { type: 'number', description: 'Сколько соседних строк показывать вокруг совпадения (0–5)' },
          max: { type: 'number', description: 'Максимум совпадений, по умолчанию 20' },
        },
        required: ['id', 'pattern'],
      },
      enabled: true,
      builtin: true,
      locked: true,
    },
    {
      id: 'builtin_artifact_list',
      name: 'artifact_list',
      description: 'Перечень больших результатов, сохранённых вне контекста в текущем чате: чем получены, размер, структура. ' +
        'Нужен, если идентификатор артефакта уже вытеснен из переписки.',
      parameters: { type: 'object', properties: {}, required: [] },
      enabled: true,
      builtin: true,
      locked: true,
    },
  ];
});
