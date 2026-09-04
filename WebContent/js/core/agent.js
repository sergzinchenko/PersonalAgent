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
    this.files = null;
    this.artifacts = null;
    this.tasks = null;
    this.security = null;
    this.models = null;
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
    this.files = new FilesEngine(this.db);
    this.artifacts = new ArtifactsEngine(this.db);
    this.tasks = new TasksEngine(this.db);
    this.security = new SecurityEngine();
    this.tools.folders = this.folders;
    this.tools.files = this.files;   // доступ к файлам из инструментов
    this.tools.artifacts = this.artifacts; // чтение больших результатов вне контекста
    this.tools.tasks = this.tasks;         // план задачи, живущий вне переписки
    this.tools.skills = this.skills; // связь «навык ↔ инструменты» из tools
    this.tools.security = this.security; // единая точка проверки операций

    // Реестр провайдеров и моделей. Автоматического переключения нет:
    // модель меняется только явным действием пользователя или агента.
    this.models = new LLMRegistry(this.db, this.llm);
    this.tools.llmRegistry = this.models;

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

    // Политики безопасности: режим, белые списки, лимиты MCP.
    // Не секрет — храним как есть.
    const securitySettings = await this.db.get('settings', 'security');
    if (securitySettings) {
      const { key, ...values } = securitySettings;
      this.security.configure(values);
    }

    // Настройки журналирования (не секрет — храним как есть, без шифрования).
    // Управляются через ⚙ Настройки → вкладка «Журналирование».
    const loggingSettings = await this.db.get('settings', 'logging');
    if (loggingSettings) {
      this.llm.debug = !!loggingSettings.llmDebug;
      this.tools.debug = !!loggingSettings.toolsDebug;
    }

    // Реестр поднимаем ПОСЛЕ settings/llm: если провайдеров ещё нет, он
    // перенесёт оттуда параметры в первого провайдера с одной моделью.
    // Если провайдеры есть — модель по умолчанию перекроет настройки
    // выше, потому что источник правды теперь реестр.
    try {
      await this.models.init();
    } catch (e) {
      console.error('LLMRegistry: не удалось загрузить провайдеров и модели', e);
    }

    // 4. Load tools (seed defaults if needed)
    await this.tools.loadTools();
    await this.skills.loadSkills();
    await this.prompts.loadPrompts();

    // 5. Init UI
    this.ui = new UI(this);
    this.tools.ui = this.ui;

    // Тема оформления — как можно раньше после создания UI, чтобы
    // окно не мигало тёмным перед переключением на светлую/системную.
    const themeSetting = await this.db.get('settings', 'theme');
    this.ui.applyTheme(themeSetting?.value);


    // Пользовательские ограничения работы с tools и настройки отображения.
    // Применяем ПОСЛЕ создания UI (значения живут в нём), перекрывая дефолты
    // из конструктора только теми полями, что реально сохранены.
    const limits = await this.db.get('settings', 'limits');
    if (limits) {
      const { key, ...values } = limits;
      this.ui.limits = { ...this.ui.limits, ...values };
    }
    const display = await this.db.get('settings', 'display');
    if (display) {
      if (display.toolVerbosity) this.ui.toolVerbosity = display.toolVerbosity;
      if (display.filesContextMode) this.ui.filesContextMode = display.filesContextMode;
      if (display.skillsPanelMode) this.ui.skillsPanelMode = display.skillsPanelMode;
    }
    // Локальный прокси: форма настроек читает значения из this.ui.proxy.
    // Сам инструмент proxy_fetch берёт их напрямую из БД на каждый вызов —
    // здесь только то, что нужно интерфейсу.
    const proxy = await this.db.get('settings', 'proxy');
    if (proxy) {
      const { key, ...values } = proxy;
      this.ui.proxy = { ...this.ui.proxy, ...values };
    }

    const context = await this.db.get('settings', 'context');
    if (context) {
      if (typeof context.contextLimit === 'number') this.ui.contextLimit = context.contextLimit;
      if (typeof context.contextWarnPercent === 'number') this.ui.contextWarnPercent = context.contextWarnPercent;
    }

    // Раскладка панели навигации: ширина и свёрнутое состояние.
    const layout = await this.db.get('settings', 'layout');
    this.ui.applyLayout(layout);

    this.ui.updateConnectionStatus();

    // Открываем последний использованный чат, а не пустое состояние: без
    // этого currentChatId остаётся null до первого клика по чату или
    // отправки сообщения, а панель чата (быстрый выбор модели, статистика)
    // уже отрисована и выглядит рабочей — действия в ней тихо ничего не делают.
    const chats = await this.db.getAll('chats');
    if (chats.length) {
      const last = chats.reduce((a, b) => (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a);
      await this.ui.loadChat(last.id);
    } else {
      this.ui.updateModelDisplay();
      this.ui.refreshSidebar();
      this.ui.updateChatToolbar();
    }

    // Предупреждение при закрытии вкладки во время работы агента и
    // разбор ходов, оборвавшихся в прошлый раз (см. ui/ui-resume.js).
    // Именно здесь, в самом конце: нужен уже открытый чат, чтобы
    // предложение продолжить появилось там, где работа и оборвалась.
    this.ui._bindUnloadGuard();
    try {
      const interrupted = await this.ui.checkInterruptedRuns();
      if (interrupted) console.warn('Прерванных ходов найдено:', interrupted);
    } catch (e) {
      console.error('Не удалось разобрать прерванные ходы', e);
    }

    console.log('🚀 AI Agent initialized');
  }
}