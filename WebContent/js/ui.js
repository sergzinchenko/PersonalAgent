// ============================================================
//  UI MANAGER
// ============================================================
class UI {
  constructor(agent) {
    this.agent = agent;
    this.currentTab = 'chat';
    this.currentChatId = null;
    this.isStreaming = false;
    this.folderSelection = { tools: null, skills: null, prompts: null };

    // ── Ограничения работы агента при использовании tools ──
    // Применяются к ОДНОМУ ходу пользователя (цепочке tool_calls подряд).
    // Значения перекрываются сохранёнными настройками (settings/limits).
    this.limits = {
      maxToolSteps: 25,      // макс. итераций tool-calling подряд
      maxTurnSeconds: 180,   // общий бюджет времени на ход, сек (0 — без лимита)
      toolTimeoutSeconds: 30,// таймаут одного вызова инструмента, сек (0 — без лимита)
      maxToolCallsPerTurn: 50, // суммарный потолок вызовов за ход
    };

    // Степень детализации вывода вызовов инструментов в чат:
    // 'hidden' — не показывать, 'compact' — имя + краткий результат,
    // 'detailed' — имя, аргументы, полный результат, время выполнения.
    this.toolVerbosity = 'compact';

    // Счётчики текущего хода (сбрасываются в sendMessage)
    this._turnStartedAt = 0;
    this._turnToolCalls = 0;

    this.recognition = null;   // экземпляр SpeechRecognition (голосовой ввод)
    this.isListening = false;

    // Прерывание работы агента пользователем
    this._abortCtl = null;      // AbortController текущего запроса к LLM
    this._stopRequested = false;// флаг: прервать цепочку между шагами

    // Окно контекста модели. contextLimit=0 → определяем автоматически
    // по имени модели; contextWarnPercent — порог предупреждения.
    this.contextLimit = 0;
    this.contextWarnPercent = 75;

    this._bindGlobalEvents();
  }

  // === Global events ===
  _bindGlobalEvents() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    document.getElementById('settings-btn').addEventListener('click', () => this.showSettingsModal());
    document.getElementById('sidebar-new-btn').addEventListener('click', () => this._handleNewItem());
    document.getElementById('sidebar-search').addEventListener('input', (e) => this._handleSearch(e.target.value));

