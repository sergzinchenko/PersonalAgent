// ============================================================
//  UI RESUME — журнал хода, восстановление после сбоя
// ============================================================
//
// ЗАЧЕМ. Ход агента живёт в памяти вкладки. Закрытая вкладка, обновление
// страницы, падение браузера, уснувший ноутбук — и работа обрывается
// молча: сообщения, успевшие попасть в базу, остаются, а всё остальное
// исчезает. Хуже того, обрыв посреди цепочки инструментов оставляет в
// истории вызов без результата — и следующий запрос к провайдеру
// отвергается с ошибкой, то есть чат становится нерабочим совсем.
//
// ЧТО ДЕЛАЕТ ЭТОТ МОДУЛЬ:
//   1. Ведёт журнал активного хода в базе (store 'runs'): стадия, шаг,
//      модель и накопленный, но ещё не сохранённый текст ответа.
//   2. При запуске находит ходы, оставшиеся в состоянии «выполняется»,
//      и предлагает продолжить — с того места, докуда дошла работа.
//   3. Чинит оборванные пары «вызов инструмента → результат», без чего
//      продолжать было бы нечем: провайдер отверг бы такой запрос.
//   4. Предупреждает при попытке закрыть вкладку во время работы.
//
// ЧЕГО ОН НЕ ДЕЛАЕТ. Он не возобновляет работу сам: после сбоя решение
// продолжать принимает пользователь. Автоматический перезапуск в момент
// открытия страницы — верный способ потратить деньги на ход, который
// уже не нужен, и повторить действие, из-за которого всё и упало.

