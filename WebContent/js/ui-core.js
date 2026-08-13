// ============================================================
//  UI CORE — класс, базовые утилиты, модальные окна, вкладки
// ============================================================
//
// Объявляет класс UI. Остальные ui-*.js дополняют UI.prototype примесями, поэтому этот файл должен подключаться первым.

// ============================================================
//  UI MANAGER
// ============================================================
class UI {
  constructor(agent) {
    this.agent = agent;
    this.currentTab = 'chat';
    this.currentChatId = null;
    this.isStreaming = false;
    this.folderSelection = { tools: null, skills: null, prompts: null, chats: null };

    // ── Ограничения работы агента при использовании tools ──
    // Применяются к ОДНОМУ ходу пользователя (цепочке tool_calls подряд).
    // Значения перекрываются сохранёнными настройками (settings/limits).
    this.limits = {
      maxToolSteps: 25,      // макс. итераций tool-calling подряд
      maxTurnSeconds: 180,   // общий бюджет времени на ход, сек (0 — без лимита)
      toolTimeoutSeconds: 30,// таймаут одного вызова инструмента, сек (0 — без лимита)
      maxToolCallsPerTurn: 50, // суммарный потолок вызовов за ход
    };

    // Степень детализации вывода вызовов инструментов в чат:
    // 'hidden' — не показывать, 'compact' — имя + краткий результат,
    // 'detailed' — имя, аргументы, полный результат, время выполнения.
    this.toolVerbosity = 'compact';

    // Счётчики текущего хода (сбрасываются в sendMessage)
    this._turnStartedAt = 0;
    this._turnToolCalls = 0;

    this.recognition = null;   // экземпляр SpeechRecognition (голосовой ввод)
    this.isListening = false;

    // Прерывание работы агента пользователем
    this._statusTimer = null;   // интервал обновления панели статуса
    this._abortCtl = null;      // AbortController текущего запроса к LLM
    this._stopRequested = false;// флаг: прервать цепочку между шагами

    // Окно контекста модели. contextLimit=0 → определяем автоматически
    // по имени модели; contextWarnPercent — порог предупреждения.
    this.contextLimit = 0;
    this.contextWarnPercent = 75;

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
    document.getElementById('voice-btn').addEventListener('click', () => this.toggleVoiceInput());
    document.getElementById('stop-btn').addEventListener('click', () => this.stopAgent());

    // Копирование кода. Обработчик делегированный: блоки кода появляются
    // динамически по мере стриминга ответа, вешать слушатель на каждый
    // было бы и дороже, и ненадёжно (innerHTML переписывается на каждый чанк).
    document.getElementById('chat-messages').addEventListener('click', (e) => {
      const btn = e.target.closest('.code-copy-btn');
      if (btn) this._copyCodeBlock(btn);
    });
    document.getElementById('add-tool-btn').addEventListener('click', () => this.showAddToolModal());
    document.getElementById('add-mcp-server-btn').addEventListener('click', () => this.showAddMCPServerModal());
    document.getElementById('add-skill-btn').addEventListener('click', () => this.showAddSkillModal());
    document.getElementById('add-prompt-btn').addEventListener('click', () => this.showAddPromptModal());
        // Кнопки создания папок
    document.getElementById('add-tool-folder-btn').addEventListener('click', () => this._createFolder('tools'));
    document.getElementById('add-skill-folder-btn').addEventListener('click', () => this._createFolder('skills'));
    document.getElementById('add-prompt-folder-btn').addEventListener('click', () => this._createFolder('prompts'));

    // Экспорт/импорт. Из шапки панели (Tools/Skills/Промпты) открывается
    // ВЫБОРОЧНЫЙ экспорт только этого раздела — с отметкой конкретных
    // объектов. Полный экспорт и любой импорт — только через
    // ⚙ Настройки → Отображение, чтобы случайное нажатие в панели
    // не перезаписало чужими данными всю базу.
    document.getElementById('chat-export-btn').addEventListener('click', () => this.showChatExportModal());
    document.getElementById('chat-import-btn').addEventListener('click', () => this.showChatImportDialog());
    document.getElementById('chats-export-btn').addEventListener('click', () => this.showChatsExportModal());
    document.getElementById('chats-import-btn').addEventListener('click', () => this.showChatsImportDialog());

    this._bindSidebarLayout();

    document.querySelectorAll('.export-import-btn').forEach(btn => {
      btn.addEventListener('click', () => this.showSelectiveExportModal(btn.dataset.section));
    });
    document.querySelectorAll('.import-btn').forEach(btn => {
      btn.addEventListener('click', () => this.showImportModal(btn.dataset.section));
    });
  }


