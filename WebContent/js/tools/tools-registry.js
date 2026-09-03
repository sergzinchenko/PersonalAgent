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
	      await this.db.put('tools', def);
	    }

	    // ── Системные инструменты ──
	    // На них держатся базовые механизмы агента (память, вопрос
	    // пользователю, объяснение устройства, самодиагностика — см. навык
	    // «Системный»), поэтому выключить их нельзя. Флаг проставляется и
	    // состояние выправляется на КАЖДОЙ загрузке, а не только при
	    // досеивании: в базе, заведённой раньше, эти записи уже есть — и
	    // могли быть выключены, пока запрета не существовало.
	    const lockedIds = new Set(defs.filter(d => d.locked).map(d => d.id));
	    let relocked = 0;
	    for (const t of existing) {
	      if (!lockedIds.has(t.id) || (t.locked === true && t.enabled === true)) continue;
	      t.locked = true;
	      t.enabled = true;
	      await this.db.put('tools', t);
	      relocked++;
	    }

	    const all = (missing.length || relocked) ? await this.db.getAll('tools') : existing;

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
