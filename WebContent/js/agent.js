// ============================================================
//  AGENT CORE — Orchestrator
// ============================================================
class AIAgent {
  constructor() {
    this.db = new AgentDB();
    this.llm = new LLMGateway();
    this.tools = null;
    this.skills = null;
    this.prompts = null;
    this.folders = null; 
    this.ui = null;
  }

  async init() {
    // 1. Open DB
    await this.db.open();

    // 2. Init engines
    this.tools = new ToolsEngine(this.db);
    this.skills = new SkillsEngine(this.db);
    this.prompts = new PromptsLibrary(this.db);
    this.folders = new FoldersEngine(this.db);
    this.tools.folders = this.folders; // делаем builtin_delete_folder переиспользуемым (без дублирования логики)

    // 3. Load settings
    const settings = await this.db.get('settings', 'llm');
    if (settings) {
      // apiKey/customHeaderValue хранятся в IndexedDB зашифрованными
      // (SecretsVault, см. crypto-utils.js) — расшифровываем перед тем,
      // как передать в LLMGateway, который держит их в памяти как обычные
      // строки (нужны в чистом виде для формирования заголовка запроса).
      const decrypted = {
        ...settings,
        apiKey: await SecretsVault.decrypt(this.db, settings.apiKey),
        customHeaderValue: await SecretsVault.decrypt(this.db, settings.customHeaderValue),
      };
      this.llm.configure(decrypted);
    }

    // Настройки журналирования (не секрет — храним как есть, без шифрования).
    // Управляются через ⚙ Настройки → вкладка «Журналирование».
    const loggingSettings = await this.db.get('settings', 'logging');
    if (loggingSettings) {
      this.llm.debug = !!loggingSettings.llmDebug;
      this.tools.debug = !!loggingSettings.toolsDebug;
    }

    // 4. Load tools (seed defaults if needed)
    await this.tools.loadTools();
    await this.skills.loadSkills();
    await this.prompts.loadPrompts();

    // 5. Init UI
    this.ui = new UI(this);
    this.tools.ui = this.ui;
    this.ui.updateConnectionStatus();
    this.ui.updateModelDisplay();
    this.ui.refreshSidebar();
    this.ui.updateChatToolbar();

    console.log('🚀 AI Agent initialized');
  }
}