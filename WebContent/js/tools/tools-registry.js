// ============================================================
//  TOOLS REGISTRY — реестр обработчиков, загрузка, выдача в API
// ============================================================
//
// Обработчики (this.registry) живут только в памяти. В IndexedDB лежат
// описания инструментов, а для MCP — ещё адрес сервера и токен. Поэтому
// при каждом старте обработчики MCP восстанавливаются заново.

// ── Раскладка встроенных инструментов по папкам ──
// Список ведётся здесь, а не флагом в каждом описании: так видно границу
// целиком — какой набор куда относится решается одним взглядом на карту, а
// не поиском по семи файлам с описаниями. Сами папки — в
// FoldersEngine.SEEDED (там же их значки и пояснения).
//
// Инструменты с locked здесь НЕ перечисляются: их место — папка
// «Системные», и определяется оно флагом, а не этой картой (см. loadTools).
// Инструмент, которого нет ни там, ни здесь, останется в корне —
// это не ошибка, а честное «место ещё не назначено».
ToolsEngine.PLACEMENT = {
  folder_tools_utils: [
    'builtin_time', 'builtin_calc', 'builtin_json_format', 'builtin_xml_format',
    'builtin_password',
  ],
  folder_tools_files: [
    'builtin_list_files', 'builtin_read_file', 'builtin_search_files',
  ],
  folder_tools_chats: [
    'builtin_search_chats', 'builtin_export_chat', 'builtin_export_chats',
    'builtin_import_chat', 'builtin_import_chats', 'builtin_chat_folder', 'builtin_move_chat',
  ],
  folder_tools_net: [
    'builtin_fetch', 'builtin_proxy_fetch',
  ],
  folder_tools_workspace: [
    'builtin_list_workspace', 'builtin_create_folder', 'builtin_rename_folder',
    'builtin_move_folder', 'builtin_delete_folder', 'builtin_move_item',
  ],
  folder_tools_skills: [
    'builtin_create_skill', 'builtin_update_skill', 'builtin_link_skill_tools',
    'builtin_import_skill_from_text', 'builtin_create_prompt', 'builtin_update_prompt',
  ],
  folder_tools_toolsmith: [
    'builtin_create_tool', 'builtin_update_tool',
    'builtin_api_import', 'builtin_api_bundle_configure', 'builtin_api_bundle_list',
  ],
  folder_tools_models: [
    'builtin_llm_list', 'builtin_llm_status', 'builtin_llm_switch', 'builtin_llm_test',
  ],
  folder_tools_confluence: [
    'builtin_confluence_configure', 'builtin_confluence_status',
    'builtin_confluence_list_spaces', 'builtin_confluence_list_pages',
    'builtin_confluence_search', 'builtin_confluence_get_page',
    'builtin_confluence_create_page', 'builtin_confluence_update_page',
    'builtin_confluence_delete_page', 'builtin_confluence_labels',
    'builtin_confluence_comments', 'builtin_confluence_attachments',
    'builtin_confluence_convert_markup',
  ],
  folder_tools_xwiki: [
    'builtin_xwiki_configure', 'builtin_xwiki_status', 'builtin_xwiki_list_wikis',
    'builtin_xwiki_list_spaces', 'builtin_xwiki_list_pages', 'builtin_xwiki_search',
    'builtin_xwiki_get_page', 'builtin_xwiki_create_page', 'builtin_xwiki_update_page',
    'builtin_xwiki_delete_page', 'builtin_xwiki_history', 'builtin_xwiki_comments',
    'builtin_xwiki_attachments', 'builtin_xwiki_objects',
  ],
};

// Папка встроенного инструмента: системная — для locked, назначенная
// картой — для остальных, null — если место ещё не назначено.
ToolsEngine.folderOfBuiltin = function (def) {
  if (def && def.locked) return FoldersEngine.systemFolderId('tools');
  for (const [folderId, ids] of Object.entries(ToolsEngine.PLACEMENT)) {
    if (ids.includes(def.id)) return folderId;
  }
  return null;
};


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

	    // Досеиваем встроенные tools, которых ещё нет в базе — сразу в их
	    // папку (см. ToolsEngine.PLACEMENT).
	    const missing = defs.filter(def => !existingIds.has(def.id));
	    for (const def of missing) {
	      await this.db.put('tools', { ...def, parentId: ToolsEngine.folderOfBuiltin(def) });
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

	    // ── Место остальных встроенных инструментов ──
	    // Их раскладку тоже задаёт приложение, и тоже на КАЖДОЙ загрузке.
	    // Причина та же, что у системных, только мягче: папка отвечает на
	    // вопрос «что этот инструмент делает», о ней говорят навыки и
	    // справка, и разъехавшаяся раскладка сделала бы эти объяснения
	    // неверными. Инструмент, которому место ещё не назначено, остаётся
	    // там, где лежит: перекладывать его в корень значило бы отменять
	    // решение пользователя без повода.
	    const byId = new Map(defs.map(d => [d.id, d]));
	    let replaced = 0;
	    for (const t of existing) {
	      if (lockedIds.has(t.id)) continue;
	      const def = byId.get(t.id);
	      if (!def) continue;
	      const home = ToolsEngine.folderOfBuiltin(def);
	      if (!home || (t.parentId || null) === home) continue;
	      t.parentId = home;
	      await this.db.put('tools', t);
	      replaced++;
	    }

	    // ── Целостность встроенных инструментов ──
	    // description и parameters — это не украшение карточки, а то, ПО ЧЕМУ
	    // модель решает, когда вызвать инструмент. Подменённое описание —
	    // незаметный способ управлять агентом: сам вызов выглядит штатно,
	    // а делает он не то, что написано. Поле handlerCode у встроенного
	    // инструмента не должно существовать вовсе: исполнитель проверяет
	    // его РАНЬШЕ реестра, поэтому дописанный код подменил бы нативный
	    // обработчик целиком. Всё это приводится к определению из кода на
	    // каждой загрузке — правка записи в базе не переживает перезапуск.
	    // Включённость при этом не трогаем: это выбор пользователя.
	    let restored = 0;
	    for (const t of existing) {
	      const def = byId.get(t.id);
	      if (!def) continue;
	      const drift = t.name !== def.name || t.description !== def.description ||
	        JSON.stringify(t.parameters || null) !== JSON.stringify(def.parameters || null) ||
	        t.handlerCode !== undefined || t.mcpServer !== undefined;
	      if (!drift) continue;
	      t.name = def.name;
	      t.description = def.description;
	      t.parameters = def.parameters;
	      t.builtin = true;
	      delete t.handlerCode;
	      delete t.mcpServer;
	      await this.db.put('tools', t);
	      restored++;
	    }

	    const all = (missing.length || relocked || replaced || restored) ? await this.db.getAll('tools') : existing;

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
