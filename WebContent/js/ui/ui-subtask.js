// ============================================================
//  UI SUBTASK — выполнение подзадачи в отдельном чате
// ============================================================
//
// ЗАЧЕМ. Цепочка из двадцати вызовов инструментов оставляет в переписке
// двадцать пар «вызов → результат», и все они едут в модель на каждом
// следующем шаге до конца чата. При этом основному разговору из всей
// этой возни нужен, как правило, один абзац: что выяснилось.
//
// ЧТО ДЕЛАЕТ. Инструмент run_subtask (tools/tools-subtask.js) запускает
// здесь ОТДЕЛЬНЫЙ ход в отдельном чате: у него свой системный промпт,
// своя переписка и свои артефакты. В родительский чат возвращается
// только итоговый текст. Вся черновая работа остаётся в под-чате —
// её можно открыть и прочитать, но в контекст основного разговора она
// не попадает никогда. Стоимость подзадачи для родителя постоянна и не
// зависит от того, сколько шагов она заняла.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ЦИКЛ, А НЕ _generateResponse. Тот цикл рекурсивно
// связан с интерфейсом чата: стриминг в DOM, панель статуса, состояние
// занятости, набор _chatRuns, где ход на чат ровно один. Подзадача же
// выполняется ВНУТРИ хода родителя — то есть в момент, когда его run
// активен. Здесь цикл без DOM: он пишет сообщения в базу и возвращает
// значение, а видимой частью остаётся один статус в родительском чате.

// Инструменты, недоступные внутри подзадачи.
// run_subtask — чтобы подзадача не порождала подзадачу: рекурсия
// съедала бы бюджет времени и делала происходящее непредсказуемым для
// пользователя, который видит только верхний уровень.
const SUBTASK_FORBIDDEN_TOOLS = new Set(['run_subtask']);

