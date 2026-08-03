// ============================================================
//  UI MANAGER
// ============================================================
class UI {
  constructor(agent) {
    this.agent = agent;
    this.currentTab = 'chat';
    this.currentChatId = null;
    this.isStreaming = false;
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
    document.getElementById('add-tool-btn').addEventListener('click', () => this.showAddToolModal());
    document.getElementById('add-mcp-server-btn').addEventListener('click', () => this.showAddMCPServerModal());
    document.getElementById('add-skill-btn').addEventListener('click', () => this.showAddSkillModal());
    document.getElementById('add-prompt-btn').addEventListener('click', () => this.showAddPromptModal());
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
    } else if (this.currentTab === 'prompts') {
      const prompts = await this.agent.prompts.loadPrompts();
      const filtered = prompts.filter(p => !search || p.title.toLowerCase().includes(search));
      list.innerHTML = filtered.map(p => `
        <div class="sidebar-item" data-id="${p.id}">
          <span class="title">${this._escHtml(p.title)}</span>
          <span class="meta">${p.category}</span>
        </div>
      `).join('');

      list.querySelectorAll('.sidebar-item').forEach(item => {
        item.addEventListener('click', () => this.usePrompt(item.dataset.id));
      });
    } else {
      list.innerHTML = '';
    }
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
    const chat = this.currentChatId ? await this.agent.db.get('chats', this.currentChatId) : null;

    toolbar.innerHTML = skills.map(s => `
      <span class="chip ${s.enabled ? 'active' : ''}" data-skill="${s.id}" title="${this._escHtml(s.description)}">
        ${s.icon} ${s.name}
      </span>
    `).join('');

