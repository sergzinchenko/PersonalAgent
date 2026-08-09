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

    // 3. Load settings
    const settings = await this.db.get('settings', 'llm');
    if (settings) {
      this.llm.configure(settings);
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