Object.assign(UI.prototype, {

  // Открыть переписку подзадачи (кнопка в блоке её вызова).
  async openSubtaskChat(chatId) {
    const chat = await this.agent.db.get('chats', chatId);
    if (!chat) {
      return this._confirm('Переписка подзадачи не найдена — возможно, она удалена вместе с чатом.',
        { title: 'Подзадача недоступна' });
    }
    this.switchTab('chat');
    await this.loadChat(chatId);
  },

  // Плашка «вы внутри подзадачи» с возвратом в основной чат.
  async _renderSubtaskBanner(chatId, container) {
    const chat = await this.agent.db.get('chats', chatId);
    if (!chat || !chat.subtaskOf || !container) return;

    const parent = await this.agent.db.get('chats', chat.subtaskOf);
    const statusText = {
      done: 'выполнена', stopped: 'прервана пользователем',
      step_limit: 'остановлена по лимиту шагов', error: 'прервана ошибкой',
    }[chat.subtaskStatus] || 'в работе';

    const id = 'sub_back_' + uid();
    container.insertAdjacentHTML('afterbegin', `
      <div class="message system subtask-banner">
        🤖 Это переписка подзадачи (${this._escHtml(statusText)}). Её содержимое не попадает
        в контекст основного разговора — здесь видно, как агент получил свой итог.
        <div style="margin-top:8px;">
          <button class="btn btn-secondary btn-sm" id="${id}">← Вернуться в чат «${this._escHtml(parent ? parent.title : 'основной')}»</button>
        </div>
      </div>`);
    document.getElementById(id)?.addEventListener('click', () => {
      if (chat.subtaskOf) this.loadChat(chat.subtaskOf);
    });
    container.scrollTop = 0;
  },

  // Итог подзадачи должен быть самодостаточным: родитель не увидит
  // ничего, кроме этого текста, — ни вызовов, ни промежуточных выводов.
  _subtaskPrompt(goal) {
    return '\n\n# Ты выполняешь ПОДЗАДАЧУ\n' +
      'Тебя вызвал другой ход того же агента, чтобы сэкономить контекст основного разговора.\n\n' +
      'Что это значит:\n' +
      '1. Ты НЕ видишь переписку основного чата. Всё, что тебе дали, — формулировка задачи ' +
      'и переданный вместе с ней контекст. Не ссылайся на то, «о чём говорили раньше».\n' +
      '2. Твой ответ целиком заменит собой всю проделанную работу. Верни короткий ' +
      'самодостаточный итог: что сделано, что выяснено, конкретные значения, пути, ' +
      'идентификаторы, цитаты — то, что понадобится дальше. Не пересказывай ход работы ' +
      'и не описывай, какие инструменты вызывал.\n' +
      '3. Не задавай уточняющих вопросов пользователю без крайней необходимости: он ждёт ' +
      'ответа в основном чате. Если задача сформулирована неполно — сделай разумное ' +
      'допущение и напиши в итоге, какое именно.\n' +
      '4. Если задачу выполнить не удалось — так и скажи, коротко и по существу: что ' +
      'пробовал и что помешало. Не выдумывай результат.\n\n' +
      'Задача: ' + goal + '\n';
  },

  // Ссылка на модель подзадачи: по названию или ref, иначе — модель
  // родительского чата. Отдельная модель здесь главное удобство: черновую
  // работу обычно незачем делать самой дорогой моделью.
  _resolveSubtaskRef(wanted, parentRef) {
    const reg = this.agent.models;
    if (!reg || !wanted) return parentRef;
    if (reg.resolve(wanted)) return wanted;
    const q = String(wanted).trim().toLowerCase();
    const found = reg.allModels().find(m =>
      (m.label || '').toLowerCase() === q || (m.name || '').toLowerCase() === q) ||
      reg.allModels().find(m => (m.name || '').toLowerCase().includes(q));
    return found ? found.ref : parentRef;
  },

  // ── Бюджет контекста внутри самой подзадачи ──
  // Подзадача тоже может набрать длинную ленту вызовов. Выбрасывать
  // сообщения нельзя — пара «вызов → результат» должна остаться целой,
  // иначе провайдер отвергнет запрос. Поэтому у САМЫХ СТАРЫХ результатов
  // заменяем содержимое заглушкой: структура диалога цела, а объём падает.
  _shrinkSubtaskMessages(messages, budgetChars) {
    let total = messages.reduce((n, m) => n + (m.content ? String(m.content).length : 0) +
      (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
    if (total <= budgetChars) return total;

    for (let i = 0; i < messages.length && total > budgetChars; i++) {
      const m = messages[i];
      if (m.role !== 'tool' || m._shrunk) continue;
      const was = String(m.content || '').length;
      m.content = '[результат вытеснен из контекста подзадачи: он больше не помещался. ' +
        'Если он ещё нужен — перечитай через artifact_list/artifact_read или повтори вызов]';
      m._shrunk = true;
      total -= was - m.content.length;
    }
    return total;
  },

  // ── Один прогон подзадачи ──
  // Возвращает объект, который уходит в родительский чат как результат
  // вызова run_subtask. Ошибки не бросаются: обрыв подзадачи — это
  // ответ инструмента, а не крушение хода родителя.
  async runSubtask(parentChatId, params = {}) {
    const goal = String(params.goal || '').trim();
    if (!goal) return { error: 'Не задана цель подзадачи (goal)' };

    const startedAt = Date.now();
    const parentRun = this._chatRuns.get(parentChatId);
    const L = this.limits;
    const maxSteps = Math.max(1, Math.min(Number(params.max_steps) || L.subtaskMaxSteps || 10, 30));

    const parent = await this.agent.db.get('chats', parentChatId);
    const parentRef = this._chatActiveRef(parent, this.agent.models);
    const ref = this._resolveSubtaskRef(params.model, parentRef);

    // Под-чат: обычный чат с пометкой subtaskOf. Он хранит всю переписку
    // подзадачи, поэтому работу агента можно проверить — но в списке
    // чатов не показывается, чтобы не смешиваться с разговорами
    // пользователя (открывается кнопкой из результата, см. ui-chat.js).
    const sub = {
      id: uid(),
      title: goal.slice(0, 60),
      subtaskOf: parentChatId,
      parentId: parent ? parent.parentId || null : null,
      createdAt: startedAt,
      updatedAt: startedAt,
      skillIds: [],
      modelRefs: ref ? [ref] : [],
      modelRef: ref || null,
      model: null,
    };
    await this.agent.db.put('chats', sub);

    const abortCtl = new AbortController();
    if (parentRun) parentRun.subtaskAbort = abortCtl;

    const stopped = () => !!(parentRun && parentRun.stopRequested);

    // Бюджет времени хода принадлежит РОДИТЕЛЮ и на подзадачу тоже
    // распространяется: его таймер обрывает родительский запрос к
    // модели, но не запрос подзадачи — у неё свой контроллер. Без этой
    // проверки подзадача продолжала бы работать после того, как ход
    // формально исчерпал отведённое время.
    const outOfTime = () => !!(parentRun && L.maxTurnSeconds > 0 && parentRun.startedAt &&
      (Date.now() - parentRun.startedAt) / 1000 >= L.maxTurnSeconds);

    let steps = 0, toolCalls = 0, promptTokens = 0, completionTokens = 0;
    let finalText = '', stopReason = 'done', failure = null;

    try {
      let systemPrompt = await this.agent.skills.buildSystemPrompt();
      systemPrompt += this._subtaskPrompt(goal);

      const userText = params.context
        ? goal + '\n\n## Контекст от основного чата\n' + String(params.context)
        : goal;

      await this.agent.db.put('messages', {
        id: uid(), chatId: sub.id, role: 'user', content: userText, timestamp: Date.now(),
      });

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userText },
      ];

      const allTools = await this.agent.tools.getEnabledToolsForAPI();
      const tools = allTools.filter(t => !SUBTASK_FORBIDDEN_TOOLS.has(t.function.name));

      // Бюджет символов подзадачи — из окна её собственной модели.
      const limitTokens = this.effectiveContextLimit(ref);
      const budgetChars = limitTokens ? Math.floor(limitTokens * 0.6 * 3) : 300000;

      while (steps < maxSteps) {
        if (stopped()) { stopReason = 'stopped'; break; }
        if (outOfTime()) { stopReason = 'turn_timeout'; break; }
        steps++;

        this._showStatus(parentChatId,
          `Подзадача: шаг ${steps} из ${maxSteps}`,
          goal.slice(0, 60) + (goal.length > 60 ? '…' : ''));

        this._shrinkSubtaskMessages(messages, budgetChars);

        // Модель подзадачи применяется прямо перед запросом: шлюз общий
        // на приложение, и родительский ход (как и другой открытый чат)
        // мог оставить в нём свою.
        if (ref) this.agent.models?.applyRef(ref);
        const modelUsed = this.agent.llm.model;

        const result = await this.agent.llm.chat(messages, {
          tools: tools.length ? tools : null,
          stream: false,
          signal: abortCtl.signal,
        });

        const usage = result.usage || this._estimateUsage(messages, result);
        promptTokens += usage.prompt_tokens || 0;
        completionTokens += usage.completion_tokens || 0;
        // Расход записывается на СОБСТВЕННУЮ статистику под-чата, а не
        // родителя: иначе одни и те же токены считались бы дважды —
        // и в чате, и в сумме по всем чатам.
        await this._recordUsage(sub.id, usage, !result.usage);

        if (result.tool_calls && result.tool_calls.length) {
          const assistantMsg = {
            id: uid(), chatId: sub.id, role: 'assistant',
            content: result.content || '', tool_calls: result.tool_calls,
            timestamp: Date.now(), model: modelUsed,
          };
          await this.agent.db.put('messages', assistantMsg);
          messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.tool_calls });

          for (const tc of result.tool_calls) {
            if (!tc) continue;
            if (stopped()) { stopReason = 'stopped'; break; }
            if (outOfTime()) { stopReason = 'turn_timeout'; break; }
            toolCalls++;

            this._showStatus(parentChatId,
              `Подзадача: ${tc.function.name}`,
              `шаг ${steps}, вызовов: ${toolCalls}`);

            const t0 = performance.now();
            const toolResult = await this.agent.tools.executeTool(
              tc.function.name, tc.function.arguments,
              { timeoutMs: (L.toolTimeoutSeconds || 0) * 1000 });
            const elapsedMs = Math.round(performance.now() - t0);
            const isError = !!(toolResult && toolResult.error);

            // Большие результаты выносятся в артефакт и здесь — но с
            // привязкой к ПОД-чату: они нужны только внутри подзадачи и
            // исчезнут вместе с ней.
            let resultStr = JSON.stringify(toolResult);
            let artifactId = null;
            const thr = L.artifactThresholdChars | 0;
            if (!isError && thr > 0 && resultStr.length > thr && this.agent.artifacts
                && !ARTIFACT_TOOLS.has(tc.function.name)) {
              try {
                const rec = await this.agent.artifacts.store({
                  chatId: sub.id, toolName: tc.function.name,
                  args: tc.function.arguments, result: toolResult,
                });
                artifactId = rec.id;
                resultStr = JSON.stringify(this.agent.artifacts.digest(rec));
              } catch (e) {
                console.error('Артефакт подзадачи не сохранён', e);
              }
            }

            await this._recordToolCall(sub.id, tc.function.name, elapsedMs, isError);
            await this.agent.db.put('messages', {
              id: uid(), chatId: sub.id, role: 'tool', content: resultStr,
              tool_call_id: tc.id, name: tc.function.name, timestamp: Date.now(),
              durationMs: elapsedMs, isError, artifactId,
            });
            messages.push({ role: 'tool', content: resultStr, tool_call_id: tc.id, name: tc.function.name });
          }
          if (stopReason === 'stopped' || stopReason === 'turn_timeout') break;
          continue;
        }

        finalText = result.content || '';
        await this.agent.db.put('messages', {
          id: uid(), chatId: sub.id, role: 'assistant', content: finalText,
          timestamp: Date.now(), model: modelUsed,
          truncated: result.finish_reason === 'length',
        });
        break;
      }

      if (steps >= maxSteps && !finalText) stopReason = 'step_limit';

    } catch (e) {
      stopReason = (e.name === 'AbortError') ? 'stopped' : 'error';
      finalText = finalText || '';
      if (stopReason === 'error') {
        await this.agent.db.put('messages', {
          id: uid(), chatId: sub.id, role: 'system',
          content: 'Подзадача прервана ошибкой: ' + e.message, timestamp: Date.now(),
        });
      }
      failure = e.message;
    } finally {
      if (parentRun) parentRun.subtaskAbort = null;
      // Возвращаем шлюзу модель родителя: следующий шаг родительского
      // хода не должен уехать на модель, выбранную для подзадачи.
      try { await this.applyChatModel(parentChatId); } catch (_) {}
      sub.updatedAt = Date.now();
      sub.model = this.agent.llm.model;
      sub.subtaskResult = finalText.slice(0, 500);
      sub.subtaskStatus = stopReason;
      await this.agent.db.put('chats', sub);
    }

    const out = {
      subtask_chat_id: sub.id,
      goal,
      steps,
      tool_calls: toolCalls,
      elapsed_ms: Date.now() - startedAt,
      tokens: { prompt: promptTokens, completion: completionTokens },
      model: sub.model,
    };

    if (stopReason === 'done' && finalText) {
      out.ok = true;
      out.result = finalText;
      return out;
    }

    out.ok = false;
    out.result = finalText || null;
    out.error = {
      stopped: 'Подзадача прервана пользователем.',
      step_limit: `Подзадача не уложилась в ${maxSteps} шагов и остановлена. ` +
        'Разбей её на части помельче или увеличь max_steps.',
      turn_timeout: `Исчерпан бюджет времени на ответ (${L.maxTurnSeconds} с) — подзадача остановлена.`,
      error: 'Подзадача прервана ошибкой: ' + (typeof failure === 'string' ? failure : 'неизвестная ошибка'),
      done: 'Подзадача завершилась без текстового ответа.',
    }[stopReason];
    out.hint = 'Итога нет — не выдавай за результат собственные догадки. ' +
      'Скажи пользователю, что подзадача не выполнена, или попробуй иначе.';
    return out;
  },

});
