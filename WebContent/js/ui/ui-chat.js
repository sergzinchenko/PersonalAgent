// ============================================================
//  UI CHAT — чат: сообщения, генерация ответа, вызовы инструментов
// ============================================================
//
// Ядро диалога: отправка сообщения, цикл tool-calling с лимитами, прерывание, копирование кода, голосовой ввод.
//
// PLAN_NUDGE_DEPTH — с какой итерации подряд идущих вызовов инструментов
// работа считается многошаговой и требует плана (см. _generateResponse).
// Два — это ещё ответ с уточнением, три — уже работа: пользователь ждёт
// и не знает, чего именно.
const PLAN_NUDGE_DEPTH = 2;

// Инструменты чтения артефактов: их собственный результат в артефакт НЕ
// выносится, даже если он большой. Иначе чтение куска артефакта плодило
// бы новый артефакт, и модель ходила бы по матрёшке вместо данных.
const ARTIFACT_TOOLS = new Set(['artifact_read', 'artifact_grep', 'artifact_list']);

// Инструменты, которыми агент ведёт план задачи. Их вызовы показываются
// одной строкой при ЛЮБОЙ выбранной детализации: содержимое плана целиком
// видно в панели справа, а подробные блоки «начал шаг 3» / «закрыл шаг 3»
// на длинной задаче вытесняли из ленты сам разговор. Режим «Скрывать»
// это правило не отменяет — скрыто значит скрыто.
const PLAN_TOOLS = new Set(['task_plan']);

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
      container.innerHTML = this._renderMessageList(messages);
      container.scrollTop = container.scrollHeight;
    }

    // Переписки подзадач в списке чатов не показываются, поэтому у них
    // нужен собственный выход обратно — иначе, открыв подзадачу, вернуться
    // в основной разговор можно было бы только через другой чат.
    await this._renderSubtaskBanner(chatId, container);

    // Ход в этом чате мог оборваться в прошлый раз (закрытая вкладка,
    // сбой) — предложим продолжить с места остановки.
    await this.renderResumeOffer(chatId);

    // ── Восстановление визуализации, если чат всё ещё генерирует ответ ──
    // Пока мы смотрели на другой чат, этот мог продолжать работать в
    // фоне: сообщения, уже завершённые к этому моменту, только что
    // пришли из БД выше, а вот текущий незаконченный ответ и индикатор
    // хода нигде, кроме run-объекта, не хранятся — достаём их оттуда.
    const run = this._chatRuns.get(chatId);
    if (run) {
      // Лента вызовов живёт в run, а не в DOM, — значит, при возврате
      // в чат её надо нарисовать заново, иначе работа выглядела бы
      // остановившейся ровно из-за того, что на неё посмотрели.
      this._renderToolTrack(chatId);
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
    } else {
      // Строка состояния живёт вне ленты и не стирается вместе с ней:
      // без этого индикатор чужого хода остался бы висеть над чатом,
      // в котором ничего не происходит.
      this._hideStatusBar();
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


  // ── Переименование чата ──
  // Заголовок чата до сих пор ставился только автоматически — по первому
  // сообщению. Для короткого разговора это нормально, но список из
  // двадцати чатов, названных первой фразой, перестаёт быть списком:
  // «Привет, помоги разобраться…» ничем не отличается от соседнего такого же.
  async renameChat(chatId) {
    const chat = await this.agent.db.get('chats', chatId);
    if (!chat) return null;

    const title = await this._prompt('Переименование чата', chat.title || '', { label: 'Название чата' });
    if (title === null) return null;                 // отмена — не трогаем
    const next = String(title).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!next || next === chat.title) return null;

    chat.title = next;
    // Отметка «название задал человек» уже используется автозаголовком:
    // без неё следующее сообщение в чате переписало бы название обратно
    // на первую фразу (см. sendMessage).
    chat.titleSetByUser = true;
    await this.agent.db.put('chats', chat);
    await this.refreshSidebar();
    return next;
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


  // ── Лента с разделителями дней ──
  // Раньше под сообщением стояло только время «14:32», и в чате, который
  // ведут неделю, это время ничего не значило: вчерашний ответ выглядел
  // так же, как сегодняшний. Дата в каждой подписи — лишний шум, поэтому
  // она стоит один раз на день, отдельной строкой, как в мессенджерах.
  _renderMessageList(messages) {
    let lastDay = null;
    const out = [];
    for (const m of messages) {
      const day = m.timestamp ? this._dayKey(m.timestamp) : null;
      if (day && day !== lastDay) {
        out.push(`<div class="day-divider"><span>${this._escHtml(this._dayLabel(m.timestamp))}</span></div>`);
        lastDay = day;
      }
      out.push(this._renderMessage(m));
    }
    return out.join('');
  },

  _dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  },

  // «Сегодня», «Вчера» или дата словами. Для давних сообщений — с годом:
  // «12 сентября» без года в переписке двухлетней давности обманчиво.
  _dayLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const key = this._dayKey(ts);
    if (key === this._dayKey(now.getTime())) return 'Сегодня';
    if (key === this._dayKey(now.getTime() - 86400000)) return 'Вчера';
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString('ru-RU', sameYear
      ? { day: 'numeric', month: 'long', weekday: 'short' }
      : { day: 'numeric', month: 'long', year: 'numeric' });
  },

  // Полные дата и время — в подсказку: точное значение нужно редко, но
  // когда нужно, искать его больше негде.
  _fullStamp(ts) {
    return new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
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
      // Ведение плана и после перезагрузки чата остаётся одной строкой.
      // Подпись взята из самой записи: аргументы вызова в истории не
      // хранятся, а «сверился с планом» вместо «закрыл шаг 3» — это уже
      // не краткость, а неправда.
      if (msg.planLabel) {
        return `<div class="message tool-call tool-plan"><div class="tool-compact">` +
               `${msg.isError ? '❌' : '🗂'} ${this._escHtml(msg.planLabel)}${this._toolStamp(msg)}</div></div>`;
      }
      // Краткий вид после перезагрузки: имя, параметры (подпись сохранена
      // при вызове) и время. Результат — кнопкой, если он был вынесен.
      const args = msg.argsLabel ? `<span class="tool-args">${this._escHtml(msg.argsLabel)}</span>` : '';
      return `<div class="message tool-call">${msg.isError ? '❌' : '🔧'} ${this._escHtml(msg.name)}${args}` +
             `${args ? '' : ' → ' + body}${more}${this._toolStamp(msg)}</div>`;
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

  // Время вызова инструмента — мелко, в конце строки. Без него длинный
  // ход выглядит как один момент времени: видно, что вызовов было
  // двадцать, но не видно, растянулись они на минуту или на полчаса.
  _toolStamp(msg) {
    if (!msg.timestamp) return '';
    const t = new Date(msg.timestamp).toLocaleTimeString('ru-RU',
      { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return ` <span class="msg-time tool-stamp" title="${this._escHtml(this._fullStamp(msg.timestamp))}">${t}</span>`;
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
      // Секунды важнее, чем кажется: на цепочке из инструментов между
      // двумя записями проходит меньше минуты, и без них порядок
      // событий по подписям не восстановить. Полная дата — в подсказке.
      const t = new Date(msg.timestamp).toLocaleTimeString('ru-RU',
        { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      parts.push(`<span class="msg-time" title="${this._escHtml(this._fullStamp(msg.timestamp))}">${t}</span>`);
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
    if (await this._blockedByOtherChat(chatId)) return;

    input.value = '';
    input.style.height = 'auto';

    // Прошлый ход мог оборваться посреди цепочки инструментов и оставить
    // вызов без результата. Такой запрос провайдер отвергает целиком —
    // чат оказался бы нерабочим навсегда, поэтому чиним перед отправкой.
    document.getElementById('resume-offer')?.remove();
    await this.repairDanglingToolCalls(chatId);

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
      // ── Лента вызовов инструментов ──
      // Что модель собралась вызвать на этом шаге, что из этого уже
      // выполнено и сколько заняло. Живёт в run, а не в DOM: чат могут
      // закрыть и открыть посреди хода, а ход от этого не прерывается.
      track: [],
      trackStep: 0,
      // ── Мягкая пауза ──
      // paused — «замри перед следующим действием»; pausedAt и pausedMs
      // нужны, чтобы время паузы не съедало бюджет хода: человек думает,
      // а не агент работает. resumeWaiters держит тех, кто ждёт снятия
      // паузы (цикл хода и цикл подзадачи).
      paused: false,
      pausedAt: 0,
      pausedMs: 0,
      resumeWaiters: [],
      stopRequested: false,
      abortCtl: null,
      // Контроллер запроса подзадачи, пока она выполняется: «⏹» должен
      // рвать и его, а не только запрос родительского хода.
      subtaskAbort: null,
      statusTimer: null,
    };
    this._chatRuns.set(chatId, run);
    // Отметка «панель с лентой закрыта крестиком» относилась к прошлой
    // работе: новый ход показывает её снова.
    if (this._planPanelDismissed === 'track') this._planPanelDismissed = null;
    // Журнал хода: с этого момента обрыв (закрытая вкладка, сбой,
    // перезагрузка) будет виден при следующем запуске, и работу можно
    // будет продолжить с места остановки — см. ui-resume.js.
    await this._runJournalPut(chatId, {
      status: 'running', startedAt: run.startedAt, stage: 'начало хода',
      turnUserMsgId: userMsg.id, partialContent: '', toolCalls: 0,
      model: this.agent.llm.model,
    });
    // Пока ход идёт, запись регулярно обновляется — иначе другая вкладка
    // приняла бы его за оборвавшийся (см. ui-resume.js).
    this._startHeartbeat(chatId);
    this._setBusy(this._chatRuns.has(this.currentChatId));
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
        // Тем же тиком — обратный отсчёт текущего вызова инструмента:
        // заводить второй секундный таймер ради соседней строки незачем.
        this._updateToolCountdown(run);
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
    // Хозяин строки — область ввода (#agent-status-host в index.html), а
    // не лента сообщений. В ленте строка была последним элементом и
    // уезжала вверх вместе с растущим ответом: на самом долгом ходе, где
    // она и нужна, пользователь не видел ни стадии, ни времени и не мог
    // отличить работу от зависания.
    const host = document.getElementById('agent-status-host');
    if (!host) return;
    let el = document.getElementById('agent-status');
    if (!el) {
      host.innerHTML = `
        <div class="agent-status" id="agent-status">
          <span class="status-spinner"></span>
          <span class="status-text"></span>
          <span class="status-detail"></span>
          <span class="status-timer"></span>
        </div>`;
      el = document.getElementById('agent-status');
    }
    host.hidden = false;
    if (!el) return;
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
  // ── Лента вызовов инструментов ──
  //
  // ЗАЧЕМ. Вызовы инструментов — самая долгая и самая непрозрачная часть
  // ответа. По умолчанию они больше не пишутся в переписку (скрытый
  // режим — см. toolVerbosity): переписка для разговора, а не для
  // протокола работы. Но «ничего не показывать» и «не показывать в
  // переписке» — разные вещи: пока агент работает, пользователь должен
  // видеть, ЧТО именно выполняется, сколько уже сделано и не завис ли
  // текущий вызов. Для этого и лента.
  //
  // ТРИ УРОВНЯ ПОДРОБНОСТИ — это одна и та же лента, свёрнутая по-разному:
  //   hidden   — одна строка: сколько вызовов сделано и сколько в шаге;
  //   compact  — сами вызовы: отметка, имя, время каждого;
  //   detailed — то же плюс аргументы и ответ в раскрывающейся строке.
  //
  // ГДЕ ОНА ЖИВЁТ. Если открыта панель плана — внутри текущего шага
  // плана: вызовы и есть то, из чего шаг состоит, и разносить их по
  // разным углам экрана значит заставлять сопоставлять их глазами.
  // Панели плана нет (или план скрыт) — над полем ввода, рядом со
  // строкой состояния.
  _renderToolTrack(chatId) {
    if (chatId !== this.currentChatId) return;
    const run = this._chatRuns.get(chatId);
    const host = document.getElementById('tool-track-host');
    if (!host) return;

    // ── Куда рисовать ──
    // Мест в панели столько, сколько шагов: у каждого своё, с номером.
    // Плюс одно без номера — под вызовы вне шагов плана (или когда плана
    // нет вовсе). Место внутри шага ищем ВСЕГДА, даже когда рисовать
    // собираемся не туда: иначе оставленное там содержимое живёт вечно.
    //
    // Глубина панели — своя настройка (panelDepth), не связанная с тем,
    // что пишется в переписку: переписку держат чистой, а за работой при
    // этом смотрят подробно. 'off' — панели хода нет, остаётся строка
    // счёта над полем ввода.
    const slots = Array.from(document.querySelectorAll('#plan-panel:not([hidden]) .plan-track'));
    const usePanel = (this.panelDepth || 'tools') !== 'off';

    // Панель могла быть ещё закрыта: первый вызов инструмента — это и
    // есть повод её открыть. Открывает её renderPlanPanel (он знает про
    // план, крестик и заголовок), а он в конце позовёт нас обратно —
    // уже с готовыми местами. Флаг против повторного входа: без него
    // получилась бы рекурсия на каждый вызов инструмента.
    if (usePanel && !slots.length && run && run.track.length && !this._trackPanelPending) {
      this._trackPanelPending = true;
      Promise.resolve(this.renderPlanPanel?.())
        .finally(() => { this._trackPanelPending = false; });
      return;
    }

    if (!run || !run.track.length) {
      host.hidden = true;
      host.innerHTML = '';
      slots.forEach(el => { el.innerHTML = ''; });
      return;
    }

    if (usePanel && slots.length) {
      // ── Каждому шагу — его собственные вызовы ──
      // Общий список под текущим шагом врал бы дважды: приписывал шагу
      // чужую работу и терял связь «что делалось, когда делали это».
      for (const el of slots) {
        const n = el.dataset.step ? parseInt(el.dataset.step, 10) : null;
        const mine = run.track.filter(t => (t.planStep ?? null) === n);
        el.innerHTML = mine.length ? this._toolTrackHtml(run, mine) : '';
        if (mine.length) this._bindToolTrack(el);
      }
      host.hidden = true;
      host.innerHTML = '';
      return;
    }

    host.hidden = false;
    host.innerHTML = this._toolTrackHtml(run, run.track);
    slots.forEach(el => { el.innerHTML = ''; });
    this._bindToolTrack(host);
  },

  // entries — какие именно вызовы показывать: весь ход (над полем ввода)
  // или только вызовы одного шага плана (в панели). Счёт и обратный
  // отсчёт считаются по переданному набору, иначе у шага показывались бы
  // чужие числа.
  _toolTrackHtml(run, entries) {
    // 'off' — только строка общего счёта (она живёт над полем ввода);
    // остальные глубины рисуют список.
    const mode = (this.panelDepth || 'tools') === 'off' ? 'hidden' : 'rows';
    const list = entries || run.track;
    const total = list.length;
    const finished = list.filter(t => t.status === 'done' || t.status === 'error').length;
    const runningIdx = list.findIndex(t => t.status === 'running');
    const current = runningIdx >= 0 ? list[runningIdx] : null;
    const limit = this.limits.maxToolCallsPerTurn | 0;

    // ── Счёт по ВСЕМУ списку, а не по выполненному ──
    // Модель заказывает вызовы пачкой, и весь состав известен заранее.
    // Пока идёт третий из десяти, «2 из 10» (сделано из всего) отвечает
    // на вопрос «сколько позади», а человеку нужен другой: «где мы
    // сейчас». Поэтому числитель — номер текущего вызова, и только
    // когда ничего не выполняется, это число сделанных.
    const position = current ? runningIdx + 1 : finished;
    const head =
      `<div class="tt-head">` +
        `<span class="tt-title">🔧 Инструменты</span>` +
        `<span class="tt-count">${position} из ${total}` +
          (current ? `<span class="tt-countdown" data-countdown></span>` : (finished >= total ? ' · шаг завершён' : '')) +
        `</span>` +
        (limit > 0 ? `<span class="tt-budget" title="Потолок вызовов за один ответ">всего за ход: ${run.turnToolCalls} из ${limit}</span>` : '') +
      `</div>`;

    if (mode === 'hidden') {
      // Только общий ход: на каком вызове из скольких мы сейчас и сколько
      // этому вызову осталось до таймаута. Имя инструмента здесь не
      // нужно — оно уже стоит строкой выше, в строке состояния.
      return `<div class="tool-track tt-hidden">${head}</div>`;
    }

    // Длинный ход даёт десятки вызовов. Показываем хвост: прошлые шаги
    // уже отработаны, а «что сейчас и что дальше» — в конце списка.
    const MAX_ROWS = 12;
    const rows = list.slice(-MAX_ROWS);
    const hiddenCount = list.length - rows.length;
    const body = rows.map((t) => this._toolTrackRow(run, t, mode)).join('');

    return `<div class="tool-track tt-${mode}">${head}` +
      (hiddenCount > 0 ? `<div class="tt-more">…ещё ${hiddenCount} раньше</div>` : '') +
      `<div class="tt-rows">${body}</div></div>`;
  },

  // ── Одна строка ленты ──
  // Обычный вызов — строка; подзадача — ветка: её собственные вызовы
  // показываются вложенно, вместе с её прогрессом и кнопкой прерывания.
  // Уровень вложенности здесь ровно один: вложенные подзадачи запрещены
  // (см. run_subtask), поэтому рекурсия не нужна.
  _toolTrackRow(run, t, mode) {
    const MARK = { pending: '·', running: '▶', done: '✔', error: '✖' };
    const depth = this.panelDepth || 'tools';
    const time = t.status === 'running'
      ? `<span class="tt-countdown" data-countdown></span>`
      : (t.ms != null ? `<span class="tt-ms">${this._fmtDuration(t.ms)}</span>` : '');

    if (t.kind === 'subtask') {
      // Заголовок ветки — цель подзадачи, а не имя инструмента:
      // «run_subtask» не говорит ничего, а «разобрать 10 файлов» —
      // ровно то, что человек хотел узнать заранее.
      const goal = t.goal || 'подзадача';
      const progress = t.subMaxSteps
        ? `<span class="tt-sub-progress">шаг ${t.subSteps || 0} из ${t.subMaxSteps}</span>` : '';
      const canStop = t.status === 'running' && !t.subDone;
      const head =
        `<div class="tt-row tt-sub tt-${t.status}">` +
          `<span class="tt-mark">${MARK[t.status] || '·'}</span>` +
          `<span class="tt-name">🤖 ${this._escHtml(goal)}</span>` +
          progress + time +
          (canStop ? `<button class="tt-btn" data-stop-subtask="1" title="Прервать подзадачу — основная работа продолжится">✕</button>` : '') +
        `</div>`;
      // Глубина «шаги и подзадачи» — внутренности не показываем.
      if (depth === 'steps' || depth === 'subtasks') return head;
      const kids = (t.children || []).slice(-12).map((c) => this._toolTrackRow(run, c, mode)).join('');
      return head + (kids ? `<div class="tt-children">${kids}</div>` : '');
    }

    const row =
      `<div class="tt-row tt-${t.status}">` +
        `<span class="tt-mark">${MARK[t.status] || '·'}</span>` +
        `<span class="tt-name">${this._escHtml(t.name)}</span>` +
        time +
      `</div>`;

    // Аргументы и ответ — только на самой подробной глубине и только у
    // уже начатых вызовов: у «предстоит» показывать нечего.
    if (depth !== 'io' || t.status === 'pending') return row;
    return `<details class="tt-details">` +
      `<summary>${row}</summary>` +
      `<div class="tt-io">` +
        `<div class="tt-io-label">Аргументы</div><pre>${this._escHtml(t.args || '{}')}</pre>` +
        (t.result != null
          ? `<div class="tt-io-label">Ответ</div><pre>${this._escHtml(t.result)}</pre>` +
            (t.artifactId ? `<button class="btn btn-secondary btn-sm" data-artifact="${this._escHtml(t.artifactId)}">📄 полностью</button>` : '') +
            (t.subChatId ? `<button class="btn btn-secondary btn-sm" data-subchat="${this._escHtml(t.subChatId)}">💬 переписка подзадачи</button>` : '')
          : '') +
      `</div>` +
    `</details>`;
  },

  // Обратный отсчёт у текущего вызова. Считается от таймаута ОДНОГО
  // вызова, а не от бюджета хода: именно он оборвёт этот вызов, и
  // именно его исчерпание выглядит как «агент завис».
  _updateToolCountdown(run) {
    const el = document.querySelector('[data-countdown]');
    if (!el) return;
    const cur = run.track.find(t => t.status === 'running');
    if (!cur || !cur.startedAt) { el.textContent = ''; return; }
    const sec = Math.floor((Date.now() - cur.startedAt) / 1000);
    const cap = this.limits.toolTimeoutSeconds | 0;
    if (cap > 0) {
      const left = Math.max(0, cap - sec);
      el.textContent = `${left} с`;
      el.classList.toggle('near-limit', left <= Math.max(3, Math.round(cap * 0.25)));
      el.title = `Вызов прервётся по таймауту через ${left} с (предел одного вызова — ${cap} с)`;
    } else {
      el.textContent = `${sec} с`;
      el.title = 'Таймаут одного вызова не задан';
    }
  },

  // Лента живёт вне ленты сообщений, поэтому общий делегированный
  // обработчик #chat-messages (см. ui-core.js) до её кнопок не достаёт —
  // вешаем те же два действия здесь.
  _bindToolTrack(mount) {
    // Прерывание подзадачи: кнопка живёт на её ветке, а действие одно на
    // ход — подзадача в нём ровно одна (вложенные запрещены).
    mount.querySelectorAll('[data-stop-subtask]').forEach(b => b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.stopSubtask(this.currentChatId);
    }));
    mount.querySelectorAll('[data-artifact]').forEach(b => b.addEventListener('click', (e) => {
      e.preventDefault();
      this.showArtifact(b.dataset.artifact);
    }));
    mount.querySelectorAll('[data-subchat]').forEach(b => b.addEventListener('click', (e) => {
      e.preventDefault();
      this.openSubtaskChat(b.dataset.subchat);
    }));
  },

  // ── Ожидание снятия паузы ──
  // Вызывается в местах, где работу можно остановить без потерь: перед
  // запросом к модели и перед каждым вызовом инструмента. Уже начатый
  // вызов доигрывает — прервать чужой код на полпути нельзя, и делать
  // вид, что можно, значило бы врать кнопкой.
  //
  // Пауза — это именно ожидание, а не остановка хода: ход остаётся в
  // памяти со всей историей, и продолжение не стоит нового запроса.
  // Заодно отсюда применяются изменения, сделанные за паузу: модель и
  // навыки читаются при следующем запросе, ограничения — при следующей
  // проверке, поэтому ничего дополнительно применять не нужно.
  async _awaitIfPaused(chatId) {
    const run = this._chatRuns.get(chatId);
    if (!run || !run.paused) return;
    await new Promise((resolve) => { run.resumeWaiters.push(resolve); });
  },

  // Приостановить работу. Кнопка есть на всех уровнях панели хода, но
  // действие одно: пауза принадлежит ХОДУ, а не шагу или подзадаче —
  // внутри хода всё выполняется по очереди, и «приостановить только
  // подзадачу» означало бы просто ничего не делать дальше.
  pauseRun(chatId) {
    const run = this._chatRuns.get(chatId || this.currentChatId);
    if (!run || run.paused) return;
    run.paused = true;
    run.pausedAt = Date.now();
    this._showStatus(chatId || this.currentChatId, '⏸ Приостановлено',
      'текущий вызов доигрывает; продолжить — кнопкой в панели хода');
    this.updateChatToolbar();
  },

  resumeRunPause(chatId) {
    const id = chatId || this.currentChatId;
    const run = this._chatRuns.get(id);
    if (!run || !run.paused) return;
    // Бюджет времени хода сдвигаем на длительность паузы: иначе
    // остановка «подумать» съедала бы отведённое на работу время и
    // ход обрывался бы сразу после продолжения.
    const waited = Date.now() - (run.pausedAt || Date.now());
    run.pausedMs += waited;
    run.startedAt += waited;
    run.paused = false;
    run.pausedAt = 0;
    const waiters = run.resumeWaiters.splice(0);
    waiters.forEach((fn) => { try { fn(); } catch (_) {} });
    this._showStatus(id, 'Продолжаю работу…', '');
    this.updateChatToolbar();
  },

  // Прервать только текущую подзадачу: сам ход продолжится и получит
  // частичный итог. Прерывание всего хода — отдельная кнопка (stopAgent).
  stopSubtask(chatId) {
    const id = chatId || this.currentChatId;
    const run = this._chatRuns.get(id);
    if (!run || !run.subtaskAbort) return;
    run.subtaskStopRequested = true;
    // Пауза и прерывание — разные вещи, но приостановленная подзадача
    // ждёт разрешения продолжить и команду об остановке увидит только
    // после снятия паузы.
    if (run.paused) this.resumeRunPause(id);
    try { run.subtaskAbort.abort(); } catch (_) {}
    this._showStatus(id, 'Прерываю подзадачу…', 'основная работа продолжится');
  },

  // Номер шага плана, который сейчас в работе, или null. Нужен, чтобы
  // приписать вызов инструмента шагу: в панели каждый шаг показывает
  // СВОИ вызовы, а не общий список за весь ход.
  async _currentPlanStep(chatId) {
    try {
      const plan = await this.agent.tasks?.active(chatId);
      const doing = plan && plan.steps.find(st => st.status === 'doing');
      return doing ? doing.n : null;
    } catch (_) { return null; }
  },

  // Короткая запись аргументов вызова для ленты: полные уходят в
  // переписку, здесь нужен опознавательный знак, а не документ.
  _briefArgs(args) {
    let s;
    try { s = typeof args === 'string' ? args : JSON.stringify(args); }
    catch (_) { s = String(args); }
    s = s || '{}';
    return s.length > 400 ? s.slice(0, 400) + '…' : s;
  },

  // Снимает строку состояния. Раньше её уносило вместе с содержимым
  // ленты (innerHTML при loadChat) — теперь она вне ленты и обязана
  // сниматься явно, иначе висела бы над чужим, ничего не делающим чатом.
  _hideStatusBar() {
    const host = document.getElementById('agent-status-host');
    if (host) { host.hidden = true; host.innerHTML = ''; }
    // Лента вызовов показывает ход, а не историю: история остаётся в
    // переписке. Оставленная после хода, она изображала бы работу,
    // которой уже нет.
    const track = document.getElementById('tool-track-host');
    if (track) { track.hidden = true; track.innerHTML = ''; }
  },

  // keepJournal — ход прерван, но продолжить его осмысленно (упёрся в
  // ограничение). Тогда запись журнала не удаляем, а переводим в
  // 'interrupted': по ней работает и кнопка «продолжить» здесь же, и
  // предложение продолжить после перезагрузки страницы (ui-resume.js).
  // Без этого остановка по лимиту была окончательной: журнал стирался,
  // и вернуться к прерванной многоэтапной работе было уже нечем.
  _endRun(chatId, { keepJournal = null } = {}) {
    // Ход закрывают из двух мест: остановка по ограничению закрывает его
    // сразу, а finally корневого кадра — ещё раз, на общем пути выхода.
    // Второй заход не должен переписывать журнал и дёргать интерфейс.
    if (!this._chatRuns.has(chatId)) return;
    const run = this._chatRuns.get(chatId);
    if (run) clearInterval(run.statusTimer);
    this._chatRuns.delete(chatId);
    if (keepJournal) {
      this._stopHeartbeat(chatId);
      this._runJournalPut(chatId, {
        status: 'interrupted', stoppedBy: 'limit', stopReason: keepJournal, partialContent: '',
      });
    } else {
      // Ход закончился штатно — журналу больше нечего сторожить. Запись
      // удаляем именно здесь: она означает «ход идёт», и оставленная
      // после завершения, предложила бы продолжить уже законченное.
      this._runJournalClear(chatId);
    }
    // Кнопка отправки отражает занятость ПРИЛОЖЕНИЯ, а не только этого
    // чата (см. _setBusy): ход мог закончиться, пока смотрят на соседний
    // чат, — и там отправку пора разблокировать.
    this._setBusy(this._chatRuns.has(this.currentChatId));
    if (chatId === this.currentChatId) this._hideStatusBar();
    this.refreshSidebar();
  },

  // ── Один ход на приложение ──
  // Шлюз LLM общий, поэтому одновременно отвечает ровно один чат.
  // Проверка нужна и здесь, хотя кнопка отправки уже заблокирована во
  // всех чатах (см. _setBusy): отправить можно и с клавиатуры, и до
  // того, как интерфейс успел перерисоваться. Отказ показываем
  // всплывающей подсказкой, а не записью в переписке: раньше каждая
  // такая попытка оставляла в чате системное сообщение — мусор,
  // который потом ехал ещё и в контекст.
  async _blockedByOtherChat(chatId) {
    if (!this._chatRuns.size || this._chatRuns.has(chatId)) return false;
    const busyId = this._chatRuns.keys().next().value;
    let title = '';
    try { title = (await this.agent.db.get('chats', busyId))?.title || ''; } catch (_) {}
    this._toast(`⏳ Агент отвечает в чате «${title || 'без названия'}» — одновременно выполняется один ход.`);
    return true;
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

    // ── Служебная обвязка вызовов не едет в контекст ──
    // Результат инструмента хранится в переписке ЦЕЛИКОМ: интерфейсу
    // нужно показать, что именно вернулось. Модели же часть этого не
    // нужна никогда, а место занимает в каждом следующем запросе до
    // конца чата — и на сложной задаче (план, подзадачи) именно эта
    // обвязка вытесняла из окна сам разговор. Отбираем здесь, на
    // границе с API, а не при сохранении: в базе остаётся правда.
    const planIdx = [];
    usable.forEach((m, i) => { if (m.role === 'tool' && PLAN_TOOLS.has(m.name)) planIdx.push(i); });
    const lastPlanIdx = planIdx.length ? planIdx[planIdx.length - 1] : -1;

    const toApi = (m, idx) => {
      if (m.role === 'tool') {
        let content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        content = this._slimToolResult(m, content, idx === lastPlanIdx);
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

  // ── Что из результата инструмента видит модель ──
  // Вызывается только на границе с API (см. toApi в _trimHistory): в
  // базе и в интерфейсе результат остаётся полным.
  //
  // ВЕДЕНИЕ ПЛАНА. Отметки о шагах возвращают подтверждение, а само
  // состояние плана модель получает не отсюда, а из системного промпта,
  // где оно всегда свежее (tasks-engine.digest). Держать в переписке
  // ещё и снимки плана на каждый его шаг — значит платить контекстом за
  // устаревшие копии того, что и так перед глазами. Последнюю отметку
  // оставляем как есть: это ответ на действие, которое модель совершила
  // прямо сейчас, и подменять его пересказом незачем.
  //
  // ПОДЗАДАЧА. Смысл подзадачи в том, что вся её работа остаётся за
  // границей основного разговора (см. ui-subtask.js), — но вместе с
  // итогом в контекст ехали ещё и её потроха: id под-чата, число шагов,
  // вызовов, миллисекунды, потраченные токены. Модели это не нужно ни
  // для чего: продолжать работу она будет по тексту итога. Интерфейсу —
  // нужно, поэтому в записи всё сохранено, и кнопка «открыть переписку
  // подзадачи» продолжает работать.
  _slimToolResult(msg, content, isLatestPlan) {
    if (!msg || !msg.name || typeof content !== 'string') return content;

    if (PLAN_TOOLS.has(msg.name)) {
      if (isLatestPlan || msg.isError) return content;
      return '{"ok":true,"note":"отметка учтена; актуальный план — в системном промпте"}';
    }

    if (msg.name === 'run_subtask' && content.length > 200) {
      let parsed = null;
      try { parsed = JSON.parse(content); } catch (_) { return content; }
      if (!parsed || typeof parsed !== 'object') return content;
      const slim = {};
      for (const k of ['ok', 'result', 'error', 'hint']) {
        if (parsed[k] !== undefined && parsed[k] !== null) slim[k] = parsed[k];
      }
      // Пустая выжимка означала бы, что формат ответа изменился, —
      // тогда честнее отдать как есть, чем молча отдать пустоту.
      return Object.keys(slim).length ? JSON.stringify(slim) : content;
    }

    return content;
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

  // ── Свёртка больше не спасает ──
  // Разговор перерос окно модели: даже сжатое начало не освобождает
  // места, потому что не помещается уже рабочая часть переписки.
  // Молчать об этом нельзя — со стороны это выглядит как деградация
  // агента без причины, — но и продолжать сворачивать бессмысленно:
  // каждый такой заход стоит запроса и ничего не меняет. Показываем
  // один раз за чат и предлагаем то, что действительно помогает.
  _showCompactionExhausted(chatId) {
    this._compactionNoticeShown = this._compactionNoticeShown || new Set();
    if (this._compactionNoticeShown.has(chatId)) return;
    this._compactionNoticeShown.add(chatId);

    const container = (chatId === this.currentChatId) ? document.getElementById('chat-messages') : null;
    if (!container) return;
    const id = 'ce_' + uid();
    container.insertAdjacentHTML('beforeend', `
      <div class="message system context-alert warn" id="${id}">
        🗜 Сворачивать переписку дальше бесполезно: в окно контекста не помещается уже
        не начало разговора, а текущая работа. Агент продолжит отвечать, но начало
        передаваться не будет. Что помогает: продолжить в новом чате (сделанное можно
        перенести словами) или выбрать модель с большим окном.
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" data-new-chat="1">➕ Новый чат</button>
          <button class="btn btn-secondary btn-sm" data-open-models="1">🔌 Выбрать модель</button>
        </div>
      </div>`);
    const el = document.getElementById(id);
    el?.querySelector('[data-new-chat]')?.addEventListener('click', () => this.newChat());
    el?.querySelector('[data-open-models]')?.addEventListener('click', () => this.showSettingsModal('models'));
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

      // Карантин — не рядовое подтверждение, и окно должно отличаться
      // с первого взгляда: в этом ходе агент уже читал чужой текст,
      // и именно он мог подсказать операцию.
      this._showModal(req.quarantine ? '⚠️ Агент меняет сам себя после чтения внешних данных' : '🛡 Подтвердите операцию', `
        ${req.quarantine ? `<div class="sec-quarantine">
          Это самый частый сценарий скрытой атаки: во внешнем тексте — странице,
          файле, странице вики — спрятана инструкция для модели, и агент выполняет её,
          считая просьбой пользователя. Разрешайте, только если это изменение
          заказывали вы сами.
        </div>` : ''}
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

  // ── Остановка хода ──
  // limit — ход упёрся в ограничение (шаги, время, число вызовов), а не
  // сломался. Разница принципиальная, и раньше её не было: пользователь
  // получал строчку «достигнут лимит», работа обрывалась посреди
  // многоэтапной задачи, а продолжить её было нечем — журнал хода
  // стирался вместе с остановкой. Теперь такая остановка обратима:
  // ход можно продолжить с места обрыва, а ограничение — поднять, не
  // теряя сделанного.
  _stopTurn(chatId, reason, depth = 0, { limit = null } = {}) {
    const run = this._chatRuns.get(chatId);
    if (run && limit) run.stoppedByLimit = limit;

    if (limit) this._renderLimitStop(chatId, reason, limit);
    else {
      const container = (chatId === this.currentChatId) ? document.getElementById('chat-messages') : null;
      if (container) {
        container.insertAdjacentHTML('beforeend', `<div class="message system">⚠️ ${this._escHtml(reason)}</div>`);
        container.scrollTop = container.scrollHeight;
      }
    }
    // На вложенном шаге ход не завершаем: цепочка раскрутится сама, и
    // корневой кадр закроет её в своём finally — уже зная из run, что
    // остановка была по ограничению.
    if (depth === 0) this._endRun(chatId, { keepJournal: limit });
  },

  // Блок остановки по ограничению: объяснение и обе двери — продолжить
  // как есть или сначала поднять предел. Кнопки здесь, а не в настройках,
  // потому что решение принимается именно сейчас и по конкретному поводу.
  _renderLimitStop(chatId, reason, limit) {
    const container = (chatId === this.currentChatId) ? document.getElementById('chat-messages') : null;
    if (!container) return;
    const id = 'limit_' + uid();
    const fields = {
      steps: 'Максимум итераций с вызовом инструментов',
      calls: 'Максимум вызовов инструментов за ответ',
      time: 'Бюджет времени на ответ',
    };
    container.insertAdjacentHTML('beforeend', `
      <div class="message system limit-stop" id="${id}">
        ⏸ ${this._escHtml(reason)}
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
          Это ограничение из настроек, а не отказ модели: всё сделанное сохранено,
          работу можно продолжить с этого же места. Что менять — «${this._escHtml(fields[limit] || 'Ограничения')}».
        </div>
        <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" data-limit-continue="1">▶ Продолжить с этого места</button>
          <button class="btn btn-secondary btn-sm" data-limit-settings="1">⚙ Изменить ограничения</button>
        </div>
      </div>`);
    const el = document.getElementById(id);
    el?.querySelector('[data-limit-continue]')?.addEventListener('click', () => {
      el.remove();
      this.resumeRun(chatId);
    });
    el?.querySelector('[data-limit-settings]')?.addEventListener('click', () => {
      this.showSettingsModal('limits');
    });
    container.scrollTop = container.scrollHeight;
  },

  // ── Предупреждение НАКАНУНЕ ограничения ──
  // Об упёршемся ходе узнавали постфактум, когда работа уже оборвана.
  // Предупреждение на подходе к пределу даёт сделать выбор заранее:
  // поднять предел, пока цепочка ещё идёт, или дать ей закончиться и
  // продолжить отдельным сообщением. Показывается один раз на ход и на
  // каждый вид ограничения — иначе на длинной задаче оно превратилось
  // бы в поток одинаковых строк.
  _limitWarn(chatId, kind, text) {
    const run = this._chatRuns.get(chatId);
    if (!run) return;
    run.limitWarned = run.limitWarned || new Set();
    if (run.limitWarned.has(kind)) return;
    run.limitWarned.add(kind);

    const container = (chatId === this.currentChatId) ? document.getElementById('chat-messages') : null;
    if (!container) return;
    const id = 'lw_' + uid();
    container.insertAdjacentHTML('beforeend', `
      <div class="message system limit-warn" id="${id}">
        ⚠️ ${this._escHtml(text)}
        <button class="btn btn-secondary btn-sm" data-limit-settings="1" style="margin-left:6px;">⚙ Ограничения</button>
      </div>`);
    document.getElementById(id)?.querySelector('[data-limit-settings]')
      ?.addEventListener('click', () => this.showSettingsModal('limits'));
    container.scrollTop = container.scrollHeight;
  },

  // Пороги предупреждений на подходе к пределам. Проверяются перед
  // каждым шагом цепочки — там же, где и сами пределы.
  _checkLimitApproach(chatId, depth, run) {
    const L = this.limits;
    const near = (used, max) => max > 0 && max >= 4 && used >= Math.ceil(max * 0.8) && used < max;

    if (near(depth, L.maxToolSteps)) {
      this._limitWarn(chatId, 'steps',
        `Использовано ${depth} из ${L.maxToolSteps} итераций с вызовом инструментов. ` +
        'Когда они закончатся, ход остановится — его можно будет продолжить или поднять предел.');
    }
    if (near(run.turnToolCalls, L.maxToolCallsPerTurn)) {
      this._limitWarn(chatId, 'calls',
        `Сделано ${run.turnToolCalls} из ${L.maxToolCallsPerTurn} вызовов инструментов за этот ответ.`);
    }
    if (L.maxTurnSeconds > 0 && run.startedAt) {
      const elapsed = (Date.now() - run.startedAt) / 1000;
      if (elapsed >= L.maxTurnSeconds * 0.8 && elapsed < L.maxTurnSeconds) {
        this._limitWarn(chatId, 'time',
          `Прошло ${Math.round(elapsed)} с из отведённых на ответ ${L.maxTurnSeconds} с.`);
      }
    }
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
      this._stopTurn(chatId, `Достигнут лимит итераций с вызовом инструментов (${L.maxToolSteps}) — цепочка остановлена, чтобы не уйти в бесконечный цикл.`, depth, { limit: 'steps' });
      return;
    }

    // ── Лимит 2: общий бюджет времени на ход ──
    if (L.maxTurnSeconds > 0 && run.startedAt) {
      const elapsedSec = (Date.now() - run.startedAt) / 1000;
      if (elapsedSec >= L.maxTurnSeconds) {
        this._stopTurn(chatId, `Превышен лимит времени на ответ (${L.maxTurnSeconds} с) — цепочка вызовов инструментов остановлена.`, depth, { limit: 'time' });
        return;
      }
    }

    // Пределы ещё не достигнуты, но уже близко — предупреждаем, пока
    // цепочка идёт и вмешаться ещё можно (см. _checkLimitApproach).
    this._checkLimitApproach(chatId, depth, run);

    // Занятость приложения, а не только этого чата: пока ход идёт,
    // отправка заблокирована во всех чатах (см. _setBusy).
    this._setBusy(this._chatRuns.has(this.currentChatId));

    this._showStatus(chatId,
      depth === 0 ? 'Отправляю запрос модели…' : `Продолжаю работу (шаг ${depth + 1})…`,
      this.agent.llm.model ? '🧠 ' + this.agent.llm.model : ''
    );
    await this._runJournalPut(chatId, {
      stage: `шаг ${depth + 1}`, depth, toolCalls: run.turnToolCalls,
      model: this.agent.llm.model, partialContent: '',
    });

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
      // Пауза перед запросом: всё, что пользователь изменил за неё —
      // модель, навыки, инструменты, ограничения, — будет прочитано ниже
      // и применится к этому же запросу.
      await this._awaitIfPaused(chatId);
      if (run.stopRequested) { if (depth === 0) this._endRun(chatId); return; }

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
        if (plan) {
          systemPrompt += this.agent.tasks.digest(plan);
        } else if (depth >= PLAN_NUDGE_DEPTH) {
          // ── Работа оказалась многошаговой, а плана нет ──
          // Завести план — решение модели, и на коротком вопросе он не
          // нужен. Но «многошаговость» выясняется не в начале, а по
          // ходу: третья итерация с вызовами инструментов подряд — это
          // уже не ответ, а работа, и у пользователя нет никакого
          // способа увидеть, что происходит и сколько осталось.
          // Просьбу повторяем на каждом следующем шаге, пока плана нет:
          // однократная тонет в длинном контексте ровно там, где она
          // нужнее всего.
          systemPrompt +=
            '\n\n# Эта работа стала многошаговой\n' +
            `Ты уже ${depth} раза подряд вызывал инструменты, а плана задачи нет. ` +
            'Заведи его СЕЙЧАС: task_plan action=create с целью и шагами (2–10 пунктов), ' +
            'включая то, что уже сделано, — отметь эти шаги выполненными. ' +
            'Дальше отмечай шаги по мере работы. План видит и пользователь: он показывает, ' +
            'чем ты занят и сколько осталось, и позволяет остановить работу осмысленно. ' +
            'Без плана длинная работа выглядит для него молчанием.\n';
        }
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
      //
      // Но не каждый раз: решение о повторной свёртке принимает
      // _compactionAllowed — иначе на длинной цепочке вызовов агент
      // сворачивал переписку перед каждым шагом (см. пояснение там же).
      if (trim.droppedCount) {
        const verdict = this._compactionAllowed(chatId, run, trim);
        if (verdict.ok) {
          const summary = await this._compactHistory(chatId, trim.dropped, chatRef);
          if (summary) {
            const refreshed = await this.agent.db.getAllByIndex('messages', 'chatId', chatId);
            refreshed.sort((a, b) => a.timestamp - b.timestamp);
            const after = this._trimHistory(refreshed, systemPrompt, chatRef);
            const st = this._noteCompaction(chatId, run, trim, after);
            trim = after;
            // Модель этого чата могла смениться внутри свёртки — вернём.
            await this.applyChatModel(chatId);
            if (st.exhausted) this._showCompactionExhausted(chatId);
          } else {
            // Свернуть не удалось (сбой сети, отказ провайдера) — работает
            // прежнее поведение: начало не передаётся, но об этом сказано.
            this._noteCompactionFailure(chatId);
            this._showTrimNotice(chatId, trim);
          }
        } else {
          if (verdict.reason === 'exhausted') this._showCompactionExhausted(chatId);
          else this._showTrimNotice(chatId, trim);
        }
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
          // Не чаще раза в полторы секунды: иначе закрытая посреди
          // ответа вкладка унесла бы уже написанный текст, а запись на
          // каждый токен тормозила бы отрисовку.
          this._runJournalStream(chatId, run.partialContent);
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

      // ── Окно контекста уточняется по факту ──
      // Запрос ПРОШЁЛ, значит окно модели не меньше того, что в него
      // поместилось. Если в настройках стоит меньше (угадали по имени,
      // ошиблись, сменили модель за тем же именем), подрезка режет
      // историю зря — и делает это молча. Точные цифры приходят только
      // от провайдера, но «не меньше» — уже достаточно, чтобы не врать
      // в меньшую сторону. Значение, введённое человеком, при этом
      // остаётся главным (см. learnContextWindow).
      if (result.usage && this.agent.models?.learnContextWindow) {
        const seen = (result.usage.prompt_tokens || 0) + (result.usage.completion_tokens || 0);
        try {
          const upd = await this.agent.models.learnContextWindow(chatRef, seen, 'observed');
          if (upd.changed) {
            this._toast(`Окно контекста модели уточнено по факту работы: ${upd.from || '—'} → ${upd.to} токенов.`);
          }
        } catch (_) { /* уточнение не должно мешать ответу */ }
      }

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

        // Весь набор вызовов этого шага известен заранее — значит, можно
        // показать не только «выполняется X», но и что будет дальше.
        // Ради этого лента и заводится здесь, до исполнения.
        //
        // Шаг плана проставляем сразу, а не в момент исполнения: иначе
        // поставленные в очередь вызовы сначала показывались бы «вне
        // шагов», а потом по одному перепрыгивали к текущему шагу — с
        // виду это и есть «мини-план попал не туда». Перед исполнением
        // каждого вызова номер уточняется: внутри пачки модель успевает
        // закрыть шаг и открыть следующий.
        run.trackStep++;
        const stepNow = await this._currentPlanStep(chatId);
        for (const tc of result.tool_calls) {
          if (!tc || !tc.function) continue;
          // Ведение плана — не работа, а бухгалтерия по ней: сам план
          // виден рядом, целиком и в человеческом виде. В ленте эти
          // вызовы только мешали: в шаге они соседствовали с настоящей
          // работой, а вызовы create/start, сделанные до появления шага,
          // собирались отдельной кучей «вне шагов» — она и выглядела как
          // ещё один мини-план неизвестно чего.
          if (PLAN_TOOLS.has(tc.function.name)) continue;
          // Подзадача — не просто вызов, а целая ветка: внутри неё свои
          // шаги и свои вызовы инструментов. Отмечаем её отдельным видом
          // узла, чтобы панель показала третий уровень, а не строчку
          // «run_subtask», за которой не видно получаса работы.
          const isSub = tc.function.name === 'run_subtask';
          let goal = '';
          if (isSub) {
            try { goal = String(JSON.parse(tc.function.arguments || '{}').goal || ''); } catch (_) { goal = ''; }
          }
          run.track.push({
            id: tc.id || uid(),
            name: tc.function.name,
            step: run.trackStep,
            planStep: stepNow,
            status: 'pending',
            ms: null,
            args: this._briefArgs(tc.function.arguments),
            result: null,
            ...(isSub ? { kind: 'subtask', goal, children: [], subSteps: 0, subMaxSteps: 0 } : {}),
          });
        }
        this._renderToolTrack(chatId);

        for (const tc of result.tool_calls) {
          if (tc === undefined) {
        		    continue; // Пропускаем текущую итерацию, если tc undefined - из-за null в списках от некоторых LLM
          }
          const trackItem = run.track.find(t => t.step === run.trackStep && t.name === tc.function.name && t.status === 'pending');
          // Шаг плана определяем в момент ИСПОЛНЕНИЯ, а не когда вызовы
          // ставились в очередь: в той же пачке модель могла сначала
          // закрыть один шаг и открыть следующий (task_plan), и всё, что
          // идёт после, относится уже к новому шагу.
          if (trackItem) trackItem.planStep = await this._currentPlanStep(chatId);

          // ── Пауза и прерывание пользователем ──
          // Пауза здесь, между вызовами: следующий не начнётся, пока
          // человек не разрешит.
          if (run.paused) {
            clearTimeout(turnTimer);
            await this._awaitIfPaused(chatId);
          }
          if (run.stopRequested) {
            clearTimeout(turnTimer);
            if (depth === 0) this._endRun(chatId);
            return;
          }

          // ── Лимит 3: суммарное число вызовов за ход ──
          if (L.maxToolCallsPerTurn > 0 && run.turnToolCalls >= L.maxToolCallsPerTurn) {
            clearTimeout(turnTimer);
            this._stopTurn(chatId, `Достигнут лимит вызовов инструментов за один ответ (${L.maxToolCallsPerTurn}).`, depth, { limit: 'calls' });
            return;
          }
          // ── Лимит 2 (повторная проверка между вызовами) ──
          if (L.maxTurnSeconds > 0 && run.startedAt &&
              (Date.now() - run.startedAt) / 1000 >= L.maxTurnSeconds) {
            clearTimeout(turnTimer);
            this._stopTurn(chatId, `Превышен лимит времени на ответ (${L.maxTurnSeconds} с).`, depth, { limit: 'time' });
            return;
          }
          run.turnToolCalls++;

          const toolContainer = dom();
          const toolResultDiv = (this.toolVerbosity === 'hidden' || !toolContainer) ? null : document.createElement('div');
          if (toolResultDiv) {
            // Вызовы ведения плана помечаем сразу: их блок оформлен тише
            // остальных (см. PLAN_TOOLS и .tool-plan в styles.css).
            toolResultDiv.className = 'message tool-call' +
              (PLAN_TOOLS.has(tc.function.name) ? ' tool-plan' : '');
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
          if (trackItem) {
            trackItem.status = 'running';
            trackItem.startedAt = Date.now();
            // Подзадача исполняется внутри этого вызова и дописывает
            // сюда свой ход (см. runSubtask): ветка одна на приложение,
            // поэтому достаточно ссылки на текущий узел.
            run.currentTrackItem = trackItem;
            this._renderToolTrack(chatId);
          }
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

          run.currentTrackItem = null;
          if (trackItem) {
            trackItem.status = isError ? 'error' : 'done';
            trackItem.ms = elapsedMs;
            trackItem.artifactId = artifactId;
            trackItem.subChatId = subChatId;
            trackItem.result = String(resultStr || '').slice(0, 600);
            this._renderToolTrack(chatId);
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
            // Готовая подпись для ленты — только у вызовов ведения плана
            // (см. _renderMessage). Поле не заводится там, где оно
            // не нужно: тысячи tool-записей чата не должны толстеть
            // ради одного их вида.
            ...(PLAN_TOOLS.has(tc.function.name)
              ? { planLabel: this._planCallLabel(tc.function.arguments, resultStr, isError) }
              : { argsLabel: this._toolArgsLabel(tc.function.arguments) }),
          };
          await this.agent.db.put('messages', toolMsg);
          await this._runJournalPut(chatId, {
            stage: 'после ' + tc.function.name, toolCalls: run.turnToolCalls, partialContent: '',
          });
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
      } else if (error.name === 'AbortError') {
        // Обрыв по бюджету времени — то же ограничение, что и проверки
        // между шагами, только сработавшее посреди запроса к модели.
        // Значит, и обходиться с ним надо так же: сохранённое остаётся,
        // ход помечается продолжаемым, рядом — обе кнопки.
        run.stoppedByLimit = 'time';
        this._renderLimitStop(chatId,
          `Запрос прерван: превышен лимит времени на ответ (${L.maxTurnSeconds} с). ` +
          (run.partialContent.trim() ? 'Полученная часть ответа сохранена.' : ''), 'time');
      } else {
        // ── Отказ по переполнению контекста ──
        // Провайдер в таком отказе САМ называет предел — это самый точный
        // источник из возможных. Раньше сообщение просто показывалось как
        // есть, и пользователь шёл искать нужную цифру в документации,
        // хотя она стояла прямо в тексте ошибки.
        let ctxNote = '';
        try {
          const declared = LLMRegistry.contextFromError(error.message);
          if (declared && this.agent.models?.learnContextWindow) {
            const upd = await this.agent.models.learnContextWindow(chatRef, declared, 'error');
            if (upd.changed) {
              ctxNote = `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">` +
                `Провайдер назвал предел в самом отказе: окно контекста модели исправлено ` +
                `на ${declared} токенов (было ${upd.from || 'не задано'}). ` +
                `Следующий запрос будет подрезан под него — попробуйте продолжить.</div>`;
            }
          }
        } catch (_) { /* разбор ошибки не должен порождать вторую ошибку */ }

        const errContainer = dom();
        if (errContainer) {
          errContainer.insertAdjacentHTML('beforeend',
            `<div class="message system">❌ ${this._escHtml('Ошибка: ' + error.message)}${ctxNote}</div>`);
          errContainer.scrollTop = errContainer.scrollHeight;
        }
        // Сбой сети или отказ провайдера тоже не должен стоить работы:
        // журнал остаётся, и к ходу можно вернуться, ничего не повторяя.
        run.stoppedByLimit = run.stoppedByLimit || 'error';
      }
    } finally {
      clearTimeout(turnTimer);
      run.abortCtl = null;
      // Единственная точка снятия занятости для всей цепочки: срабатывает
      // на любом пути выхода корневого кадра, включая return из середины
      // цикла вызовов инструментов и любую необработанную ошибку.
      // Панель статуса и запись в this._chatRuns снимаются здесь же —
      // иначе «зависший» индикатор пережил бы ошибку или прерывание.
      // keepJournal: остановка по ограничению или сбою оставляет запись
      // журнала — по ней ход можно продолжить, в том числе после
      // перезагрузки страницы (см. renderResumeOffer).
      if (depth === 0) {
        this._endRun(chatId, {
          keepJournal: run.stoppedByLimit || (run.stoppedByUser ? 'user' : null),
        });
      }
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
    // ── Ведение плана: одна строка при любой детализации ──
    // Полный аргумент и результат тут не нужны никому: то же самое, но
    // связно и целиком, показывает панель плана справа. См. PLAN_TOOLS.
    if (PLAN_TOOLS.has(name)) {
      return `<div class="tool-compact">${isError ? '❌' : '🗂'} ` +
             `${this._escHtml(this._planCallLabel(argsRaw, resultStr, isError))}</div>`;
    }

    if (this.toolVerbosity === 'detailed') {
      let argsPretty = argsRaw;
      try { argsPretty = JSON.stringify(JSON.parse(argsRaw), null, 2); } catch (_) {}
      let resPretty = resultStr;
      try { resPretty = JSON.stringify(JSON.parse(resultStr), null, 2); } catch (_) {}
      // Свёрнуто по умолчанию: развёрнутый ответ инструмента занимает
      // экран целиком, и переписка между двумя такими блоками перестаёт
      // читаться. Заголовок с именем, временем и признаком ошибки виден
      // всегда — этого хватает, чтобы решить, надо ли разворачивать.
      return `
        <details class="tool-detail">
          <summary><strong>${icon} ${this._escHtml(name)}</strong>
            <span class="tool-meta">${elapsedMs} мс</span></summary>
          <div class="tool-section">Аргументы:</div>
          <pre class="tool-pre">${this._escHtml(argsPretty)}</pre>
          <div class="tool-section">Результат:</div>
          <pre class="tool-pre">${this._escHtml(resPretty)}</pre>
          ${artifactBtn}${subBtn}
        </details>
      `;
    }
    // ── Краткий вид: чем вызвали, а не что ответило ──
    // Раньше здесь стояло начало результата. Триста символов чужого JSON
    // не говорят ни о чём («{"ok":true,"results":[{"id":"...»), а вот
    // ПАРАМЕТРЫ отвечают на единственный вопрос, который возникает к
    // строке вызова: что именно агент сделал — какой файл прочитал, что
    // искал, куда записал. Ответ целиком доступен рядом: подробный режим
    // и кнопка артефакта.
    const err = isError ? this._toolErrorBrief(resultStr) : '';
    return `<div class="tool-compact">${icon} ${this._escHtml(name)}` +
           `<span class="tool-args">${this._escHtml(this._toolArgsLabel(argsRaw))}</span>` +
           (err ? ` <span class="tool-err">${this._escHtml(err)}</span>` : '') +
           `</div>` +
           `<span class="tool-meta">${elapsedMs} мс</span>` + artifactBtn + subBtn;
  },

  // ── Параметры вызова одной строкой ──
  // «(file: "отчёт.docx", mode: "text")». Значения режутся до 20 символов:
  // строка вызова в переписке должна опознаваться взглядом, а не читаться
  // как документ; полные аргументы есть в подробном режиме.
  _toolArgsLabel(argsRaw) {
    let obj = argsRaw;
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch (_) { obj = null; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
    const parts = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue;
      let val = typeof v === 'string' ? v : JSON.stringify(v);
      val = String(val).replace(/\s+/g, ' ').trim();
      if (val.length > 20) val = val.slice(0, 20) + '…';
      parts.push(`${k}: "${val}"`);
      // Десяток параметров в одну строку не помещается ни у кого.
      if (parts.length >= 6) { parts.push('…'); break; }
    }
    return parts.length ? ' (' + parts.join(', ') + ')' : '';
  },

  // Короткая причина отказа: без неё неудачный вызов в кратком виде
  // отличается от удачного только значком.
  _toolErrorBrief(resultStr) {
    let obj = resultStr;
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch (_) { obj = null; }
    }
    const msg = (obj && (obj.error || obj.message)) || '';
    const s = String(msg).replace(/\s+/g, ' ').trim();
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  },


  // Человеческая подпись к вызову task_plan: «План: взялся за шаг 3 · 2/7».
  // Из аргументов, а не из результата: результат у половины действий —
  // это сводка плана, из которой не видно, что именно агент только что
  // сделал, а видно лишь состояние после.
  _planCallLabel(argsRaw, resultStr, isError) {
    let a = {};
    try { a = JSON.parse(argsRaw) || {}; } catch (_) {}
    const action = String(a.action || 'show').toLowerCase();
    const labels = {
      create: 'составил план',
      show: 'сверился с планом',
      start: `взялся за шаг ${a.step}`,
      done: `закрыл шаг ${a.step}`,
      fail: `шаг ${a.step} не удался`,
      fact: 'записал факт',
      add_steps: 'дописал шаги',
      finish: 'завершил план',
      cancel: 'прекратил план',
    };
    let out = 'План: ' + (labels[action] || action);

    let r = {};
    try { r = JSON.parse(resultStr) || {}; } catch (_) {}
    if (isError || r.error) return out + ' — ' + (r.error || 'ошибка');
    // Подпись собирается из того, что действие реально возвращает.
    // Полный снимок плана оттуда убран (он занимал контекст, см.
    // tools-tasks.js), поэтому счётчик берём из оставшегося: у show —
    // сводка, у отметки шага — сколько шагов ещё не закрыто.
    if (r.plan && typeof r.plan.total === 'number') out += ` · ${r.plan.done}/${r.plan.total}`;
    else if (typeof r.left === 'number') out += r.left ? ` · осталось ${r.left}` : ' · план выполнен';
    else if (typeof r.steps === 'number') out += ` · ${r.steps} шагов`;
    else if (typeof r.total === 'number') out += ` · всего ${r.total}`;
    return out;
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
    // Приостановленный ход ждёт разрешения продолжить. Если его просто
    // пометить остановленным, он так и останется ждать — снимаем паузу,
    // чтобы ожидающие проснулись и увидели команду остановиться.
    if (run.paused) this.resumeRunPause(chatId);
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

    // ── Остановка — это пауза, а не отмена ──
    // Раньше «⏹» закрывал ход насовсем: журнал стирался, и вернуться к
    // многошаговой работе было нечем — приходилось просить то же самое
    // заново, оплачивая уже сделанное второй раз. Теперь остановка
    // помечает ход продолжаемым, как и остановка по ограничению.
    run.stoppedByUser = true;

    const container = document.getElementById('chat-messages');
    const id = 'stopped_' + uid();
    container.insertAdjacentHTML('beforeend', `
      <div class="message system" id="${id}">
        ⏹ Работа агента остановлена вами. Сделанное сохранено.
        <div style="margin-top:8px;">
          <button class="btn btn-primary btn-sm" data-resume-stop="1">▶ Продолжить с этого места</button>
        </div>
      </div>`);
    document.getElementById(id)?.querySelector('[data-resume-stop]')
      ?.addEventListener('click', (e) => {
        e.target.closest('.message')?.remove();
        this.resumeRun(chatId);
      });
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
