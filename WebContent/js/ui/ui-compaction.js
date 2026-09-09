// ============================================================
//  UI COMPACTION — свёртка вытесненной части переписки
// ============================================================
//
// ЗАЧЕМ. Когда история перестаёт помещаться в окно контекста, её начало
// вытесняется. Раньше на его месте оставалась заглушка «столько-то
// сообщений не переданы, попроси пользователя повторить» — то есть
// работа, проделанная в начале разговора, для агента исчезала: принятые
// решения, найденные пути, выясненные ограничения. Дальше он либо
// переспрашивал уже отвеченное, либо, что хуже, действовал по догадке.
//
// ЧТО ВМЕСТО. Вытесняемая часть один раз прогоняется через модель и
// превращается в структурированное резюме: цель, что сделано, что
// выяснено, решения, незакрытые вопросы, конкретные значения. Резюме
// сохраняется в переписку отдельным сообщением (kind:'context-summary')
// и с этого момента едет в запросы ВМЕСТО покрытых им сообщений
// (см. _trimHistory). Десяток строк вместо десятков тысяч токенов.
//
// ЦЕНА. Свёртка — это лишний запрос к модели, поэтому она делается
// только когда история реально не помещается, и на неё уходит один
// вызов на много вытесненных сообщений. Если запрос не удался, работает
// прежнее поведение (заглушка) — потерять контекст неприятно, но это
// лучше, чем не ответить вовсе.

// ── ПОЧЕМУ У СВЁРТКИ ЕСТЬ ТОРМОЗА ──
// Свёртка вызывалась всякий раз, когда история не помещалась в окно, —
// то есть на КАЖДОМ шаге цепочки вызовов инструментов и на каждой
// попытке продолжить прерванный ход. А шаг цепочки добавляет в историю
// новый результат инструмента, снова выталкивая часть переписки за
// границу бюджета. Получался самоподдерживающийся цикл: агент сворачивал
// переписку, делал шаг, снова сворачивал — резюме поверх резюме, лишний
// запрос к модели на каждом шаге, и со стороны это выглядело как
// зависание, которым невозможно управлять. Особенно наглядно при
// возобновлении многоэтапной задачи, где история и так уже на пределе.
//
// Ограничения ниже отвечают на вопрос «сворачивать ли ЕЩЁ РАЗ»:
//   • не чаще одного раза за ход — свёртка делается ради этого хода, и
//     второй такой же в нём ничего не добавит;
//   • не ради мелочи — за пару вытесненных реплик платить запросом глупо;
//   • не бесконечно на чат — если свёртка перестала помогать, проблема
//     не в истории, а в том, что разговор перерос окно модели; об этом
//     надо сказать человеку, а не молча жечь запросы;
//   • не после повторных сбоев — если модель не отвечает, следующие
//     попытки тоже не ответят.
UI.COMPACTION_MAX_PER_TURN = 1;
UI.COMPACTION_MAX_PER_CHAT = 5;
UI.COMPACTION_MIN_MESSAGES = 4;
UI.COMPACTION_MAX_FAILURES = 2;

Object.assign(UI.prototype, {

  // Состояние свёртки по чатам за сессию. В базе ему делать нечего:
  // это счётчики попыток, а не данные пользователя.
  _compactionState(chatId) {
    this._compactions = this._compactions || new Map();
    if (!this._compactions.has(chatId)) {
      this._compactions.set(chatId, { total: 0, failures: 0, useless: 0, exhausted: false });
    }
    return this._compactions.get(chatId);
  },

  // Решение «сворачивать ли сейчас». Возвращает { ok } либо
  // { ok:false, reason } — причина уходит в объяснение пользователю.
  _compactionAllowed(chatId, run, trim) {
    if (this.limits.contextCompaction === false) return { ok: false, reason: 'off' };
    if (trim.droppedCount < UI.COMPACTION_MIN_MESSAGES) return { ok: false, reason: 'tiny' };

    const st = this._compactionState(chatId);
    if (st.exhausted) return { ok: false, reason: 'exhausted' };
    if (st.failures >= UI.COMPACTION_MAX_FAILURES) return { ok: false, reason: 'failing' };
    if (st.total >= UI.COMPACTION_MAX_PER_CHAT) {
      st.exhausted = true;
      return { ok: false, reason: 'exhausted' };
    }
    if (run && (run.compactions || 0) >= UI.COMPACTION_MAX_PER_TURN) {
      return { ok: false, reason: 'turn' };
    }
    return { ok: true };
  },

  // Свёртка прошла — считаем и проверяем, дала ли она результат.
  // «Не помогло» — это когда после резюме за границу бюджета всё равно
  // вытесняется почти столько же: значит, не помещается уже не начало
  // разговора, а его рабочая часть, и следующая свёртка ничего не
  // изменит. Два таких раза подряд — повод остановиться и сказать.
  _noteCompaction(chatId, run, before, after) {
    const st = this._compactionState(chatId);
    st.total++;
    if (run) run.compactions = (run.compactions || 0) + 1;

    const gained = (before?.droppedCount || 0) - (after?.droppedCount || 0);
    if (gained <= 0) st.useless++;
    else st.useless = 0;
    if (st.useless >= 2) st.exhausted = true;
    return st;
  },

  _noteCompactionFailure(chatId) {
    const st = this._compactionState(chatId);
    st.failures++;
    return st;
  },

});

