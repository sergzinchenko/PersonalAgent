// ============================================================
//  UI CHAT — чат: сообщения, генерация ответа, вызовы инструментов
// ============================================================
//
// Ядро диалога: отправка сообщения, цикл tool-calling с лимитами, прерывание, копирование кода, голосовой ввод.

// Инструменты чтения артефактов: их собственный результат в артефакт НЕ
// выносится, даже если он большой. Иначе чтение куска артефакта плодило
// бы новый артефакт, и модель ходила бы по матрёшке вместо данных.
const ARTIFACT_TOOLS = new Set(['artifact_read', 'artifact_grep', 'artifact_list']);

Object.assign(UI.prototype, {


  // === Chat ===
  async newChat() {
    const now = Date.now();
    const chat = {
      id: uid(),
      // Заголовок с меткой времени: пока пользователь не переименовал чат,
      // «Новый чат» у всех одинаковый и список становится нечитаемым.
      title: 'Чат ' + new Date(now).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      }),
      createdAt: now,
      updatedAt: now,
      // Новый чат создаётся в папке, выбранной сейчас в дереве сайдбара.
      parentId: this.folderSelection.chats || null,
      skillIds: [],
      // Набор моделей чата и выбранная из них. Новый чат начинает с
      // модели по умолчанию, отмеченной звёздочкой в настройках.
      modelRefs: this.agent.models?.defaultRef ? [this.agent.models.defaultRef] : [],
      modelRef: this.agent.models?.defaultRef || null,
      model: this.agent.llm.model,
    };
    await this.agent.db.put('chats', chat);
    await this.loadChat(chat.id);
  },


  async loadChat(chatId) {
    this.currentChatId = chatId;
    const messages = await this.agent.db.getAllByIndex('messages', 'chatId', chatId);
    messages.sort((a, b) => a.timestamp - b.timestamp);

    const container = document.getElementById('chat-messages');
    if (messages.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">✨</div>
          <div class="text">Начните диалог</div>
        </div>`;
    } else {
      container.innerHTML = messages.map(m => this._renderMessage(m)).join('');
      container.scrollTop = container.scrollHeight;
    }

    // Переписки подзадач в списке чатов не показываются, поэтому у них
    // нужен собственный выход обратно — иначе, открыв подзадачу, вернуться
    // в основной разговор можно было бы только через другой чат.
    await this._renderSubtaskBanner(chatId, container);

    // ── Восстановление визуализации, если чат всё ещё генерирует ответ ──
    // Пока мы смотрели на другой чат, этот мог продолжать работать в
    // фоне: сообщения, уже завершённые к этому моменту, только что
    // пришли из БД выше, а вот текущий незаконченный ответ и индикатор
    // хода нигде, кроме run-объекта, не хранятся — достаём их оттуда.
    const run = this._chatRuns.get(chatId);
    if (run) {
      if (run.partialContent) {
        const el = document.createElement('div');
        el.className = 'message assistant';
        el.innerHTML = renderMarkdown(run.partialContent);
        container.appendChild(el);
        // Тот же узел подхватит и допишет активный _generateResponse —
        // общее состояние живёт в run, а не в замыкании функции.
        run.streamEl = el;
      }
      if (run.stage) this._renderStatusBar(run.stage.text, run.stage.detail, run);
      container.scrollTop = container.scrollHeight;
    }
    // Кнопки «Отправить»/«⏹» отражают состояние именно этого, просматриваемого
    // сейчас чата — а не то, что где-то на фоне работает другой.
    this._setBusy(!!run);

    // Модель — свойство чата. Применяем её к общему шлюзу и здесь: если
    // этот чат сам сейчас не генерирует ответ, иначе индикатор в шапке
    // показывал бы модель предыдущего просмотренного чата. Если же он
    // генерирует — _generateResponse всё равно переприменит свою модель
    // непосредственно перед обращением к API, так что гонки с чужим
    // выбором модели в списке это не создаёт.
    await this.applyChatModel(chatId);

    this.updateChatToolbar();
    this.refreshSidebar();
    this.updateModelDisplay();
  },


  async deleteChat(chatId) {
    // Чат мог в этот момент генерировать ответ — останавливаем ход,
    // иначе он продолжит писать сообщения в уже удалённый чат.
    const run = this._chatRuns.get(chatId);
    if (run) {
      run.stopRequested = true;
      try { run.abortCtl?.abort(); } catch (_) {}
      try { run.subtaskAbort?.abort(); } catch (_) {}
      clearInterval(run.statusTimer);
      this._chatRuns.delete(chatId);
    }

    // Переписки подзадач этого чата — его часть: они не показываются
    // в списке отдельно, и без этого остались бы недостижимым мусором.
    const allChats = await this.agent.db.getAll('chats');
    for (const c of allChats) {
      if (c.subtaskOf === chatId) await this.deleteChat(c.id);
    }

    await this.agent.db.delete('chats', chatId);
    const msgs = await this.agent.db.getAllByIndex('messages', 'chatId', chatId);
    // Одна транзакция вместо N: у длинного чата это тысячи сообщений.
    await this.agent.db.deleteAll('messages', msgs.map(m => m.id));
    // Техническая статистика живёт в отдельном store — чистим и её,
    // иначе останется «сирота» с токенами удалённого чата.
    await this.agent.db.delete('chat_stats', chatId);
    // То же для больших результатов инструментов: они и по объёму
    // крупнее всего остального, что оставил бы после себя чат.
    try { await this.agent.artifacts?.removeByChat(chatId); } catch (_) {}
    // И для планов задач этого чата — они тоже привязаны только к нему.
    try { await this.agent.tasks?.removeByChat(chatId); } catch (_) {}

    if (this.currentChatId === chatId) {
      this.currentChatId = null;
      document.getElementById('chat-messages').innerHTML = '<div class="empty-state"><div class="icon">💬</div><div class="text">Выберите чат</div></div>';
      this._setBusy(false);
    }
    this.refreshSidebar();
  },


  _renderMessage(msg) {
    if (msg.role === 'tool') {
      const body = this._escHtml(typeof msg.content === 'string'
        ? msg.content.substring(0, 200) : JSON.stringify(msg.content).substring(0, 200));
      // Полный результат вынесен из переписки — даём его открыть, иначе
      // при перезагрузке чата от большого ответа осталась бы только шапка.
      const more = msg.artifactId
        ? ` <button class="btn btn-secondary btn-sm" data-artifact="${this._escHtml(msg.artifactId)}">📄 полностью</button>`
        : '';
      // Подзадача: её итог и вход в переписку — см. _renderToolCallBlock.
      if (msg.subChatId) {
        let parsed = null;
        try { parsed = JSON.parse(msg.content); } catch (_) {}
        if (parsed) {
          return `<div class="message tool-call">` +
            this._renderToolCallBlock(msg.name, '{}', msg.content, msg.durationMs || 0,
                                      !!msg.isError, msg.artifactId || null, msg.subChatId) +
            `</div>`;
        }
      }
      return `<div class="message tool-call">🔧 Tool: ${this._escHtml(msg.name)} → ${body}${more}</div>`;
    }
    if (msg.role === 'system') {
      // Свёрнутая часть переписки — служебная запись со своим видом
      // (сложена, разворачивается кликом), см. ui-compaction.js.
      if (msg.kind === 'context-summary') return this._renderContextSummary(msg);
      // Отметка смены модели — самостоятельный тип записи, показываем целиком
      // и без обрезки, в отличие от прочих системных сообщений.
      if (msg.kind === 'model-switch') {
        return `<div class="message system model-switch">🔄 ${this._escHtml(msg.content)}</div>`;
      }
      return `<div class="message system">${this._escHtml(msg.content?.substring(0, 100))}...</div>`;
    }
    const roleClass = msg.role === 'user' ? 'user' : 'assistant';
    const content = msg.role === 'assistant' ? renderMarkdown(msg.content) : this._escHtml(msg.content);
    return `<div class="message ${roleClass}" data-msg-id="${this._escHtml(msg.id || '')}">${content}${this._msgFooter(msg)}</div>`;
  },

  // Подпись под сообщением: время, модель-автор ответа и длительность.
  // Модель берётся из самой записи, а не из текущих настроек, — иначе
  // старые ответы «переприписывались» бы новой моделью после смены.
  _msgFooter(msg) {
    const inner = this._msgFooterInner(msg);
    return inner ? `<div class="msg-footer">${inner}</div>` : '';
  },

  // Вынесено отдельно, чтобы обновлять подпись на месте (например, когда
  // время обработки хода становится известно уже после отрисовки).
  _msgFooterInner(msg) {
    const parts = [];
    if (msg.timestamp) {
      parts.push(new Date(msg.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
    }
    if (msg.role === 'user' && msg.turnDurationMs != null) {
      // Для запроса пользователя показываем полное время обработки —
      // включая вызовы инструментов, а не только генерацию ответа.
      parts.push('⏱ обработка ' + this._fmtDuration(msg.turnDurationMs));
    }
    if (msg.role === 'assistant') {
      if (msg.model) parts.push('🧠 ' + this._escHtml(msg.model));
      if (msg.durationMs != null) parts.push('⏱ ' + this._fmtDuration(msg.durationMs));
      // Явно помечаем неполные ответы, чтобы обрыв не выглядел
      // «странным поведением модели».
      if (msg.truncated) parts.push('✂️ оборван по лимиту токенов');
      if (msg.interrupted) parts.push('⏹ прерван, сохранена полученная часть');
    }
    return parts.join(' · ');
  },

  // 850 → «0,9 с», 65000 → «1 м 5 с»
  _fmtDuration(ms) {
    if (ms < 1000) return ms + ' мс';
    const sec = ms / 1000;
    if (sec < 60) return sec.toFixed(1).replace('.', ',') + ' с';
    const m = Math.floor(sec / 60);
    return m + ' м ' + Math.round(sec - m * 60) + ' с';
  },


  async sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    if (!this.agent.llm.isConfigured()) {
      this.showSettingsModal();
      return;
    }

    if (!this.currentChatId) await this.newChat();
    // Захватываем id один раз и дальше используем только его: если во
    // время всей этой async-функции пользователь переключится на другой
    // чат, this.currentChatId изменится, а chatId — нет. Раньше запись
    // сообщений шла по this.currentChatId напрямую, и переключение чата
    // посреди отправки могло приписать их не тому чату.
    const chatId = this.currentChatId;

    if (this._chatRuns.has(chatId)) return; // этот чат уже отвечает

    // Общий шлюз LLM обслуживает один запрос за раз (см. пояснение в
    // конструкторе UI) — если где-то уже идёт генерация, второй чат
    // придётся подождать. Раньше это блокировало отправку молча и во
    // ВСЕХ чатах сразу; теперь ограничение понятно и относится только
    // к попытке начать новый ход, пока другой ещё выполняется.
    if (this._chatRuns.size > 0) {
      const busyId = this._chatRuns.keys().next().value;
      const busyChat = await this.agent.db.get('chats', busyId);
      const c = document.getElementById('chat-messages');
      c.insertAdjacentHTML('beforeend',
        `<div class="message system">⏳ Дождитесь ответа в чате «${this._escHtml(busyChat?.title || 'без названия')}» — одновременно обрабатывается только один запрос.</div>`);
      c.scrollTop = c.scrollHeight;
      return;
    }

    input.value = '';
    input.style.height = 'auto';

    const chat = await this.agent.db.get('chats', chatId);
    // Пока идут await ниже, пользователь мог уйти в другой чат — каждое
    // обращение к DOM берёт контейнер заново и только если chatId всё ещё
    // тот, что сейчас на экране.
    const dom = () => (chatId === this.currentChatId) ? document.getElementById('chat-messages') : null;
    const emptyState = dom()?.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    // ── Смена модели фиксируется в истории ──
    // Модель можно переключить прямо в чате; без отметки в переписке потом
    // невозможно понять, где проходит граница между ответами разных моделей.
    const currentModel = this.agent.llm.model;
    if (currentModel && chat.model && chat.model !== currentModel) {
      const switchMsg = {
        id: uid(),
        chatId,
        role: 'system',
        kind: 'model-switch',
        content: `Модель изменена: ${chat.model} → ${currentModel}`,
        from: chat.model,
        to: currentModel,
        timestamp: Date.now(),
      };
      await this.agent.db.put('messages', switchMsg);
      dom()?.insertAdjacentHTML('beforeend', this._renderMessage(switchMsg));
    }
    chat.model = currentModel;

    const userMsg = {
      id: uid(),
      chatId,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    await this.agent.db.put('messages', userMsg);

    // Автозаголовок по первому сообщению. Проверяем не по строке «Новый
    // чат» (формат заголовка изменился на «Чат ДД.ММ, ЧЧ:ММ»), а по факту
    // отсутствия пользовательского названия.
    if (!chat.titleSetByUser && /^Чат \d|^Новый чат$/.test(chat.title || '')) {
      chat.title = text.substring(0, 50);
    }
    chat.updatedAt = Date.now();
    await this.agent.db.put('chats', chat);
    this.refreshSidebar();

    const container = dom();
    if (container) {
      container.insertAdjacentHTML('beforeend', this._renderMessage(userMsg));
      container.scrollTop = container.scrollHeight;
    }

    // Новый ход — заводим состояние генерации именно этого чата (см.
    // пояснение к this._chatRuns в конструкторе UI).
    const run = {
      startedAt: Date.now(),
      stage: null,            // { text, detail } последнего _showStatus — для восстановления при возврате в чат
      partialContent: '',     // накопленный за текущий шаг стриминга текст, ещё не сохранённый в БД
      streamEl: null,         // DOM-узел этого текста, если чат сейчас виден
      turnToolCalls: 0,
      turnUserMsgId: userMsg.id,
      stopRequested: false,
      abortCtl: null,
      // Контроллер запроса подзадачи, пока она выполняется: «⏹» должен
      // рвать и его, а не только запрос родительского хода.
      subtaskAbort: null,
      statusTimer: null,
    };
    this._chatRuns.set(chatId, run);
    if (chatId === this.currentChatId) this._setBusy(true);
    this.refreshSidebar(); // сразу показать индикатор у чата в списке

    // Счётчики политики безопасности считаются на ход, а не на сессию:
    // «за один ответ уже 20 изменений» — сигнал, «за день» — нет. Общий
    // шлюз обслуживает один ход за раз, поэтому одного глобального
    // состояния в SecurityEngine достаточно и здесь ничего дублировать не нужно.
    this.agent.security?.resetTurn();

    // Шлюз глобален, а модель выбирается у чата. Открытый ранее другой
    // чат мог оставить в шлюзе свою модель — применяем нужную перед
    // ходом (и ещё раз непосредственно перед обращением к API внутри
    // _generateResponse, см. пояснение там).
    await this.applyChatModel(chatId);

    await this._generateResponse(chatId);
  },


  // Останавливает ход и сообщает причину. Возвращает true — значит выше
  // по стеку нужно прекратить цепочку tool-calling.
  // depth важен: состоянием «агент занят» владеет ТОЛЬКО корневой кадр
  // цепочки (depth === 0). Вложенные кадры не снимают занятость, иначе
  // на середине цепочки tool-calling кнопка отправки разблокируется,
  // а кнопка останова остаётся висеть от следующего шага.
  // Предупреждение об обрыве ответа по лимиту токенов + продолжение.
  // Продолжение реализовано как обычное сообщение пользователя: обрезанный
  // ответ уже лежит в истории, поэтому модель видит, где остановилась.
  // ── Индикатор хода работы ──
  // Раньше во время работы висели три статичные точки, которые к тому же
  // снимались перед вызовами инструментов — то есть на самом долгом этапе
  // пользователь не видел вообще ничего. Панель показывает текущую стадию,
  // счётчик прошедшего времени и (когда задан) остаток бюджета на ход.
  // chatId — чат, к которому относится этот статус (обычно this._chatRuns
  // ключ). Таймер и текст стадии хранятся в run и тикают независимо от
  // того, что сейчас на экране: DOM трогаем, только если chatId — это
  // именно просматриваемый сейчас чат, иначе статус чужого хода лёг бы
  // поверх переписки другого чата.
  _showStatus(chatId, text, detail = '') {
    const run = this._chatRuns.get(chatId);
    if (run) run.stage = { text, detail };

    if (run && !run.statusTimer) {
      const started = run.startedAt || Date.now();
      const budget = this.limits.maxTurnSeconds;
      run.statusTimer = setInterval(() => {
        if (chatId !== this.currentChatId) return;
        const node = document.getElementById('agent-status');
        const timer = node?.querySelector('.status-timer');
        if (!timer) return;
        const sec = Math.floor((Date.now() - started) / 1000);
        timer.textContent = budget > 0 ? `${sec} с из ${budget}` : `${sec} с`;
        // Ближе к исчерпанию бюджета подсвечиваем — обрыв не должен
        // становиться неожиданностью.
        timer.classList.toggle('near-limit', budget > 0 && sec >= budget * 0.75);
      }, 1000);
    }

    if (chatId !== this.currentChatId) return;
    this._renderStatusBar(text, detail, run);
  },

  // Отрисовывает панель статуса в текущем #chat-messages по состоянию run.
  // Используется и из _showStatus (когда просматриваемый чат — это тот,
  // что сейчас отвечает), и из loadChat() — при возврате в чат, который
  // продолжал генерировать ответ, пока был не виден.
  _renderStatusBar(text, detail, run) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    let el = document.getElementById('agent-status');
    if (!el) {
      container.insertAdjacentHTML('beforeend', `
        <div class="agent-status" id="agent-status">
          <span class="status-spinner"></span>
          <span class="status-text"></span>
          <span class="status-detail"></span>
          <span class="status-timer"></span>
        </div>`);
      el = document.getElementById('agent-status');
      container.scrollTop = container.scrollHeight;
    }
    el.querySelector('.status-text').textContent = text;
    el.querySelector('.status-detail').textContent = detail;
    if (run) {
      const sec = Math.floor((Date.now() - (run.startedAt || Date.now())) / 1000);
      const budget = this.limits.maxTurnSeconds;
      const timer = el.querySelector('.status-timer');
      timer.textContent = budget > 0 ? `${sec} с из ${budget}` : `${sec} с`;
      timer.classList.toggle('near-limit', budget > 0 && sec >= budget * 0.75);
    }
  },

  // Единственная точка завершения хода для всей цепочки (см. depth===0 в
  // _generateResponse): убирает чат из this._chatRuns, останавливает его
  // таймер, снимает панель статуса и разблокирует ввод — но только если
  // это всё ещё влияет на то, что сейчас видно, — и обновляет индикатор
  // в списке чатов в любом случае.
  _endRun(chatId) {
    const run = this._chatRuns.get(chatId);
    if (run) clearInterval(run.statusTimer);
    this._chatRuns.delete(chatId);
    if (chatId === this.currentChatId) {
      this._setBusy(false);
      document.getElementById('agent-status')?.remove();
    }
    this.refreshSidebar();
  },

  _showTruncationNotice(chatId) {
    const container = (chatId === this.currentChatId) ? document.getElementById('chat-messages') : null;
    if (!container) return;
    const max = this.agent.llm.maxTokens;
    const id = 'trunc_' + uid();
    container.insertAdjacentHTML('beforeend', `
      <div class="message system truncation-notice" id="${id}">
        ✂️ Ответ оборван: исчерпан лимит ответа (max_tokens = ${max}).
        Увеличьте его в ⚙ Настройки → Модель или продолжите ответ.
        <div style="margin-top:8px;">
          <button class="btn btn-primary btn-sm" data-continue="1">▶ Продолжить ответ</button>
        </div>
      </div>`);
    const el = document.getElementById(id);
    el?.querySelector('[data-continue]')?.addEventListener('click', () => {
      el.remove();
      const input = document.getElementById('chat-input');
      input.value = 'Продолжи ответ с того места, где он оборвался, не повторяя уже написанное.';
      this.sendMessage();
    });
  },

  // ── Обрезка истории под окно контекста ──
  // Раньше в API уходила ВСЯ история чата: приложение предупреждало о
  // заполнении контекста, но ничего не предпринимало, и после превышения
  // лимита чат становился нерабочим — каждый следующий запрос снова слал
  // переполненный контекст и получал ошибку провайдера.
  //
  // Стратегия: системный промпт неприкосновенен, дальше берём сообщения
  // с конца (свежие важнее) пока укладываемся в бюджет. Бюджет — это
  // окно контекста минус место под ответ (max_tokens) минус запас.
  // ref — модель ИМЕННО этого чата (см. вызов в _generateResponse). Без
  // явного ref лимит брался бы из того, что сейчас применено к общему
  // шлюзу, — а это могла успеть переключить другая, просматриваемая в тот
  // же момент вкладка/чат.
  //
  // ВЫТЕСНЕННОЕ БОЛЬШЕ НЕ ТЕРЯЕТСЯ. Начало переписки, не поместившееся в
  // бюджет, сначала сворачивается в резюме (_compactHistory) и участвует
  // в контексте уже в виде десятка строк. Здесь такое резюме — обычное
  // сообщение с kind:'context-summary'; всё, что оно покрывает, в запрос
  // не идёт, иначе платили бы дважды за одно и то же.
  _trimHistory(allMsgs, systemPrompt, ref) {
    // Служебные отметки не идут в API (см. model-switch), убираем сразу.
    let usable = allMsgs.filter(m => m.kind !== 'model-switch');

    // Всё, что уже свёрнуто, заменено последним резюме — оно идёт вместо
    // покрытых сообщений и стоит на их месте в ленте.
    const summaries = usable.filter(m => m.kind === 'context-summary');
    if (summaries.length) {
      const last = summaries[summaries.length - 1];
      usable = usable.filter(m => m === last || m.timestamp > last.timestamp);
    }

    // ── Старые результаты инструментов передаются коротко ──
    // Свежие результаты нужны целиком: с ними агент работает прямо
    // сейчас. Те, что старше последних нескольких, почти всегда уже
    // отработаны — но продолжали ехать в каждый запрос полным текстом.
    // Оставляем начало и говорим прямо, где взять остальное.
    const KEEP_FULL_TOOL_RESULTS = 6;
    const toolIdx = [];
    usable.forEach((m, i) => { if (m.role === 'tool') toolIdx.push(i); });
    const shrinkBefore = toolIdx.length > KEEP_FULL_TOOL_RESULTS
      ? toolIdx[toolIdx.length - KEEP_FULL_TOOL_RESULTS]
      : -1;

    const toApi = (m, idx) => {
      if (m.role === 'tool') {
        let content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        if (shrinkBefore >= 0 && idx < shrinkBefore && content.length > 400) {
          content = content.slice(0, 400) +
            `… [результат сокращён: было ${content.length} символов. ` +
            (m.artifactId
              ? `Полный текст — artifact_read({ id: "${m.artifactId}" })]`
              : 'Если он снова нужен — повтори вызов]');
        }
        return {
          role: 'tool',
          content,
          tool_call_id: m.tool_call_id,
          name: m.name,
        };
      }
      if (m.role === 'assistant' && m.tool_calls) {
        return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls };
      }
      return { role: m.role, content: m.content };
    };

    const limit = this.effectiveContextLimit(ref);
    // Лимит неизвестен — обрезать не по чему, оставляем как есть.
    if (!limit) {
      return { messages: usable.map(toApi), droppedCount: 0, droppedTokens: 0, dropped: [] };
    }

    const resolved = ref ? this.agent.models?.resolve(ref) : null;
    const maxTokens = resolved ? resolved.model.maxTokens : this.agent.llm.maxTokens;
    const reserve = Math.min(maxTokens || 4096, Math.floor(limit * 0.3));
    const budget = Math.max(1000, limit - reserve - this._estimateTokens(systemPrompt) - 200);

    const costOf = (m) => this._estimateTokens(
      (m.content || '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '')) + 4;

    let used = 0;
    const keptIdx = [];
    for (let i = usable.length - 1; i >= 0; i--) {
      const c = costOf(usable[i]);
      if (used + c > budget && keptIdx.length) break;
      used += c;
      keptIdx.push(i);
    }
    keptIdx.reverse();

    if (keptIdx.length === usable.length) {
      return { messages: usable.map(toApi), droppedCount: 0, droppedTokens: 0, dropped: [] };
    }

    let start = keptIdx[0];

    // ── Целостность пар «вызов инструмента → результат» ──
    // Сообщение role:'tool' без предшествующего assistant с tool_calls
    // ломает запрос: провайдеры отвечают ошибкой на «сироту». Поэтому
    // сдвигаем границу вперёд, пока первое сообщение — осиротевший
    // результат инструмента.
    while (start < usable.length && usable[start].role === 'tool') start++;

    const kept = usable.slice(start);
    const dropped = usable.slice(0, start);
    const droppedTokens = dropped.reduce((n, m) => n + costOf(m), 0);

    // Вместо молчаливой потери начала переписки вставляем краткую
    // сводку — модель хотя бы знает, что разговор начался раньше.
    const summary = {
      role: 'system',
      content: `[Начало переписки свёрнуто, чтобы уместиться в контекст: ` +
        `${dropped.length} сообщений (≈${droppedTokens} токенов) не переданы. ` +
        `Если понадобится что-то из ранней части диалога — попроси пользователя повторить.]`,
    };

    return {
      messages: [summary, ...kept.map((m, i) => toApi(m, start + i))],
      droppedCount: dropped.length,
      droppedTokens,
      // Сами вытесненные записи нужны вызывающей стороне: она сворачивает
      // их в резюме (_compactHistory), чтобы работа не пропадала.
      dropped,
      budget,
    };
  },

  // Уведомление показываем один раз за чат: повтор после каждого
  // запроса засорял бы переписку. Раньше запоминался id только ОДНОГО
  // чата (this._trimNoticeShownFor) — при переключении между двумя
  // чатами, каждому из которых нужна обрезка, уведомление лезло бы
  // заново при каждом возврате. Set помнит все чаты за сессию.
  _showTrimNotice(chatId, trim) {
    this._trimNoticeShown = this._trimNoticeShown || new Set();
    if (this._trimNoticeShown.has(chatId)) return;
    this._trimNoticeShown.add(chatId);

    const container = (chatId === this.currentChatId) ? document.getElementById('chat-messages') : null;
    if (!container) return;
    container.insertAdjacentHTML('beforeend', `
      <div class="message system context-alert warn">
        ✂️ Ранняя часть переписки (${trim.droppedCount} сообщений) больше не передаётся модели —
        контекст не вмещает весь чат. Сама история сохранена и видна здесь.
        Для длинной новой темы лучше создать отдельный чат.
      </div>`);
    container.scrollTop = container.scrollHeight;
  },

  // ── Подтверждение операции агента ──
  // Диалог должен давать основание для решения, а не просто спрашивать
  // «разрешить?». Поэтому показываем: что за операция, чем именно она
  // рискованна и с какими аргументами вызывается.
  confirmSecurityAction(req) {
    return new Promise((resolve) => {
      let settled = false;

      const catLabels = {
        read: 'Чтение', write: 'Изменение данных',
        destroy: 'Удаление или перезапись', network: 'Обращение в интернет',
        execute: 'Исполнение кода или подмена поведения',
      };

      let argsText = '';
      try {
        argsText = JSON.stringify(req.args, null, 2) || '';
      } catch (_) { argsText = String(req.args); }
      if (argsText.length > 2000) argsText = argsText.slice(0, 2000) + '\n… (сокращено)';

      const risks = (req.risks || []).map(r =>
        `<li>${this._escHtml(r)}</li>`).join('');

      this._showModal('🛡 Подтвердите операцию', `
        <div class="sec-summary">
          <div class="sec-tool">${this._escHtml(req.toolName)}</div>
          <div class="sec-cat">${this._escHtml(catLabels[req.category] || req.category)}</div>
        </div>
        ${risks ? `<div class="form-group">
          <label>На что обратить внимание</label>
          <ul class="sec-risks">${risks}</ul>
        </div>` : ''}
        <div class="form-group">
          <label>Что именно будет выполнено</label>
          <pre class="tool-pre" style="max-height:30vh;">${this._escHtml(argsText)}</pre>
        </div>
        ${req.host && !req.noRemember ? `<label class="check-row">
          <input type="checkbox" id="sec_remember_host"> Больше не спрашивать про ${this._escHtml(req.host)} в этой сессии
        </label>` : ''}
        ${req.noRemember ? `<div style="font-size:11px;color:var(--warning);margin-top:8px;">
          Об этом спрашивают каждый раз: разрешение не запоминается.
        </div>` : ''}
        <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
          Отказ не прерывает работу агента — он получит сообщение, что операция не разрешена.
        </div>
      `,
        () => {
          settled = true;
          resolve({
            approved: true,
            rememberHost: document.getElementById('sec_remember_host')?.checked || false,
          });
        },
        () => { if (!settled) resolve({ approved: false }); },
        { wide: true }
      );
    });
  },

  _stopTurn(chatId, reason, depth = 0) {
    const container = (chatId === this.currentChatId) ? document.getElementById('chat-messages') : null;
    if (container) {
      container.insertAdjacentHTML('beforeend', `<div class="message system">⚠️ ${this._escHtml(reason)}</div>`);
      container.scrollTop = container.scrollHeight;
    }
    if (depth === 0) this._endRun(chatId);
  },


  // chatId захвачен один раз в sendMessage и передаётся через всю
  // рекурсию tool-calling — НЕ читается из this.currentChatId, который
  // может измениться в любой момент, если пользователь переключится на
  // другой чат. Любое обращение к DOM идёт через dom(), проверяющую,
  // что chatId всё ещё совпадает с просматриваемым чатом, — иначе вывод
  // этого хода отрисовался бы поверх переписки другого чата.
  async _generateResponse(chatId, depth = 0) {
    const run = this._chatRuns.get(chatId);
    if (!run) return; // ход уже остановлен/завершён откуда-то ещё
    const L = this.limits;
    const dom = () => (chatId === this.currentChatId) ? document.getElementById('chat-messages') : null;

    // ── Прерывание пользователем: проверяем между шагами цепочки ──
    if (run.stopRequested) {
      if (depth === 0) this._endRun(chatId);
      return;
    }

    // ── Лимит 1: количество итераций tool-calling ──
    if (L.maxToolSteps > 0 && depth >= L.maxToolSteps) {
      this._stopTurn(chatId, `Достигнут лимит итераций с вызовом инструментов (${L.maxToolSteps}). Остановлено, чтобы не уйти в бесконечный цикл. Уточните запрос или продолжите вручную.`, depth);
      return;
    }

    // ── Лимит 2: общий бюджет времени на ход ──
    if (L.maxTurnSeconds > 0 && run.startedAt) {
      const elapsedSec = (Date.now() - run.startedAt) / 1000;
      if (elapsedSec >= L.maxTurnSeconds) {
        this._stopTurn(chatId, `Превышен лимит времени на ответ (${L.maxTurnSeconds} с). Цепочка вызовов инструментов остановлена.`, depth);
        return;
      }
    }

    if (chatId === this.currentChatId) this._setBusy(true);

    this._showStatus(chatId,
      depth === 0 ? 'Отправляю запрос модели…' : `Продолжаю работу (шаг ${depth + 1})…`,
      this.agent.llm.model ? '🧠 ' + this.agent.llm.model : ''
    );

    // AbortController прерывает сам HTTP-запрос к LLM — и по таймауту хода,
    // и по кнопке «⏹» (stopAgent() вызывает abort() через run.abortCtl).
    const abortCtl = new AbortController();
    run.abortCtl = abortCtl;
    let turnTimer = null;
    if (L.maxTurnSeconds > 0 && run.startedAt) {
      const remainingMs = L.maxTurnSeconds * 1000 - (Date.now() - run.startedAt);
      turnTimer = setTimeout(() => abortCtl.abort(), Math.max(0, remainingMs));
    }

    // Своё состояние стриминга на каждый вызов (в т.ч. рекурсивный) —
    // предыдущий шаг уже сохранён в БД отдельным сообщением. Хранится в
    // run, а не в замыкании: если пользователь уйдёт и вернётся в этот
    // чат, loadChat() должен суметь дорисовать уже накопленный текст.
    run.partialContent = '';
    run.streamEl = null;
    const requestStartedAt = performance.now();

    // Создаёт (или переиспользует) DOM-узел стримящегося ответа. Если
    // сейчас смотрим на другой чат — возвращает null, ничего не трогая;
    // при возврате в ЭТОТ чат loadChat() уже мог создать узел с
    // накопленным текстом (run.streamEl) — подхватываем его же.
    const ensureMsgEl = () => {
      const container = dom();
      if (!container) return null;
      if (!run.streamEl || !run.streamEl.isConnected) {
        run.streamEl = document.createElement('div');
        run.streamEl.className = 'message assistant';
        if (run.partialContent) run.streamEl.innerHTML = renderMarkdown(run.partialContent);
        container.appendChild(run.streamEl);
        container.scrollTop = container.scrollHeight;
      }
      return run.streamEl;
    };

    try {
      // Ссылка на модель ИМЕННО этого чата — нужна ниже для правильного
      // бюджета обрезки истории (_trimHistory), даже если к этому моменту
      // общий шлюз уже смотрит на модель другого, параллельно
      // просматриваемого чата.
      const chatForRef = await this.agent.db.get('chats', chatId);
      const chatRef = this._chatActiveRef(chatForRef, this.agent.models);

      this._showStatus(chatId, 'Собираю контекст…', 'история чата и активные навыки');
      const allMsgs = await this.agent.db.getAllByIndex('messages', 'chatId', chatId);
      allMsgs.sort((a, b) => a.timestamp - b.timestamp);

      let systemPrompt = await this.agent.skills.buildSystemPrompt();

      // ── План задачи ──
      // Состояние длинной работы живёт в отдельной записи, а не в
      // переписке (см. engines/tasks-engine.js), и подставляется в
      // системный промпт при каждом запросе. Поэтому «что уже сделано и
      // что осталось» переживает и подрезку истории, и перезагрузку
      // страницы: сводка занимает десяток строк, а обсуждение плана,
      // которое она заменяет, занимало бы всю переписку.
      try {
        const plan = await this.agent.tasks?.active(chatId);
        if (plan) systemPrompt += this.agent.tasks.digest(plan);
      } catch (_) { /* план не критичен для ответа */ }

      // ── Упоминание файлов в системном промпте ──
      // Раньше сюда безусловно вставлялся ПЕРЕЧЕНЬ всех файлов. Само его
      // присутствие работало как приглашение: агент начинал анализировать
      // файлы даже на вопрос «с чего начать». Теперь по умолчанию модель
      // знает лишь, что файлы есть, а перечень получает инструментом
      // list_files — то есть только когда пользователь о них заговорил.
      try {
        const mode = this.filesContextMode || 'brief';
        if (mode !== 'off') {
          const known = await this.agent.files.all();
          if (known.length) {
            let block = '\n\n## Файлы пользователя\n' +
              `У пользователя есть ссылки на файлы (${known.length} шт.). ` +
              'НЕ читай и НЕ анализируй их по своей инициативе. ' +
              'Если пользователь спросит про свои файлы или про конкретный файл — ' +
              'получи перечень инструментом list_files, затем читай нужное через read_file. ' +
              'Если файл кажется нужным, но о нём не просили — сначала спроси.\n';

            if (mode === 'full') {
              const folders = await this.agent.db.getAll('folders');
              const lines = [];
              for (const f of known.slice(0, 100)) {
                const path = await this.agent.files.pathOf(f, folders);
                lines.push(`- ${path}${f.note ? ' — ' + f.note : ''}`);
              }
              block += lines.join('\n') + '\n';
            }
            systemPrompt += block;
          }
        }
      } catch (_) { /* список файлов не критичен для ответа */ }

      const apiMessages = [{ role: 'system', content: systemPrompt }];
      let trim = this._trimHistory(allMsgs, systemPrompt, chatRef);

      // ── Свёртка вместо потери ──
      // Часть переписки не помещается в окно — вместо того чтобы просто
      // выбросить её, сворачиваем в резюме одним запросом к модели и
      // пересобираем контекст уже с ним (см. ui-compaction.js). Так
      // сделанное в начале разговора продолжает работать, занимая
      // десяток строк вместо десятков тысяч токенов.
      if (trim.droppedCount && this.limits.contextCompaction !== false) {
        const summary = await this._compactHistory(chatId, trim.dropped, chatRef);
        if (summary) {
          const refreshed = await this.agent.db.getAllByIndex('messages', 'chatId', chatId);
          refreshed.sort((a, b) => a.timestamp - b.timestamp);
          trim = this._trimHistory(refreshed, systemPrompt, chatRef);
          // Модель этого чата могла смениться внутри свёртки — вернём.
          await this.applyChatModel(chatId);
        } else {
          // Свернуть не удалось (сбой сети, отказ провайдера) — работает
          // прежнее поведение: начало не передаётся, но об этом сказано.
          this._showTrimNotice(chatId, trim);
        }
      } else if (trim.droppedCount) {
        this._showTrimNotice(chatId, trim);
      }

      for (const m of trim.messages) apiMessages.push(m);

      const tools = await this.agent.tools.getEnabledToolsForAPI();

      this._showStatus(chatId, 'Жду ответ модели…',
        `${apiMessages.length} сообщений в запросе` + (tools.length ? `, ${tools.length} инструментов` : ''));

      // Прямо перед обращением к шлюзу — переприменяем модель ЭТОГО чата.
      // За время сбора контекста (несколько await выше) пользователь мог
      // заглянуть в другой чат: loadChat() того чата уже настроил бы
      // общий шлюз на СВОЮ модель, и без повторного применения запрос
      // ушёл бы не туда, куда должен. modelUsed фиксируем сразу же —
      // ответ может идти долго, а к его завершению шлюз мог снова
      // переключиться на модель чата, который в этот момент просматривают.
      await this.applyChatModel(chatId);
      const modelUsed = this.agent.llm.model;

      let firstChunkSeen = false;
      const result = await this.agent.llm.chat(apiMessages, {
        tools: tools.length > 0 ? tools : null,
        stream: true,
        signal: abortCtl.signal,
        onChunk: (chunk) => {
          run.partialContent += chunk;
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            this._showStatus(chatId, 'Модель отвечает…', '');
          }
          const el = ensureMsgEl();
          if (el) {
            // Объём в статусе обновляем не на каждый чанк, а раз в ~200
            // символов: запись в DOM на каждом токене заметно грузит отрисовку.
            if (run.partialContent.length % 200 < chunk.length) {
              const d = document.querySelector('#agent-status .status-detail');
              if (d) d.textContent = `${run.partialContent.length} символов`;
            }
            el.innerHTML = renderMarkdown(run.partialContent);
            const c = dom();
            if (c) c.scrollTop = c.scrollHeight;
          }
        },
      });

      this._showStatus(chatId, 'Обрабатываю ответ…', '');

      // Учёт токенов. Многие провайдеры игнорируют stream_options и не
      // присылают usage при stream:true — тогда считаем приблизительно
      // сами, иначе счётчик навсегда остался бы нулевым.
      let contextTokens;
      if (result.usage) {
        await this._recordUsage(chatId, result.usage);
        // prompt_tokens = ровно то, что модель приняла на вход,
        // то есть фактический размер контекста этого запроса.
        contextTokens = result.usage.prompt_tokens || 0;
      } else {
        const est = this._estimateUsage(apiMessages, result);
        await this._recordUsage(chatId, est, true);
        contextTokens = est.prompt_tokens;
      }
      await this._recordContextSize(chatId, contextTokens, !result.usage);
      if (chatId === this.currentChatId) this.updateChatToolbar();
      await this._checkContextThresholds(chatId, contextTokens, chatRef);

      if (result.tool_calls && result.tool_calls.length > 0) {
        const assistantMsg = {
          id: uid(),
          chatId,
          role: 'assistant',
          content: result.content || '',
          tool_calls: result.tool_calls,
          timestamp: Date.now(),
          // Модель и время генерации фиксируем в самой истории: модель
          // можно сменить прямо в чате, и без этого потом не понять,
          // какой именно ответ чем сформирован. modelUsed — а не текущее
          // this.agent.llm.model — потому что к этому моменту шлюз мог
          // уже переключиться на модель другого, просматриваемого чата.
          model: modelUsed,
          durationMs: Math.round(performance.now() - requestStartedAt),
        };
        await this.agent.db.put('messages', assistantMsg);

        for (const tc of result.tool_calls) {
          if (tc === undefined) {
        		    continue; // Пропускаем текущую итерацию, если tc undefined - из-за null в списках от некоторых LLM
          }

          // ── Прерывание пользователем ──
          if (run.stopRequested) {
            clearTimeout(turnTimer);
            if (depth === 0) this._endRun(chatId);
            return;
          }

          // ── Лимит 3: суммарное число вызовов за ход ──
          if (L.maxToolCallsPerTurn > 0 && run.turnToolCalls >= L.maxToolCallsPerTurn) {
            clearTimeout(turnTimer);
            this._stopTurn(chatId, `Достигнут лимит вызовов инструментов за один ответ (${L.maxToolCallsPerTurn}).`, depth);
            return;
          }
          // ── Лимит 2 (повторная проверка между вызовами) ──
          if (L.maxTurnSeconds > 0 && run.startedAt &&
              (Date.now() - run.startedAt) / 1000 >= L.maxTurnSeconds) {
            clearTimeout(turnTimer);
            this._stopTurn(chatId, `Превышен лимит времени на ответ (${L.maxTurnSeconds} с).`, depth);
            return;
          }
          run.turnToolCalls++;

          const toolContainer = dom();
          const toolResultDiv = (this.toolVerbosity === 'hidden' || !toolContainer) ? null : document.createElement('div');
          if (toolResultDiv) {
            toolResultDiv.className = 'message tool-call';
            toolResultDiv.textContent = `🔧 Вызываю: ${tc.function.name}...`;
            toolContainer.appendChild(toolResultDiv);
            toolContainer.scrollTop = toolContainer.scrollHeight;
          }

          // Самая долгая и самая непрозрачная стадия: показываем, какой
          // именно инструмент выполняется и сколько их всего в этом шаге.
          this._showStatus(chatId,
            `Выполняю инструмент: ${tc.function.name}`,
            result.tool_calls.length > 1
              ? `вызов ${run.turnToolCalls} из ${result.tool_calls.length} в этом шаге`
              : `всего вызовов за ход: ${run.turnToolCalls}`
          );

          const startedAt = performance.now();
          const toolResult = await this.agent.tools.executeTool(
            tc.function.name,
            tc.function.arguments,
            { timeoutMs: (L.toolTimeoutSeconds || 0) * 1000 }
          );
          const elapsedMs = Math.round(performance.now() - startedAt);
          const isError = !!(toolResult && toolResult.error);
          // Переписка подзадачи скрыта из списка чатов — единственный
          // вход в неё ведёт отсюда, из блока её вызова.
          const subChatId = (toolResult && toolResult.subtask_chat_id) || null;

          // ── Большой результат уходит в артефакт, а не в переписку ──
          // Полный текст сохраняется отдельной записью, а в историю (и
          // значит — в КАЖДЫЙ следующий запрос этого хода) попадает
          // только шапка с идентификатором. Модель дочитывает нужное
          // через artifact_read/artifact_grep. См. artifacts-engine.js.
          let resultStr = JSON.stringify(toolResult);
          let artifactId = null;
          const artifactThreshold = this.limits.artifactThresholdChars | 0;
          if (!isError && artifactThreshold > 0 && resultStr.length > artifactThreshold
              && this.agent.artifacts && !ARTIFACT_TOOLS.has(tc.function.name)) {
            try {
              const rec = await this.agent.artifacts.store({
                chatId,
                toolName: tc.function.name,
                args: tc.function.arguments,
                result: toolResult,
              });
              artifactId = rec.id;
              resultStr = JSON.stringify(this.agent.artifacts.digest(rec));
            } catch (e) {
              // Не смогли сохранить (например, кончилось место) — это не
              // повод терять результат: отдаём как раньше, целиком.
              console.error('Артефакт не сохранён, результат уходит в контекст целиком', e);
            }
          }

          await this._recordToolCall(chatId, tc.function.name, elapsedMs, isError);
          if (chatId === this.currentChatId) this.updateChatToolbar();

          if (toolResultDiv && toolResultDiv.isConnected) {
            toolResultDiv.innerHTML = this._renderToolCallBlock(
              tc.function.name, tc.function.arguments, resultStr, elapsedMs, isError, artifactId, subChatId
            );
            const c = dom();
            if (c) c.scrollTop = c.scrollHeight;
          }

          const toolMsg = {
            id: uid(),
            chatId,
            role: 'tool',
            content: resultStr,
            tool_call_id: tc.id,
            name: tc.function.name,
            timestamp: Date.now(),
            durationMs: elapsedMs,
            isError,
            // Ссылка на полный результат, если он вынесен из переписки.
            // Нужна интерфейсу (кнопка «показать полностью») — модели
            // идентификатор и так виден в самом content.
            artifactId,
            // То же для подзадачи: ссылка на её переписку.
            subChatId,
          };
          await this.agent.db.put('messages', toolMsg);
        }

        clearTimeout(turnTimer);
        // Занятость НЕ снимаем: цепочка продолжается следующим шагом.
        // Раньше здесь стоял сырой сброс isStreaming и send-btn.disabled —
        // он открывал окно, в котором пользователь мог отправить второе
        // сообщение параллельно текущей цепочке. Два одновременных хода
        // затирали состояние друг друга, и кнопка останова оставалась
        // висеть после завершения одного из них.
        await this._generateResponse(chatId, depth + 1);
        return;
      }

      const assistantMsg = {
        id: uid(),
        chatId,
        role: 'assistant',
        content: result.content,
        timestamp: Date.now(),
        model: modelUsed,
        durationMs: Math.round(performance.now() - requestStartedAt),
        // 'length' означает, что провайдер оборвал ответ, упёршись в
        // max_tokens. Раньше это никак не показывалось — ответ просто
        // выглядел незаконченным, и понять причину было невозможно.
        truncated: result.finish_reason === 'length',
      };
      await this.agent.db.put('messages', assistantMsg);

      // Элемент ответа уже отрисован стримингом (если чат был виден) —
      // дописываем подпись (время, модель, длительность), не перерисовывая
      // содержимое. Если сейчас смотрим на другой чат, ensureMsgEl() ничего
      // не создаст — при следующем открытии этого чата подпись придёт из
      // БД вместе с самим сообщением через обычный _renderMessage().
      const finalEl = ensureMsgEl();
      if (finalEl) {
        finalEl.dataset.msgId = assistantMsg.id;
        finalEl.insertAdjacentHTML('beforeend', this._msgFooter(assistantMsg));
      }

      if (assistantMsg.truncated) this._showTruncationNotice(chatId);
      const doneContainer = dom();
      if (doneContainer) doneContainer.scrollTop = doneContainer.scrollHeight;

    } catch (error) {

      // ── Сохраняем частично полученный ответ ──
      // Прерывание (таймаут хода или кнопка «⏹») происходит во время
      // стриминга: текст уже отрисован на экране, но запись в БД шла
      // ПОСЛЕ await, поэтому раньше он терялся — ответ выглядел
      // неполным, а после перезагрузки чата исчезал совсем и выпадал
      // из контекста следующего запроса.
      if (run.partialContent.trim()) {
        const partial = {
          id: uid(),
          chatId,
          role: 'assistant',
          content: run.partialContent,
          timestamp: Date.now(),
          model: this.agent.llm.model,
          durationMs: Math.round(performance.now() - requestStartedAt),
          interrupted: true,
        };
        await this.agent.db.put('messages', partial);
        const el = ensureMsgEl();
        if (el) {
          el.dataset.msgId = partial.id;
          el.insertAdjacentHTML('beforeend', this._msgFooter(partial));
        }
      }

      if (error.name === 'AbortError' && run.stopRequested) {
        // Сообщение об остановке уже показал stopAgent() — не дублируем.
      } else {
        const msg = error.name === 'AbortError'
          ? `Запрос прерван: превышен лимит времени на ответ (${L.maxTurnSeconds} с). ` +
            (run.partialContent.trim() ? 'Полученная часть ответа сохранена. ' : '') +
            'Лимит можно изменить в ⚙ Настройки → Ограничения.'
          : `Ошибка: ${error.message}`;
        const errContainer = dom();
        if (errContainer) {
          errContainer.insertAdjacentHTML('beforeend', `<div class="message system">❌ ${this._escHtml(msg)}</div>`);
          errContainer.scrollTop = errContainer.scrollHeight;
        }
      }
    } finally {
      clearTimeout(turnTimer);
      run.abortCtl = null;
      // Единственная точка снятия занятости для всей цепочки: срабатывает
      // на любом пути выхода корневого кадра, включая return из середины
      // цикла вызовов инструментов и любую необработанную ошибку.
      // Панель статуса и запись в this._chatRuns снимаются здесь же —
      // иначе «зависший» индикатор пережил бы ошибку или прерывание.
      if (depth === 0) this._endRun(chatId);
    }

    // Ход завершён (цепочка вызовов инструментов раскручена) — записываем
    // полное время обработки запроса пользователя: от отправки сообщения
    // до финального ответа, включая все промежуточные вызовы.
    if (run.turnUserMsgId && run.startedAt) {
      const msg = await this.agent.db.get('messages', run.turnUserMsgId);
      if (msg) {
        msg.turnDurationMs = Date.now() - run.startedAt;
        await this.agent.db.put('messages', msg);
        if (chatId === this.currentChatId) {
          const el = document.querySelector(`[data-msg-id="${run.turnUserMsgId}"] .msg-footer`);
          if (el) el.innerHTML = this._msgFooterInner(msg);
        }
      }
      run.turnUserMsgId = null;
    }

    if (chatId === this.currentChatId) this.updateChatToolbar();
  },


  // Разметка блока вызова инструмента с учётом выбранной детализации.
  // artifactId — если полный результат вынесен из переписки: показываем
  // кнопку просмотра, иначе пользователь видел бы только шапку и не мог
  // проверить, что именно получил агент.
  _renderToolCallBlock(name, argsRaw, resultStr, elapsedMs, isError, artifactId = null, subChatId = null) {
    const icon = isError ? '❌' : '🔧';
    const artifactBtn = artifactId
      ? `<div class="tool-artifact"><button class="btn btn-secondary btn-sm" data-artifact="${this._escHtml(artifactId)}">📄 Показать полный результат</button></div>`
      : '';
    const subBtn = subChatId
      ? `<div class="tool-artifact"><button class="btn btn-secondary btn-sm" data-subchat="${this._escHtml(subChatId)}">👁 Открыть переписку подзадачи</button></div>`
      : '';

    // ── Подзадача показывается по-своему ──
    // Её результат — не технический JSON, а связный текст, который
    // заменил собой всю работу: пользователь должен видеть именно его,
    // иначе самая содержательная часть хода выглядит как «{ok:true,…}».
    if (subChatId) {
      let parsed = null;
      try { parsed = JSON.parse(resultStr); } catch (_) {}
      if (parsed) {
        const head = parsed.ok
          ? `🤖 Подзадача выполнена — ${parsed.steps} шаг(ов), ${parsed.tool_calls} вызов(ов) инструментов`
          : `🤖 Подзадача не завершена: ${this._escHtml(parsed.error || '')}`;
        const body = parsed.result || '';
        return `
          <div><strong>${head}</strong> <span class="tool-meta">${this._fmtDuration(parsed.elapsed_ms || elapsedMs)}</span></div>
          <div class="tool-section">${this._escHtml(parsed.goal || '')}</div>
          ${body ? `<div class="subtask-result">${renderMarkdown(body)}</div>` : ''}
          ${subBtn}`;
      }
    }
    if (this.toolVerbosity === 'detailed') {
      let argsPretty = argsRaw;
      try { argsPretty = JSON.stringify(JSON.parse(argsRaw), null, 2); } catch (_) {}
      let resPretty = resultStr;
      try { resPretty = JSON.stringify(JSON.parse(resultStr), null, 2); } catch (_) {}
      return `
        <div><strong>${icon} ${this._escHtml(name)}</strong> <span class="tool-meta">${elapsedMs} мс</span></div>
        <div class="tool-section">Аргументы:</div>
        <pre class="tool-pre">${this._escHtml(argsPretty)}</pre>
        <div class="tool-section">Результат:</div>
        <pre class="tool-pre">${this._escHtml(resPretty)}</pre>
        ${artifactBtn}${subBtn}
      `;
    }
    // compact
    return `<div class="tool-compact">${icon} ${this._escHtml(name)} → ` +
           `${this._escHtml(resultStr.substring(0, 300))}${resultStr.length > 300 ? '…' : ''}</div>` +
           `<span class="tool-meta">${elapsedMs} мс</span>` + artifactBtn + subBtn;
  },


  // Полный текст артефакта по кнопке из блока вызова инструмента.
  // Показываем окном по 100 000 символов: в модалку большего смысла не
  // помещать, а листать длинный текст удобнее кнопкой «дальше».
  async showArtifact(artifactId, offset = 0) {
    const rec = await this.agent.artifacts?.get(artifactId);
    if (!rec) {
      this._showModal('📄 Результат недоступен',
        '<p style="font-size:13px;">Полный результат не найден: возможно, чат с ним удалён.</p>');
      return;
    }
    const PAGE = 100000;
    const chunk = rec.text.slice(offset, offset + PAGE);
    const end = offset + chunk.length;
    const hasMore = end < rec.chars;
    const btnId = 'af_more_' + uid();
    this._showModal(`📄 ${this._escHtml(rec.toolName)} — полный результат`, `
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">
        ${rec.chars.toLocaleString('ru-RU')} символов, ${rec.lines.toLocaleString('ru-RU')} строк · ${this._escHtml(rec.outline)}<br>
        Показано ${offset.toLocaleString('ru-RU')}–${end.toLocaleString('ru-RU')}. Идентификатор: ${this._escHtml(rec.id)}
      </div>
      <pre class="tool-pre" style="max-height:60vh;">${this._escHtml(chunk)}</pre>
      ${hasMore ? `<button class="btn btn-secondary btn-sm" id="${btnId}" style="margin-top:8px;">▼ Показать следующие ${PAGE.toLocaleString('ru-RU')} символов</button>` : ''}
    `, null, null, { wide: true });
    if (hasMore) {
      // Следующее окно просто заменяет текущее: _showModal переписывает
      // контейнер #modals целиком, отдельно закрывать нечего.
      document.getElementById(btnId)?.addEventListener('click', () => this.showArtifact(artifactId, end));
    }
  },


  // Останавливает ход просматриваемого сейчас чата. Кнопка «⏹» видна
  // только тогда, когда у this.currentChatId есть активный run (см.
  // _setBusy/_endRun), так что здесь всегда именно тот чат, что на экране.
  stopAgent() {
    const chatId = this.currentChatId;
    const run = chatId && this._chatRuns.get(chatId);
    if (!run) return;
    run.stopRequested = true;
    try { run.abortCtl?.abort(); } catch (_) {}
    // Ход мог остановиться внутри подзадачи — её запрос к модели ведётся
    // своим контроллером, и без этого «⏹» не прервал бы саму подзадачу,
    // а лишь запретил бы следующий шаг родителя после её завершения.
    try { run.subtaskAbort?.abort(); } catch (_) {}

    // Прячем кнопку сразу: команда принята, повторные нажатия смысла не
    // имеют. Кнопку «Отправить» при этом НЕ разблокируем — цепочка ещё
    // раскручивается (может доигрываться начатый вызов инструмента),
    // её включит _endRun() в конце _generateResponse.
    const stop = document.getElementById('stop-btn');
    if (stop) stop.hidden = true;

    // Уже запущенный вызов инструмента прервать нельзя — он доигрывает до
    // своего таймаута. Показываем это явно, иначе пауза после нажатия
    // выглядит как зависание.
    this._showStatus(chatId, 'Останавливаю…', 'жду завершения текущей операции');

    const container = document.getElementById('chat-messages');
    container.insertAdjacentHTML('beforeend',
      '<div class="message system">⏹ Работа агента прервана пользователем.</div>');
    container.scrollTop = container.scrollHeight;
  },


  // ── Прерывание работы агента пользователем ──
  // Работает на двух уровнях: abort() рвёт текущий HTTP-запрос к модели
  // (в том числе посреди стриминга), а флаг _stopRequested проверяется
  // между шагами цепочки — чтобы не начать следующую итерацию или
  // следующий вызов инструмента. Уже запущенный вызов инструмента
  // дождётся своего таймаута: прервать чужой код на полпути нельзя.
  // Копирует содержимое блока кода в буфер обмена.
  async _copyCodeBlock(btn) {
    const codeEl = btn.closest('.code-block')?.querySelector('code');
    if (!codeEl) return;
    // textContent, а не innerHTML: нужен исходный текст без сущностей
    // (&lt; и т.п.) и без разметки подсветки.
    const text = codeEl.textContent;

    const done = (ok) => {
      const original = btn.textContent;
      btn.textContent = ok ? '✓ Скопировано' : '✗ Не удалось';
      btn.classList.toggle('copied', ok);
      setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1500);
    };

    try {
      // navigator.clipboard требует защищённого контекста (HTTPS/localhost).
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return done(true);
      }
      // Запасной путь для http:// и старых браузеров.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(ok);
    } catch (e) {
      done(false);
    }
  },


  // ── Голосовой ввод (Web Speech API) ──
  // Поддержка сильно зависит от браузера: в Chrome/Edge работает
  // (распознавание идёт на серверах Google), в Firefox по умолчанию нет.
  // Требует HTTPS (или localhost) и разрешения на микрофон.
  toggleVoiceInput() {
    const btn = document.getElementById('voice-btn');
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SR) {
      alert('Голосовой ввод не поддерживается этим браузером.\nРаботает в Chrome и Edge; страница должна быть открыта по HTTPS или с localhost.');
      return;
    }

    if (this.isListening) {
      this.recognition?.stop();
      return;
    }

    const input = document.getElementById('chat-input');
    const rec = new SR();
    rec.lang = 'ru-RU';
    rec.interimResults = true;
    rec.continuous = false;

    // Текст, который был в поле до начала диктовки — распознанное
    // дописываем к нему, а не затираем пользовательский ввод.
    const baseText = input.value;

    rec.onstart = () => {
      this.isListening = true;
      btn.classList.add('listening');
      btn.title = 'Идёт запись — нажмите, чтобы остановить';
    };

    rec.onresult = (e) => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
      }
      input.value = (baseText ? baseText + ' ' : '') + text;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    };

    rec.onerror = (e) => {
      const reasons = {
        'not-allowed': 'Доступ к микрофону запрещён. Разрешите его в настройках сайта.',
        'no-speech': 'Речь не распознана — попробуйте ещё раз.',
        'network': 'Ошибка сети при распознавании речи.',
        'service-not-allowed': 'Сервис распознавания недоступен (нужен HTTPS).',
      };
      const msg = reasons[e.error] || ('Ошибка распознавания: ' + e.error);
      const container = document.getElementById('chat-messages');
      container.insertAdjacentHTML('beforeend',
        `<div class="message system">🎙 ${this._escHtml(msg)}</div>`);
      container.scrollTop = container.scrollHeight;
    };

    rec.onend = () => {
      this.isListening = false;
      btn.classList.remove('listening');
      btn.title = 'Голосовой ввод';
      input.focus();
    };

    this.recognition = rec;
    try {
      rec.start();
    } catch (e) {
      this.isListening = false;
      btn.classList.remove('listening');
    }
  },


  // Подставляет содержимое файлов в текст по плейсхолдерам {{file:путь}}.
  // Так на файл можно сослаться из промпта или навыка, не копируя текст.
  async _expandFileRefs(text) {
    const re = /\{\{file:([^}]+)\}\}/g;
    const refs = [...String(text).matchAll(re)];
    if (!refs.length) return text;

    let out = text;
    for (const m of refs) {
      const ref = m[1].trim();
      const record = await this.agent.files.resolve(ref);
      if (!record) {
        out = out.replaceAll(m[0], `[файл «${ref}» не найден]`);
        continue;
      }
      const res = await this.agent.files.read(record.id, { maxBytes: 256 * 1024 });
      out = res.error
        ? out.replaceAll(m[0], `[файл «${record.name}» недоступен: ${res.error}]`)
        : out.replaceAll(m[0], "\n```\n" + res.text + "\n```\n");
    }
    return out;
  },

  async usePrompt(promptId) {
    const prompt = await this.agent.db.get('prompts', promptId);
    if (!prompt) return;

    let content = await this._expandFileRefs(prompt.content);

    const vars = content.match(/\{\{(\w+)\}\}/g);
    if (vars && vars.length > 0) {
      this._showModal('Заполните переменные', `
        <p style="color:var(--text-secondary);font-size:13px;margin-bottom:12px;">${this._escHtml(prompt.title)}</p>
        ${vars.map(v => {
          const name = v.replace(/\{\{|\}\}/g, '');
          return `<div class="form-group"><label>${name}</label><textarea id="var_${name}" rows="2"></textarea></div>`;
        }).join('')}
      `, async () => {
        for (const v of vars) {
          const name = v.replace(/\{\{|\}\}/g, '');
          const val = document.getElementById(`var_${name}`)?.value || '';
          content = content.replaceAll(v, val);
        }
        this.switchTab('chat');
        if (!this.currentChatId) await this.newChat();
        document.getElementById('chat-input').value = content;
      });
    } else {
      this.switchTab('chat');
      if (!this.currentChatId) await this.newChat();
      document.getElementById('chat-input').value = content;
    }
  }

});
