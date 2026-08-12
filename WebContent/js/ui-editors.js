// ============================================================
//  UI EDITORS — окна создания и правки Tools / Skills / Prompts
// ============================================================
//
// Формы редактирования сущностей и импорт инструментов с MCP-сервера.

Object.assign(UI.prototype, {


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
  },


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
  },


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
  },


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

});