Object.assign(UI.prototype, {

  // ── Журнал ──
  // Пишется часто, поэтому запись плоская и маленькая: без истории
  // сообщений (она и так в базе) и без объектов, которые нельзя
  // сериализовать (AbortController, узлы DOM).
  async _runJournalPut(chatId, patch = {}) {
    if (!chatId || !this.agent.db) return null;
    try {
      const prev = (await this.agent.db.get('runs', chatId)) || { chatId };
      const rec = {
        ...prev, ...patch,
        chatId,
        status: patch.status || prev.status || 'running',
        updatedAt: Date.now(),
      };
      await this.agent.db.put('runs', rec);
      return rec;
    } catch (e) {
      // Журнал — страховка, а не часть ответа: его сбой не должен
      // ронять сам ход.
      console.error('Журнал хода: не удалось записать состояние', e);
      return null;
    }
  },

  // Частичный текст ответа пишется по ходу стриминга, но не на каждый
  // чанк: запись в базу на каждом токене заметно тормозила бы ответ.
  async _runJournalStream(chatId, text) {
    const now = Date.now();
    this._runJournalLastWrite = this._runJournalLastWrite || 0;
    if (now - this._runJournalLastWrite < 1500) return;
    this._runJournalLastWrite = now;
    await this._runJournalPut(chatId, { partialContent: text });
  },

  async _runJournalClear(chatId) {
    if (!chatId || !this.agent.db) return;
    try { await this.agent.db.delete('runs', chatId); } catch (_) {}
  },

  // ── Починка оборванной цепочки ──
  // Сообщение assistant с tool_calls обязано сопровождаться результатом
  // на КАЖДЫЙ вызов — иначе провайдер отвечает ошибкой на весь запрос.
  // Обрыв посреди цепочки оставляет как раз такую дыру; закрываем её
  // честной записью о том, что выполнение прервано.
  async repairDanglingToolCalls(chatId) {
    const msgs = await this.agent.db.getAllByIndex('messages', 'chatId', chatId);
    msgs.sort((a, b) => a.timestamp - b.timestamp);

    const answered = new Set(msgs.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    const repairs = [];
    for (const m of msgs) {
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      for (const tc of m.tool_calls) {
        if (!tc || answered.has(tc.id)) continue;
        repairs.push({
          id: uid(),
          chatId,
          role: 'tool',
          content: JSON.stringify({
            error: 'Выполнение прервано: страница была закрыта или произошёл сбой.',
            interrupted: true,
            hint: 'Результата этого вызова нет. Если он всё ещё нужен — вызови инструмент заново.',
          }),
          tool_call_id: tc.id,
          name: tc.function ? tc.function.name : 'unknown',
          timestamp: (m.timestamp || Date.now()) + 1,
          isError: true,
          interrupted: true,
        });
      }
    }
    if (repairs.length) await this.agent.db.putAll('messages', repairs);
    return repairs.length;
  },

  // ── Поиск прерванных ходов при запуске ──
  // Вызывается один раз после инициализации (см. agent.js). Записи со
  // статусом «выполняется» могли остаться только от вкладки, которая
  // не дожила до конца хода.
  async checkInterruptedRuns() {
    let records = [];
    try { records = await this.agent.db.getAll('runs'); } catch (_) { return 0; }

    const stale = records.filter(r => r.status === 'running');
    if (!stale.length) return 0;

    for (const rec of stale) {
      const chat = await this.agent.db.get('chats', rec.chatId);
      if (!chat) { await this._runJournalClear(rec.chatId); continue; }

      // Накопленный, но не сохранённый текст ответа — единственное, что
      // при обрыве пропало бы совсем: остальное уже лежит в сообщениях.
      if (rec.partialContent && rec.partialContent.trim()) {
        await this.agent.db.put('messages', {
          id: uid(),
          chatId: rec.chatId,
          role: 'assistant',
          content: rec.partialContent,
          timestamp: rec.updatedAt || Date.now(),
          model: rec.model || null,
          interrupted: true,
        });
      }

      const repaired = await this.repairDanglingToolCalls(rec.chatId);
      await this._runJournalPut(rec.chatId, {
        status: 'interrupted',
        repairedCalls: repaired,
        partialContent: '',
      });
    }

    // Если прерванный ход был в чате, который сейчас открыт, — показываем
    // предложение продолжить сразу; для остальных оно появится при
    // открытии их чата (см. loadChat).
    if (this.currentChatId) await this.renderResumeOffer(this.currentChatId);
    return stale.length;
  },

  // ── Предложение продолжить ──
  // Показывается в чате, где ход оборвался. Текст объясняет, что именно
  // произошло и что уже сохранено: обрыв не должен выглядеть как
  // необъяснимая пропажа ответа.
  async renderResumeOffer(chatId) {
    if (!chatId || chatId !== this.currentChatId) return;
    if (this._chatRuns.has(chatId)) return;   // ход идёт прямо сейчас

    let rec = null;
    try { rec = await this.agent.db.get('runs', chatId); } catch (_) { return; }
    if (!rec || rec.status !== 'interrupted') return;

    const container = document.getElementById('chat-messages');
    if (!container || document.getElementById('resume-offer')) return;

    const when = rec.updatedAt ? new Date(rec.updatedAt).toLocaleString('ru-RU') : '';
    const details = [];
    if (rec.stage) details.push('остановился на стадии: ' + rec.stage);
    if (rec.toolCalls) details.push(`выполнено вызовов инструментов: ${rec.toolCalls}`);
    if (rec.repairedCalls) details.push(`незавершённых вызовов помечено как прерванные: ${rec.repairedCalls}`);

    container.insertAdjacentHTML('beforeend', `
      <div class="message system resume-offer" id="resume-offer">
        ⚠️ Работа агента прервалась ${when ? '(' + this._escHtml(when) + ')' : ''} — вкладка была закрыта,
        страница обновлена или произошёл сбой. Всё, что агент успел сделать, сохранено выше.
        ${details.length ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">${this._escHtml(details.join(' · '))}</div>` : ''}
        <div style="margin-top:8px;display:flex;gap:8px;">
          <button class="btn btn-primary btn-sm" id="resume-continue">▶ Продолжить с этого места</button>
          <button class="btn btn-secondary btn-sm" id="resume-dismiss">Не продолжать</button>
        </div>
      </div>`);
    container.scrollTop = container.scrollHeight;

    document.getElementById('resume-continue')?.addEventListener('click', () => this.resumeRun(chatId));
    document.getElementById('resume-dismiss')?.addEventListener('click', async () => {
      document.getElementById('resume-offer')?.remove();
      await this._runJournalClear(chatId);
    });
  },

  // ── Продолжение прерванного хода ──
  // Новое сообщение пользователя не создаётся: агент продолжает с той
  // истории, что уже есть, — включая результаты инструментов, успевшие
  // выполниться до обрыва. Это и есть смысл возобновления: не повторять
  // уже сделанную (и оплаченную) работу.
  async resumeRun(chatId) {
    document.getElementById('resume-offer')?.remove();
    if (this._chatRuns.has(chatId)) return;

    if (this._chatRuns.size > 0) {
      const c = document.getElementById('chat-messages');
      c?.insertAdjacentHTML('beforeend',
        '<div class="message system">⏳ Сейчас отвечает другой чат — одновременно обрабатывается только один запрос. Попробуйте, когда он закончит.</div>');
      return;
    }

    if (!this.agent.llm.isConfigured()) return this.showSettingsModal();

    // Цепочка могла оборваться и после последней починки (например, если
    // страницу закрыли ещё раз) — проверяем целостность ещё раз.
    await this.repairDanglingToolCalls(chatId);

    const run = {
      startedAt: Date.now(),
      stage: null,
      partialContent: '',
      streamEl: null,
      turnToolCalls: 0,
      // Сообщения пользователя в этом ходе нет — время обработки
      // приписывать некуда, и это честно: ход уже не первый.
      turnUserMsgId: null,
      stopRequested: false,
      abortCtl: null,
      subtaskAbort: null,
      statusTimer: null,
      resumed: true,
    };
    this._chatRuns.set(chatId, run);
    await this._runJournalPut(chatId, { status: 'running', resumed: true, stage: 'возобновление' });

    if (chatId === this.currentChatId) {
      this._setBusy(true);
      const c = document.getElementById('chat-messages');
      c?.insertAdjacentHTML('beforeend',
        '<div class="message system">▶ Работа продолжена с места обрыва.</div>');
    }
    this.refreshSidebar();
    this.agent.security?.resetTurn();
    await this.applyChatModel(chatId);
    await this._generateResponse(chatId);
  },

  // ── Предупреждение при закрытии вкладки ──
  // Браузер покажет своё стандартное окно «покинуть страницу?». Текст
  // задать нельзя — это ограничение браузеров, — но само предупреждение
  // спасает от случайного закрытия посреди длинной работы.
  _bindUnloadGuard() {
    window.addEventListener('beforeunload', (e) => {
      if (!this._chatRuns.size) return;
      e.preventDefault();
      e.returnValue = '';
      return '';
    });
  },

});
