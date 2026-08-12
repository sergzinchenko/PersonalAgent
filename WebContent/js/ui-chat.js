// ============================================================
//  UI CHAT — чат: сообщения, генерация ответа, вызовы инструментов
// ============================================================
//
// Ядро диалога: отправка сообщения, цикл tool-calling с лимитами, прерывание, копирование кода, голосовой ввод.

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

    this.updateChatToolbar();
    this.refreshSidebar();
    this.updateModelDisplay();
  },


  async deleteChat(chatId) {
    await this.agent.db.delete('chats', chatId);
    const msgs = await this.agent.db.getAllByIndex('messages', 'chatId', chatId);
    for (const m of msgs) await this.agent.db.delete('messages', m.id);
    // Техническая статистика живёт в отдельном store — чистим и её,
    // иначе останется «сирота» с токенами удалённого чата.
    await this.agent.db.delete('chat_stats', chatId);

    if (this.currentChatId === chatId) {
      this.currentChatId = null;
      document.getElementById('chat-messages').innerHTML = '<div class="empty-state"><div class="icon">💬</div><div class="text">Выберите чат</div></div>';
    }
    this.refreshSidebar();
  },


  _renderMessage(msg) {
    if (msg.role === 'tool') {
      return `<div class="message tool-call">🔧 Tool: ${this._escHtml(msg.name)} → ${this._escHtml(typeof msg.content === 'string' ? msg.content.substring(0, 200) : JSON.stringify(msg.content).substring(0, 200))}</div>`;
    }
    if (msg.role === 'system') {
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
    if (this.isStreaming) return;
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    if (!this.agent.llm.isConfigured()) {
      this.showSettingsModal();
      return;
    }

    if (!this.currentChatId) await this.newChat();

    input.value = '';
    input.style.height = 'auto';

    const chat = await this.agent.db.get('chats', this.currentChatId);
    const container = document.getElementById('chat-messages');
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    // ── Смена модели фиксируется в истории ──
    // Модель можно переключить прямо в чате; без отметки в переписке потом
    // невозможно понять, где проходит граница между ответами разных моделей.
    const currentModel = this.agent.llm.model;
    if (currentModel && chat.model && chat.model !== currentModel) {
      const switchMsg = {
        id: uid(),
        chatId: this.currentChatId,
        role: 'system',
        kind: 'model-switch',
        content: `Модель изменена: ${chat.model} → ${currentModel}`,
        from: chat.model,
        to: currentModel,
        timestamp: Date.now(),
      };
      await this.agent.db.put('messages', switchMsg);
      container.insertAdjacentHTML('beforeend', this._renderMessage(switchMsg));
    }
    chat.model = currentModel;

    const userMsg = {
      id: uid(),
      chatId: this.currentChatId,
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

    container.insertAdjacentHTML('beforeend', this._renderMessage(userMsg));
    container.scrollTop = container.scrollHeight;

    // Новый ход пользователя — обнуляем бюджет времени и счётчик вызовов,
    // которые действуют на всю цепочку tool_calls этого хода.
    this._turnStartedAt = Date.now();
    this._turnToolCalls = 0;
    this._stopRequested = false;
    // Сообщение пользователя, к которому будет привязано общее время хода
    // (пункт «тайминг запроса пользователя»): полный цикл от отправки до
    // финального ответа, включая все вызовы инструментов.
    this._turnUserMsgId = userMsg.id;

    await this._generateResponse();
  },


  // Останавливает ход и сообщает причину. Возвращает true — значит выше
  // по стеку нужно прекратить цепочку tool-calling.
  _stopTurn(container, reason) {
    container.insertAdjacentHTML('beforeend',
      `<div class="message system">⚠️ ${this._escHtml(reason)}</div>`);
    container.scrollTop = container.scrollHeight;
    this._setBusy(false);
  },


  async _generateResponse(depth = 0) {
    const container = document.getElementById('chat-messages');
    const L = this.limits;

    // ── Прерывание пользователем: проверяем между шагами цепочки ──
    if (this._stopRequested) {
      this._setBusy(false);
      return;
    }

    // ── Лимит 1: количество итераций tool-calling ──
    if (L.maxToolSteps > 0 && depth >= L.maxToolSteps) {
      this._stopTurn(container, `Достигнут лимит итераций с вызовом инструментов (${L.maxToolSteps}). Остановлено, чтобы не уйти в бесконечный цикл. Уточните запрос или продолжите вручную.`);
      return;
    }

    // ── Лимит 2: общий бюджет времени на ход ──
    if (L.maxTurnSeconds > 0 && this._turnStartedAt) {
      const elapsedSec = (Date.now() - this._turnStartedAt) / 1000;
      if (elapsedSec >= L.maxTurnSeconds) {
        this._stopTurn(container, `Превышен лимит времени на ответ (${L.maxTurnSeconds} с). Цепочка вызовов инструментов остановлена.`);
        return;
      }
    }

    this._setBusy(true);

    container.insertAdjacentHTML('beforeend', '<div class="typing-indicator" id="typing"><span></span><span></span><span></span></div>');
    container.scrollTop = container.scrollHeight;

    // AbortController прерывает сам HTTP-запрос к LLM — и по таймауту хода,
    // и по кнопке «⏹» (stopAgent() вызывает abort() через this._abortCtl).
    const abortCtl = new AbortController();
    this._abortCtl = abortCtl;
    let turnTimer = null;
    if (L.maxTurnSeconds > 0 && this._turnStartedAt) {
      const remainingMs = L.maxTurnSeconds * 1000 - (Date.now() - this._turnStartedAt);
      turnTimer = setTimeout(() => abortCtl.abort(), Math.max(0, remainingMs));
    }

    try {
      const allMsgs = await this.agent.db.getAllByIndex('messages', 'chatId', this.currentChatId);
      allMsgs.sort((a, b) => a.timestamp - b.timestamp);

      const systemPrompt = await this.agent.skills.buildSystemPrompt();
      const apiMessages = [{ role: 'system', content: systemPrompt }];

      for (const m of allMsgs) {
        // Служебные отметки (например, смена модели) — часть истории для
        // пользователя, но не часть диалога: в API их слать не нужно,
        // иначе они попадут вторым system-сообщением и собьют модель.
        if (m.kind === 'model-switch') continue;
        if (m.role === 'tool') {
          apiMessages.push({ role: 'tool', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content), tool_call_id: m.tool_call_id, name: m.name });
        } else if (m.role === 'assistant' && m.tool_calls) {
          apiMessages.push({ role: 'assistant', content: m.content || null, tool_calls: m.tool_calls });
        } else {
          apiMessages.push({ role: m.role, content: m.content });
        }
      }

      const tools = await this.agent.tools.getEnabledToolsForAPI();

      document.getElementById('typing')?.remove();

      const msgEl = document.createElement('div');
      msgEl.className = 'message assistant';
      container.appendChild(msgEl);

      let fullContent = '';

      // Засекаем время именно вокруг обращения к модели: это то, что
      // показывается в чате как длительность ответа.
      const requestStartedAt = performance.now();

      const result = await this.agent.llm.chat(apiMessages, {
        tools: tools.length > 0 ? tools : null,
        stream: true,
        signal: abortCtl.signal,
        onChunk: (chunk) => {
          fullContent += chunk;
          msgEl.innerHTML = renderMarkdown(fullContent);
          container.scrollTop = container.scrollHeight;
        },
      });

      // Учёт токенов. Многие провайдеры игнорируют stream_options и не
      // присылают usage при stream:true — тогда считаем приблизительно
      // сами, иначе счётчик навсегда остался бы нулевым.
      let contextTokens;
      if (result.usage) {
        await this._recordUsage(result.usage);
        // prompt_tokens = ровно то, что модель приняла на вход,
        // то есть фактический размер контекста этого запроса.
        contextTokens = result.usage.prompt_tokens || 0;
      } else {
        const est = this._estimateUsage(apiMessages, result);
        await this._recordUsage(est, true);
        contextTokens = est.prompt_tokens;
      }
      await this._recordContextSize(contextTokens, !result.usage);
      this.updateChatToolbar();
      await this._checkContextThresholds(container, contextTokens);

      if (result.tool_calls && result.tool_calls.length > 0) {
        const assistantMsg = {
          id: uid(),
          chatId: this.currentChatId,
          role: 'assistant',
          content: result.content || '',
          tool_calls: result.tool_calls,
          timestamp: Date.now(),
          // Модель и время генерации фиксируем в самой истории: модель
          // можно сменить прямо в чате, и без этого потом не понять,
          // какой именно ответ чем сформирован.
          model: this.agent.llm.model,
          durationMs: Math.round(performance.now() - requestStartedAt),
        };
        await this.agent.db.put('messages', assistantMsg);

        for (const tc of result.tool_calls) {
          if (tc === undefined) {
        		    continue; // Пропускаем текущую итерацию, если tc undefined - из-за null в списках от некоторых LLM
          }

          // ── Прерывание пользователем ──
          if (this._stopRequested) {
            clearTimeout(turnTimer);
            this._setBusy(false);
            return;
          }

          // ── Лимит 3: суммарное число вызовов за ход ──
          if (L.maxToolCallsPerTurn > 0 && this._turnToolCalls >= L.maxToolCallsPerTurn) {
            clearTimeout(turnTimer);
            this._stopTurn(container, `Достигнут лимит вызовов инструментов за один ответ (${L.maxToolCallsPerTurn}).`);
            return;
          }
          // ── Лимит 2 (повторная проверка между вызовами) ──
          if (L.maxTurnSeconds > 0 && this._turnStartedAt &&
              (Date.now() - this._turnStartedAt) / 1000 >= L.maxTurnSeconds) {
            clearTimeout(turnTimer);
            this._stopTurn(container, `Превышен лимит времени на ответ (${L.maxTurnSeconds} с).`);
            return;
          }
          this._turnToolCalls++;

          const toolResultDiv = this.toolVerbosity === 'hidden' ? null : document.createElement('div');
          if (toolResultDiv) {
            toolResultDiv.className = 'message tool-call';
            toolResultDiv.textContent = `🔧 Вызываю: ${tc.function.name}...`;
            container.appendChild(toolResultDiv);
            container.scrollTop = container.scrollHeight;
          }

          const startedAt = performance.now();
          const toolResult = await this.agent.tools.executeTool(
            tc.function.name,
            tc.function.arguments,
            { timeoutMs: (L.toolTimeoutSeconds || 0) * 1000 }
          );
          const elapsedMs = Math.round(performance.now() - startedAt);
          const resultStr = JSON.stringify(toolResult);
          const isError = !!(toolResult && toolResult.error);

          await this._recordToolCall(tc.function.name, elapsedMs, isError);
          this.updateChatToolbar();

          if (toolResultDiv) {
            toolResultDiv.innerHTML = this._renderToolCallBlock(
              tc.function.name, tc.function.arguments, resultStr, elapsedMs, isError
            );
            container.scrollTop = container.scrollHeight;
          }

          const toolMsg = {
            id: uid(),
            chatId: this.currentChatId,
            role: 'tool',
            content: resultStr,
            tool_call_id: tc.id,
            name: tc.function.name,
            timestamp: Date.now(),
            durationMs: elapsedMs,
            isError,
          };
          await this.agent.db.put('messages', toolMsg);
        }

        clearTimeout(turnTimer);
        this.isStreaming = false;
        document.getElementById('send-btn').disabled = false;
        await this._generateResponse(depth + 1);
        return;
      }

      const assistantMsg = {
        id: uid(),
        chatId: this.currentChatId,
        role: 'assistant',
        content: result.content,
        timestamp: Date.now(),
        model: this.agent.llm.model,
        durationMs: Math.round(performance.now() - requestStartedAt),
      };
      await this.agent.db.put('messages', assistantMsg);

      // Элемент ответа уже отрисован стримингом — дописываем подпись
      // (время, модель, длительность), не перерисовывая содержимое.
      msgEl.insertAdjacentHTML('beforeend', this._msgFooter(assistantMsg));
      container.scrollTop = container.scrollHeight;

    } catch (error) {
      document.getElementById('typing')?.remove();
      if (error.name === 'AbortError' && this._stopRequested) {
        // Сообщение об остановке уже показал stopAgent() — не дублируем.
      } else {
        const msg = error.name === 'AbortError'
          ? `Запрос прерван: превышен лимит времени на ответ (${L.maxTurnSeconds} с).`
          : `Ошибка: ${error.message}`;
        container.insertAdjacentHTML('beforeend', `<div class="message system">❌ ${this._escHtml(msg)}</div>`);
        container.scrollTop = container.scrollHeight;
      }
    } finally {
      clearTimeout(turnTimer);
      this._abortCtl = null;
    }

    // Ход завершён (цепочка вызовов инструментов раскручена) — записываем
    // полное время обработки запроса пользователя: от отправки сообщения
    // до финального ответа, включая все промежуточные вызовы.
    if (this._turnUserMsgId && this._turnStartedAt) {
      const msg = await this.agent.db.get('messages', this._turnUserMsgId);
      if (msg) {
        msg.turnDurationMs = Date.now() - this._turnStartedAt;
        await this.agent.db.put('messages', msg);
        const el = document.querySelector(`[data-msg-id="${this._turnUserMsgId}"] .msg-footer`);
        if (el) el.innerHTML = this._msgFooterInner(msg);
      }
      this._turnUserMsgId = null;
    }

    this._setBusy(false);
    this.updateChatToolbar();
  },


  // Разметка блока вызова инструмента с учётом выбранной детализации.
  _renderToolCallBlock(name, argsRaw, resultStr, elapsedMs, isError) {
    const icon = isError ? '❌' : '🔧';
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
      `;
    }
    // compact
    return `<div class="tool-compact">${icon} ${this._escHtml(name)} → ` +
           `${this._escHtml(resultStr.substring(0, 300))}${resultStr.length > 300 ? '…' : ''}</div>` +
           `<span class="tool-meta">${elapsedMs} мс</span>`;
  },


  stopAgent() {
    if (!this.isStreaming) return;
    this._stopRequested = true;
    try { this._abortCtl?.abort(); } catch (_) {}

    // Прячем кнопку сразу: команда принята, повторные нажатия смысла не
    // имеют. Кнопку «Отправить» при этом НЕ разблокируем — цепочка ещё
    // раскручивается (может доигрываться начатый вызов инструмента),
    // её включит _setBusy(false) в конце _generateResponse.
    const stop = document.getElementById('stop-btn');
    if (stop) stop.hidden = true;

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


  async usePrompt(promptId) {
    const prompt = await this.agent.db.get('prompts', promptId);
    if (!prompt) return;

    let content = prompt.content;

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
