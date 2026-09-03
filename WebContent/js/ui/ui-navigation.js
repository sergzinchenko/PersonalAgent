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
    } else if (['tools', 'skills', 'prompts', 'files'].includes(this.currentTab)) {
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
      return items.map(c => {
        // Чат может генерировать ответ, даже когда сейчас открыт другой —
        // без этого индикатора это никак не было видно (см. this._chatRuns
        // в ui-core.js/ui-chat.js).
        const busy = this._chatRuns.has(c.id);
        return `
        <div class="sidebar-item chat-item ${c.id === this.currentChatId ? 'active' : ''} ${busy ? 'chat-busy' : ''}"
             data-id="${c.id}" draggable="true" title="${this._escHtml(c.title)}${busy ? ' — генерирует ответ' : ''}">
          ${busy ? '<span class="chat-busy-spinner" title="Генерирует ответ…"></span>' : ''}
          <span class="title">${this._escHtml(c.title)}</span>
          <span class="chat-time">${fmtTime(c.updatedAt || c.createdAt)}</span>
          <button class="delete-btn" data-delete="${c.id}" title="Удалить">✕</button>
        </div>`;
      }).join('');
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
      const name = await this._prompt('Новая папка', '', { label: 'Название папки' });
      if (!name) return;
      const f = await this.agent.folders.create('chats', name, b.dataset.addSub || null);
      this.folderSelection.chats = f.id;
      await this.refreshSidebar();
    }));

    list.querySelectorAll('[data-ren]').forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const f = await this.agent.db.get('folders', b.dataset.ren);
      const name = await this._prompt('Переименование папки', f ? f.name : '', { label: 'Название папки' });
      if (!name) return;
      await this.agent.folders.rename(b.dataset.ren, name);
      await this.refreshSidebar();
    }));

    list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await this._confirm('Удалить папку? Чаты и подпапки переместятся на уровень выше.', { title: 'Удаление папки' })) return;
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
  //
  // Для раздела 'tools' узлы с f.mcpServerId — не обычные папки, а
  // контейнеры MCP-серверов (см. ToolsEngine.connectMcpServer): у них
  // вместо переименования/удаления папки — настройка и удаление сервера
  // целиком, а перетаскивание отключено (сервер всегда лежит в корне).
  // Обычные подпапки внутри такого контейнера рендерятся как всегда —
  // изоляция от смешивания серверов обеспечивается не здесь, а проверкой
  // области видимости в _bindSidebarTree при перетаскивании.
  async _renderSidebarTree(type) {
    const list = document.getElementById('sidebar-list');
    const search = document.getElementById('sidebar-search').value.toLowerCase();
    const folders = await this.agent.folders.all(type);
    const mcpServers = type === 'tools' ? await this.agent.db.getAll('mcp_servers') : [];
    const mcpById = new Map(mcpServers.map(s => [s.id, s]));
    // Только для tools: список нужен, чтобы у каждой папки посчитать,
    // сколько инструментов внутри неё и всех вложенных папок включено —
    // см. переключатель папки целиком (_folderSubtreeIds).
    const tools = type === 'tools' ? await this.agent.tools.loadTools() : [];

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
        const server = f.mcpServerId ? mcpById.get(f.mcpServerId) : null;
        const label = server ? server.name : f.name;

        let toggle = '';
        if (type === 'tools') {
          const scope = new Set(this._folderSubtreeIds(folders, f.id));
          // Системные инструменты в счёт папки не идут: их состояние
          // менять нельзя, и, попади они в счётчик, переключатель папки
          // навсегда застрял бы в промежуточном состоянии.
          const inScope = tools.filter(t => !t.locked && scope.has(t.parentId || null));
          if (inScope.length) {
            const enabledCount = inScope.filter(t => t.enabled).length;
            const mixed = enabledCount > 0 && enabledCount < inScope.length;
            toggle = `
              <label class="toggle-switch sm" title="${enabledCount} из ${inScope.length} инструментов включено">
                <input type="checkbox" data-folder-toggle="${f.id}" ${enabledCount === inScope.length ? 'checked' : ''} ${mixed ? 'data-mixed="1"' : ''}>
                <span class="toggle-slider"></span>
              </label>`;
          }
        }

        html += `
          <div class="tree-node">
            <div class="tree-node-row ${sel}" data-folder-id="${f.id}" ${server ? `data-mcp-server="${server.id}"` : ''}>
              <span class="tw-toggle">${hasKids ? '▾' : '•'}</span>
              <span class="tw-name">${server ? '🧩' : '📁'} ${this._escHtml(label)}</span>
              ${toggle}
              <span class="tw-actions">
                <button data-add-sub="${f.id}" title="Подпапка">＋</button>
                ${server
                  ? `<button data-mcp-edit="${server.id}" title="Настроить сервер">✏</button>
                     <button data-mcp-del="${server.id}" title="Удалить сервер">✕</button>`
                  : `<button data-ren="${f.id}" title="Переименовать">✏</button>
                     <button data-del="${f.id}" title="Удалить">✕</button>`}
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

    // indeterminate — свойство DOM-объекта, атрибутом в HTML не задаётся.
    list.querySelectorAll('[data-folder-toggle][data-mixed]').forEach(cb => { cb.indeterminate = true; });

    this._bindSidebarTree(type);
  },


  _bindSidebarTree(type) {
    const list = document.getElementById('sidebar-list');

    // Выбор папки / сворачивание
    list.querySelectorAll('.tree-node-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.tw-actions') || e.target.closest('.toggle-switch')) return;

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
      const name = await this._prompt('Новая папка', '', { label: 'Название папки' });
      if (!name) return;
      const f = await this.agent.folders.create(type, name, b.dataset.addSub || null);
      this.folderSelection[type] = f.id;
      await this.refreshSidebar();
      this._refreshPanel(type);
    }));

    list.querySelectorAll('[data-ren]').forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const f = await this.agent.db.get('folders', b.dataset.ren);
      const name = await this._prompt('Переименование папки', f ? f.name : '', { label: 'Название папки' });
      if (!name) return;
      await this.agent.folders.rename(b.dataset.ren, name);
      await this.refreshSidebar();
    }));

    list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await this._confirm('Удалить папку? Вложенные элементы и подпапки переместятся на уровень выше.', { title: 'Удаление папки' })) return;
      const fid = b.dataset.del;
      const folder = await this.agent.db.get('folders', fid);
      await this.agent.folders.remove(fid, type);
      if (this.folderSelection[type] === fid) this.folderSelection[type] = folder?.parentId || null;
      await this.refreshSidebar();
      this._refreshPanel(type);
    }));

    // Переключатель папки целиком: включает/выключает все инструменты
    // прямо в ней и во всех вложенных папках (в т.ч. под MCP-сервером —
    // сама область видимости от этого не меняется, просто у сервера тоже
    // бывают вложенные подпапки).
    list.querySelectorAll('[data-folder-toggle]').forEach(cb => cb.addEventListener('change', async () => {
      const folders = await this.agent.folders.all(type);
      const scope = new Set(this._folderSubtreeIds(folders, cb.dataset.folderToggle));
      const tools = await this.agent.tools.loadTools();
      const affected = tools.filter(t => !t.locked && scope.has(t.parentId || null));
      for (const t of affected) {
        t.enabled = cb.checked;
        await this.agent.db.put('tools', t);
      }
      await this.refreshSidebar();
      this._refreshPanel(type);
    }));

    // Действия с MCP-серверами (узлы с data-mcp-server вместо обычных папок)
    list.querySelectorAll('[data-mcp-edit]').forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.showEditMCPServerModal(b.dataset.mcpEdit);
    }));

    list.querySelectorAll('[data-mcp-del]').forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const serverId = b.dataset.mcpDel;
      const server = await this.agent.db.get('mcp_servers', serverId);
      const yes = await this._confirm(
        `Удалить сервер «${server ? server.name : serverId}»? ` +
        'Все его инструменты и организующие их папки будут удалены безвозвратно.',
        { title: 'Удаление MCP-сервера', danger: true });
      if (!yes) return;

      // Выбранная папка могла лежать внутри удаляемого сервера — тогда
      // панель справа осталась бы показывать несуществующую папку.
      const scope = await this._mcpScopeOf(type, this.folderSelection[type]);
      if (scope === serverId) this.folderSelection[type] = null;

      await this.agent.tools.removeMcpServer(serverId);
      await this.refreshSidebar();
      this._refreshPanel(type);
    }));

    // Drag & Drop
    list.querySelectorAll('.tree-node-row').forEach(row => {
      const fid = row.dataset.folderId; // '' для корня

      // Контейнер MCP-сервера не перетаскивается: он всегда лежит в корне
      // раздела Tools, а перемещение внутрь другой папки или другого
      // сервера не имеет смысла — сервер целиком, а не его часть.
      if (fid && !row.hasAttribute('data-mcp-server')) {
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
        // Область видимости — id MCP-сервера, если целевая (или исходная)
        // папка лежит в его поддереве, иначе null. Перемещение разрешено
        // только внутри одной области: нельзя утащить чужой tool в сервер,
        // тот его — в другой сервер или в общие папки, и наоборот —
        // см. постановку в connectMcpServer.
        const targetScope = await this._mcpScopeOf(type, target);

        if (data.kind === 'item') {
          const rec = await this.agent.db.get(type, data.id);
          if (!rec) return;
          const sourceScope = await this._mcpScopeOf(type, rec.parentId || null);
          if (sourceScope !== targetScope) return;
          rec.parentId = target; await this.agent.db.put(type, rec);
        } else if (data.kind === 'folder') {
          const sourceScope = await this._mcpScopeOf(type, data.id);
          if (sourceScope !== targetScope) return;
          await this.agent.folders.move(data.id, target);
        }
        await this.refreshSidebar();
        this._refreshPanel(type);
      });
    });
  },


  // fid + id всех вложенных папок любой глубины (плоский список) —
  // общая область видимости для операций над содержимым папки целиком
  // (см. переключатель "включить/выключить все инструменты" ниже).
  _folderSubtreeIds(folders, fid) {
    const byParent = {};
    folders.forEach(f => { const k = f.parentId || 'root'; (byParent[k] = byParent[k] || []).push(f); });
    const acc = [fid];
    const walk = (id) => { (byParent[id] || []).forEach(f => { acc.push(f.id); walk(f.id); }); };
    walk(fid);
    return acc;
  },


  // Id MCP-сервера, если папка folderId (или кто-то из её предков) —
  // его контейнер, иначе null. Для разделов без MCP (skills/prompts/files)
  // всегда null — там ни у одной папки не бывает mcpServerId.
  async _mcpScopeOf(type, folderId) {
    if (!folderId) return null;
    const folders = await this.agent.folders.all(type);
    const byId = new Map(folders.map(f => [f.id, f]));
    let cur = byId.get(folderId);
    while (cur) {
      if (cur.mcpServerId) return cur.mcpServerId;
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return null;
  },


  async _createFolder(type) {
    const name = await this._prompt('Новая папка', '', { label: 'Название папки' });
    if (!name) return;
    const f = await this.agent.folders.create(type, name, this.folderSelection[type] || null);
    this.folderSelection[type] = f.id;
    await this.refreshSidebar();
    this._refreshPanel(type);
  },


  _refreshPanel(type) {
    if (type === 'files') return this.renderFiles();
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

    // Обратная сторона связи «навык ↔ инструменты»: у какого навыка этот
    // инструмент числится. Показываем прямо на карточке — иначе понять,
    // на что повлияет выключение инструмента, можно только перебрав навыки.
    const skills = await this.agent.skills.loadSkills();
    const usedBy = new Map();
    for (const s of skills) {
      for (const id of this.agent.skills.toolIdsOf(s)) {
        if (!usedBy.has(id)) usedBy.set(id, []);
        usedBy.get(id).push(s);
      }
    }

    const renderCard = (t) => {
      const inSkills = usedBy.get(t.id) || [];
      const skillsLine = inSkills.length
        ? `<div class="tool-skills" title="Навыки, к которым привязан инструмент">
             🧩 ${inSkills.map(s => `${this._escHtml(s.icon)} ${this._escHtml(s.name)}`).join(' · ')}
           </div>`
        : '';
      // Системный инструмент: тумблер заблокирован, удаления нет —
      // на нём держатся базовые механизмы агента (см. навык «Системный»).
      const lockTitle = 'Системный инструмент — на нём держатся базовые механизмы агента, выключить нельзя';
      return `
      <div class="tool-card${t.locked ? ' tool-locked' : ''}" data-id="${t.id}">
        <div class="tool-header">
          <span class="tool-name">${t.locked ? '🔒 ' : (t.mcpServerId ? '🧩 ' : '')}${this._escHtml(t.name)}</span>
          <label class="toggle-switch${t.locked ? ' locked' : ''}" ${t.locked ? `title="${lockTitle}"` : ''}>
            <input type="checkbox" ${t.enabled ? 'checked' : ''} ${t.locked ? 'disabled' : ''} data-toggle="${t.id}">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="tool-desc">${this._escHtml(t.description)}</div>
        ${skillsLine}
        <div class="tool-params">${this._escHtml(JSON.stringify(t.parameters, null, 2))}</div>
        <div class="tool-actions">
          <button class="btn btn-secondary btn-sm" data-tool-skills="${t.id}">🧩 Навыки${inSkills.length ? ` (${inSkills.length})` : ''}</button>
          ${!t.builtin && !t.mcpServerId ? `<button class="btn btn-secondary btn-sm" data-edit-tool="${t.id}">✏ Редактировать</button>` : ''}
          ${!t.builtin ? `<button class="btn btn-danger btn-sm" data-del-tool="${t.id}">Удалить</button>` : ''}
        </div>
      </div>`;
    };

    const bind = (scope) => {
      scope.querySelectorAll('[data-toggle]').forEach(el => el.addEventListener('change', async () => {
        const tool = await this.agent.db.get('tools', el.dataset.toggle);
        // Системный инструмент нельзя выключить даже в обход disabled
        // (например, снятием атрибута в DevTools).
        if (tool.locked) { el.checked = true; return; }
        tool.enabled = el.checked; await this.agent.db.put('tools', tool);
        // Привязки не меняются, но подпись «включён/выключен» в навыках
        // и в системном промпте зависит от этого флага.
        this.renderTools();
      }));
      scope.querySelectorAll('[data-tool-skills]').forEach(el => el.addEventListener('click', () => this.showToolSkillsModal(el.dataset.toolSkills)));
      scope.querySelectorAll('[data-edit-tool]').forEach(el => el.addEventListener('click', () => this.showAddToolModal(el.dataset.editTool)));
      scope.querySelectorAll('[data-del-tool]').forEach(el => el.addEventListener('click', async () => {
        const id = el.dataset.delTool;
        const inSkills = usedBy.get(id) || [];
        if (inSkills.length) {
          const yes = await this._confirm(
            `Инструмент привязан к навыкам: ${inSkills.map(s => s.name).join(', ')}. ` +
            'Удалить его и убрать эти привязки?', { title: 'Удаление инструмента', danger: true });
          if (!yes) return;
        }
        await this.agent.db.delete('tools', id);
        // Иначе в навыках остались бы ссылки на несуществующий инструмент.
        await this.agent.skills.forgetTool(id);
        this.agent.tools.unregisterHandler(id);
        this.renderTools();
      }));
    };

    await this._renderPanelItems('tools', mount, tools, renderCard, bind);
  },


  async renderSkills() {
    const skills = await this.agent.skills.loadSkills();
    const mount = document.getElementById('skills-container');

    // Привязанные инструменты с их текущим состоянием: выключенный
    // инструмент навыку недоступен, и это стоит видеть, не открывая
    // вкладку Tools.
    const allTools = await this.agent.tools.loadTools();
    const toolsById = new Map(allTools.map(t => [t.id, t]));

    const renderCard = (s) => {
      const bound = this.agent.skills.toolIdsOf(s).map(id => toolsById.get(id)).filter(Boolean);
      const offCount = bound.filter(t => !t.enabled).length;
      const toolsBlock = bound.length ? `
        <div class="skill-tools" title="Инструменты, привязанные к навыку">
          ${bound.map(t => `<span class="skill-tool-chip${t.enabled ? '' : ' off'}"
            title="${t.enabled ? 'Инструмент включён' : 'Инструмент выключен — навык не сможет им воспользоваться'}"
            >${this._escHtml(t.name)}</span>`).join('')}
          ${offCount ? `<span class="skill-tools-warn" title="Выключенные инструменты модели не передаются">⚠ ${offCount} выключено</span>` : ''}
        </div>` : '';

      // Системный навык описывает устройство самого агента и участвует
      // в каждом запросе — выключать и удалять его нечему.
      const lockTitle = 'Системный навык — описывает устройство агента, выключить нельзя';
      return `
      <div class="tool-card${s.locked ? ' tool-locked' : ''}" data-id="${s.id}">
        <div class="tool-header">
          <span class="tool-name">${s.locked ? '🔒 ' : ''}${this._escHtml(s.icon)} ${this._escHtml(s.name)}</span>
          <label class="toggle-switch${s.locked ? ' locked' : ''}" ${s.locked ? `title="${lockTitle}"` : ''}>
            <input type="checkbox" ${s.enabled ? 'checked' : ''} ${s.locked ? 'disabled' : ''} data-skill-toggle="${s.id}">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="tool-desc">${this._escHtml(s.description)}</div>
        ${toolsBlock}
        <div class="tool-params" style="white-space:pre-wrap">${this._escHtml(s.systemPrompt)}</div>
        <div class="tool-actions">
          <button class="btn btn-secondary btn-sm" data-edit-skill="${s.id}">${s.locked ? '👁 Посмотреть' : '✏ Редактировать'}</button>
          ${s.locked ? '' : `<button class="btn btn-danger btn-sm" data-del-skill="${s.id}">Удалить</button>`}
        </div>
      </div>`;
    };

    const bind = (scope) => {
      scope.querySelectorAll('[data-skill-toggle]').forEach(el => el.addEventListener('change', async () => {
        const skill = await this.agent.db.get('skills', el.dataset.skillToggle);
        if (skill.locked) { el.checked = true; return; }
        skill.enabled = el.checked; await this.agent.db.put('skills', skill);
        this.updateChatToolbar();
      }));
      scope.querySelectorAll('[data-edit-skill]').forEach(el => el.addEventListener('click', () => this.showAddSkillModal(el.dataset.editSkill)));
      scope.querySelectorAll('[data-del-skill]').forEach(el => el.addEventListener('click', async () => {
        const skill = await this.agent.db.get('skills', el.dataset.delSkill);
        if (skill?.locked) return;
        if (!await this._confirm(`Удалить навык «${skill?.name || ''}»?`, { title: 'Удаление навыка', danger: true })) return;
        await this.agent.db.delete('skills', el.dataset.delSkill);
        this.renderSkills();
        this.updateChatToolbar();
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

  ,

  // ── Панель файлов ──
  // Карточка показывает метаданные и состояние ссылки: доступен ли файл,
  // нужно ли разрешение или повторный выбор. Содержимого здесь нет —
  // оно читается с диска только по требованию.
  async renderFiles() {
    const mount = document.getElementById('files-container');
    const files = await this.agent.files.all();
    const folders = await this.agent.db.getAll('folders');

    const fmtSize = (n) => {
      if (n == null) return '';
      if (n < 1024) return n + ' Б';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace('.', ',') + ' КБ';
      return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
    };

    // Реальное состояние каждой ссылки: после перезагрузки браузер обычно
    // сбрасывает разрешение, и файл «связан», но не читается. Раньше
    // панель показывала только флаг из базы и вводила в заблуждение.
    const states = new Map();
    for (const f of files) states.set(f.id, await this.agent.files.statusOf(f));
    const needPermission = files.filter(f => states.get(f.id) === 'needs-permission');

    const renderCard = (f) => {
      const st = states.get(f.id);
      const state = st === 'ready'
        ? '<span class="file-state ok" title="Файл читается по сохранённому дескриптору">🔗 связан</span>'
        : st === 'needs-permission'
        ? '<span class="file-state warn" title="Дескриптор сохранён, но браузер требует подтвердить доступ">🔒 нужно разрешение</span>'
        : '<span class="file-state warn" title="Файл недоступен — укажите его заново">⚠ требуется повторный выбор</span>';
      return `
        <div class="tool-card file-card" draggable="true" data-item-id="${f.id}">
          <div class="tool-header">
            <div class="tool-name">📎 ${this._escHtml(f.name)}</div>
            ${state}
          </div>
          <div class="tool-desc">
            ${fmtSize(f.size)}${f.mime ? ' · ' + this._escHtml(f.mime) : ''}
            ${f.lastModified ? ' · изменён ' + new Date(f.lastModified).toLocaleDateString('ru-RU') : ''}
          </div>
          ${f.note ? `<div class="tool-params">${this._escHtml(f.note)}</div>` : ''}
          <div class="tool-actions">
            <button class="btn btn-secondary btn-sm" data-preview="${f.id}">👁 Просмотр</button>
            <button class="btn btn-secondary btn-sm" data-note="${f.id}">✏ Заметка</button>
            <button class="btn btn-secondary btn-sm" data-relink="${f.id}">🔄 Перевыбрать</button>
            <button class="btn btn-danger btn-sm" data-unlink="${f.id}">✕ Убрать</button>
          </div>
        </div>`;
    };

    const bind = (el) => {
      el.querySelectorAll('[data-preview]').forEach(b => b.addEventListener('click', () => this.showFilePreview(b.dataset.preview)));
      el.querySelectorAll('[data-note]').forEach(b => b.addEventListener('click', async () => {
        const f = await this.agent.files.get(b.dataset.note);
        const note = await this._prompt('Заметка о файле', f?.note || '', { multiline: true, label: 'Зачем нужен файл, что внутри' });
        if (note === null) return;
        await this.agent.files.setNote(b.dataset.note, note);
        this.renderFiles();
      }));
      el.querySelectorAll('[data-relink]').forEach(b => b.addEventListener('click', () => this.relinkFile(b.dataset.relink)));
      el.querySelectorAll('[data-unlink]').forEach(b => b.addEventListener('click', async () => {
        if (!await this._confirm('Убрать ссылку на файл? Сам файл на диске останется нетронутым.', { title: 'Удаление ссылки' })) return;
        await this.agent.files.remove(b.dataset.unlink);
        this.renderFiles();
      }));
    };

    await this._renderPanelItems('files', mount, files, renderCard, bind);

    // Одна кнопка на все файлы: запрашивать разрешение по одному —
    // худший вариант из возможных, а браузер позволяет серию запросов
    // в рамках одного нажатия.
    if (needPermission.length) {
      mount.insertAdjacentHTML('afterbegin', `
        <div class="files-restore" id="files-restore-bar">
          🔒 ${needPermission.length} ${needPermission.length === 1 ? 'файл ждёт' : 'файлов ждут'} подтверждения доступа —
          браузер сбрасывает разрешения при перезапуске.
          <button class="btn btn-primary btn-sm" id="files-restore-btn">Восстановить доступ</button>
        </div>`);
      document.getElementById('files-restore-btn')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Подтвердите в диалогах браузера…';
        const res = await this.agent.files.restoreAccess(needPermission);
        const bar = document.getElementById('files-restore-bar');
        if (res.failed.length) {
          bar.innerHTML = `Доступ восстановлен: ${res.granted.length}. ` +
            `Осталось: ${res.failed.length} — нажмите ещё раз или используйте «Перевыбрать» у конкретного файла. ` +
            `<button class="btn btn-primary btn-sm" id="files-restore-btn2">Повторить</button>`;
          document.getElementById('files-restore-btn2')?.addEventListener('click', () => this.renderFiles());
        } else {
          this.renderFiles();
        }
      });
    }
  }

});