Object.assign(UI.prototype, {

  _compactionPrompt() {
    return 'Ты сжимаешь начало переписки пользователя с ИИ-агентом, чтобы оно поместилось ' +
      'в окно контекста. Это НЕ пересказ для человека: результат прочитает сам агент ' +
      'и продолжит по нему работу.\n\n' +
      'Верни сжатую выжимку по разделам (пропускай пустые):\n' +
      '1. Задача — чего добивается пользователь.\n' +
      '2. Сделано — какие шаги уже выполнены и с каким результатом.\n' +
      '3. Выяснено — факты, значения, пути, идентификаторы, ограничения. Приводи их ТОЧНО, ' +
      'не пересказывай приблизительно: именно за ними сюда и будут возвращаться.\n' +
      '4. Решения и договорённости — что выбрано и почему, что пользователь запретил или попросил.\n' +
      '5. Открытые вопросы — что осталось сделать или уточнить.\n\n' +
      'Правила: не выдумывай ничего, чего нет в тексте; не описывай, какие инструменты ' +
      'вызывались, — только то, что из них получилось; уложись в 400 слов; ' +
      'пиши по-русски, если переписка на русском.';
  },

  // Собирает текст вытесненной части. Каждое сообщение подрезается: цель —
  // сохранить смысл, а не буквальный текст, и сама свёртка не должна
  // упереться в то же окно контекста, из-за которого затевается.
  _compactionTranscript(dropped) {
    const PER_MESSAGE = 1200;
    const TOTAL = 60000;
    const lines = [];
    for (const m of dropped) {
      if (m.kind === 'model-switch') continue;
      const who = m.role === 'tool' ? `инструмент ${m.name || ''}` : m.role;
      let text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      if (m.tool_calls) text += ' ' + JSON.stringify(m.tool_calls).slice(0, 300);
      if (text.length > PER_MESSAGE) text = text.slice(0, PER_MESSAGE) + '…';
      lines.push(`[${who}] ${text}`);
    }
    let out = lines.join('\n');
    if (out.length > TOTAL) {
      // Режем СЕРЕДИНУ: начало разговора задаёт задачу, конец — ближе
      // всего к тому, чем агент занят сейчас; провисает наименее ценная часть.
      const half = Math.floor(TOTAL / 2);
      out = out.slice(0, half) + '\n\n[…середина пропущена, слишком длинная…]\n\n' + out.slice(-half);
    }
    return out;
  },

  // ── Свернуть вытесненную часть в резюме ──
  // Возвращает сохранённое сообщение-резюме или null, если свернуть не
  // удалось (тогда вызывающая сторона откатывается к прежнему поведению).
  async _compactHistory(chatId, dropped, ref) {
    if (!dropped || !dropped.length) return null;

    const transcript = this._compactionTranscript(dropped);
    if (!transcript.trim()) return null;

    this._showStatus(chatId, 'Сворачиваю раннюю часть переписки…',
      `${dropped.length} сообщений — чтобы не потерять сделанное`);

    // Модель — та же, что у чата: другая может не знать предметной
    // терминологии разговора, а резюме потом читает именно она.
    if (ref) this.agent.models?.applyRef(ref);

    let text = '';
    try {
      const result = await this.agent.llm.chat([
        { role: 'system', content: this._compactionPrompt() },
        { role: 'user', content: transcript },
      ], { stream: false });
      text = (result && result.content) ? result.content.trim() : '';
      if (result && result.usage) await this._recordUsage(chatId, result.usage);
    } catch (e) {
      console.error('Свёртка переписки не удалась', e);
      return null;
    }

    if (!text) return null;

    const lastCovered = dropped[dropped.length - 1];
    const summary = {
      id: uid(),
      chatId,
      role: 'system',
      kind: 'context-summary',
      content: text,
      // Метка времени ровно на границе покрытой части: так резюме встаёт
      // в ленте на место свёрнутых сообщений и при сборке контекста
      // легко определить, что именно оно заменяет.
      timestamp: (lastCovered.timestamp || Date.now()) + 1,
      coveredCount: dropped.length,
      coveredFrom: dropped[0].timestamp || null,
      coveredTo: lastCovered.timestamp || null,
    };
    await this.agent.db.put('messages', summary);

    // Показываем свёртку сразу: пользователь должен видеть, что часть
    // переписки теперь участвует в работе агента в сжатом виде.
    if (chatId === this.currentChatId) {
      // Просто в конец ленты: строка состояния теперь живёт над полем
      // ввода, а не последним элементом ленты, и вставлять запись
      // «перед ней» стало нечем — да и незачем.
      const container = document.getElementById('chat-messages');
      if (container) {
        container.insertAdjacentHTML('beforeend', this._renderMessage(summary));
        container.scrollTop = container.scrollHeight;
      }
    }

    return summary;
  },

  // Разметка свёрнутой части: по умолчанию сложена, разворачивается кликом.
  // Показывать резюме целиком в ленте незачем — это служебная запись,
  // но спрятать её совсем нельзя: пользователь должен понимать, на чём
  // именно агент теперь основывается.
  _renderContextSummary(msg) {
    const id = 'cs_' + (msg.id || uid());
    return `<div class="message system context-summary" id="${id}">
      🗜 Ранняя часть переписки (${msg.coveredCount || 0} сообщений) свёрнута в резюме —
      агент работает по нему, ничего не потеряно.
      <button class="btn btn-secondary btn-sm" data-summary-toggle="${id}">Показать</button>
      <div class="summary-body" hidden>${renderMarkdown(msg.content || '')}</div>
    </div>`;
  },

});
