// ============================================================
//  TOOLS REGISTRY — реестр обработчиков, загрузка, выдача в API
// ============================================================
//
// Обработчики (this.registry) живут только в памяти. В IndexedDB лежат
// описания инструментов, а для MCP — ещё адрес сервера и токен. Поэтому
// при каждом старте обработчики MCP восстанавливаются заново.

Object.assign(ToolsEngine.prototype, {

  registerHandler(toolId, handler) {
    if (!this.registry.has(toolId)) {
      this.registry.set(toolId, { handler });
    } else {
      this.registry.get(toolId).handler = handler;
    }
  },

  unregisterHandler(toolId) {
	    this.registry.delete(toolId);
  },

  // Полный список описаний: встроенные + добавленные модулями.
  _allBuiltinDefs() {
    const defs = this._builtinDefs();
    for (const contribute of ToolsEngine.DEF_CONTRIBUTORS) {
      try { defs.push(...contribute.call(this)); }
      catch (e) { console.error('ToolsEngine: сбой описаний модуля', e); }
    }
    return defs;
  },


	  async loadTools() {
	    const existing = await this.db.getAll('tools');
	    const existingIds = new Set(existing.map(t => t.id));

	    const defs = this._allBuiltinDefs();

	    // Досеиваем встроенные tools, которых ещё нет в базе
	    const missing = defs.filter(def => !existingIds.has(def.id));
	    for (const def of missing) {
	      await this.db.put('tools', def.locked
	        ? { ...def, parentId: FoldersEngine.systemFolderId('tools') }
	        : def);
	    }

	    // ── Системные инструменты ──
	    // На них держатся базовые механизмы агента (память, вопрос
	    // пользователю, объяснение устройства, самодиагностика — см. навык
	    // «Системный»), поэтому выключить их нельзя. Флаг проставляется и
	    // состояние выправляется на КАЖДОЙ загрузке, а не только при
	    // досеивании: в базе, заведённой раньше, эти записи уже есть — и
	    // могли быть выключены, пока запрета не существовало.
	    // Заодно системные инструменты держатся в папке «Системные»: она
	    // отвечает на вопрос «что здесь трогать нельзя» одним взглядом, а
	    // не перебором карточек. Место — такая же неизменяемая часть
	    // системного инструмента, как и его включённость: утащенный в
	    // чужую папку, он выглядел бы обычным (см. engines/folders-engine.js).
	    const systemFolder = FoldersEngine.systemFolderId('tools');
	    const lockedIds = new Set(defs.filter(d => d.locked).map(d => d.id));
	    let relocked = 0;
	    for (const t of existing) {
	      if (!lockedIds.has(t.id)) continue;
	      if (t.locked === true && t.enabled === true && (t.parentId || null) === systemFolder) continue;
	      t.locked = true;
	      t.enabled = true;
	      t.parentId = systemFolder;
	      await this.db.put('tools', t);
	      relocked++;
	    }

	    const all = (missing.length || relocked) ? await this.db.getAll('tools') : existing;

	    // Единственное место, где известен актуальный состав папки
	    // «Системные», — здесь. Отсюда он и уходит в защиту журнала:
	    // вызовы этих инструментов в консоль не печатаются никогда
	    // (см. core/log-guard.js).
	    LogGuard.setSystemTools(all.filter(t => t.locked).map(t => t.name));

	    // Восстанавливаем обработчики MCP-инструментов, не переживающие релоад (см. комментарий выше).
	    for (const t of all) {
	      if (t.mcpServer && !this.registry.has(t.id)) {
	        // mcpToken в БД хранится зашифрованным (SecretsVault) — расшифровываем
	        // перед тем, как передать в handler, который держит его в памяти
	        // в замыкании как обычную строку (нужен для заголовка Authorization).
	        const plainToken = await SecretsVault.decrypt(this.db, t.mcpToken);
	        this._registerMcpHandler({ ...t, mcpToken: plainToken });
	      }
	    }

	    return all;
	  },

  async getEnabledToolsForAPI() {
    const tools = await this.loadTools();
    return tools
      .filter(t => t.enabled)
      .map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
  },

});
