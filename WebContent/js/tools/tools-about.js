// ============================================================
//  TOOLS ABOUT — имя агента и история его доработок
// ============================================================
//
// Два системных инструмента (locked), потому что оба обслуживают то, что
// агент обязан знать о себе всегда:
//   agent_name — как его зовут и как это изменить;
//   whats_new  — что в нём появилось и о чём пользователь ещё не слышал.
//
// Почему имя меняется инструментом, а не только формой настроек: просьба
// «зовись Ада» произносится в разговоре, а не в окне настроек, и агент
// должен уметь её исполнить, а не пересказывать путь в меню.
//
// whats_new отдаёт ТОЛЬКО описания возможностей (см. границу в
// core/changelog.js). Устройства он не раскрывает — это отдельное
// требование, а не случайность формата: рассказ о продукте и рассказ о
// его внутренностях нужны разным людям в разных случаях, и второй здесь
// не нужен никогда.

ToolsEngine.HANDLER_CONTRIBUTORS.push(function registerAboutHandlers() {

  this.registerHandler('builtin_agent_name', async (params) => {
    const about = this.about;
    if (!about) return { error: 'Сведения об агенте недоступны' };

    const p = params || {};
    const action = String(p.action || 'get').toLowerCase();

    if (action === 'get') {
      return {
        name: about.name,
        has_name: !!about.name,
        displayed_as: about.label,
        note: about.name
          ? 'Это имя видно пользователю в шапке приложения.'
          : 'Имя ещё не задано — стоит предложить пользователю выбрать его.',
      };
    }

    if (action === 'set') {
      const res = await about.setName(p.name);
      if (res.error) return res;
      // Шапка и заголовок вкладки должны смениться сразу: иначе агент
      // скажет «теперь меня зовут Ада», а на экране останется прежнее имя.
      try { this.ui?.applyAgentName?.(res.name); } catch (_) {}
      return {
        ok: true,
        name: res.name,
        previous: res.previous,
        note: 'Имя изменено и видно в шапке приложения. Оно сохранится между запусками.',
      };
    }

    return { error: `Неизвестное действие "${action}". Доступны: get, set.` };
  });


  this.registerHandler('builtin_whats_new', async (params) => {
    const about = this.about;
    if (!about) return { error: 'История доработок недоступна' };

    const p = params || {};
    const action = String(p.action || 'unread').toLowerCase();
    const limit = Math.min(30, Math.max(1, parseInt(p.limit, 10) || 6));

    // ── Отбор по категории ──
    // «Что нового по инструментам?» — обычный вопрос, и перебирать ради
    // него всю историю модели незачем. Релизы без пунктов нужной
    // категории из ответа выпадают целиком.
    const known = new Set(about.categories().map(c => c.id));
    const wanted = p.category && known.has(String(p.category)) ? String(p.category) : '';
    const byCategory = (releases) => !wanted ? releases : releases
      .map(r => ({ ...r, items: about.itemsOf(r).filter(i => i.cat === wanted) }))
      .filter(r => r.items.length);

    // Общая для всех ответов подпись: инструмент отдаёт готовые
    // формулировки, и без этой строки модель охотно «дополняет» их
    // догадками о том, как всё устроено внутри.
    const guard = 'Рассказывай своими словами и только о возможностях: что пользователь может сделать ' +
      'и что получит. Не объясняй, как это устроено внутри, и не придумывай пунктов, которых здесь нет.';

    if (action === 'count') {
      const seen = await about.lastSeenRelease();
      return {
        releases: about.releaseCount(),
        last_seen_by_user: seen,
        unread: (await about.unread()).length,
        latest_title: about.latest()?.title || null,
      };
    }

    if (action === 'categories') {
      return {
        categories: about.categoryCounts(about.all()).map(c => ({ id: c.id, label: c.label, items: c.count })),
        note: 'Это разделы доработок. Любое действие можно ограничить одним из них: category=<id>.',
        guidance: guard,
      };
    }

    if (action === 'release') {
      const rel = about.byNumber(p.n);
      if (!rel) return { error: `Релиза ${p.n} нет. Всего релизов: ${about.releaseCount()}.` };
      return { release: rel, of: about.releaseCount(), guidance: guard };
    }

    if (action === 'all') {
      const all = byCategory(about.all());
      const shown = all.slice(-limit);
      return {
        releases: shown,
        shown: shown.length,
        total: all.length,
        // Прямо говорим, что показана не вся история: иначе модель
        // объявит «это всё, что было», хотя видела только хвост.
        note: shown.length < all.length
          ? `Показаны последние ${shown.length} релизов из ${all.length}. Остальные — тем же инструментом с бо́льшим limit или по номеру.`
          : 'Это вся история доработок.',
        guidance: guard,
      };
    }

    if (action === 'mark_read') {
      const upTo = await about.markRead(p.n);
      return { ok: true, last_seen_by_user: upTo };
    }

    if (action === 'unread') {
      const seen = await about.lastSeenRelease();
      const list = byCategory(await about.unread());
      return {
        releases: list,
        unread: list.length,
        last_seen_by_user: seen,
        total: about.releaseCount(),
        note: list.length
          ? 'Пользователь этих возможностей ещё не видел. Расскажи о них коротко, а после рассказа отметь прочитанным: whats_new action=mark_read.'
          : 'Непрочитанного нет — всё, что появлялось, пользователю уже показано.',
        guidance: guard,
      };
    }

    return { error: `Неизвестное действие "${action}". Доступны: unread, all, release, count, mark_read.` };
  });

});