    toolbar.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        const skill = await this.agent.db.get('skills', chip.dataset.skill);
        skill.enabled = !skill.enabled;
        await this.agent.db.put('skills', skill);
        this.updateChatToolbar();
      });
    });
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

    await this._generateResponse();
  }

  async _generateResponse() {
    this.isStreaming = true;
    document.getElementById('send-btn').disabled = true;
    const container = document.getElementById('chat-messages');

    container.insertAdjacentHTML('beforeend', '<div class="typing-indicator" id="typing"><span></span><span></span><span></span></div>');
    container.scrollTop = container.scrollHeight;

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
        onChunk: (chunk) => {
          fullContent += chunk;
          msgEl.innerHTML = renderMarkdown(fullContent);
          container.scrollTop = container.scrollHeight;
        },
      });

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
          const toolResultDiv = document.createElement('div');
          toolResultDiv.className = 'message tool-call';
          toolResultDiv.textContent = `🔧 Вызываю: ${tc.function.name}(${tc.function.arguments})...`;
          container.appendChild(toolResultDiv);
          container.scrollTop = container.scrollHeight;

          const toolResult = await this.agent.tools.executeTool(tc.function.name, tc.function.arguments);
          const resultStr = JSON.stringify(toolResult);

          toolResultDiv.textContent = `🔧 ${tc.function.name} → ${resultStr.substring(0, 200)}`;

          const toolMsg = {
            id: uid(),
            chatId: this.currentChatId,
            role: 'tool',
            content: resultStr,
            tool_call_id: tc.id,
            name: tc.function.name,
            timestamp: Date.now(),
          };
          await this.agent.db.put('messages', toolMsg);
        }

        this.isStreaming = false;
        document.getElementById('send-btn').disabled = false;
        await this._generateResponse();
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
      container.insertAdjacentHTML('beforeend', `<div class="message system">❌ Ошибка: ${this._escHtml(error.message)}</div>`);
      container.scrollTop = container.scrollHeight;
    }

    this.isStreaming = false;
    document.getElementById('send-btn').disabled = false;
  }

  async deleteChat(chatId) {
    await this.agent.db.delete('chats', chatId);
    const msgs = await this.agent.db.getAllByIndex('messages', 'chatId', chatId);
    for (const m of msgs) await this.agent.db.delete('messages', m.id);

    if (this.currentChatId === chatId) {
      this.currentChatId = null;
      document.getElementById('chat-messages').innerHTML = '<div class="empty-state"><div class="icon">💬</div><div class="text">Выберите чат</div></div>';
    }
    this.refreshSidebar();
  }

  // === Tools ===
  // === Tools ===
  async renderTools() {
    const tools = await this.agent.tools.loadTools();
    const grid = document.getElementById('tools-grid');

    grid.innerHTML = tools.map(t => `
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
      </div>
    `).join('');

    grid.querySelectorAll('[data-toggle]').forEach(el => {
      el.addEventListener('change', async () => {
        const tool = await this.agent.db.get('tools', el.dataset.toggle);
        tool.enabled = el.checked;
        await this.agent.db.put('tools', tool);
      });
    });

    grid.querySelectorAll('[data-edit-tool]').forEach(el => {
      el.addEventListener('click', () => this.showAddToolModal(el.dataset.editTool));
    });

    grid.querySelectorAll('[data-del-tool]').forEach(el => {
      el.addEventListener('click', async () => {
        await this.agent.db.delete('tools', el.dataset.delTool);
        this.renderTools();
      });
    });
  }

  // === Skills ===
  async renderSkills() {
    const skills = await this.agent.skills.loadSkills();
    const container = document.getElementById('skills-container');

    container.innerHTML = `<div class="tools-grid">${skills.map(s => `
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
      </div>
    `).join('')}</div>`;

    container.querySelectorAll('[data-skill-toggle]').forEach(el => {
      el.addEventListener('change', async () => {
        const skill = await this.agent.db.get('skills', el.dataset.skillToggle);
        skill.enabled = el.checked;
        await this.agent.db.put('skills', skill);
      });
    });

    container.querySelectorAll('[data-edit-skill]').forEach(el => {
      el.addEventListener('click', () => this.showAddSkillModal(el.dataset.editSkill));
    });

    container.querySelectorAll('[data-del-skill]').forEach(el => {
      el.addEventListener('click', async () => {
        await this.agent.db.delete('skills', el.dataset.delSkill);
        this.renderSkills();
      });
    });
  }

  // === Prompts ===
  async renderPrompts() {
    const prompts = await this.agent.prompts.loadPrompts();
    const categories = await this.agent.prompts.getCategories();
    const container = document.getElementById('prompts-container');

    const catLabels = { all: '📁 Все', development: '💻 Разработка', content: '✍️ Контент', analysis: '📊 Анализ', learning: '📚 Обучение' };

    container.innerHTML = `
      <div class="prompt-categories">
        ${categories.map(c => `<span class="chip active" data-cat="${c}">${catLabels[c] || c}</span>`).join('')}
      </div>
      <div class="prompt-grid">
        ${prompts.map(p => `
          <div class="prompt-card" data-prompt-id="${p.id}">
            <div class="prompt-title">${this._escHtml(p.title)}</div>
            <div class="prompt-preview">${this._escHtml(p.content)}</div>
            <div class="prompt-tags">
              ${(p.tags || []).map(t => `<span class="tag">${this._escHtml(t)}</span>`).join('')}
            </div>
            <div style="margin-top:8px; display:flex; gap:4px;">
              <button class="btn btn-primary btn-sm" data-use-prompt="${p.id}">Использовать</button>
              <button class="btn btn-secondary btn-sm" data-edit-prompt="${p.id}">✏</button>
              <button class="btn btn-danger btn-sm" data-del-prompt="${p.id}">✕</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    container.querySelectorAll('[data-use-prompt]').forEach(el => {
      el.addEventListener('click', () => this.usePrompt(el.dataset.usePrompt));
    });

    container.querySelectorAll('[data-edit-prompt]').forEach(el => {
      el.addEventListener('click', () => this.showAddPromptModal(el.dataset.editPrompt));
    });

    container.querySelectorAll('[data-del-prompt]').forEach(el => {
      el.addEventListener('click', async () => {
        await this.agent.db.delete('prompts', el.dataset.delPrompt);
        this.renderPrompts();
      });
    });
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
  //  чтобы клик по оверлею НЕ закрывал окно
  // ──────────────────────────────────────────────
  showSettingsModal() {
    const llm = this.agent.llm;
    const isBearerChecked = llm.authType !== 'custom' ? 'checked' : '';
    const isCustomChecked = llm.authType === 'custom' ? 'checked' : '';
    const customDisplay = llm.authType === 'custom' ? '' : 'display:none;';
    const bearerDisplay = llm.authType !== 'custom' ? '' : 'display:none;';

    this._showModal('⚙ Настройки', '\
      <div class="form-group">\
        <label>API URL (OpenAI-compatible)</label>\
        <input id="s_url" value="' + this._escHtml(llm.apiUrl) + '" placeholder="https://api.example.com/v1">\
      </div>\
      \
      <div class="form-group">\
        <label>Способ авторизации</label>\
        <div style="display:flex;gap:16px;margin-top:4px;">\
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:var(--text-primary);">\
            <input type="radio" name="auth_type" value="bearer" ' + isBearerChecked + ' style="width:auto;"> Стандартный OpenAI (Bearer)\
          </label>\
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:var(--text-primary);">\
            <input type="radio" name="auth_type" value="custom" ' + isCustomChecked + ' style="width:auto;"> Нестандартный заголовок\
          </label>\
        </div>\
      </div>\
      \
      <div id="auth_bearer_section" style="' + bearerDisplay + '">\
        <div class="form-group">\
          <label>API Key</label>\
          <input id="s_key" type="password" value="' + this._escHtml(llm.apiKey) + '" placeholder="sk-...">\
        </div>\
      </div>\
      \
      <div id="auth_custom_section" style="' + customDisplay + '">\
        <div class="form-group">\
          <label>Имя HTTP заголовка</label>\
          <input id="s_custom_header" value="' + this._escHtml(llm.customHeaderName) + '" placeholder="X-API-Key">\
        </div>\
        <div class="form-group">\
          <label>Значение заголовка</label>\
          <input id="s_custom_value" type="password" value="' + this._escHtml(llm.customHeaderValue) + '" placeholder="your-secret-key">\
        </div>\
      </div>\
      \
      <div class="form-group">\
        <label>Model</label>\
        <div style="display:flex;gap:8px;">\
          <select id="s_model_select" style="flex:1;">\
            <option value="">-- Нажмите &quot;Загрузить модели&quot; --</option>\
          </select>\
          <input id="s_model_manual" value="' + this._escHtml(llm.model) + '" placeholder="или введите вручную" style="flex:1;">\
        </div>\
        <div style="margin-top:4px;font-size:11px;color:var(--text-muted);">Выберите из списка или введите вручную. Приоритет у выпадающего списка.</div>\
      </div>\
      \
      <div class="form-group">\
        <label>Max Tokens</label>\
        <input id="s_tokens" type="number" value="' + llm.maxTokens + '">\
      </div>\
      \
      <div class="form-group">\
        <label>Temperature (0-2)</label>\
        <input id="s_temp" type="number" step="0.1" min="0" max="2" value="' + llm.temperature + '">\
      </div>\
      \
      <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">\
        <button class="btn btn-success btn-sm" id="test-conn-btn">🔌 Тест и загрузка моделей</button>\
        <span id="conn-result" style="font-size:12px;"></span>\
      </div>\
      <div id="models-status" style="margin-top:8px;font-size:12px;color:var(--text-muted);"></div>\
    ', async () => {
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
      llm.configure(config);
      await this.agent.db.put('settings', { key: 'llm', ...config });
      this.updateConnectionStatus();
      this.updateModelDisplay();
    }, null, { modal: true }); // ← strict modal: overlay click does NOT close

    setTimeout(() => {
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
    const { modal = false } = options;
    const id = 'modal_' + uid();
    const modals = document.getElementById('modals');
    modals.innerHTML = `
      <div class="modal-overlay" id="${id}">
        <div class="modal">
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
            mcpToken: token,
          };
          await this.agent.db.put('tools', toolObj);

          this.agent.tools.registerHandler(toolObj.id, async (params) => {
            const h = { 'Content-Type': 'application/json' };
            if (token) h['Authorization'] = `Bearer ${token}`;
            const r = await fetch(url, {
              method: 'POST',
              headers: h,
              body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name: mt.name, arguments: params },
                id: Date.now(),
              }),
            });
            const d = await r.json();
            return d.result?.content?.[0]?.text || d.result || d;
          });
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
}