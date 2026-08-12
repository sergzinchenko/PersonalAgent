// ============================================================
//  UI SETTINGS — окно настроек, состояние подключения и модели
// ============================================================
//
// Модальное окно настроек со вкладками и индикаторы подключения.

Object.assign(UI.prototype, {


  // ──────────────────────────────────────────────
  //  showSettingsModal — вызывается с modal: true,
  //  чтобы клик по оверлею НЕ закрывал окно.
  //  Настройки сгруппированы по вкладкам: Подключение / Модель / Журналирование.
  // ──────────────────────────────────────────────
  showSettingsModal() {
    const llm = this.agent.llm;
    const isBearerChecked = llm.authType !== 'custom' ? 'checked' : '';
    const isCustomChecked = llm.authType === 'custom' ? 'checked' : '';
    const customDisplay = llm.authType === 'custom' ? '' : 'display:none;';
    const bearerDisplay = llm.authType !== 'custom' ? '' : 'display:none;';

    this._showModal('⚙ Настройки', `
      <div class="settings-tabs">
        <button type="button" class="tab-btn settings-tab-btn active" data-settings-tab="connection">🔌 Подключение</button>
        <button type="button" class="tab-btn settings-tab-btn" data-settings-tab="model">🧠 Модель</button>
        <button type="button" class="tab-btn settings-tab-btn" data-settings-tab="limits">⏱ Ограничения</button>
        <button type="button" class="tab-btn settings-tab-btn" data-settings-tab="display">👁 Отображение</button>
        <button type="button" class="tab-btn settings-tab-btn" data-settings-tab="logging">🪵 Журналирование</button>
      </div>

      <div class="settings-tab-panel" data-settings-panel="connection">
        <div class="form-group">
          <label>API URL (OpenAI-compatible)</label>
          <input id="s_url" value="${this._escHtml(llm.apiUrl)}" placeholder="https://api.example.com/v1">
        </div>

        <div class="form-group">
          <label>Способ авторизации</label>
          <div style="display:flex;gap:16px;margin-top:4px;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:var(--text-primary);">
              <input type="radio" name="auth_type" value="bearer" ${isBearerChecked} style="width:auto;"> Стандартный OpenAI (Bearer)
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;color:var(--text-primary);">
              <input type="radio" name="auth_type" value="custom" ${isCustomChecked} style="width:auto;"> Нестандартный заголовок
            </label>
          </div>
        </div>

        <div id="auth_bearer_section" style="${bearerDisplay}">
          <div class="form-group">
            <label>API Key</label>
            <input id="s_key" type="password" value="${this._escHtml(llm.apiKey)}" placeholder="sk-...">
          </div>
        </div>

        <div id="auth_custom_section" style="${customDisplay}">
          <div class="form-group">
            <label>Имя HTTP заголовка</label>
            <input id="s_custom_header" value="${this._escHtml(llm.customHeaderName)}" placeholder="X-API-Key">
          </div>
          <div class="form-group">
            <label>Значение заголовка</label>
            <input id="s_custom_value" type="password" value="${this._escHtml(llm.customHeaderValue)}" placeholder="your-secret-key">
          </div>
        </div>

        <div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <button class="btn btn-success btn-sm" id="test-conn-btn">🔌 Тест и загрузка моделей</button>
          <span id="conn-result" style="font-size:12px;"></span>
        </div>
        <div id="models-status" style="margin-top:8px;font-size:12px;color:var(--text-muted);"></div>
      </div>

      <div class="settings-tab-panel" data-settings-panel="model" hidden>
        <div class="form-group">
          <label>Model</label>
          <div style="display:flex;gap:8px;">
            <select id="s_model_select" style="flex:1;">
              <option value="">-- Нажмите &quot;Загрузить модели&quot; на вкладке «Подключение» --</option>
            </select>
            <input id="s_model_manual" value="${this._escHtml(llm.model)}" placeholder="или введите вручную" style="flex:1;">
          </div>
          <div style="margin-top:4px;font-size:11px;color:var(--text-muted);">Выберите из списка или введите вручную. Приоритет у выпадающего списка.</div>
        </div>

        <div class="form-group">
          <label>Max Tokens</label>
          <input id="s_tokens" type="number" value="${llm.maxTokens}">
        </div>

        <div class="form-group">
          <label>Temperature (0-2)</label>
          <input id="s_temp" type="number" step="0.1" min="0" max="2" value="${llm.temperature}">
        </div>

        <div class="form-group">
          <label>Окно контекста модели, токенов</label>
          <input id="s_ctx_limit" type="number" min="0" value="${this.contextLimit}"
                 placeholder="0 — определять автоматически">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            0 — определяется по названию модели${this._knownContextLimit(llm.model) ? ` (сейчас: ${this._fmtLimit(this._knownContextLimit(llm.model))})` : ' (для этой модели не распознано — укажите вручную)'}.
            API обычно не сообщает этот лимит, поэтому значение задаётся здесь.
          </div>
        </div>

        <div class="form-group">
          <label>Предупреждать при заполнении контекста, %</label>
          <input id="s_ctx_warn" type="number" min="1" max="99" value="${this.contextWarnPercent}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            При достижении этого порога появится предупреждение, при 100% — предложение создать новый чат.
          </div>
        </div>
      </div>

      <div class="settings-tab-panel" data-settings-panel="limits" hidden>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
          Ограничения применяются к одному ответу агента — то есть ко всей цепочке
          вызовов инструментов, запущенной вашим сообщением. 0 — без ограничения.
        </div>
        <div class="settings-grid">
        <div class="form-group">
          <label>Максимум итераций с вызовом инструментов</label>
          <input id="s_max_steps" type="number" min="0" value="${this.limits.maxToolSteps}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            Сколько раз подряд модель может вызвать инструменты и получить ответ. Защита от зацикливания.
          </div>
        </div>
        <div class="form-group">
          <label>Бюджет времени на ответ, секунд</label>
          <input id="s_max_turn_sec" type="number" min="0" value="${this.limits.maxTurnSeconds}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            По истечении запрос к модели прерывается, цепочка останавливается.
          </div>
        </div>
        <div class="form-group">
          <label>Таймаут одного вызова инструмента, секунд</label>
          <input id="s_tool_timeout_sec" type="number" min="0" value="${this.limits.toolTimeoutSeconds}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            Зависший инструмент вернёт ошибку таймаута вместо бесконечного ожидания.
          </div>
        </div>
        <div class="form-group">
          <label>Максимум вызовов инструментов за ответ</label>
          <input id="s_max_calls" type="number" min="0" value="${this.limits.maxToolCallsPerTurn}">
        </div>
        </div>
      </div>

      <div class="settings-tab-panel" data-settings-panel="display" hidden>
        <div class="form-group">
          <label>Детализация вызовов инструментов в чате</label>
          <select id="s_tool_verbosity">
            <option value="hidden" ${this.toolVerbosity === 'hidden' ? 'selected' : ''}>Скрывать — не показывать вызовы</option>
            <option value="compact" ${this.toolVerbosity === 'compact' ? 'selected' : ''}>Кратко — имя и начало результата</option>
            <option value="detailed" ${this.toolVerbosity === 'detailed' ? 'selected' : ''}>Подробно — аргументы, полный результат, время</option>
          </select>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            Влияет только на отображение. Вызовы выполняются и сохраняются в истории в любом случае.
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
          Экспорт и импорт tools, skills и промптов доступны кнопками «📦 Экспорт» и «📥 Импорт»
          в шапке соответствующей панели.
        </div>
      </div>

      <div class="settings-tab-panel" data-settings-panel="logging" hidden>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
          Подробное логирование в консоль браузера (DevTools). Полезно для отладки,
          но может писать в консоль содержимое переписки и аргументов инструментов —
          по умолчанию выключено.
        </div>

        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="s_debug_llm" style="width:auto;" ${this.agent.llm.debug ? 'checked' : ''}>
            Запросы/ответы LLM (llm-gateway)
          </label>
          <div style="margin-top:2px;font-size:11px;color:var(--text-muted);">
            Эндпоинт, заголовки (ключ маскируется), тело запроса, сообщения, стрим-чанки, usage.
          </div>
        </div>

        <div class="form-group">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" id="s_debug_tools" style="width:auto;" ${this.agent.tools.debug ? 'checked' : ''}>
            Вызовы инструментов (tools-engine)
          </label>
          <div style="margin-top:2px;font-size:11px;color:var(--text-muted);">
            Какой tool вызван, с какими аргументами, что вернул.
          </div>
        </div>
      </div>
    `, async () => {
      const selectVal = document.getElementById('s_model_select').value;
      const manualVal = document.getElementById('s_model_manual').value.trim();
      const finalModel = selectVal || manualVal;

      const authType = document.querySelector('input[name="auth_type"]:checked')?.value || 'bearer';

      const config = {
        apiUrl: document.getElementById('s_url').value.trim(),
        apiKey: document.getElementById('s_key').value.trim(),
        model: finalModel,
        maxTokens: parseInt(document.getElementById('s_tokens').value) || 4096,
        temperature: parseFloat(document.getElementById('s_temp').value) || 0.7,
        authType: authType,
        customHeaderName: document.getElementById('s_custom_header').value.trim(),
        customHeaderValue: document.getElementById('s_custom_value').value.trim(),
      };
      llm.configure(config); // в памяти держим и используем расшифрованные значения как есть

      // Перед записью в IndexedDB шифруем секреты (apiKey/customHeaderValue)
      // через SecretsVault (crypto-utils.js) — в самой БД они не должны
      // лежать простым текстом. В памяти у `llm` остаются как обычные строки.
      const storedConfig = {
        ...config,
        apiKey: await SecretsVault.encrypt(this.agent.db, config.apiKey),
        customHeaderValue: await SecretsVault.encrypt(this.agent.db, config.customHeaderValue),
      };
      await this.agent.db.put('settings', { key: 'llm', ...storedConfig });

      // Окно контекста: ручной лимит и порог предупреждения.
      this.contextLimit = Math.max(0, parseInt(document.getElementById('s_ctx_limit').value) || 0);
      this.contextWarnPercent = Math.min(99, Math.max(1, parseInt(document.getElementById('s_ctx_warn').value) || 75));
      await this.agent.db.put('settings', {
        key: 'context',
        contextLimit: this.contextLimit,
        contextWarnPercent: this.contextWarnPercent,
      });

      // Ограничения работы агента при использовании tools.
      const limits = {
        maxToolSteps: Math.max(0, parseInt(document.getElementById('s_max_steps').value) || 0),
        maxTurnSeconds: Math.max(0, parseInt(document.getElementById('s_max_turn_sec').value) || 0),
        toolTimeoutSeconds: Math.max(0, parseInt(document.getElementById('s_tool_timeout_sec').value) || 0),
        maxToolCallsPerTurn: Math.max(0, parseInt(document.getElementById('s_max_calls').value) || 0),
      };
      this.limits = limits;
      await this.agent.db.put('settings', { key: 'limits', ...limits });

      // Отображение хода вызова инструментов.
      this.toolVerbosity = document.getElementById('s_tool_verbosity').value;
      await this.agent.db.put('settings', { key: 'display', toolVerbosity: this.toolVerbosity });

      // Журналирование: значения не секретные, храним как есть (без шифрования).
      const loggingConfig = {
        llmDebug: document.getElementById('s_debug_llm').checked,
        toolsDebug: document.getElementById('s_debug_tools').checked,
      };
      this.agent.llm.debug = loggingConfig.llmDebug;
      this.agent.tools.debug = loggingConfig.toolsDebug;
      await this.agent.db.put('settings', { key: 'logging', ...loggingConfig });

      this.updateConnectionStatus();
      this.updateModelDisplay();
      this.updateChatToolbar();
    }, null, { modal: true, wide: true }); // ← strict modal: overlay click does NOT close

    setTimeout(() => {
      // --- Переключение вкладок ---
      document.querySelectorAll('.settings-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.settings-tab-btn').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          const target = btn.dataset.settingsTab;
          document.querySelectorAll('.settings-tab-panel').forEach((p) => {
            p.hidden = p.dataset.settingsPanel !== target;
          });
        });
      });

      document.querySelectorAll('input[name="auth_type"]').forEach(function(radio) {
        radio.addEventListener('change', function() {
          var isBearerSelected = this.value === 'bearer';
          document.getElementById('auth_bearer_section').style.display = isBearerSelected ? '' : 'none';
          document.getElementById('auth_custom_section').style.display = isBearerSelected ? 'none' : '';
        });
      });

      if (llm.availableModels.length > 0) {
        var sel = document.getElementById('s_model_select');
        sel.innerHTML = '<option value="">-- Выберите модель --</option>';
        llm.availableModels.forEach(function(m) {
          var opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          if (m === llm.model) opt.selected = true;
          sel.appendChild(opt);
        });
      }

      document.getElementById('s_model_select').addEventListener('change', function() {
        if (this.value) {
          document.getElementById('s_model_manual').value = this.value;
        }
      });

      document.getElementById('test-conn-btn').addEventListener('click', async function() {
        var resultEl = document.getElementById('conn-result');
        var modelsEl = document.getElementById('models-status');
        resultEl.textContent = '⏳ Проверяю...';
        resultEl.style.color = 'var(--warning)';
        modelsEl.textContent = '';

        var tmpUrl = document.getElementById('s_url').value.trim();
        var authType = document.querySelector('input[name="auth_type"]:checked')?.value || 'bearer';
        var headers = { 'Content-Type': 'application/json' };

        if (authType === 'custom') {
          var hName = document.getElementById('s_custom_header').value.trim();
          var hVal = document.getElementById('s_custom_value').value.trim();
          if (hName) headers[hName] = hVal;
        } else {
          var key = document.getElementById('s_key').value.trim();
          if (key) headers['Authorization'] = 'Bearer ' + key;
        }

        try {
          var models = await llm.fetchModels(tmpUrl, headers);

          resultEl.textContent = '✅ Подключено!';
          resultEl.style.color = 'var(--success)';
          modelsEl.textContent = 'Найдено моделей: ' + models.length;

          var sel = document.getElementById('s_model_select');
          sel.innerHTML = '<option value="">-- Выберите модель --</option>';

          var currentModel = document.getElementById('s_model_manual').value.trim();

          models.forEach(function(m) {
            var opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (m === currentModel) opt.selected = true;
            sel.appendChild(opt);
          });

          if (models.length > 0 && !currentModel) {
            sel.selectedIndex = 1;
            document.getElementById('s_model_manual').value = models[0];
          }

        } catch (e) {
          resultEl.textContent = '❌ Ошибка: ' + e.message;
          resultEl.style.color = 'var(--danger)';
          modelsEl.textContent = '';
        }
      });
    }, 50);
  },


  updateConnectionStatus() {
    const dot = document.querySelector('#connection-status .status-dot');
    dot.className = 'status-dot ' + (this.agent.llm.isConfigured() ? 'online' : 'offline');
  },


  updateModelDisplay() {
    var existing = document.getElementById('model-badge');
    if (existing) existing.remove();

    if (this.agent.llm.model) {
      var badge = document.createElement('span');
      badge.id = 'model-badge';
      badge.style.cssText = 'font-size:11px; padding:3px 10px; background:var(--bg-tertiary); border:1px solid var(--border); border-radius:20px; color:var(--accent-light); white-space:nowrap; max-width:200px; overflow:hidden; text-overflow:ellipsis;';
      badge.textContent = '🤖 ' + this.agent.llm.model;
      badge.title = 'Текущая модель: ' + this.agent.llm.model;
      var settingsBtn = document.getElementById('settings-btn');
      settingsBtn.parentNode.insertBefore(badge, settingsBtn);
    }
  }

});
