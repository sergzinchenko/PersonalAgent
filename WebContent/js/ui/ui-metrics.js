// ============================================================
//  UI METRICS — токены, окно контекста, статистика чата
// ============================================================
//
// Учёт израсходованных токенов, оценка размера контекста, предупреждения о заполнении окна и панель статистики.

Object.assign(UI.prototype, {



  // ── Набор моделей чата ──
  //
  // Хранится в записи чата: modelRefs — короткий список, modelRef —
  // выбранная. Ссылки на удалённые модели отфильтровываются на чтении,
  // а не чистятся при удалении: чатов могут быть сотни, и переписывать
  // их все ради одной убранной модели неоправданно.

  _chatModelRefs(chat, reg) {
    const refs = (chat && Array.isArray(chat.modelRefs) ? chat.modelRefs : [])
      .filter(r => reg.resolve(r));
    // Пока пользователь ничего не добавил, показываем модель по
    // умолчанию — иначе панель выглядела бы пустой и непонятной.
    if (!refs.length && reg.resolve(reg.defaultRef)) return [reg.defaultRef];
    return refs;
  },

  _chatActiveRef(chat, reg) {
    if (chat && chat.modelRef && reg.resolve(chat.modelRef)) return chat.modelRef;
    const list = this._chatModelRefs(chat, reg);
    return list[0] || null;
  },

  // Применяет модель чата к шлюзу. Вызывается и при переключении чата, и
  // перед отправкой запроса: чат мог быть открыт давно, а шлюз с тех пор
  // настроен под другой чат.
  async applyChatModel(chatId) {
    const reg = this.agent.models;
    if (!reg) return null;
    const chat = chatId ? await this.agent.db.get('chats', chatId) : null;
    const ref = this._chatActiveRef(chat, reg) || reg.defaultRef;
    if (ref) reg.applyRef(ref);
    return ref;
  },

  async setChatModel(ref) {
    const reg = this.agent.models;
    if (!reg.resolve(ref) || !this.currentChatId) return;

    const chat = await this.agent.db.get('chats', this.currentChatId);
    if (!chat) return;

    chat.modelRefs = Array.from(new Set([...(chat.modelRefs || []), ref]));
    chat.modelRef = ref;
    // Дублируем имя модели в chat.model: оно используется в списке чатов
    // и в экспорте, где разбирать ссылку неудобно.
    const d = reg.describe(ref);
    chat.model = d ? d.model : chat.model;
    await this.agent.db.put('chats', chat);

    reg.applyRef(ref);
    this.updateModelDisplay?.();
    await this.updateChatToolbar();
  },

  async removeChatModel(ref) {
    if (!this.currentChatId) return;
    const chat = await this.agent.db.get('chats', this.currentChatId);
    if (!chat || !Array.isArray(chat.modelRefs)) return;

    chat.modelRefs = chat.modelRefs.filter(r => r !== ref);
    // Убрали выбранную — выбираем первую из оставшихся, чтобы чат не
    // остался без модели.
    if (chat.modelRef === ref) chat.modelRef = chat.modelRefs[0] || null;
    await this.agent.db.put('chats', chat);

    await this.applyChatModel(this.currentChatId);
    this.updateModelDisplay?.();
    await this.updateChatToolbar();
  },

  // Выбор модели для добавления в чат — из всех, что заведены в реестре.
  // Окно остаётся открытым после добавления: за один заход в чат обычно
  // добавляют не одну модель, а две-три для сравнения, и закрывать диалог
  // после первой же было бы неудобно — пришлось бы открывать его заново.
  async showChatModelPicker() {
    // На случай, если чат ещё не открыт (например, самый первый запуск
    // без единого чата) — иначе набор моделей нечему было бы применить.
    if (!this.currentChatId) await this.newChat();

    const reg = this.agent.models;
    const all = reg.allModels();

    if (!all.length) {
      return this._confirm('Моделей пока нет. Добавьте провайдера и его модели в ⚙ Настройки.',
        { title: 'Нет моделей' });
    }

    const renderGroups = async () => {
      const chat = this.currentChatId ? await this.agent.db.get('chats', this.currentChatId) : null;
      const inChat = new Set(this._chatModelRefs(chat, reg));

      // Группируем по провайдеру: одно и то же имя модели встречается у
      // нескольких провайдеров, и без группировки их не различить.
      const byProvider = new Map();
      for (const m of all) {
        if (!byProvider.has(m.connName)) byProvider.set(m.connName, []);
        byProvider.get(m.connName).push(m);
      }

      return Array.from(byProvider.entries()).map(([prov, models]) => `
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;margin:10px 0 4px;">
          ${this._escHtml(prov)}
        </div>
        ${models.map(m => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;
                      border:1px solid var(--border);border-radius:6px;margin-bottom:4px;">
            <span title="${this._escHtml(m.tierInfo.hint)}">${m.tierInfo.icon}</span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;">${this._escHtml(m.label || m.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);">
                ${this._escHtml(m.tierInfo.label)}${m.contextWindow ? ' · окно ' + this._fmtLimit(m.contextWindow) : ''}
                ${m.notes ? ' · ' + this._escHtml(m.notes) : ''}
              </div>
            </div>
            <button class="btn ${inChat.has(m.ref) ? 'btn-secondary' : 'btn-success'}"
                    data-add-ref="${this._escHtml(m.ref)}" style="padding:4px 10px;font-size:11px;"
                    ${inChat.has(m.ref) ? 'disabled' : ''}>
              ${inChat.has(m.ref) ? 'уже в чате' : '+ В чат'}
            </button>
          </div>`).join('')}
      `).join('');
    };

    this._showModal('🧠 Модели для этого чата', `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">
        Добавленные модели появятся в панели чата — переключаться между ними можно одним кликом.
        Можно добавить сразу несколько. Правая кнопка по значку в чате убирает модель из набора.
      </div>
      <div id="cmp_list" style="max-height:50vh;overflow-y:auto;">${await renderGroups()}</div>
    `, null, null, { wide: true });

    // Делегирование на контейнер, а не на кнопки: после добавления модели
    // список перерисовывается целиком (новые кнопки — новые DOM-узлы), и
    // слушатель на самом контейнере переживает эту перерисовку без
    // необходимости перевешивать его на каждый новый набор кнопок.
    const list = document.getElementById('cmp_list');
    if (list) {
      list.onclick = async (e) => {
        const btn = e.target.closest('button[data-add-ref]');
        if (!btn) return;
        try {
          await this.setChatModel(btn.dataset.addRef);
          list.innerHTML = await renderGroups();
        } catch (err) {
          console.error('Не удалось добавить модель в чат:', err);
        }
      };
    }
  },

  // ── Быстрое включение навыка: разобраться с его инструментами ──
  // Навык может опираться на инструменты, которые сейчас выключены. Тогда
  // он включается наполовину: указания модель получит, а выполнить их не
  // сможет — со стороны это выглядит как «навык не работает».
  // Включать инструменты молча нельзя: это отдельное решение пользователя
  // (в том числе про инструменты, написанные моделью). Поэтому — разовый
  // вопрос ровно в момент включения навыка, со списком и галочками.
  async _offerEnableSkillTools(skill) {
    let off;
    try {
      off = await this.agent.skills.disabledToolsOf(skill);
    } catch (_) { return; }
    if (!off || !off.length) return;

    const rows = off.map(t => `
      <label class="skill-tool-row bound">
        <input type="checkbox" data-enable-tool="${t.id}" checked>
        <span class="skill-tool-name">${this._escHtml(t.name)}</span>
        <span class="skill-tool-state">выключен</span>
      </label>`).join('');

    // Кнопка «Отмена» здесь — «оставить как есть»: навык уже включён,
    // отказ касается только инструментов.
    this._showModal(`🧩 Навык «${this._escHtml(skill.name)}» включён`, `
      <div style="font-size:13px;color:var(--text-primary);line-height:1.6;margin-bottom:10px;">
        ${off.length === 1 ? 'Инструмент, на который опирается этот навык, сейчас выключен' :
          `Инструменты, на которые опирается этот навык, сейчас выключены (${off.length})`} —
        модель их не получит и вызвать не сможет.
      </div>
      <div class="skill-tools-picker">${rows}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.5;">
        «Сохранить» — включить отмеченные. «Отмена» — оставить как есть:
        навык всё равно останется включённым, просто без этих действий.
        Инструменты можно включить позже на вкладке Tools.
      </div>
    `, async () => {
      const ids = [...document.querySelectorAll('[data-enable-tool]')]
        .filter(cb => cb.checked).map(cb => cb.dataset.enableTool);
      const names = [];
      for (const id of ids) {
        const tool = await this.agent.db.get('tools', id);
        if (!tool) continue;
        tool.enabled = true;
        await this.agent.db.put('tools', tool);
        names.push(tool.name);
      }
      if (!names.length) return;
      this.renderTools?.();
      const c = document.getElementById('chat-messages');
      c?.insertAdjacentHTML('beforeend',
        `<div class="message system">✅ Для навыка «${this._escHtml(skill.name)}» ` +
        `${names.length === 1 ? 'включён инструмент' : 'включены инструменты'}: ` +
        `${this._escHtml(names.join(', '))}.</div>`);
      if (c) c.scrollTop = c.scrollHeight;
    });
  },


  async updateChatToolbar() {
    const toolbar = document.getElementById('chat-toolbar');
    const skills = await this.agent.skills.loadSkills();
    const llm = this.agent.llm;

    const stats = this.currentChatId ? await this.agent.db.get('chat_stats', this.currentChatId) : null;
    const fmt = (n) => (n || 0).toLocaleString('ru-RU');

    // ── Быстрый выбор модели ──
    // Устроено как навыки: у чата свой короткий набор моделей, из которого
    // одна выбрана. Плоский список всех моделей провайдера здесь не годится:
    // их бывают десятки, а в конкретном чате нужны две-три.
    const reg = this.agent.models;
    const chat = this.currentChatId ? await this.agent.db.get('chats', this.currentChatId) : null;
    const chatModels = this._chatModelRefs(chat, reg);
    const activeRef = this._chatActiveRef(chat, reg);

    const modelChips = chatModels.map(ref => {
      const d = reg.describe(ref);
      if (!d) return '';
      const on = ref === activeRef;
      const title = `${d.provider} · ${d.model} · ${d.tierLabel}` +
        (d.contextWindow ? ` · окно ${this._fmtLimit(d.contextWindow)}` : '') +
        (d.notes ? `\n${d.notes}` : '');
      return `<span class="chip model-chip ${on ? 'active' : ''}" data-model-ref="${this._escHtml(ref)}"
                    title="${this._escHtml(title)}">${d.tierIcon} ${this._escHtml(d.label)}</span>`;
    }).join('');

    const modelRow = reg.allModels().length
      ? `${modelChips || '<span class="skills-empty">модель не выбрана</span>'}
         <button type="button" class="skills-toggle" id="model-add-btn"
                 title="Добавить модель в этот чат">+ модель</button>`
      : `<span class="skills-empty">моделей нет — добавьте в ⚙ Настройки</span>`;

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
        contextChip = `<span class="chip stat-chip${cls}" title="Контекст последнего запроса: ${ctxApprox}${fmt(ctxUsed)} из ${fmt(ctxLimit)} токенов${' (окно задано в карточке модели)'}">📐 ${ctxApprox}${fmt(ctxUsed)} / ${this._fmtLimit(ctxLimit)} · ${pct}%</span>`;
      } else {
        contextChip = `<span class="chip stat-chip" title="Окно контекста неизвестно — задайте его в карточке модели: ⚙ Настройки → Провайдеры и модели">📐 ${ctxApprox}${fmt(ctxUsed)} / ?</span>`;
      }
    } else if (ctxLimit) {
      contextChip = `<span class="chip stat-chip muted" title="Окно контекста выбранной модели">📐 окно ${this._fmtLimit(ctxLimit)}</span>`;
    }

    // ── План задачи ──
    // Пока агент ведёт план, пользователь должен видеть то же, что видит
    // модель: на каком шаге работа и сколько осталось. Иначе длинная
    // задача выглядит как молчание с редкими сообщениями.
    let planChip = '';
    try {
      const plan = this.currentChatId ? await this.agent.tasks?.active(this.currentChatId) : null;
      const sum = plan ? this.agent.tasks.summary(plan) : null;
      if (sum) {
        const hint = 'Цель: ' + sum.goal + (sum.current ? '\nСейчас: ' + sum.current : '');
        planChip = `<span class="chip stat-chip plan-chip" id="task-plan-chip"
          title="${this._escHtml(hint)}">` +
          `🗂 план ${sum.done}/${sum.total}${sum.current ? ' · ' + this._escHtml(sum.current.slice(0, 40)) : ''}</span>`;
      }
    } catch (_) { /* панель не должна падать из-за плана */ }

    const toolsChip = stats && stats.toolCalls
      ? `<span class="chip stat-chip" id="tool-stats-chip" title="Нажмите для подробной статистики">🔧 ${fmt(stats.toolCalls)} вызовов${stats.toolErrors ? ` · ${fmt(stats.toolErrors)} ошибок` : ''}</span>`
      : `<span class="chip stat-chip muted">🔧 нет вызовов</span>`;

    // ── Режим отображения навыков ──
    // 'active' — только включённые (при отключении навык исчезает из
    // панели), 'all' — все. При десятке навыков полный список занимал
    // заметную часть экрана в каждом чате, поэтому по умолчанию —
    // компактный режим.
    const skillsMode = this.skillsPanelMode || 'active';
    const enabled = skills.filter(s => s.enabled);
    const shown = skillsMode === 'all' ? skills : enabled;
    const hiddenCount = skills.length - shown.length;

    // Системный навык показываем, но кликом не переключаем: он действует
    // всегда. Без него в панели он выглядел бы как выключаемый.
    const skillChips = shown.map(s => s.locked
      ? `<span class="chip active chip-locked" title="${this._escHtml(s.description)} Выключить нельзя.">
           🔒 ${this._escHtml(s.icon)} ${this._escHtml(s.name)}
         </span>`
      : `<span class="chip ${s.enabled ? 'active' : ''}" data-skill="${s.id}" title="${this._escHtml(s.description)}">
           ${this._escHtml(s.icon)} ${this._escHtml(s.name)}
         </span>`).join('');

    // В компактном режиме без включённых навыков панель была бы пустой и
    // непонятной — поясняем, что навыки есть и как их показать.
    const emptyNote = (skillsMode === 'active' && !enabled.length && skills.length)
      ? '<span class="skills-empty">навыки не включены</span>'
      : '';

    const toggleLabel = skillsMode === 'all'
      ? `▴ только включённые`
      : `▾ все навыки${hiddenCount ? ' (' + hiddenCount + ')' : ''}`;

    toolbar.innerHTML = `
      <div class="toolbar-row skills-row">
        ${skillChips}${emptyNote}
        ${skills.length ? `<button type="button" class="skills-toggle" id="skills-mode-toggle"
          title="Переключить отображение навыков">${toggleLabel}</button>` : ''}
      </div>
      <div class="toolbar-row toolbar-meta">
        <span class="model-row">${modelRow}</span>
        ${tokensChip}
        ${contextChip}
        ${toolsChip}
        ${planChip}
      </div>
    `;

    // Переключатель режима: значение сохраняем, чтобы выбор не сбрасывался
    // при каждом обновлении панели и после перезагрузки.
    document.getElementById('skills-mode-toggle')?.addEventListener('click', async () => {
      this.skillsPanelMode = (this.skillsPanelMode || 'active') === 'all' ? 'active' : 'all';
      const cur = (await this.agent.db.get('settings', 'display')) || { key: 'display' };
      await this.agent.db.put('settings', { ...cur, key: 'display', skillsPanelMode: this.skillsPanelMode });
      this.updateChatToolbar();
    });

    toolbar.querySelectorAll('.chip[data-skill]').forEach(chip => {
      chip.addEventListener('click', async () => {
        const skill = await this.agent.db.get('skills', chip.dataset.skill);
        if (skill.locked) return;
        skill.enabled = !skill.enabled;
        await this.agent.db.put('skills', skill);
        // В компактном режиме отключённый навык исчезает из панели —
        // это ожидаемо, но при первом разе выглядит как пропажа.
        // Показываем короткую подсказку, где его найти.
        if (!skill.enabled && (this.skillsPanelMode || 'active') === 'active' && !this._skillHideHintShown) {
          this._skillHideHintShown = true;
          const c = document.getElementById('chat-messages');
          c?.insertAdjacentHTML('beforeend',
            `<div class="message system">ℹ️ Навык «${this._escHtml(skill.name)}» отключён и скрыт из панели. ` +
            `Вернуть его можно кнопкой «все навыки».</div>`);
          c.scrollTop = c.scrollHeight;
        }
        this.updateChatToolbar();

        // Проверка привязанных инструментов — ТОЛЬКО в момент включения
        // навыка отсюда, и только один раз. Постоянный контроль здесь не
        // нужен: состояние инструментов пользователь меняет сам и видит
        // это на вкладке Tools, а навязчивое напоминание в каждом ответе
        // быстро превратилось бы в шум, который перестают читать.
        if (skill.enabled) await this._offerEnableSkillTools(skill);
      });
    });

    // Быстрая смена модели — меняет её и в памяти, и в сохранённых настройках,
    // чтобы выбор пережил перезагрузку (секреты при этом не трогаем).
    // Клик по чипу — выбор рабочей модели чата. Выбранной может быть
    // только одна: набор в чате нужен для быстрого переключения, а не
    // для одновременного использования.
    toolbar.querySelectorAll('.chip[data-model-ref]').forEach(chip => {
      chip.addEventListener('click', async () => {
        await this.setChatModel(chip.dataset.modelRef);
      });
      // Правая кнопка убирает модель из набора чата. Отдельного крестика
      // на чипе нет — он занимал бы место в и без того плотной панели.
      chip.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        await this.removeChatModel(chip.dataset.modelRef);
      });
    });

    document.getElementById('model-add-btn')?.addEventListener('click', () => this.showChatModelPicker());

    document.getElementById('tool-stats-chip')?.addEventListener('click', () => this.showChatStatsModal());
    document.getElementById('task-plan-chip')?.addEventListener('click', () => this.showTaskPlanModal());
  },


  // ── План задачи целиком ──
  // Тот же текст, что видит модель, только в человеческом виде: агент и
  // пользователь должны смотреть на одно и то же состояние работы.
  // Отсюда же план можно прекратить — если он больше не нужен, а агент
  // продолжает на него опираться.
  async showTaskPlanModal() {
    const plan = this.currentChatId ? await this.agent.tasks?.active(this.currentChatId) : null;
    if (!plan) {
      return this._showModal('🗂 План задачи',
        '<p style="color:var(--text-secondary);font-size:13px;">Активного плана нет.</p>', null);
    }

    const mark = { done: '✔', doing: '▶', failed: '✖', todo: '·' };
    const rows = plan.steps.map(s => `
      <div class="plan-step plan-${s.status}">
        <span class="plan-mark">${mark[s.status] || '·'}</span>
        <span class="plan-title">${s.n}. ${this._escHtml(s.title)}</span>
        ${s.note ? `<div class="plan-note">${this._escHtml(s.note)}</div>` : ''}
      </div>`).join('');

    const done = plan.steps.filter(s => s.status === 'done').length;
    this._showModal('🗂 План задачи', `
      <div class="form-group">
        <label>Цель</label>
        <div style="font-size:13px;">${this._escHtml(plan.goal)}</div>
      </div>
      <div class="form-group">
        <label>Шаги — готово ${done} из ${plan.steps.length}</label>
        <div class="plan-list">${rows}</div>
      </div>
      ${plan.facts.length ? `<div class="form-group">
        <label>Выяснено по ходу работы</label>
        <ul class="sec-risks">${plan.facts.map(f => `<li>${this._escHtml(f)}</li>`).join('')}</ul>
      </div>` : ''}
      <div style="font-size:11px;color:var(--text-muted);">
        План хранится отдельно от переписки, поэтому переживает подрезку контекста
        и перезагрузку страницы. Кнопка ниже закрывает его: агент перестанет
        получать эту сводку в каждом запросе.
      </div>
    `, async () => { await this.agent.tasks.finish(this.currentChatId, 'cancelled'); this.updateChatToolbar(); },
      null, { wide: true });

    // Кнопка «Сохранить» здесь означает «прекратить план» — подписываем
    // её честно, иначе пользователь нажмёт её, ожидая сохранения.
    const save = document.querySelector('#modals .btn-primary');
    if (save) save.textContent = 'Прекратить план';
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


  // Эффективный лимит окна контекста, по убыванию достоверности:
  //   1. окно, заданное у выбранной модели (пользователь указал его сам);
  //   2. подсказка по имени модели;
  //   3. 0 — неизвестно, индикатор заполнения не показывается.
  //
  // Ручной общий лимит убран: он был один на всё приложение и врал, как
  // только в чатах оказывались разные модели. Теперь окно — свойство
  // модели, а не приложения.
  // ref — необязательная явная ссылка на модель (id_провайдера::id_модели).
  // Без неё берётся то, что сейчас применено к общему шлюзу — подходит
  // для отображения (например, чипа в панели чата). С ref — описывает
  // конкретную модель конкретного чата независимо от того, что сейчас
  // может быть применено к шлюзу параллельным переключением на другой
  // чат (см. _trimHistory в ui-chat.js).
  effectiveContextLimit(ref) {
    const reg = this.agent.models;
    const d = reg && reg.describe(ref);
    if (d && d.contextWindow > 0) return d.contextWindow;
    const modelName = ref ? reg?.resolve(ref)?.model?.name : this.agent.llm.model;
    return this._knownContextLimit(modelName);
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
  async _recordContextSize(chatId, tokens, isEstimate) {
    return this._statsUpdate(chatId, (stats) => {
      stats.lastContextTokens = tokens;
      stats.lastContextEstimated = !!isEstimate;
    });
  },


  // Предупреждения о приближении к границе окна контекста.
  // Каждый уровень показывается один раз за чат, иначе сообщение
  // повторялось бы после каждого запроса и засоряло переписку.
  // chatId — чат, которому принадлежит этот ответ (не обязательно тот,
  // что сейчас на экране): DOM трогаем, только если это совпадает. ref —
  // ссылка на модель ИМЕННО этого чата (см. _trimHistory) — без неё лимит
  // считался бы по модели общего шлюза, а тот к этому моменту мог уже
  // переключиться на модель другого, параллельно просматриваемого чата.
  async _checkContextThresholds(chatId, contextTokens, ref) {
    const limit = this.effectiveContextLimit(ref);
    if (!limit || !contextTokens) return;

    const stats = await this._getChatStats(chatId);
    if (!stats) return;

    const percent = Math.round((contextTokens / limit) * 100);
    const warnAt = this.contextWarnPercent;
    const container = (chatId === this.currentChatId) ? document.getElementById('chat-messages') : null;

    // Достигнут максимум окна контекста
    if (percent >= 100 && stats.contextAlertLevel !== 'max') {
      // Через очередь: прямая запись затёрла бы счётчики, накопленные
      // параллельными обновлениями (объект прочитан раньше).
      await this._statsUpdate(chatId, (st) => { st.contextAlertLevel = 'max'; });
      if (container) {
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
      }
      return;
    }

    // Достигнут рекомендуемый порог
    if (percent >= warnAt && percent < 100 && !stats.contextAlertLevel) {
      await this._statsUpdate(chatId, (st) => { st.contextAlertLevel = 'warn'; });
      if (container) {
        container.insertAdjacentHTML('beforeend', `
          <div class="message system context-alert warn">
            ⚠️ Контекст заполнен на ${percent}% (${contextTokens.toLocaleString('ru-RU')} из ${limit.toLocaleString('ru-RU')} токенов).
            Дальше расходы растут, а качество ответов может падать — стоит завершить тему или начать новый чат.
          </div>`);
        container.scrollTop = container.scrollHeight;
      }
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


  async _recordUsage(chatId, usage, isEstimate = false) {
    return this._statsUpdate(chatId, (stats) => {
      stats.promptTokens += usage.prompt_tokens || 0;
      stats.completionTokens += usage.completion_tokens || 0;
      stats.totalTokens += usage.total_tokens ||
        ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
      stats.requests += 1;
      if (isEstimate) stats.estimated = true;
    });
  },


  async _recordToolCall(chatId, name, elapsedMs, isError) {
    return this._statsUpdate(chatId, (stats) => {
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