ToolsEngine.DEF_CONTRIBUTORS.push(function aboutDefs() {
  return [
    {
      id: 'builtin_agent_name',
      name: 'agent_name',
      description:
        'Имя этого агента: узнать (action=get) или изменить (action=set, name). ' +
        'Имя видно пользователю в шапке приложения и сохраняется между запусками. ' +
        'Вызывай set, когда пользователь просит называться иначе («зовись Ада», «переименуйся»), ' +
        'и get, если сомневаешься, как тебя зовут. Не выдумывай себе имя сам и не меняй его без просьбы.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'], description: 'По умолчанию get.' },
          name: { type: 'string', description: 'Новое имя — для action=set. До 40 символов, одной строкой.' },
        },
        required: [],
      },
      enabled: true,
      builtin: true,
      // Системный: выключить нельзя (см. навык «Системный»).
      locked: true,
    },
    {
      id: 'builtin_whats_new',
      name: 'whats_new',
      description:
        'История доработок агента по релизам: какие возможности появлялись и в каком порядке. ' +
        'action=unread — то, чего пользователь ещё не видел (по умолчанию); all — история (последние limit релизов); ' +
        'release + n — конкретный релиз; count — сколько всего релизов и на каком пользователь остановился; ' +
        'categories — разделы доработок и сколько пунктов в каждом; mark_read — отметить рассказанное прочитанным.\n' +
        'У каждого пункта есть раздел (cat): chat — чат и работа, models — модели и сервисы, ' +
        'tools — инструменты, skills — навыки и промпты, data — файлы и данные, ' +
        'net — сеть и внешние системы, security — безопасность, ui — интерфейс. ' +
        'Параметр category сужает ответ до одного раздела — так отвечают на «что нового по инструментам».\n' +
        'Вызывай на вопросы «что нового», «что появилось», «что ты умеешь», «когда это добавили». ' +
        'Пересказывай возможности своими словами и НЕ объясняй, как они устроены внутри.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['unread', 'all', 'release', 'count', 'categories', 'mark_read'],
            description: 'Что показать. По умолчанию unread.',
          },
          n: { type: 'number', description: 'Номер релиза — для action=release; для mark_read — по какой номер считать прочитанным.' },
          limit: { type: 'number', description: 'Сколько последних релизов вернуть для action=all. По умолчанию 6, максимум 30.' },
          category: {
            type: 'string',
            enum: ['chat', 'models', 'tools', 'skills', 'data', 'net', 'security', 'ui'],
            description: 'Показать только пункты этого раздела (для action=unread и all).',
          },
        },
        required: [],
      },
      enabled: true,
      builtin: true,
      // Системный: выключить нельзя (см. навык «Системный»).
      locked: true,
    },
  ];
});