  // === Tab switching ===
  // ── Раскладка панели навигации: сворачивание и изменение ширины ──
  // Ширина живёт в CSS-переменной --sidebar-w, которую использует
  // grid-раскладка #app, поэтому менять достаточно её одну.
  // Состояние сохраняется в настройках, а не в localStorage: у приложения
  // уже есть своё хранилище, дублировать механизмы незачем.
  _bindSidebarLayout() {
    const app = document.getElementById('app');
    const toggle = document.getElementById('sidebar-toggle');
    const resizer = document.getElementById('sidebar-resizer');

    toggle?.addEventListener('click', () => {
      const collapsed = app.classList.toggle('sidebar-collapsed');
      toggle.textContent = collapsed ? '▸' : '◧';
      toggle.title = collapsed ? 'Развернуть панель' : 'Свернуть панель';
      this._saveLayout({ collapsed });
    });

    if (!resizer) return;

    const MIN = 180, MAX = 640;
    let startX = 0, startW = 0;

    const onMove = (e) => {
      const delta = e.clientX - startX;
      const w = Math.min(MAX, Math.max(MIN, startW + delta));
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing-sidebar');
      resizer.classList.remove('dragging');
      const w = parseInt(getComputedStyle(document.documentElement)
        .getPropertyValue('--sidebar-w'), 10);
      this._saveLayout({ width: w });
    };

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = document.getElementById('sidebar').getBoundingClientRect().width;
      document.body.classList.add('resizing-sidebar');
      resizer.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Двойной клик по разделителю возвращает ширину по умолчанию.
    resizer.addEventListener('dblclick', () => {
      document.documentElement.style.setProperty('--sidebar-w', '280px');
      this._saveLayout({ width: 280 });
    });
  }

  async _saveLayout(patch) {
    try {
      const cur = (await this.agent.db.get('settings', 'layout')) || { key: 'layout' };
      await this.agent.db.put('settings', { ...cur, key: 'layout', ...patch });
    } catch (_) { /* сохранение раскладки не критично */ }
  }

  // Применяет сохранённую раскладку при запуске (вызывается из agent.js).
  applyLayout(layout) {
    if (!layout) return;
    if (layout.width) {
      document.documentElement.style.setProperty('--sidebar-w', layout.width + 'px');
    }
    if (layout.collapsed) {
      document.getElementById('app')?.classList.add('sidebar-collapsed');
      const t = document.getElementById('sidebar-toggle');
      if (t) { t.textContent = '▸'; t.title = 'Развернуть панель'; }
    }
  }

  switchTab(tab) {
    this.currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`));

    this.refreshSidebar();
    // Кнопки работы с файлом чата имеют смысл только на вкладке чатов.
    const ioRow = document.getElementById('chat-io-row');
    if (ioRow) ioRow.hidden = tab !== 'chat';
    const iosRow = document.getElementById('chats-io-row');
    if (iosRow) iosRow.hidden = tab !== 'chat';
    if (tab === 'tools') this.renderTools();
    if (tab === 'skills') this.renderSkills();
    if (tab === 'prompts') this.renderPrompts();
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
    const { modal = false, wide = false } = options;
    const id = 'modal_' + uid();
    const modals = document.getElementById('modals');
    modals.innerHTML = `
      <div class="modal-overlay" id="${id}">
        <div class="modal${wide ? ' modal-wide' : ''}">
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


  // === Helpers ===
  _escHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }


  // Единая точка переключения "агент занят / свободен":
  // раньше disabled у send-btn выставлялся в семи местах вразнобой.
  _setBusy(busy) {
    this.isStreaming = busy;
    const send = document.getElementById('send-btn');
    const stop = document.getElementById('stop-btn');
    if (send) send.disabled = busy;
    if (stop) stop.hidden = !busy;
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
}
