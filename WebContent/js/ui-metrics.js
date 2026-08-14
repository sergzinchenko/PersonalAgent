// ============================================================
//  UI METRICS — токены, окно контекста, статистика чата
// ============================================================
//
// Учёт израсходованных токенов, оценка размера контекста, предупреждения о заполнении окна и панель статистики.

Object.assign(UI.prototype, {


  async updateChatToolbar() {
    const toolbar = document.getElementById('chat-toolbar');
    const skills = await this.agent.skills.loadSkills();
    const llm = this.agent.llm;

    const stats = this.currentChatId ? await this.agent.db.get('chat_stats', this.currentChatId) : null;
    const fmt = (n) => (n || 0).toLocaleString('ru-RU');

    // Быстрый выбор модели: список из ранее загруженных моделей;
    // если их ещё не запрашивали — показываем только текущую.
    const models = llm.availableModels.length ? llm.availableModels
                 : (llm.model ? [llm.model] : []);
    const modelOptions = models.map(m =>
      `<option value="${this._escHtml(m)}" ${m === llm.model ? 'selected' : ''}>${this._escHtml(m)}</option>`
    ).join('');

    const approx = stats && stats.estimated ? '≈' : '';
    const tokensChip = stats && stats.totalTokens
      ? `<span class="chip stat-chip" id="tokens-chip" title="Промпт: ${approx}${fmt(stats.promptTokens)} · Ответ: ${approx}${fmt(stats.completionTokens)} · Запросов: ${fmt(stats.requests)}${stats.estimated ? '\nПровайдер не вернул usage — значения оценены приблизительно' : ''}">🎫 ${approx}${fmt(stats.totalTokens)} токенов</span>`
      : `<span class="chip stat-chip muted" title="Появится после первого ответа модели">🎫 — токенов</span>`;

    // Чип контекста: сколько токенов ушло в последний запрос и сколько
    // вмещает модель. Цвет меняется при приближении к границе.
    const ctxLimit = this.effectiveContextLimit();
    const ctxUsed = stats?.lastContextTokens || 0;
    let contextChip = '';
    if (ctxUsed) {
      const ctxApprox = stats.lastContextEstimated ? '≈' : '';
      if (ctxLimit) {
        const pct = Math.round((ctxUsed / ctxLimit) * 100);
        const cls = pct >= 100 ? ' ctx-danger' : (pct >= this.contextWarnPercent ? ' ctx-warn' : '');
        contextChip = `<span class="chip stat-chip${cls}" title="Контекст последнего запроса: ${ctxApprox}${fmt(ctxUsed)} из ${fmt(ctxLimit)} токенов${this.contextLimit ? ' (лимит задан вручную)' : ' (лимит определён по названию модели)'}">📐 ${ctxApprox}${fmt(ctxUsed)} / ${this._fmtLimit(ctxLimit)} · ${pct}%</span>`;
      } else {
        contextChip = `<span class="chip stat-chip" title="Окно контекста для этой модели неизвестно — задайте его в ⚙ Настройки → Модель">📐 ${ctxApprox}${fmt(ctxUsed)} / ?</span>`;
      }
    } else if (ctxLimit) {
      contextChip = `<span class="chip stat-chip muted" title="Окно контекста выбранной модели">📐 окно ${this._fmtLimit(ctxLimit)}</span>`;
    }

    const toolsChip = stats && stats.toolCalls
      ? `<span class="chip stat-chip" id="tool-stats-chip" title="Нажмите для подробной статистики">🔧 ${fmt(stats.toolCalls)} вызовов${stats.toolErrors ? ` · ${fmt(stats.toolErrors)} ошибок` : ''}</span>`
      : `<span class="chip stat-chip muted">🔧 нет вызовов</span>`;

    toolbar.innerHTML = `
      <div class="toolbar-row">
        ${skills.map(s => `
          <span class="chip ${s.enabled ? 'active' : ''}" data-skill="${s.id}" title="${this._escHtml(s.description)}">
            ${this._escHtml(s.icon)} ${this._escHtml(s.name)}
          </span>
        `).join('')}
      </div>
      <div class="toolbar-row toolbar-meta">
        <select id="quick-model-select" class="quick-model" title="Быстрый выбор модели">
          ${modelOptions || '<option value="">модель не выбрана</option>'}
        </select>
        ${tokensChip}
        ${contextChip}
        ${toolsChip}
      </div>
    `;

    toolbar.querySelectorAll('.chip[data-skill]').forEach(chip => {
      chip.addEventListener('click', async () => {
        const skill = await this.agent.db.get('skills', chip.dataset.skill);
        skill.enabled = !skill.enabled;
        await this.agent.db.put('skills', skill);
        this.updateChatToolbar();
      });
    });

    // Быстрая смена модели — меняет её и в памяти, и в сохранённых настройках,
    // чтобы выбор пережил перезагрузку (секреты при этом не трогаем).
    const modelSel = document.getElementById('quick-model-select');
    modelSel?.addEventListener('change', async () => {
      const chosen = modelSel.value;
      if (!chosen) return;
      llm.configure({ model: chosen });
      const saved = await this.agent.db.get('settings', 'llm');
      if (saved) {
        saved.model = chosen;
        await this.agent.db.put('settings', saved);
      }
      this.updateModelDisplay();
    });

    document.getElementById('tool-stats-chip')?.addEventListener('click', () => this.showChatStatsModal());
  },


  // 128000 → «128k», 1000000 → «1M» — иначе чип занимает пол-панели.
  _fmtLimit(n) {
    if (!n) return '?';
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  },


  // Подробная техническая статистика текущего чата
  async showChatStatsModal() {
    const stats = this.currentChatId ? await this.agent.db.get('chat_stats', this.currentChatId) : null;
    const fmt = (n) => (n || 0).toLocaleString('ru-RU');

    if (!stats) {
      this._showModal('📊 Статистика чата', '<p style="color:var(--text-secondary);">Пока нет данных по этому чату.</p>', null);
      return;
    }

    const rows = Object.entries(stats.byTool || {})
      .sort((a, b) => b[1].calls - a[1].calls)
      .map(([name, s]) => `
        <tr>
          <td>${this._escHtml(name)}</td>
          <td style="text-align:right;">${fmt(s.calls)}</td>
          <td style="text-align:right;color:${s.errors ? 'var(--danger)' : 'inherit'};">${fmt(s.errors)}</td>
          <td style="text-align:right;">${fmt(Math.round(s.timeMs))} мс</td>
          <td style="text-align:right;">${fmt(Math.round(s.timeMs / Math.max(1, s.calls)))} мс</td>
        </tr>`).join('');

    this._showModal('📊 Статистика чата', `
      <div class="form-group">
        <label>Токены</label>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.8;">
          Всего: <strong style="color:var(--text-primary);">${stats.estimated ? '≈' : ''}${fmt(stats.totalTokens)}</strong><br>
          Промпт: ${fmt(stats.promptTokens)} · Ответ: ${fmt(stats.completionTokens)}<br>
          Запросов к модели: ${fmt(stats.requests)}
        </div>
        ${stats.estimated ? `<div style="font-size:11px;color:var(--warning);margin-top:6px;">
          ≈ — провайдер не возвращает usage, значения посчитаны приблизительно по объёму текста и не подходят для сверки со счётом.
        </div>` : ''}
      </div>
      <div class="form-group">
        <label>Вызовы инструментов</label>
        <div style="font-size:13px;color:var(--text-secondary);line-height:1.8;">
          Всего: <strong style="color:var(--text-primary);">${fmt(stats.toolCalls)}</strong> ·
          Ошибок: ${fmt(stats.toolErrors)} ·
          Суммарное время: ${fmt(Math.round(stats.toolTimeMs))} мс
        </div>
      </div>
      ${rows ? `
      <div class="form-group">
        <label>По инструментам</label>
        <table class="stats-table">
          <thead><tr><th>Инструмент</th><th>Вызовов</th><th>Ошибок</th><th>Время</th><th>Среднее</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : ''}
    `, null);
  },


  // ── Окно контекста модели ──
  // Точного способа узнать лимит через OpenAI-совместимый API нет:
  // /models почти никогда не отдаёт context_length. Поэтому используем
  // таблицу известных семейств моделей, а пользователь может задать
  // значение вручную в ⚙ Настройки → Модель (оно имеет приоритет).
  _knownContextLimit(modelName) {
    const m = String(modelName || '').toLowerCase();
    const table = [
      [/gpt-4\.1|gpt-4o|o1|o3|o4/, 128000],
      [/gpt-4-turbo|gpt-4-1106|gpt-4-0125/, 128000],
      [/gpt-4-32k/, 32768],
      [/gpt-4/, 8192],
      [/gpt-3\.5-turbo-16k/, 16384],
      [/gpt-3\.5/, 16385],
      [/claude-3|claude-4|claude-opus|claude-sonnet|claude-haiku/, 200000],
      [/claude-2\.1/, 200000],
      [/claude-2/, 100000],
      [/gemini-1\.5-pro|gemini-2/, 1000000],
      [/gemini/, 32768],
      [/llama-?3\.[12]|llama-?3-?70|llama-?3-?8/, 128000],
      [/llama-?2/, 4096],
      [/mixtral|mistral-large/, 32768],
      [/mistral/, 32768],
      [/qwen2?\.5|qwen3/, 128000],
      [/deepseek/, 64000],
      [/command-r/, 128000],
      [/yi-/, 200000],
      [/phi-3/, 128000],
    ];
    for (const [re, limit] of table) if (re.test(m)) return limit;
    return 0; // неизвестно
  },


  // Эффективный лимит: ручная настройка > таблица > 0 (неизвестно)
  effectiveContextLimit() {
    return this.contextLimit > 0
      ? this.contextLimit
      : this._knownContextLimit(this.agent.llm.model);
  },


  // Грубая оценка числа токенов, когда провайдер не вернул usage.
  // Эвристика: латиница ≈ 4 символа на токен, кириллица дробится
  // токенизаторами мельче — ≈ 2. Это ОЦЕНКА, а не факт: в UI такие
  // значения помечаются знаком «≈», чтобы их не принимали за биллинговые.
  _estimateTokens(text) {
    if (!text) return 0;
    const s = String(text);
    const cyr = (s.match(/[\u0400-\u04FF]/g) || []).length;
    const rest = s.length - cyr;
    return Math.ceil(cyr / 2 + rest / 4);
  },


  _estimateUsage(apiMessages, result) {
    let promptChars = 0;
    for (const m of apiMessages) {
      promptChars += this._estimateTokens(m.content || '');
      if (m.tool_calls) promptChars += this._estimateTokens(JSON.stringify(m.tool_calls));
    }
    let completion = this._estimateTokens(result.content || '');
    if (result.tool_calls) completion += this._estimateTokens(JSON.stringify(result.tool_calls));
    return { prompt_tokens: promptChars, completion_tokens: completion };
  },


  // Сохраняем размер контекста последнего запроса — он показывается
  // в панели чата и переживает перезагрузку вместе со статистикой.
  async _recordContextSize(tokens, isEstimate) {
    return this._statsUpdate(this.currentChatId, (stats) => {
      stats.lastContextTokens = tokens;
      stats.lastContextEstimated = !!isEstimate;
    });
  },


  // Предупреждения о приближении к границе окна контекста.
  // Каждый уровень показывается один раз за чат, иначе сообщение
  // повторялось бы после каждого запроса и засоряло переписку.
  async _checkContextThresholds(container, contextTokens) {
    const limit = this.effectiveContextLimit();
    if (!limit || !contextTokens) return;

    const stats = await this._getChatStats(this.currentChatId);
    if (!stats) return;

    const percent = Math.round((contextTokens / limit) * 100);
    const warnAt = this.contextWarnPercent;

    // Достигнут максимум окна контекста
    if (percent >= 100 && stats.contextAlertLevel !== 'max') {
      // Через очередь: прямая запись затёрла бы счётчики, накопленные
      // параллельными обновлениями (объект прочитан раньше).
      await this._statsUpdate(this.currentChatId, (st) => { st.contextAlertLevel = 'max'; });
      container.insertAdjacentHTML('beforeend', `
        <div class="message system context-alert danger">
          🛑 Контекст исчерпан: ${contextTokens.toLocaleString('ru-RU')} из ${limit.toLocaleString('ru-RU')} токенов (${percent}%).
          Модель начнёт терять начало переписки или возвращать ошибку.
          <div style="margin-top:8px;">
            <button class="btn btn-primary btn-sm" id="ctx-new-chat-btn">➕ Создать новый чат</button>
          </div>
        </div>`);
      document.getElementById('ctx-new-chat-btn')?.addEventListener('click', () => this.newChat());
      container.scrollTop = container.scrollHeight;
      return;
    }

    // Достигнут рекомендуемый порог
    if (percent >= warnAt && percent < 100 && !stats.contextAlertLevel) {
      await this._statsUpdate(this.currentChatId, (st) => { st.contextAlertLevel = 'warn'; });
      container.insertAdjacentHTML('beforeend', `
        <div class="message system context-alert warn">
          ⚠️ Контекст заполнен на ${percent}% (${contextTokens.toLocaleString('ru-RU')} из ${limit.toLocaleString('ru-RU')} токенов).
          Дальше расходы растут, а качество ответов может падать — стоит завершить тему или начать новый чат.
        </div>`);
      container.scrollTop = container.scrollHeight;
    }
  },


  // ── Персистентная техническая статистика чата (store 'chat_stats') ──
  // ── Сериализация обновлений статистики ──
  // Все три записи (_recordUsage, _recordContextSize, _recordToolCall)
  // работают по схеме read-modify-write в отдельных транзакциях и
  // вызываются подряд, а _recordToolCall — ещё и в цикле по вызовам.
  // Без очереди два перекрывающихся обновления читали бы одно и то же
  // состояние, и изменения одного терялись: счётчики занижались.
  // Очередь гарантирует, что следующая правка видит результат предыдущей.
  _statsUpdate(chatId, mutate) {
    if (!chatId) return Promise.resolve(null);
    this._statsQueue = (this._statsQueue || Promise.resolve()).then(async () => {
      const stats = await this._getChatStats(chatId);
      if (!stats) return null;
      mutate(stats);
      await this.agent.db.put('chat_stats', stats);
      return stats;
    }).catch((e) => {
      console.error('Не удалось обновить статистику чата:', e);
      return null;
    });
    return this._statsQueue;
  },

  async _getChatStats(chatId) {
    if (!chatId) return null;
    const existing = await this.agent.db.get('chat_stats', chatId);
    return existing || {
      chatId,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requests: 0,
      estimated: false,  // true — хотя бы часть цифр получена оценкой
      lastContextTokens: 0,      // размер контекста последнего запроса
      lastContextEstimated: false,
      contextAlertLevel: null,   // null | 'warn' | 'max' — какое предупреждение уже показано
      toolCalls: 0,
      toolErrors: 0,
      toolTimeMs: 0,
      byTool: {},   // { имя: { calls, errors, timeMs } }
    };
  },


  async _recordUsage(usage, isEstimate = false) {
    return this._statsUpdate(this.currentChatId, (stats) => {
      stats.promptTokens += usage.prompt_tokens || 0;
      stats.completionTokens += usage.completion_tokens || 0;
      stats.totalTokens += usage.total_tokens ||
        ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
      stats.requests += 1;
      if (isEstimate) stats.estimated = true;
    });
  },


  async _recordToolCall(name, elapsedMs, isError) {
    return this._statsUpdate(this.currentChatId, (stats) => {
      stats.toolCalls += 1;
      stats.toolTimeMs += elapsedMs;
      if (isError) stats.toolErrors += 1;
      const entry = stats.byTool[name] || { calls: 0, errors: 0, timeMs: 0 };
      entry.calls += 1;
      entry.timeMs += elapsedMs;
      if (isError) entry.errors += 1;
      stats.byTool[name] = entry;
    });
  }

});