    const chatInput = document.getElementById('chat-input');
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
    });

    document.getElementById('send-btn').addEventListener('click', () => this.sendMessage());
    document.getElementById('voice-btn').addEventListener('click', () => this.toggleVoiceInput());
    document.getElementById('stop-btn').addEventListener('click', () => this.stopAgent());
    document.getElementById('add-tool-btn').addEventListener('click', () => this.showAddToolModal());
    document.getElementById('add-mcp-server-btn').addEventListener('click', () => this.showAddMCPServerModal());
    document.getElementById('add-skill-btn').addEventListener('click', () => this.showAddSkillModal());
    document.getElementById('add-prompt-btn').addEventListener('click', () => this.showAddPromptModal());
        // Кнопки создания папок
    document.getElementById('add-tool-folder-btn').addEventListener('click', () => this._createFolder('tools'));
    document.getElementById('add-skill-folder-btn').addEventListener('click', () => this._createFolder('skills'));
    document.getElementById('add-prompt-folder-btn').addEventListener('click', () => this._createFolder('prompts'));

    // Экспорт/импорт. Из шапки панели (Tools/Skills/Промпты) открывается
    // ВЫБОРОЧНЫЙ экспорт только этого раздела — с отметкой конкретных
    // объектов. Полный экспорт и любой импорт — только через
    // ⚙ Настройки → Отображение, чтобы случайное нажатие в панели
    // не перезаписало чужими данными всю базу.
    document.querySelectorAll('.export-import-btn').forEach(btn => {
      btn.addEventListener('click', () => this.showSelectiveExportModal(btn.dataset.section));
    });
  }

  // === Tab switching ===
  switchTab(tab) {
    this.currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`));

    this.refreshSidebar();
    if (tab === 'tools') this.renderTools();
    if (tab === 'skills') this.renderSkills();
    if (tab === 'prompts') this.renderPrompts();
  }

  // === Sidebar ===
  async refreshSidebar() {
    const list = document.getElementById('sidebar-list');
    const search = document.getElementById('sidebar-search').value.toLowerCase();

    if (this.currentTab === 'chat') {
      const chats = await this.agent.db.getAll('chats');
      chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const filtered = chats.filter(c => !search || c.title.toLowerCase().includes(search));

      list.innerHTML = filtered.map(c => `
        <div class="sidebar-item ${c.id === this.currentChatId ? 'active' : ''}" data-id="${c.id}">
          <span class="title">${this._escHtml(c.title)}</span>
          <button class="delete-btn" data-delete="${c.id}" title="Удалить">✕</button>
        </div>
      `).join('') || '<div class="empty-state"><div class="text">Нет чатов</div></div>';

      list.querySelectorAll('.sidebar-item').forEach(item => {
        item.addEventListener('click', (e) => {
          if (e.target.dataset.delete) return;
          this.loadChat(item.dataset.id);
        });
      });
      list.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.deleteChat(btn.dataset.delete);
        });
      });
    } else if (['tools', 'skills', 'prompts'].includes(this.currentTab)) {
      await this._renderSidebarTree(this.currentTab);
    } else {
      list.innerHTML = '';
    }
  }

  // === Дерево папок в сайдбаре ===
  async _renderSidebarTree(type) {
    const list = document.getElementById('sidebar-list');
    const search = document.getElementById('sidebar-search').value.toLowerCase();
    const folders = await this.agent.folders.all(type);

    const byParent = {};
    folders.forEach(f => { const k = f.parentId || 'root'; (byParent[k] = byParent[k] || []).push(f); });

    const selected = this.folderSelection[type];

    const build = (parentId) => {
      const key = parentId || 'root';
      const children = (byParent[key] || []).slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .filter(f => !search || f.name.toLowerCase().includes(search));
      if (!children.length) return '';
      let html = '<div class="tree-node-children">';
      for (const f of children) {
        const sel = f.id === selected ? 'selected' : '';
        const hasKids = (byParent[f.id] || []).length > 0;
        html += `
          <div class="tree-node">
            <div class="tree-node-row ${sel}" data-folder-id="${f.id}">
              <span class="tw-toggle">${hasKids ? '▾' : '•'}</span>
              <span class="tw-name">📁 ${this._escHtml(f.name)}</span>
              <span class="tw-actions">
                <button data-add-sub="${f.id}" title="Подпапка">＋</button>
                <button data-ren="${f.id}" title="Переименовать">✏</button>
                <button data-del="${f.id}" title="Удалить">✕</button>
              </span>
            </div>
            ${build(f.id)}
          </div>`;
      }
      html += '</div>';
      return html;
    };

    const rootSel = selected === null ? 'selected' : '';
    list.innerHTML = `
      <div class="tree-nav">
        <div class="tree-node">
          <div class="tree-node-row ${rootSel}" data-folder-id="">
            <span class="tw-toggle">▾</span>
            <span class="tw-name">🏠 Корень</span>
            <span class="tw-actions"><button data-add-sub="" title="Новая папка">＋</button></span>
          </div>
          ${build(null)}
        </div>
      </div>`;

    this._bindSidebarTree(type);
  }

  _bindSidebarTree(type) {
    const list = document.getElementById('sidebar-list');

    // Выбор папки / сворачивание
    list.querySelectorAll('.tree-node-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.tw-actions')) return;

        if (e.target.classList.contains('tw-toggle')) {
          const kids = row.nextElementSibling;
          if (kids && kids.classList.contains('tree-node-children')) {
            const collapsed = kids.classList.toggle('collapsed');
            e.target.textContent = collapsed ? '▸' : (kids.children.length ? '▾' : '•');
          }
          return;
        }

        this.folderSelection[type] = row.dataset.folderId || null;
        this.refreshSidebar();
        this._refreshPanel(type);
      });
    });

    // Действия с папками
    list.querySelectorAll('[data-add-sub]').forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = prompt('Название папки:');
      if (!name) return;
      const f = await this.agent.folders.create(type, name, b.dataset.addSub || null);
      this.folderSelection[type] = f.id;
      await this.refreshSidebar();
      this._refreshPanel(type);
    }));

    list.querySelectorAll('[data-ren]').forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const f = await this.agent.db.get('folders', b.dataset.ren);
      const name = prompt('Новое название папки:', f ? f.name : '');
      if (!name) return;
      await this.agent.folders.rename(b.dataset.ren, name);
      await this.refreshSidebar();
    }));

    list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Удалить папку? Вложенные элементы и подпапки переместятся на уровень выше.')) return;
      const fid = b.dataset.del;
      const folder = await this.agent.db.get('folders', fid);
      await this.agent.folders.remove(fid, type);
      if (this.folderSelection[type] === fid) this.folderSelection[type] = folder?.parentId || null;
      await this.refreshSidebar();
      this._refreshPanel(type);
    }));

    // Drag & Drop
    list.querySelectorAll('.tree-node-row').forEach(row => {
      const fid = row.dataset.folderId; // '' для корня

      if (fid) {
        row.setAttribute('draggable', 'true');
        row.addEventListener('dragstart', (e) => {
          e.stopPropagation();
          e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'folder', id: fid }));
          e.dataTransfer.effectAllowed = 'move';
        });
      }

      row.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); row.classList.add('drop-hover'); });
      row.addEventListener('dragleave', () => row.classList.remove('drop-hover'));
      row.addEventListener('drop', async (e) => {
        e.preventDefault(); e.stopPropagation();
        row.classList.remove('drop-hover');

        let data;
        try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
        const target = fid || null;

        if (data.kind === 'item') {
          const rec = await this.agent.db.get(type, data.id);
          if (rec) { rec.parentId = target; await this.agent.db.put(type, rec); }
        } else if (data.kind === 'folder') {
          await this.agent.folders.move(data.id, target);
        }
        await this.refreshSidebar();
        this._refreshPanel(type);
      });
    });
  }

  async _createFolder(type) {
    const name = prompt('Название новой папки:');
    if (!name) return;
    const f = await this.agent.folders.create(type, name, this.folderSelection[type] || null);
    this.folderSelection[type] = f.id;
    await this.refreshSidebar();
    this._refreshPanel(type);
  }

  _refreshPanel(type) {
    if (type === 'tools') return this.renderTools();
    if (type === 'skills') return this.renderSkills();
    if (type === 'prompts') return this.renderPrompts();
  }

  async _folderPath(type, id) {
    if (!id) return '🏠 Корень';
    const folders = await this.agent.folders.all(type);
    const map = {}; folders.forEach(f => map[f.id] = f);
    const parts = [];
    let cur = map[id];
    while (cur) { parts.unshift('📁 ' + this._escHtml(cur.name)); cur = cur.parentId ? map[cur.parentId] : null; }
    return '🏠 Корень / ' + parts.join(' / ');
  }

  // Плоский рендер карточек выбранной папки + DnD-источник
  async _renderPanelItems(type, mount, allItems, renderItemCard, bindItemEvents) {
    if (!mount) return;
    const sel = this.folderSelection[type];
    const items = allItems.filter(it => (it.parentId || null) === sel);
    const crumb = `<div class="folder-breadcrumb">${await this._folderPath(type, sel)}</div>`;

    const grid = items.length
      ? `<div class="tree-items">${items.map(it =>
          `<div class="tree-item-wrap" draggable="true" data-item-id="${it.id}">${renderItemCard(it)}</div>`
        ).join('')}</div>`
      : `<div class="tree-empty">В этой папке пусто. Нажмите «+ Создать» — элемент добавится сюда.</div>`;

    mount.innerHTML = crumb + grid;

    bindItemEvents(mount);
    mount.querySelectorAll('[data-item-id]').forEach(el => {
      el.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'item', id: el.dataset.itemId }));
        e.dataTransfer.effectAllowed = 'move';
      });
    });
  }

  _handleNewItem() {
    if (this.currentTab === 'chat') this.newChat();
    else if (this.currentTab === 'tools') this.showAddToolModal();
    else if (this.currentTab === 'skills') this.showAddSkillModal();
    else if (this.currentTab === 'prompts') this.showAddPromptModal();
  }

  _handleSearch(value) {
    this.refreshSidebar();
  }

  // === Chat ===
  async newChat() {
    const chat = {
      id: uid(),
      title: 'Новый чат',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      skillIds: [],
      model: this.agent.llm.model,
    };
    await this.agent.db.put('chats', chat);
    await this.loadChat(chat.id);
  }

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
  }

  _renderMessage(msg) {
    if (msg.role === 'tool') {
      return `<div class="message tool-call">🔧 Tool: ${this._escHtml(msg.name)} → ${this._escHtml(typeof msg.content === 'string' ? msg.content.substring(0, 200) : JSON.stringify(msg.content).substring(0, 200))}</div>`;
    }
    if (msg.role === 'system') {
      return `<div class="message system">${this._escHtml(msg.content?.substring(0, 100))}...</div>`;
    }
    const roleClass = msg.role === 'user' ? 'user' : 'assistant';
    const content = msg.role === 'assistant' ? renderMarkdown(msg.content) : this._escHtml(msg.content);
    return `<div class="message ${roleClass}">${content}</div>`;
  }

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
            ${s.icon} ${this._escHtml(s.name)}
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
  }

  // 128000 → «128k», 1000000 → «1M» — иначе чип занимает пол-панели.
  _fmtLimit(n) {
    if (!n) return '?';
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    return String(n);
  }

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
  }

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

    const userMsg = {
      id: uid(),
      chatId: this.currentChatId,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    await this.agent.db.put('messages', userMsg);

    const chat = await this.agent.db.get('chats', this.currentChatId);
    if (chat.title === 'Новый чат') {
      chat.title = text.substring(0, 50);
      await this.agent.db.put('chats', chat);
      this.refreshSidebar();
    }
    chat.updatedAt = Date.now();
    await this.agent.db.put('chats', chat);

    const container = document.getElementById('chat-messages');
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
    container.insertAdjacentHTML('beforeend', this._renderMessage(userMsg));
    container.scrollTop = container.scrollHeight;

    // Новый ход пользователя — обнуляем бюджет времени и счётчик вызовов,
    // которые действуют на всю цепочку tool_calls этого хода.
    this._turnStartedAt = Date.now();
    this._turnToolCalls = 0;
    this._stopRequested = false;

    await this._generateResponse();
  }

  // Останавливает ход и сообщает причину. Возвращает true — значит выше
  // по стеку нужно прекратить цепочку tool-calling.
  _stopTurn(container, reason) {
    container.insertAdjacentHTML('beforeend',
      `<div class="message system">⚠️ ${this._escHtml(reason)}</div>`);
    container.scrollTop = container.scrollHeight;
    this._setBusy(false);
  }

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
      };
      await this.agent.db.put('messages', assistantMsg);

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

    this.isStreaming = false;
    document.getElementById('send-btn').disabled = false;
    this.updateChatToolbar();
  }

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
  }

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
  }

  // Эффективный лимит: ручная настройка > таблица > 0 (неизвестно)
  effectiveContextLimit() {
    return this.contextLimit > 0
      ? this.contextLimit
      : this._knownContextLimit(this.agent.llm.model);
  }

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
  }

  _estimateUsage(apiMessages, result) {
    let promptChars = 0;
    for (const m of apiMessages) {
      promptChars += this._estimateTokens(m.content || '');
      if (m.tool_calls) promptChars += this._estimateTokens(JSON.stringify(m.tool_calls));
    }
    let completion = this._estimateTokens(result.content || '');
    if (result.tool_calls) completion += this._estimateTokens(JSON.stringify(result.tool_calls));
    return { prompt_tokens: promptChars, completion_tokens: completion };
  }

  // Сохраняем размер контекста последнего запроса — он показывается
  // в панели чата и переживает перезагрузку вместе со статистикой.
  async _recordContextSize(tokens, isEstimate) {
    const stats = await this._getChatStats(this.currentChatId);
    if (!stats) return;
    stats.lastContextTokens = tokens;
    stats.lastContextEstimated = !!isEstimate;
    await this.agent.db.put('chat_stats', stats);
  }

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
      stats.contextAlertLevel = 'max';
      await this.agent.db.put('chat_stats', stats);
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
      stats.contextAlertLevel = 'warn';
      await this.agent.db.put('chat_stats', stats);
      container.insertAdjacentHTML('beforeend', `
        <div class="message system context-alert warn">
          ⚠️ Контекст заполнен на ${percent}% (${contextTokens.toLocaleString('ru-RU')} из ${limit.toLocaleString('ru-RU')} токенов).
          Дальше расходы растут, а качество ответов может падать — стоит завершить тему или начать новый чат.
        </div>`);
      container.scrollTop = container.scrollHeight;
    }
  }

  // ── Персистентная техническая статистика чата (store 'chat_stats') ──
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
  }

  async _recordUsage(usage, isEstimate = false) {
    const stats = await this._getChatStats(this.currentChatId);
    if (!stats) return;
    stats.promptTokens += usage.prompt_tokens || 0;
    stats.completionTokens += usage.completion_tokens || 0;
    stats.totalTokens += usage.total_tokens ||
      ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
    stats.requests += 1;
    if (isEstimate) stats.estimated = true;
    await this.agent.db.put('chat_stats', stats);
  }

  async _recordToolCall(name, elapsedMs, isError) {
    const stats = await this._getChatStats(this.currentChatId);
    if (!stats) return;
    stats.toolCalls += 1;
    stats.toolTimeMs += elapsedMs;
    if (isError) stats.toolErrors += 1;
    const entry = stats.byTool[name] || { calls: 0, errors: 0, timeMs: 0 };
    entry.calls += 1;
    entry.timeMs += elapsedMs;
    if (isError) entry.errors += 1;
    stats.byTool[name] = entry;
    await this.agent.db.put('chat_stats', stats);
  }

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
  }

  // ── Выборочный экспорт одного раздела ──
  // Вызывается из шапки панели и учитывает, в какой папке пользователь
  // сейчас находится: по умолчанию предлагается текущая папка со всем
  // вложенным. Импорта здесь намеренно нет — он живёт только в полном
  // окне (⚙ Настройки → Отображение).
  async showSelectiveExportModal(section) {
    const titles = { tools: '🔧 инструментов', skills: '🧩 навыков', prompts: '📋 промптов' };
    if (!titles[section]) return this.showExportImportModal();

    let allItems = await this.agent.db.getAll(section);
    if (section === 'tools') allItems = allItems.filter(t => !t.builtin);
    const allFolders = (await this.agent.db.getAll('folders')).filter(f => f.type === section);

    const currentFolder = this.folderSelection[section] || null;
    const path = await this._folderPath(section, currentFolder);

    // Состояние модалки живёт здесь: переключение охвата перерисовывает
    // только список, не пересоздавая окно.
    // ВАЖНО: unchecked хранит id, которые пользователь СНЯЛ вручную.
    // Хранить именно снятые, а не отмеченные, нужно потому, что при
    // смене охвата в список приходят новые объекты — они должны быть
    // отмечены по умолчанию, а ранее снятые остаться снятыми.
    const state = {
      scope: currentFolder ? 'subtree' : 'all',
      unchecked: new Set(),
    };

    this._showModal(`⬆ Экспорт ${titles[section]}`, `
      <div class="form-group">
        <label>Откуда выгружать</label>
        <div class="folder-breadcrumb" style="margin-bottom:8px;">${path}</div>
        <select id="sel-scope">
          <option value="current">Только эта папка (без вложенных)</option>
          <option value="subtree">Эта папка со вложенными</option>
          <option value="all">Весь раздел целиком</option>
        </select>
      </div>
      <div class="form-group">
        <label>Объекты <span id="sel-count" style="color:var(--text-muted);font-weight:400;"></span></label>
        <div style="display:flex;gap:8px;margin:6px 0;">
          <button type="button" class="btn btn-secondary btn-sm" id="sel-all">Выделить все</button>
          <button type="button" class="btn btn-secondary btn-sm" id="sel-none">Снять все</button>
        </div>
        <div class="sel-list" id="sel-list"></div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">
          Папки отмеченных объектов выгружаются автоматически вместе со всей цепочкой родителей.
        </div>
      </div>
      <div class="form-group">
        <label>Пароль для шифрования архива</label>
        <input id="sel_pass" type="password" placeholder="минимум 8 символов">
      </div>
      <div class="form-group">
        <label>Повторите пароль</label>
        <input id="sel_pass2" type="password" placeholder="ещё раз">
      </div>
      <button class="btn btn-primary btn-sm" id="sel-export-btn">⬆ Скачать зашифрованный архив</button>
      <span id="sel-status" style="font-size:12px;margin-left:8px;"></span>
    `, null, null, { modal: true, wide: true });

    // Все папки-потомки заданной (для охвата «со вложенными»)
    const descendants = (rootId) => {
      const out = new Set([rootId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of allFolders) {
          if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
        }
      }
      return out;
    };

    const itemsForScope = () => {
      if (state.scope === 'all') return allItems;
      if (state.scope === 'current') {
        return allItems.filter(it => (it.parentId || null) === currentFolder);
      }
      // subtree
      if (!currentFolder) return allItems; // корень со вложенными = весь раздел
      const set = descendants(currentFolder);
      return allItems.filter(it => it.parentId && set.has(it.parentId));
    };

    const folderName = (id) => allFolders.find(x => x.id === id)?.name || null;

    const renderList = () => {
      const items = itemsForScope();
      // При смене охвата сохраняем ранее снятые галочки, а новые
      // элементы добавляем уже отмеченными.
      const list = document.getElementById('sel-list');
      if (!list) return;
      list.innerHTML = items.length ? items.map(it => `
        <label class="check-row">
          <input type="checkbox" class="sel-item" value="${this._escHtml(it.id)}" ${state.unchecked.has(it.id) ? '' : 'checked'}>
          <span>${it.icon ? it.icon + ' ' : ''}${this._escHtml(it.title || it.name || it.id)}</span>
          ${it.parentId ? `<span class="sel-folder">📁 ${this._escHtml(folderName(it.parentId) || '—')}</span>` : ''}
        </label>`).join('')
        : '<div style="color:var(--text-muted);font-size:13px;">В выбранной области нет объектов.</div>';

      list.querySelectorAll('.sel-item').forEach(b => {
        b.addEventListener('change', () => {
          if (b.checked) state.unchecked.delete(b.value); else state.unchecked.add(b.value);
          updateCount();
        });
      });
      updateCount();
    };

    const updateCount = () => {
      const boxes = Array.from(document.querySelectorAll('.sel-item'));
      const n = boxes.filter(b => b.checked).length;
      const el = document.getElementById('sel-count');
      if (el) el.textContent = `— выбрано ${n} из ${boxes.length}`;
    };

    setTimeout(() => {
      const scopeSel = document.getElementById('sel-scope');
      if (scopeSel) {
        scopeSel.value = state.scope;
        scopeSel.addEventListener('change', () => { state.scope = scopeSel.value; renderList(); });
      }
      document.getElementById('sel-all')?.addEventListener('click', () => {
        document.querySelectorAll('.sel-item').forEach(b => { b.checked = true; state.unchecked.delete(b.value); });
        updateCount();
      });
      document.getElementById('sel-none')?.addEventListener('click', () => {
        document.querySelectorAll('.sel-item').forEach(b => { b.checked = false; state.unchecked.add(b.value); });
        updateCount();
      });
      document.getElementById('sel-export-btn')?.addEventListener('click', () => this._doSelectiveExport(section));
      renderList();
    }, 50);
  }

  async _doSelectiveExport(section) {
    const status = document.getElementById('sel-status');
    const setErr = (msg) => { status.textContent = '❌ ' + msg; status.style.color = 'var(--danger)'; };

    const pass = document.getElementById('sel_pass').value;
    const pass2 = document.getElementById('sel_pass2').value;
    if (pass.length < 8) return setErr('пароль короче 8 символов');
    if (pass !== pass2) return setErr('пароли не совпадают');

    const chosenIds = new Set(
      Array.from(document.querySelectorAll('.sel-item')).filter(b => b.checked).map(b => b.value)
    );
    if (!chosenIds.size) return setErr('не выбрано ни одного объекта');

    status.textContent = '⏳ Шифрую...';
    status.style.color = 'var(--warning)';

    try {
      let items = (await this.agent.db.getAll(section)).filter(i => chosenIds.has(i.id));
      if (section === 'tools') {
        items = items.map(t => { const { mcpToken, ...rest } = t; return rest; });
      }

      // Выгружаем только те папки, которые реально нужны выбранным
      // объектам, — вместе со всей цепочкой родителей, иначе на импорте
      // подпапка осталась бы без своего родителя.
      // Ограничиваем разделом: папки tools/skills/prompts лежат в одном
      // store и различаются полем type.
      const allFolders = (await this.agent.db.getAll('folders')).filter(f => f.type === section);
      const byId = {};
      allFolders.forEach(f => { byId[f.id] = f; });
      const needed = new Set();
      for (const it of items) {
        let p = it.parentId;
        const guard = new Set();
        while (p && byId[p] && !guard.has(p)) {
          guard.add(p);
          needed.add(p);
          p = byId[p].parentId;
        }
      }

      const payload = {
        version: 1,
        createdAt: new Date().toISOString(),
        partial: true,
        sections: {
          [section]: { items, folders: allFolders.filter(f => needed.has(f.id)) },
        },
      };

      const envelope = await ArchiveCrypto.encryptPayload(payload, pass);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url;
      a.download = `ai-agent-${section}-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);

      status.textContent = `✅ Выгружено: ${items.length}, папок: ${payload.sections[section].folders.length}`;
      status.style.color = 'var(--success)';
    } catch (e) {
      setErr(e.message);
    }
  }

  // ──────────────────────────────────────────────
  //  ЭКСПОРТ / ИМПОРТ (tools, skills, prompts + папки)
  //  Архив шифруется паролем пользователя (ArchiveCrypto:
  //  PBKDF2-SHA256 → AES-GCM, см. crypto-utils.js).
  // ──────────────────────────────────────────────
  showExportImportModal() {
    this._showModal('📦 Экспорт / импорт', `
      <div class="settings-tabs">
        <button type="button" class="tab-btn settings-tab-btn active" data-settings-tab="export">⬆ Экспорт</button>
        <button type="button" class="tab-btn settings-tab-btn" data-settings-tab="import">⬇ Импорт</button>
      </div>

      <div class="settings-tab-panel" data-settings-panel="export">
        <div class="form-group">
          <label>Что выгружать</label>
          <label class="check-row"><input type="checkbox" id="exp_tools" checked> 🔧 Tools</label>
          <label class="check-row"><input type="checkbox" id="exp_skills" checked> 🧩 Skills</label>
          <label class="check-row"><input type="checkbox" id="exp_prompts" checked> 📋 Промпты</label>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            Структура папок выгружается автоматически для выбранных разделов.
          </div>
        </div>
        <div class="form-group">
          <label>Пароль для шифрования архива</label>
          <input id="exp_pass" type="password" placeholder="минимум 8 символов">
        </div>
        <div class="form-group">
          <label>Повторите пароль</label>
          <input id="exp_pass2" type="password" placeholder="ещё раз">
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">
          Файл можно расшифровать только этим паролем — восстановить его невозможно.
          Стойкость архива определяется тем, насколько сложный пароль вы выберете.
        </div>
        <button class="btn btn-primary btn-sm" id="do-export-btn">⬆ Скачать зашифрованный архив</button>
        <span id="exp-status" style="font-size:12px;margin-left:8px;"></span>
      </div>

      <div class="settings-tab-panel" data-settings-panel="import" hidden>
        <div class="form-group">
          <label>Файл архива (.json)</label>
          <input id="imp_file" type="file" accept="application/json,.json">
        </div>
        <div class="form-group">
          <label>Пароль архива</label>
          <input id="imp_pass" type="password" placeholder="пароль, заданный при экспорте">
        </div>
        <div class="form-group">
          <label>Режим импорта</label>
          <label class="check-row"><input type="radio" name="imp_mode" value="merge" checked> Добавить к существующим (дубликаты по id пропускаются)</label>
          <label class="check-row"><input type="radio" name="imp_mode" value="overwrite"> Перезаписать элементы с совпадающими id</label>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">
          Импортированные инструменты с собственным кодом всегда добавляются
          <strong>выключенными</strong> — включите их вручную после проверки кода.
        </div>
        <button class="btn btn-primary btn-sm" id="do-import-btn">⬇ Расшифровать и импортировать</button>
        <span id="imp-status" style="font-size:12px;margin-left:8px;"></span>
      </div>
    `, null, null, { modal: true, wide: true });

    setTimeout(() => {
      document.querySelectorAll('.settings-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.settings-tab-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          const target = btn.dataset.settingsTab;
          document.querySelectorAll('.settings-tab-panel').forEach((p) => {
            p.hidden = p.dataset.settingsPanel !== target;
          });
        });
      });

      document.getElementById('do-export-btn').addEventListener('click', () => this._doExport());
      document.getElementById('do-import-btn').addEventListener('click', () => this._doImport());
    }, 50);
  }

  async _doExport() {
    const status = document.getElementById('exp-status');
    const pass = document.getElementById('exp_pass').value;
    const pass2 = document.getElementById('exp_pass2').value;

    const setErr = (msg) => { status.textContent = '❌ ' + msg; status.style.color = 'var(--danger)'; };

    if (pass.length < 8) return setErr('пароль короче 8 символов');
    if (pass !== pass2) return setErr('пароли не совпадают');

    const want = {
      tools: document.getElementById('exp_tools').checked,
      skills: document.getElementById('exp_skills').checked,
      prompts: document.getElementById('exp_prompts').checked,
    };
    if (!want.tools && !want.skills && !want.prompts) return setErr('не выбран ни один раздел');

    status.textContent = '⏳ Шифрую...';
    status.style.color = 'var(--warning)';

    try {
      const payload = { version: 1, createdAt: new Date().toISOString(), sections: {} };
      const allFolders = await this.agent.db.getAll('folders');

      for (const [section, enabled] of Object.entries(want)) {
        if (!enabled) continue;
        let items = await this.agent.db.getAll(section);
        if (section === 'tools') {
          // Встроенные инструменты не выгружаем: они и так создаются
          // при первом запуске, а их id совпадут на любой установке.
          // mcpToken вырезаем — это секрет от чужого сервера, ему не место
          // в архиве, который пользователь может передать другому человеку.
          items = items.filter(t => !t.builtin).map(t => {
            const { mcpToken, ...rest } = t;
            return rest;
          });
        }
        payload.sections[section] = {
          items,
          folders: allFolders.filter(f => f.type === section),
        };
      }

      const envelope = await ArchiveCrypto.encryptPayload(payload, pass);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url;
      a.download = `ai-agent-archive-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);

      const counts = Object.entries(payload.sections)
        .map(([k, v]) => `${k}: ${v.items.length}`).join(', ');
      status.textContent = `✅ Готово (${counts})`;
      status.style.color = 'var(--success)';
    } catch (e) {
      setErr(e.message);
    }
  }

  async _doImport() {
    const status = document.getElementById('imp-status');
    const fileInput = document.getElementById('imp_file');
    const pass = document.getElementById('imp_pass').value;
    const mode = document.querySelector('input[name="imp_mode"]:checked')?.value || 'merge';

    const setErr = (msg) => { status.textContent = '❌ ' + msg; status.style.color = 'var(--danger)'; };

    if (!fileInput.files || !fileInput.files[0]) return setErr('файл не выбран');
    if (!pass) return setErr('введите пароль');

    status.textContent = '⏳ Расшифровываю...';
    status.style.color = 'var(--warning)';

    try {
      const text = await fileInput.files[0].text();
      let envelope;
      try { envelope = JSON.parse(text); }
      catch (e) { return setErr('файл не является корректным JSON'); }

      const payload = await ArchiveCrypto.decryptPayload(envelope, pass);

      let added = 0, skipped = 0, foldersAdded = 0, foldersReused = 0;

      for (const [section, block] of Object.entries(payload.sections || {})) {
        if (!['tools', 'skills', 'prompts'].includes(section)) continue;

        // ── Папки ──
        // Импортируем ДО элементов, чтобы их parentId указывал на реально
        // существующие записи. Сопоставление не только по id: одна и та же
        // по смыслу папка на другой машине имеет другой id, поэтому папку
        // с тем же именем на том же уровне ПЕРЕИСПОЛЬЗУЕМ, а не дублируем.
        const existingFolders = await this.agent.db.getAll('folders');

        // Старый id из архива → фактический id в этой базе.
        const folderIdMap = {};
        const incoming = block.folders || [];
        const incomingById = {};
        incoming.forEach(f => { incomingById[f.id] = f; });

        // Обрабатываем сверху вниз: родитель должен быть сопоставлен раньше
        // ребёнка, иначе уровень вложенности определится неверно.
        const depthOf = (f) => {
          let d = 0, p = f.parentId;
          const seen = new Set();
          while (p && incomingById[p] && !seen.has(p)) { seen.add(p); d++; p = incomingById[p].parentId; }
          return d;
        };
        const ordered = incoming.slice().sort((a, b) => depthOf(a) - depthOf(b));

        const norm = (s) => String(s || '').trim().toLowerCase();

        for (const f of ordered) {
          const mappedParent = f.parentId ? (folderIdMap[f.parentId] || f.parentId) : null;

          // 1) Совпадение по id — та же самая папка, ничего не создаём.
          const sameId = existingFolders.find(e => e.id === f.id);
          if (sameId && mode !== 'overwrite') {
            folderIdMap[f.id] = sameId.id;
            foldersReused++;
            continue;
          }

          // 2) Совпадение по имени на том же уровне и в том же разделе —
          //    переиспользуем существующую папку.
          const twin = existingFolders.find(e =>
            e.type === f.type &&
            (e.parentId || null) === (mappedParent || null) &&
            norm(e.name) === norm(f.name)
          );
          if (twin) {
            folderIdMap[f.id] = twin.id;
            foldersReused++;
            continue;
          }

          const record = { ...f, parentId: mappedParent };
          await this.agent.db.put('folders', record);
          existingFolders.push(record);
          folderIdMap[f.id] = record.id;
          foldersAdded++;
        }

        const existingItems = await this.agent.db.getAll(section);
        const existingIds = new Set(existingItems.map(i => i.id));

        for (const item of (block.items || [])) {
          if (existingIds.has(item.id) && mode !== 'overwrite') { skipped++; continue; }

          const record = { ...item };
          // parentId элемента тоже перемаппим — иначе он указывал бы на id
          // папки из чужой базы, которую мы переиспользовали под другим id.
          if (record.parentId) {
            record.parentId = folderIdMap[record.parentId] || record.parentId;
          }
          // Тот же принцип, что и для create_tool: чужой исполняемый код
          // не должен становиться активным без явного решения пользователя.
          if (section === 'tools' && record.handlerCode) record.enabled = false;

          await this.agent.db.put(section, record);
          added++;
        }
      }

      status.textContent = `✅ Импортировано: ${added}, папок создано: ${foldersAdded}` +
        `${foldersReused ? `, папок переиспользовано: ${foldersReused}` : ''}` +
        `${skipped ? `, пропущено: ${skipped}` : ''}`;
      status.style.color = 'var(--success)';

      await this.agent.tools.loadTools();
      this.renderTools();
      this.renderSkills();
      this.renderPrompts();
      this.refreshSidebar();
      this.updateChatToolbar();
    } catch (e) {
      setErr(e.message);
    }
  }

  // ── Прерывание работы агента пользователем ──
  // Работает на двух уровнях: abort() рвёт текущий HTTP-запрос к модели
  // (в том числе посреди стриминга), а флаг _stopRequested проверяется
  // между шагами цепочки — чтобы не начать следующую итерацию или
  // следующий вызов инструмента. Уже запущенный вызов инструмента
  // дождётся своего таймаута: прервать чужой код на полпути нельзя.
  stopAgent() {
    if (!this.isStreaming) return;
    this._stopRequested = true;
    try { this._abortCtl?.abort(); } catch (_) {}
    const container = document.getElementById('chat-messages');
    container.insertAdjacentHTML('beforeend',
      '<div class="message system">⏹ Работа агента прервана пользователем.</div>');
    container.scrollTop = container.scrollHeight;
  }

  // Единая точка переключения "агент занят / свободен":
  // раньше disabled у send-btn выставлялся в семи местах вразнобой.
  _setBusy(busy) {
    this.isStreaming = busy;
    const send = document.getElementById('send-btn');
    const stop = document.getElementById('stop-btn');
    if (send) send.disabled = busy;
    if (stop) stop.hidden = !busy;
  }

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
  }

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

  // ──────────────────────────────────────────────
  //  showSettingsModal — вызывается с modal: true,
  //  чтобы клик по оверлею НЕ закрывал окно.
  //  Настройки сгруппированы по вкладкам: Подключение / Модель / Журналирование.
  // ──────────────────────────────────────────────
  showSettingsModal() {
    const llm = this.agent.llm;
    const isBearerChecked = llm.authType !== 'custom' ? 'checked' : '';
    const isCustomChecked = llm.authType === 'custom' ? 'checked' : '';
    const customDisplay = llm.authType === 'custom' ? '' : 'display:none;';
    const bearerDisplay = llm.authType !== 'custom' ? '' : 'display:none;';

    this._showModal('⚙ Настройки', `
      <div class="settings-tabs">
        <button type="button" class="tab-btn settings-tab-btn active" data-settings-tab="connection">🔌 Подключение</button>
        <button type="button" class="tab-btn settings-tab-btn" data-settings-tab="model">🧠 Модель</button>
        <button type="button" class="tab-btn settings-tab-btn" data-settings-tab="limits">⏱ Ограничения</button>
        <button type="button" class="tab-btn settings-tab-btn" data-settings-tab="display">👁 Отображение</button>
        <button type="button" class="tab-btn settings-tab-btn" data-settings-tab="logging">🪵 Журналирование</button>
      </div>

      <div class="settings-tab-panel" data-settings-panel="connection">
        <div class="form-group">
          <label>API URL (OpenAI-compatible)</label>
          <input id="s_url" value="${this._escHtml(llm.apiUrl)}" placeholder="https://api.example.com/v1">
        </div>

        <div class="form-group">
          <label>Способ авторизации</label>
          <div style="display:flex;gap:16px;margin-top:4px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:var(--text-primary);">
              <input type="radio" name="auth_type" value="bearer" ${isBearerChecked} style="width:auto;"> Стандартный OpenAI (Bearer)
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:var(--text-primary);">
              <input type="radio" name="auth_type" value="custom" ${isCustomChecked} style="width:auto;"> Нестандартный заголовок
            </label>
          </div>
        </div>

        <div id="auth_bearer_section" style="${bearerDisplay}">
          <div class="form-group">
            <label>API Key</label>
            <input id="s_key" type="password" value="${this._escHtml(llm.apiKey)}" placeholder="sk-...">
          </div>
        </div>

        <div id="auth_custom_section" style="${customDisplay}">
          <div class="form-group">
            <label>Имя HTTP заголовка</label>
            <input id="s_custom_header" value="${this._escHtml(llm.customHeaderName)}" placeholder="X-API-Key">
          </div>
          <div class="form-group">
            <label>Значение заголовка</label>
            <input id="s_custom_value" type="password" value="${this._escHtml(llm.customHeaderValue)}" placeholder="your-secret-key">
          </div>
        </div>

        <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-success btn-sm" id="test-conn-btn">🔌 Тест и загрузка моделей</button>
          <span id="conn-result" style="font-size:12px;"></span>
        </div>
        <div id="models-status" style="margin-top:8px;font-size:12px;color:var(--text-muted);"></div>
      </div>

      <div class="settings-tab-panel" data-settings-panel="model" hidden>
        <div class="form-group">
          <label>Model</label>
          <div style="display:flex;gap:8px;">
            <select id="s_model_select" style="flex:1;">
              <option value="">-- Нажмите &quot;Загрузить модели&quot; на вкладке «Подключение» --</option>
            </select>
            <input id="s_model_manual" value="${this._escHtml(llm.model)}" placeholder="или введите вручную" style="flex:1;">
          </div>
          <div style="margin-top:4px;font-size:11px;color:var(--text-muted);">Выберите из списка или введите вручную. Приоритет у выпадающего списка.</div>
        </div>

        <div class="form-group">
          <label>Max Tokens</label>
          <input id="s_tokens" type="number" value="${llm.maxTokens}">
        </div>

        <div class="form-group">
          <label>Temperature (0-2)</label>
          <input id="s_temp" type="number" step="0.1" min="0" max="2" value="${llm.temperature}">
        </div>

        <div class="form-group">
          <label>Окно контекста модели, токенов</label>
          <input id="s_ctx_limit" type="number" min="0" value="${this.contextLimit}"
                 placeholder="0 — определять автоматически">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            0 — определяется по названию модели${this._knownContextLimit(llm.model) ? ` (сейчас: ${this._fmtLimit(this._knownContextLimit(llm.model))})` : ' (для этой модели не распознано — укажите вручную)'}.
            API обычно не сообщает этот лимит, поэтому значение задаётся здесь.
          </div>
        </div>

        <div class="form-group">
          <label>Предупреждать при заполнении контекста, %</label>
          <input id="s_ctx_warn" type="number" min="1" max="99" value="${this.contextWarnPercent}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            При достижении этого порога появится предупреждение, при 100% — предложение создать новый чат.
          </div>
        </div>
      </div>

      <div class="settings-tab-panel" data-settings-panel="limits" hidden>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
          Ограничения применяются к одному ответу агента — то есть ко всей цепочке
          вызовов инструментов, запущенной вашим сообщением. 0 — без ограничения.
        </div>
        <div class="settings-grid">
        <div class="form-group">
          <label>Максимум итераций с вызовом инструментов</label>
          <input id="s_max_steps" type="number" min="0" value="${this.limits.maxToolSteps}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            Сколько раз подряд модель может вызвать инструменты и получить ответ. Защита от зацикливания.
          </div>
        </div>
        <div class="form-group">
          <label>Бюджет времени на ответ, секунд</label>
          <input id="s_max_turn_sec" type="number" min="0" value="${this.limits.maxTurnSeconds}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            По истечении запрос к модели прерывается, цепочка останавливается.
          </div>
        </div>
        <div class="form-group">
          <label>Таймаут одного вызова инструмента, секунд</label>
          <input id="s_tool_timeout_sec" type="number" min="0" value="${this.limits.toolTimeoutSeconds}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            Зависший инструмент вернёт ошибку таймаута вместо бесконечного ожидания.
          </div>
        </div>
        <div class="form-group">
          <label>Максимум вызовов инструментов за ответ</label>
          <input id="s_max_calls" type="number" min="0" value="${this.limits.maxToolCallsPerTurn}">
        </div>
        </div>
      </div>

      <div class="settings-tab-panel" data-settings-panel="display" hidden>
        <div class="form-group">
          <label>Детализация вызовов инструментов в чате</label>
          <select id="s_tool_verbosity">
            <option value="hidden" ${this.toolVerbosity === 'hidden' ? 'selected' : ''}>Скрывать — не показывать вызовы</option>
            <option value="compact" ${this.toolVerbosity === 'compact' ? 'selected' : ''}>Кратко — имя и начало результата</option>
            <option value="detailed" ${this.toolVerbosity === 'detailed' ? 'selected' : ''}>Подробно — аргументы, полный результат, время</option>
          </select>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            Влияет только на отображение. Вызовы выполняются и сохраняются в истории в любом случае.
          </div>
        </div>
        <div class="form-group">
          <label>Данные</label>
          <button class="btn btn-secondary btn-sm" id="open-export-import-btn">📦 Экспорт / импорт tools, skills, промптов</button>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            Архив шифруется паролем, структура папок сохраняется.
          </div>
        </div>
      </div>

      <div class="settings-tab-panel" data-settings-panel="logging" hidden>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
          Подробное логирование в консоль браузера (DevTools). Полезно для отладки,
          но может писать в консоль содержимое переписки и аргументов инструментов —
          по умолчанию выключено.
        </div>

        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="s_debug_llm" style="width:auto;" ${this.agent.llm.debug ? 'checked' : ''}>
            Запросы/ответы LLM (llm-gateway)
          </label>
          <div style="margin-top:2px;font-size:11px;color:var(--text-muted);">
            Эндпоинт, заголовки (ключ маскируется), тело запроса, сообщения, стрим-чанки, usage.
          </div>
        </div>

        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="s_debug_tools" style="width:auto;" ${this.agent.tools.debug ? 'checked' : ''}>
            Вызовы инструментов (tools-engine)
          </label>
          <div style="margin-top:2px;font-size:11px;color:var(--text-muted);">
            Какой tool вызван, с какими аргументами, что вернул.
          </div>
        </div>
      </div>
    `, async () => {
      const selectVal = document.getElementById('s_model_select').value;
      const manualVal = document.getElementById('s_model_manual').value.trim();
      const finalModel = selectVal || manualVal;

      const authType = document.querySelector('input[name="auth_type"]:checked')?.value || 'bearer';

      const config = {
        apiUrl: document.getElementById('s_url').value.trim(),
        apiKey: document.getElementById('s_key').value.trim(),
        model: finalModel,
        maxTokens: parseInt(document.getElementById('s_tokens').value) || 4096,
        temperature: parseFloat(document.getElementById('s_temp').value) || 0.7,
        authType: authType,
        customHeaderName: document.getElementById('s_custom_header').value.trim(),
        customHeaderValue: document.getElementById('s_custom_value').value.trim(),
      };
      llm.configure(config); // в памяти держим и используем расшифрованные значения как есть

      // Перед записью в IndexedDB шифруем секреты (apiKey/customHeaderValue)
      // через SecretsVault (crypto-utils.js) — в самой БД они не должны
      // лежать простым текстом. В памяти у `llm` остаются как обычные строки.
      const storedConfig = {
        ...config,
        apiKey: await SecretsVault.encrypt(this.agent.db, config.apiKey),
        customHeaderValue: await SecretsVault.encrypt(this.agent.db, config.customHeaderValue),
      };
      await this.agent.db.put('settings', { key: 'llm', ...storedConfig });

      // Окно контекста: ручной лимит и порог предупреждения.
      this.contextLimit = Math.max(0, parseInt(document.getElementById('s_ctx_limit').value) || 0);
      this.contextWarnPercent = Math.min(99, Math.max(1, parseInt(document.getElementById('s_ctx_warn').value) || 75));
      await this.agent.db.put('settings', {
        key: 'context',
        contextLimit: this.contextLimit,
        contextWarnPercent: this.contextWarnPercent,
      });

      // Ограничения работы агента при использовании tools.
      const limits = {
        maxToolSteps: Math.max(0, parseInt(document.getElementById('s_max_steps').value) || 0),
        maxTurnSeconds: Math.max(0, parseInt(document.getElementById('s_max_turn_sec').value) || 0),
        toolTimeoutSeconds: Math.max(0, parseInt(document.getElementById('s_tool_timeout_sec').value) || 0),
        maxToolCallsPerTurn: Math.max(0, parseInt(document.getElementById('s_max_calls').value) || 0),
      };
      this.limits = limits;
      await this.agent.db.put('settings', { key: 'limits', ...limits });

      // Отображение хода вызова инструментов.
      this.toolVerbosity = document.getElementById('s_tool_verbosity').value;
      await this.agent.db.put('settings', { key: 'display', toolVerbosity: this.toolVerbosity });

      // Журналирование: значения не секретные, храним как есть (без шифрования).
      const loggingConfig = {
        llmDebug: document.getElementById('s_debug_llm').checked,
        toolsDebug: document.getElementById('s_debug_tools').checked,
      };
      this.agent.llm.debug = loggingConfig.llmDebug;
      this.agent.tools.debug = loggingConfig.toolsDebug;
      await this.agent.db.put('settings', { key: 'logging', ...loggingConfig });

      this.updateConnectionStatus();
      this.updateModelDisplay();
      this.updateChatToolbar();
    }, null, { modal: true, wide: true }); // ← strict modal: overlay click does NOT close

    setTimeout(() => {
      // --- Переключение вкладок ---
      document.querySelectorAll('.settings-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.settings-tab-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          const target = btn.dataset.settingsTab;
          document.querySelectorAll('.settings-tab-panel').forEach((p) => {
            p.hidden = p.dataset.settingsPanel !== target;
          });
        });
      });

      document.getElementById('open-export-import-btn')?.addEventListener('click', () => {
        this.showExportImportModal();
      });

      document.querySelectorAll('input[name="auth_type"]').forEach(function(radio) {
        radio.addEventListener('change', function() {
          var isBearerSelected = this.value === 'bearer';
          document.getElementById('auth_bearer_section').style.display = isBearerSelected ? '' : 'none';
          document.getElementById('auth_custom_section').style.display = isBearerSelected ? 'none' : '';
        });
      });

      if (llm.availableModels.length > 0) {
        var sel = document.getElementById('s_model_select');
        sel.innerHTML = '<option value="">-- Выберите модель --</option>';
        llm.availableModels.forEach(function(m) {
          var opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          if (m === llm.model) opt.selected = true;
          sel.appendChild(opt);
        });
      }

      document.getElementById('s_model_select').addEventListener('change', function() {
        if (this.value) {
          document.getElementById('s_model_manual').value = this.value;
        }
      });

      document.getElementById('test-conn-btn').addEventListener('click', async function() {
        var resultEl = document.getElementById('conn-result');
        var modelsEl = document.getElementById('models-status');
        resultEl.textContent = '⏳ Проверяю...';
        resultEl.style.color = 'var(--warning)';
        modelsEl.textContent = '';

        var tmpUrl = document.getElementById('s_url').value.trim();
        var authType = document.querySelector('input[name="auth_type"]:checked')?.value || 'bearer';
        var headers = { 'Content-Type': 'application/json' };

        if (authType === 'custom') {
          var hName = document.getElementById('s_custom_header').value.trim();
          var hVal = document.getElementById('s_custom_value').value.trim();
          if (hName) headers[hName] = hVal;
        } else {
          var key = document.getElementById('s_key').value.trim();
          if (key) headers['Authorization'] = 'Bearer ' + key;
        }

        try {
          var models = await llm.fetchModels(tmpUrl, headers);

          resultEl.textContent = '✅ Подключено!';
          resultEl.style.color = 'var(--success)';
          modelsEl.textContent = 'Найдено моделей: ' + models.length;

          var sel = document.getElementById('s_model_select');
          sel.innerHTML = '<option value="">-- Выберите модель --</option>';

          var currentModel = document.getElementById('s_model_manual').value.trim();

          models.forEach(function(m) {
            var opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (m === currentModel) opt.selected = true;
            sel.appendChild(opt);
          });

          if (models.length > 0 && !currentModel) {
            sel.selectedIndex = 1;
            document.getElementById('s_model_manual').value = models[0];
          }

        } catch (e) {
          resultEl.textContent = '❌ Ошибка: ' + e.message;
          resultEl.style.color = 'var(--danger)';
          modelsEl.textContent = '';
        }
      });
    }, 50);
  }

  // Промис-обёртка над модальным окном для вопроса от агента (tool ask_user)
  askUser(question, defaultValue = '') {
    return new Promise((resolve) => {
      let resolved = false;

      this._showModal('❓ Вопрос от агента', `
        <p style="color:var(--text-secondary);font-size:13px;margin-bottom:12px;white-space:pre-wrap;">${this._escHtml(question)}</p>
        <div class="form-group">
          <label>Ваш ответ</label>
          <textarea id="ask_user_input" rows="3" placeholder="Введите ответ...">${this._escHtml(defaultValue)}</textarea>
        </div>
      `, async () => {
        // «Сохранить»
        resolved = true;
        const val = document.getElementById('ask_user_input')?.value ?? '';
        resolve({ answered: true, answer: val });
      }, () => {
        // «Отмена» / закрытие
        if (!resolved) resolve({ answered: false, answer: null });
      }, { modal: true }); // strict: клик по оверлею не закрывает окно

      // Автофокус + отправка по Ctrl/Cmd+Enter
      setTimeout(() => {
        const input = document.getElementById('ask_user_input');
        if (!input) return;
        input.focus();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            document.querySelector('.modal-actions .btn-primary')?.click();
          }
        });
      }, 50);
    });
  }
  // ══════════════════════════════════════════════
  //  _showModal — универсальный метод
  //
  //  options.modal  (bool, default false)
  //    true  → окно НЕ закрывается по клику на оверлей
  //    false → окно закрывается по клику на оверлей
  //            (прежнее поведение)
  // ══════════════════════════════════════════════
  _showModal(title, bodyHtml, onSave, onCancel, options = {}) {
    const { modal = false, wide = false } = options;
    const id = 'modal_' + uid();
    const modals = document.getElementById('modals');
    modals.innerHTML = `
      <div class="modal-overlay" id="${id}">
        <div class="modal${wide ? ' modal-wide' : ''}">
          <h2>${title}</h2>
          ${bodyHtml}
          <div class="modal-actions">
            <button class="btn btn-secondary" id="${id}_cancel">Отмена</button>
            <button class="btn btn-primary" id="${id}_save">Сохранить</button>
          </div>
        </div>
      </div>
    `;

    // «Отмена» — всегда закрывает
    document.getElementById(`${id}_cancel`).addEventListener('click', () => {
      modals.innerHTML = '';
      onCancel?.();
    });

    // Клик по оверлею — только если НЕ strict modal
    if (!modal) {
      document.getElementById(id).addEventListener('click', (e) => {
        if (e.target.id === id) { modals.innerHTML = ''; onCancel?.(); }
      });
    }

    // «Сохранить»
    document.getElementById(`${id}_save`).addEventListener('click', async () => {
      await onSave?.();
      modals.innerHTML = '';
    });

    return id;
  }

  updateConnectionStatus() {
    const dot = document.querySelector('#connection-status .status-dot');
    dot.className = 'status-dot ' + (this.agent.llm.isConfigured() ? 'online' : 'offline');
  }

  updateModelDisplay() {
    var existing = document.getElementById('model-badge');
    if (existing) existing.remove();

    if (this.agent.llm.model) {
      var badge = document.createElement('span');
      badge.id = 'model-badge';
      badge.style.cssText = 'font-size:11px; padding:3px 10px; background:var(--bg-tertiary); border:1px solid var(--border); border-radius:20px; color:var(--accent-light); white-space:nowrap; max-width:200px; overflow:hidden; text-overflow:ellipsis;';
      badge.textContent = '🤖 ' + this.agent.llm.model;
      badge.title = 'Текущая модель: ' + this.agent.llm.model;
      var settingsBtn = document.getElementById('settings-btn');
      settingsBtn.parentNode.insertBefore(badge, settingsBtn);
    }
  }

  showAddToolModal(editId = null) {
    const isEdit = !!editId;
    const title = isEdit ? 'Редактировать Tool' : 'Добавить Tool';

    const loadAndShow = async () => {
      const tool = isEdit ? await this.agent.db.get('tools', editId) : null;

      this._showModal(title, `
        <div class="form-group">
          <label>Имя функции (name)</label>
          <input id="t_name" value="${tool ? this._escHtml(tool.name) : ''}" placeholder="my_custom_tool">
        </div>
        <div class="form-group">
          <label>Описание</label>
          <textarea id="t_desc" rows="2">${tool ? this._escHtml(tool.description) : ''}</textarea>
        </div>
        <div class="form-group">
          <label>Parameters (JSON Schema)</label>
          <textarea id="t_params" rows="6">${tool ? JSON.stringify(tool.parameters, null, 2) : '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}'}</textarea>
        </div>
        <div class="form-group">
          <label>Handler Code (JavaScript, получает params)</label>
          <textarea id="t_handler" rows="5">${tool?.handlerCode || '// return { result: params.input };\n'}</textarea>
        </div>
      `, async () => {
        const id = isEdit ? editId : 'custom_' + uid();
        let params;
        try { params = JSON.parse(document.getElementById('t_params').value); }
        catch { params = { type: 'object', properties: {}, required: [] }; }

        const toolObj = {
          id,
          name: document.getElementById('t_name').value.trim(),
          description: document.getElementById('t_desc').value.trim(),
          parameters: params,
          handlerCode: document.getElementById('t_handler').value,
          enabled: tool?.enabled ?? true,
          builtin: false,
          parentId: isEdit ? (tool?.parentId ?? null) : (this.folderSelection.tools || null),
        };
        await this.agent.db.put('tools', toolObj);
        this.agent.tools.unregisterHandler(id);   // ← сбрасываем stale-handler из registry       
        this.renderTools();
      });
    };
    loadAndShow();
  }

  showAddMCPServerModal() {
    this._showModal('Подключить MCP Server', `
      <p style="color:var(--text-secondary);font-size:13px;margin-bottom:16px;">
        MCP (Model Context Protocol) сервер выставляет tools через HTTP.<br>
        Укажите URL до MCP-совместимого эндпоинта.
      </p>
      <div class="form-group">
        <label>MCP Server URL</label>
        <input id="mcp_url" placeholder="http://localhost:3000/mcp">
      </div>
      <div class="form-group">
        <label>Auth Token (опционально)</label>
        <input id="mcp_token" type="password" placeholder="Bearer token">
      </div>
    `, async () => {
      const url = document.getElementById('mcp_url').value.trim();
      const token = document.getElementById('mcp_token').value.trim();
      if (!url) return;

      try {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
        });

        const data = await resp.json();
        const mcpTools = data.result?.tools || [];

        for (const mt of mcpTools) {
          const toolObj = {
            id: 'mcp_' + uid(),
            name: mt.name,
            description: mt.description || '',
            parameters: mt.inputSchema || { type: 'object', properties: {}, required: [] },
            enabled: true,
            builtin: false,
            mcpServer: url,
            // Токен шифруется перед сохранением в IndexedDB (SecretsVault,
            // crypto-utils.js). Для регистрации handler'а ниже используем
            // ещё не зашифрованный `token`, который уже есть в памяти.
            mcpToken: await SecretsVault.encrypt(this.agent.db, token),
          };
          await this.agent.db.put('tools', toolObj);
          // Общий метод: та же логика используется при восстановлении
          // MCP-обработчиков на старте приложения в ToolsEngine.loadTools().
          this.agent.tools._registerMcpHandler({ ...toolObj, mcpToken: token });
        }

        alert(`Импортировано ${mcpTools.length} tools с MCP-сервера`);
        this.renderTools();
      } catch (e) {
        alert('Ошибка подключения к MCP серверу: ' + e.message);
      }
    });
  }

  showAddSkillModal(editId = null) {
    const loadAndShow = async () => {
      const skill = editId ? await this.agent.db.get('skills', editId) : null;
      const title = skill ? 'Редактировать Skill' : 'Новый Skill';

      this._showModal(title, `
        <div class="form-group">
          <label>Иконка</label>
          <input id="sk_icon" value="${skill?.icon || '🤖'}" maxlength="4" style="width:60px">
        </div>
        <div class="form-group">
          <label>Название</label>
          <input id="sk_name" value="${skill ? this._escHtml(skill.name) : ''}" placeholder="Мой навык">
        </div>
        <div class="form-group">
          <label>Описание</label>
          <input id="sk_desc" value="${skill ? this._escHtml(skill.description) : ''}" placeholder="Краткое описание">
        </div>
        <div class="form-group">
          <label>Категория</label>
          <select id="sk_cat">
            <option value="development" ${skill?.category === 'development' ? 'selected' : ''}>Development</option>
            <option value="content" ${skill?.category === 'content' ? 'selected' : ''}>Content</option>
            <option value="analysis" ${skill?.category === 'analysis' ? 'selected' : ''}>Analysis</option>
            <option value="custom" ${skill?.category === 'custom' ? 'selected' : ''}>Custom</option>
          </select>
        </div>
        <div class="form-group">
          <label>System Prompt</label>
          <textarea id="sk_prompt" rows="6">${skill ? this._escHtml(skill.systemPrompt) : ''}</textarea>
        </div>
      `, async () => {
        const obj = {
          id: editId || 'skill_' + uid(),
          icon: document.getElementById('sk_icon').value || '🤖',
          name: document.getElementById('sk_name').value.trim(),
          description: document.getElementById('sk_desc').value.trim(),
          category: document.getElementById('sk_cat').value,
          systemPrompt: document.getElementById('sk_prompt').value.trim(),
          enabled: skill?.enabled ?? false,
          parentId: editId ? (skill?.parentId ?? null) : (this.folderSelection.skills || null),
        };
        await this.agent.db.put('skills', obj);
        this.renderSkills();
        this.updateChatToolbar();
      });
    };
    loadAndShow();
  }

  showAddPromptModal(editId = null) {
    const loadAndShow = async () => {
      const prompt = editId ? await this.agent.db.get('prompts', editId) : null;
      const title = prompt ? 'Редактировать промпт' : 'Новый промпт';

      this._showModal(title, `
        <div class="form-group">
          <label>Название</label>
          <input id="pr_title" value="${prompt ? this._escHtml(prompt.title) : ''}" placeholder="Название промпта">
        </div>
        <div class="form-group">
          <label>Категория</label>
          <select id="pr_cat">
            <option value="development" ${prompt?.category === 'development' ? 'selected' : ''}>Development</option>
            <option value="content" ${prompt?.category === 'content' ? 'selected' : ''}>Content</option>
            <option value="analysis" ${prompt?.category === 'analysis' ? 'selected' : ''}>Analysis</option>
            <option value="learning" ${prompt?.category === 'learning' ? 'selected' : ''}>Learning</option>
            <option value="custom" ${prompt?.category === 'custom' ? 'selected' : ''}>Custom</option>
          </select>
        </div>
        <div class="form-group">
          <label>Теги (через запятую)</label>
          <input id="pr_tags" value="${prompt?.tags?.join(', ') || ''}" placeholder="тег1, тег2">
        </div>
        <div class="form-group">
          <label>Контент (используйте {{variable}} для переменных)</label>
          <textarea id="pr_content" rows="8">${prompt ? this._escHtml(prompt.content) : ''}</textarea>
        </div>
      `, async () => {
        const content = document.getElementById('pr_content').value;
        const variables = [...new Set((content.match(/\{\{(\w+)\}\}/g) || []).map(v => v.replace(/\{\{|\}\}/g, '')))];
        const obj = {
          id: editId || 'p_' + uid(),
          title: document.getElementById('pr_title').value.trim(),
          category: document.getElementById('pr_cat').value,
          tags: document.getElementById('pr_tags').value.split(',').map(s => s.trim()).filter(Boolean),
          content,
          variables,
          createdAt: prompt?.createdAt || Date.now(),
          parentId: editId ? (prompt?.parentId ?? null) : (this.folderSelection.prompts || null),
        };
        await this.agent.db.put('prompts', obj);
        this.renderPrompts();
        this.refreshSidebar();
      });
    };
    loadAndShow();
  }

  // === Helpers ===
  _escHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

   async renderTools() {
    const tools = await this.agent.tools.loadTools();
    const mount = document.getElementById('tools-grid');

    const renderCard = (t) => `
      <div class="tool-card" data-id="${t.id}">
        <div class="tool-header">
          <span class="tool-name">${this._escHtml(t.name)}</span>
          <label class="toggle-switch">
            <input type="checkbox" ${t.enabled ? 'checked' : ''} data-toggle="${t.id}">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="tool-desc">${this._escHtml(t.description)}</div>
        <div class="tool-params">${this._escHtml(JSON.stringify(t.parameters, null, 2))}</div>
        ${!t.builtin ? `<div style="margin-top:12px; display:flex; gap:8px;">
          <button class="btn btn-secondary btn-sm" data-edit-tool="${t.id}">✏ Редактировать</button>
          <button class="btn btn-danger btn-sm" data-del-tool="${t.id}">Удалить</button>
        </div>` : ''}
      </div>`;

    const bind = (scope) => {
      scope.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('change', async () => {
        const tool = await this.agent.db.get('tools', el.dataset.toggle);
        tool.enabled = el.checked; await this.agent.db.put('tools', tool);
      }));
      scope.querySelectorAll('[data-edit-tool]').forEach(el => el.addEventListener('click', () => this.showAddToolModal(el.dataset.editTool)));
      scope.querySelectorAll('[data-del-tool]').forEach(el => el.addEventListener('click', async () => {
        await this.agent.db.delete('tools', el.dataset.delTool); this.renderTools();
      }));
    };

    await this._renderPanelItems('tools', mount, tools, renderCard, bind);
  }

  async renderSkills() {
    const skills = await this.agent.skills.loadSkills();
    const mount = document.getElementById('skills-container');

    const renderCard = (s) => `
      <div class="tool-card" data-id="${s.id}">
        <div class="tool-header">
          <span class="tool-name">${s.icon} ${this._escHtml(s.name)}</span>
          <label class="toggle-switch">
            <input type="checkbox" ${s.enabled ? 'checked' : ''} data-skill-toggle="${s.id}">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="tool-desc">${this._escHtml(s.description)}</div>
        <div class="tool-params" style="white-space:pre-wrap">${this._escHtml(s.systemPrompt)}</div>
        <div style="margin-top:12px; display:flex; gap:8px;">
          <button class="btn btn-secondary btn-sm" data-edit-skill="${s.id}">✏ Редактировать</button>
          <button class="btn btn-danger btn-sm" data-del-skill="${s.id}">Удалить</button>
        </div>
      </div>`;

    const bind = (scope) => {
      scope.querySelectorAll('[data-skill-toggle]').forEach(el => el.addEventListener('change', async () => {
        const skill = await this.agent.db.get('skills', el.dataset.skillToggle);
        skill.enabled = el.checked; await this.agent.db.put('skills', skill);
      }));
      scope.querySelectorAll('[data-edit-skill]').forEach(el => el.addEventListener('click', () => this.showAddSkillModal(el.dataset.editSkill)));
      scope.querySelectorAll('[data-del-skill]').forEach(el => el.addEventListener('click', async () => {
        await this.agent.db.delete('skills', el.dataset.delSkill); this.renderSkills();
      }));
    };

    await this._renderPanelItems('skills', mount, skills, renderCard, bind);
  }

  async renderPrompts() {
    const prompts = await this.agent.prompts.loadPrompts();
    const mount = document.getElementById('prompts-container');

    const renderCard = (p) => `
      <div class="prompt-card" data-prompt-id="${p.id}">
        <div class="prompt-title">${this._escHtml(p.title)}</div>
        <div class="prompt-preview">${this._escHtml(p.content)}</div>
        <div class="prompt-tags">${(p.tags || []).map(t => `<span class="tag">${this._escHtml(t)}</span>`).join('')}</div>
        <div style="margin-top:8px; display:flex; gap:4px;">
          <button class="btn btn-primary btn-sm" data-use-prompt="${p.id}">Использовать</button>
          <button class="btn btn-secondary btn-sm" data-edit-prompt="${p.id}">✏</button>
          <button class="btn btn-danger btn-sm" data-del-prompt="${p.id}">✕</button>
        </div>
      </div>`;

    const bind = (scope) => {
      scope.querySelectorAll('[data-use-prompt]').forEach(el => el.addEventListener('click', () => this.usePrompt(el.dataset.usePrompt)));
      scope.querySelectorAll('[data-edit-prompt]').forEach(el => el.addEventListener('click', () => this.showAddPromptModal(el.dataset.editPrompt)));
      scope.querySelectorAll('[data-del-prompt]').forEach(el => el.addEventListener('click', async () => {
        await this.agent.db.delete('prompts', el.dataset.delPrompt); this.renderPrompts();
      }));
    };

    await this._renderPanelItems('prompts', mount, prompts, renderCard, bind);
  }
}