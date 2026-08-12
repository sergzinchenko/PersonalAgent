// ============================================================
//  UI NAVIGATION — боковая панель, дерево папок, рендер разделов
// ============================================================
//
// Всё, что относится к навигации: сайдбар с чатами, иерархия папок, drag-and-drop и карточки Tools/Skills/Prompts.

Object.assign(UI.prototype, {


  // === Sidebar ===
  async refreshSidebar() {
    const list = document.getElementById('sidebar-list');

    if (this.currentTab === 'chat') {
      await this._renderChatTree();
    } else if (['tools', 'skills', 'prompts'].includes(this.currentTab)) {
      await this._renderSidebarTree(this.currentTab);
    } else {
      list.innerHTML = '';
    }
  },

  // Дерево чатов: папки произвольной вложенности + сами чаты внутри них.
  // Отличие от _renderSidebarTree (tools/skills/prompts): там элементы
  // живут в отдельной панели справа, а чаты открываются кликом прямо
  // здесь, поэтому они отрисовываются внутри самого дерева.
  async _renderChatTree() {
    const list = document.getElementById('sidebar-list');
    const search = document.getElementById('sidebar-search').value.toLowerCase();

    const folders = await this.agent.folders.all('chats');
    const chats = await this.agent.db.getAll('chats');

    const byParent = {};
    folders.forEach(f => { const k = f.parentId || 'root'; (byParent[k] = byParent[k] || []).push(f); });

    const chatsByParent = {};
    chats.forEach(c => { const k = c.parentId || 'root'; (chatsByParent[k] = chatsByParent[k] || []).push(c); });

    const selected = this.folderSelection.chats;
    const fmtTime = (ts) => ts
      ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '';

    const matches = (c) => !search || (c.title || '').toLowerCase().includes(search);

    const renderChats = (parentKey) => {
      const items = (chatsByParent[parentKey] || [])
        .filter(matches)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return items.map(c => `
        <div class="sidebar-item chat-item ${c.id === this.currentChatId ? 'active' : ''}"
             data-id="${c.id}" draggable="true" title="${this._escHtml(c.title)}">
          <span class="title">${this._escHtml(c.title)}</span>
          <span class="chat-time">${fmtTime(c.updatedAt || c.createdAt)}</span>
          <button class="delete-btn" data-delete="${c.id}" title="Удалить">✕</button>
        </div>`).join('');
    };

    const build = (parentId) => {
      const key = parentId || 'root';
      const children = (byParent[key] || []).slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      let html = '<div class="tree-node-children">';
      for (const f of children) {
        const sel = f.id === selected ? 'selected' : '';
        const hasKids = (byParent[f.id] || []).length > 0 || (chatsByParent[f.id] || []).length > 0;
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
      html += renderChats(key);
      html += '</div>';
      return html;
    };

    const rootSel = selected === null ? 'selected' : '';
    const anyChats = chats.length > 0;
    list.innerHTML = `
      <div class="tree-nav">
        <div class="tree-node">
          <div class="tree-node-row ${rootSel}" data-folder-id="">
            <span class="tw-toggle">▾</span>
            <span class="tw-name">🏠 Все чаты</span>
            <span class="tw-actions"><button data-add-sub="" title="Новая папка">＋</button></span>
          </div>
          ${build(null)}
        </div>
      </div>
      ${anyChats ? '' : '<div class="empty-state"><div class="text">Нет чатов</div></div>'}`;

    this._bindChatTree();
  },

  _bindChatTree() {
    const list = document.getElementById('sidebar-list');

    // --- Папки: выбор, сворачивание ---
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
        this.folderSelection.chats = row.dataset.folderId || null;
        this.refreshSidebar();
      });
    });

    // --- Кнопки управления папками ---
    list.querySelectorAll('[data-add-sub]').forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = prompt('Название папки:');
      if (!name) return;
      const f = await this.agent.folders.create('chats', name, b.dataset.addSub || null);
      this.folderSelection.chats = f.id;
      await this.refreshSidebar();
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
      if (!confirm('Удалить папку? Чаты и подпапки переместятся на уровень выше.')) return;
      const fid = b.dataset.del;
      const folder = await this.agent.db.get('folders', fid);
      // Папка удаляется, содержимое поднимается — сами чаты не теряются.
      await this.agent.folders.remove(fid, 'chats');
      if (this.folderSelection.chats === fid) this.folderSelection.chats = folder?.parentId || null;
      await this.refreshSidebar();
    }));

    // --- Чаты: открытие и удаление ---
    list.querySelectorAll('.chat-item').forEach(item => {
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

    // --- Drag & Drop: чат в папку, папка в папку ---
    list.querySelectorAll('.chat-item').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'chat', id: item.dataset.id }));
        e.dataTransfer.effectAllowed = 'move';
      });
    });

    list.querySelectorAll('.tree-node-row').forEach(row => {
      const fid = row.dataset.folderId; // '' — корень

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

        if (data.kind === 'chat') {
          const chat = await this.agent.db.get('chats', data.id);
          if (chat) { chat.parentId = target; await this.agent.db.put('chats', chat); }
        } else if (data.kind === 'folder') {
          // move() сам защищает от вложения папки в собственного потомка.
          await this.agent.folders.move(data.id, target);
        }
        await this.refreshSidebar();
      });
    });
  },


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
  },


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
  },


  async _createFolder(type) {
    const name = prompt('Название новой папки:');
    if (!name) return;
    const f = await this.agent.folders.create(type, name, this.folderSelection[type] || null);
    this.folderSelection[type] = f.id;
    await this.refreshSidebar();
    this._refreshPanel(type);
  },


  _refreshPanel(type) {
    if (type === 'tools') return this.renderTools();
    if (type === 'skills') return this.renderSkills();
    if (type === 'prompts') return this.renderPrompts();
  },


  async _folderPath(type, id) {
    if (!id) return '🏠 Корень';
    const folders = await this.agent.folders.all(type);
    const map = {}; folders.forEach(f => map[f.id] = f);
    const parts = [];
    let cur = map[id];
    while (cur) { parts.unshift('📁 ' + this._escHtml(cur.name)); cur = cur.parentId ? map[cur.parentId] : null; }
    return '🏠 Корень / ' + parts.join(' / ');
  },


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
  },


  _handleNewItem() {
    if (this.currentTab === 'chat') this.newChat();
    else if (this.currentTab === 'tools') this.showAddToolModal();
    else if (this.currentTab === 'skills') this.showAddSkillModal();
    else if (this.currentTab === 'prompts') this.showAddPromptModal();
  },


  _handleSearch(value) {
    this.refreshSidebar();
  },


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
  },


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
  },


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

});
