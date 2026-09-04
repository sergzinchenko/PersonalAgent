// ============================================================
//  UI SETTINGS — окно настроек, состояние подключения и модели
// ============================================================
//
// Модальное окно настроек со вкладками и индикаторы подключения.

Object.assign(UI.prototype, {


  // ──────────────────────────────────────────────
  //  Настройки сгруппированы по вкладкам:
  //  Провайдеры и модели / Ограничения / Отображение / Безопасность / Журналирование.
  //  Окно, как и все прочие, строго модально — см. _showModal.
  // ──────────────────────────────────────────────
  showSettingsModal() {
    const llm = this.agent.llm;
    const isBearerChecked = llm.authType !== 'custom' ? 'checked' : '';
    const isCustomChecked = llm.authType === 'custom' ? 'checked' : '';
    const customDisplay = llm.authType === 'custom' ? '' : 'display:none;';
    const bearerDisplay = llm.authType !== 'custom' ? '' : 'display:none;';

    this._showModal('⚙ Настройки', `
      <div class="settings-tabs">
        <button type="button" class="tab-btn settings-tab-btn active" data-settings-tab="models">🔌 Провайдеры и модели</button>
        <button type="button" class="tab-btn settings-tab-btn" data-settings-tab="limits">⏱ Ограничения</button>
        <button type="button" class="tab-btn settings-tab-btn" data-settings-tab="display">👁 Отображение</button>
        <button type="button" class="tab-btn settings-tab-btn" data-settings-tab="security">🛡 Безопасность</button>
        <button type="button" class="tab-btn settings-tab-btn" data-settings-tab="logging">🪵 Журналирование</button>
      </div>

      <div class="settings-tab-panel" data-settings-panel="models">
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:10px;">
          Два уровня: <b>провайдер</b> — куда обращаться и с каким ключом,
          <b>модели</b> — что у него использовать. Разверните провайдера, чтобы увидеть его модели.
          Отмеченная звёздочкой модель подставляется в новые чаты; в каждом чате её можно сменить.
        </div>

        <div id="providers-panel"></div>

        <button class="btn btn-secondary" id="providers-add" style="width:100%;margin-top:4px;">
          + Добавить провайдера
        </button>

        <div class="form-group" style="margin-top:16px;">
          <label>Предупреждать при заполнении контекста, %</label>
          <input id="s_ctx_warn" type="number" min="1" max="99" value="${this.contextWarnPercent}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            При достижении порога появится предупреждение, при 100% — предложение создать новый чат.
            Само окно контекста задаётся у каждой модели отдельно.
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
        <div class="form-group">
          <label>Предел ответа инструмента, символов</label>
          <input id="s_max_resp_chars" type="number" min="500" step="500" value="${this.limits.maxToolResponseChars}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            Сколько символов ответа попадёт в контекст. Действует на все внешние
            каналы сразу: MCP-серверы, <code>proxy_fetch</code>, <code>http_fetch</code>.
            Большой ответ вытесняет из контекста историю переписки и системный промпт.
          </div>
        </div>
        <div class="form-group">
          <label class="check-row">
            <input type="checkbox" id="s_ctx_compaction" ${this.limits.contextCompaction !== false ? 'checked' : ''}>
            Сворачивать переписку вместо потери начала
          </label>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            Когда история перестаёт помещаться в окно контекста, её начало один раз
            сжимается моделью в резюме — что сделано, что выяснено, какие решения приняты —
            и дальше участвует в работе в таком виде. Стоит одного дополнительного запроса
            в момент переполнения. Без этого начало переписки просто перестаёт передаваться.
          </div>
        </div>
        <div class="form-group">
          <label>Максимум шагов внутри подзадачи</label>
          <input id="s_subtask_steps" type="number" min="1" max="30" value="${this.limits.subtaskMaxSteps}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            Подзадача (<code>run_subtask</code>) — часть работы, выполняемая отдельным ходом
            с чистым контекстом: в основную переписку возвращается только итог.
            Здесь её собственный потолок итераций; агент может запросить меньший.
          </div>
        </div>
        <div class="form-group">
          <label>Выносить результат в артефакт от, символов</label>
          <input id="s_artifact_threshold" type="number" min="0" step="500" value="${this.limits.artifactThresholdChars}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            Результат крупнее этого порога сохраняется отдельно, а модели уходит короткая
            шапка с идентификатором: размер, структура, начало текста. Дочитывает она его
            сама — инструментами <code>artifact_read</code> и <code>artifact_grep</code>.
            Так один большой ответ перестаёт занимать контекст до конца чата.
            0 — выключить и передавать результаты целиком, как раньше.
          </div>
        </div>
        </div>
      </div>

      <div class="settings-tab-panel" data-settings-panel="display" hidden>
        <div class="form-group">
          <label>Имя агента</label>
          <input id="s_agent_name" maxlength="${AboutEngine.MAX_NAME}"
                 value="${this._escHtml(this.agent.about?.name || '')}"
                 placeholder="Например: Ада, Помощник, Пятница">
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            Видно в шапке приложения и в заголовке вкладки. Агент знает своё имя и отзывается
            на него — переименовать можно и прямо в разговоре, просто попросив.
            Пустое поле имя не сбрасывает.
          </div>
        </div>
        <div class="form-group">
          <label>История доработок</label>
          <div style="font-size:11px;color:var(--text-muted);">
            Сейчас релиз ${APP_RELEASE_COUNT}. Что появлялось от релиза к релизу, показывает значок
            «r${APP_RELEASE_COUNT}» в шапке; то же окно открывается само, когда есть непрочитанное.
            Кнопки здесь нет намеренно: она закрыла бы это окно вместе с несохранёнными изменениями.
            Спросить агента «что нового» тоже можно — он расскажет.
          </div>
        </div>
        <div class="form-group">
          <label>Тема оформления</label>
          <select id="s_theme">
            <option value="system" ${this.theme === 'system' ? 'selected' : ''}>Системная (по умолчанию)</option>
            <option value="dark" ${this.theme === 'dark' ? 'selected' : ''}>Тёмная</option>
            <option value="light" ${this.theme === 'light' ? 'selected' : ''}>Светлая</option>
          </select>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            «Системная» следует за настройкой оформления вашей ОС/браузера.
          </div>
        </div>
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
        <div class="form-group">
          <label>Навыки в панели чата</label>
          <select id="s_skills_mode">
            <option value="active">Только включённые (компактно)</option>
            <option value="all">Все навыки</option>
          </select>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            Переключать можно и прямо в чате — кнопкой справа от навыков.
          </div>
        </div>

        <div class="form-group">
          <label>Что агент знает о ваших файлах</label>
          <select id="s_files_ctx">
            <option value="off">Ничего — файлы только по прямому запросу</option>
            <option value="brief">Только факт наличия (рекомендуется)</option>
            <option value="full">Полный перечень путей</option>
          </select>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            Полный перечень в каждом запросе провоцирует агента анализировать файлы
            без просьбы и расходует контекст. При любом варианте агент может получить
            список инструментом, когда вы о файлах спросите.
          </div>
        </div>

        <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
          Экспорт и импорт tools, skills и промптов доступны кнопками «📦 Экспорт» и «📥 Импорт»
          в шапке соответствующей панели.
        </div>
      </div>

      <div class="settings-tab-panel" data-settings-panel="security" hidden>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
          Агент выполняет действия самостоятельно, по решению модели. Эти правила определяют,
          что он может сделать сразу, а что — только с вашего подтверждения.
        </div>

        <div class="form-group">
          <label>Режим</label>
          <select id="s_sec_mode">
            ${Object.entries(SecurityEngine.MODES).map(([k, v]) =>
              `<option value="${k}" ${this.agent.security.mode === k ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
          <div id="sec_mode_hint" style="font-size:11px;color:var(--text-secondary);margin-top:6px;line-height:1.5;"></div>
        </div>

        <div id="sec_max_fields" ${this.agent.security.mode === 'maximum' ? '' : 'hidden'}>
          <div class="form-group">
            <label>Разрешённые домены</label>
            <input id="s_sec_hosts" value="${this._escHtml((this.agent.security.allowedHosts || []).join(', '))}"
                   placeholder="example.com, api.example.org — пусто = спрашивать про каждый">
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
              В максимальном режиме обращения к другим адресам блокируются без вопроса.
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>Потолок изменений за один ответ</label>
          <input id="s_sec_writes" type="number" min="0" value="${this.agent.security.maxWritesPerTurn || 20}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            После этого числа изменений подряд агент будет спрашивать подтверждение.
            Защита от случая «агент увлёкся и переделал всё».
          </div>
        </div>

        <div class="form-group">
          <label>Потолок вызовов одного инструмента за ответ</label>
          <input id="s_sec_percall" type="number" min="1" value="${this.agent.security.maxCallsPerToolPerTurn || 25}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            Ловит зацикливание: сто вызовов подряд одного и того же инструмента — это не работа,
            а застрявший ход. Общий потолок изменений выше такой случай не замечает,
            потому что чтение и сетевые запросы ничего не меняют.
          </div>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:14px;">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px;">Внешние MCP-серверы</div>
          <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:10px;">
            MCP-вызов отличается от прочих инструментов: аргументы формирует модель и отправляет
            на чужой сервер, а ответ возвращается прямо в контекст диалога — вместе со всем,
            что в нём написано.
          </div>

          <div class="form-group">
            <label>Разрешённые MCP-серверы</label>
            <input id="s_mcp_hosts" value="${this._escHtml((this.agent.security.allowedMcpHosts || []).join(', '))}"
                   placeholder="mcp.example.com, tools.example.org — пусто = список не ограничен">
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
              Заполненный список действует сильнее режима: всё, чего в нём нет, блокируется
              без вопроса. Пустой — обращения подтверждаются по первому разу для каждого адреса.
            </div>
          </div>

          <div class="form-group">
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;">
              <input type="checkbox" id="s_mcp_https" style="width:auto;" ${this.agent.security.mcpLimits.requireHttps !== false ? 'checked' : ''}>
              Требовать https
            </label>
            <div style="font-size:11px;color:var(--text-muted);margin:2px 0 8px 22px;">
              По http токен доступа уходит открытым текстом.
            </div>

            <label style="display:flex;align-items:center;gap:6px;font-weight:400;">
              <input type="checkbox" id="s_mcp_local" style="width:auto;" ${this.agent.security.mcpLimits.allowLocalServers ? 'checked' : ''}>
              Разрешить локальные серверы (localhost)
            </label>
            <div style="font-size:11px;color:var(--text-muted);margin:2px 0 8px 22px;">
              Нужно, если MCP-сервер запущен на этой же машине. Остальные адреса внутренней
              сети остаются запрещёнными в любом случае.
            </div>

            <label style="display:flex;align-items:center;gap:6px;font-weight:400;">
              <input type="checkbox" id="s_mcp_mark" style="width:auto;" ${this.agent.security.mcpLimits.markUntrusted !== false ? 'checked' : ''}>
              Помечать ответы как данные, а не указания
            </label>
            <div style="font-size:11px;color:var(--text-muted);margin:2px 0 0 22px;">
              Снижает — но не устраняет — риск того, что текст с чужого сервера будет
              воспринят агентом как команда.
            </div>
          </div>

          <div class="form-group">
            <label>Вызовов MCP за ответ</label>
            <input id="s_mcp_calls" type="number" min="1" max="200" value="${this.agent.security.mcpLimits.maxCallsPerTurn || 15}">
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
              Отдельный, более узкий потолок именно для MCP — поверх общего числа
              вызовов за ответ на вкладке «Ограничения».
              Таймаут и предел ответа у MCP не свои: действуют общие оттуда же.
            </div>
          </div>

          <div style="font-size:11px;color:var(--text-muted);line-height:1.5;">
            Большой ответ вытесняет из контекста историю переписки и системный промпт —
            то есть в том числе правила поведения самого агента.
          </div>

          <div class="form-group" style="margin-top:10px;">
            <button class="btn btn-secondary btn-sm" id="sec-show-mcp">🔌 Показать подключённые MCP-серверы</button>
          </div>
        </div>

        <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:14px;">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px;">Локальный прокси</div>
          <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:10px;">
            Отдельный процесс на вашей машине (<code>node proxy/proxy.js</code>), через который
            инструмент <b>proxy_fetch</b> обходит CORS и достаёт внутренние адреса.
            Пока адрес не задан, а сам инструмент не включён на вкладке Tools, агент им не пользуется.
            Свой белый список хостов у прокси задаётся в его <code>proxy/config.js</code>.
          </div>

          <div class="form-group">
            <label>Адрес прокси</label>
            <input id="s_proxy_url" value="${this._escHtml(this.proxy?.baseUrl || '')}"
                   placeholder="http://localhost:3000">
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
              Порт берётся из <code>proxy/config.js</code> (по умолчанию 3000). Пусто = инструмент отключён.
            </div>
          </div>

          <div class="form-group">
            <label style="display:flex;align-items:center;gap:6px;font-weight:400;">
              <input type="checkbox" id="s_proxy_sso" style="width:auto;" ${this.proxy?.allowSso ? 'checked' : ''}>
              Разрешить режим SSO (доменная аутентификация)
            </label>
            <div style="font-size:11px;color:var(--warning);margin:2px 0 0 22px;line-height:1.5;">
              В этом режиме прокси обращается к цели через curl с правами вашей учётной записи Windows
              (NTLM/Negotiate), и целевой сервер видит, кто вы. Адрес при этом выбирает модель, поэтому
              каждый такой запрос подтверждается вручную — независимо от режима выше, и без варианта
              «больше не спрашивать».
            </div>
          </div>

          <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">
            Предел ответа — общий для всех внешних каналов, он на вкладке «⏱ Ограничения».
            В отдельном вызове его можно понизить параметром <code>max_chars</code>.
          </div>

          <div class="form-group">
            <button class="btn btn-secondary btn-sm" id="sec-check-proxy">🔌 Проверить прокси</button>
            <button class="btn btn-secondary btn-sm" id="sec-gen-proxy">📦 Сгенерировать файлы прокси</button>
            <span id="proxy_check_result" style="font-size:12px;margin-left:8px;"></span>
            <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">
              Генератор соберёт <code>config.js</code> по вашим значениям, приложит
              <code>proxy.js</code> и скрипты запуска и предложит сохранить всё в одну папку.
            </div>
          </div>
        </div>

        <div class="form-group">
          <label>Журнал решений</label>
          <button class="btn btn-secondary btn-sm" id="sec-show-audit">📋 Показать журнал безопасности</button>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            Что агент запрашивал, что было разрешено и что заблокировано.
          </div>
        </div>

        <div style="font-size:11px;color:var(--warning);margin-top:12px;line-height:1.5;">
          ⚠️ Проверки касаются действий агента через инструменты. Они не изолируют код самого
          инструмента: включённый инструмент выполняется в браузере и может обращаться к сети
          напрямую. Поэтому инструменты, созданные моделью, всегда требуют ручного включения.
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
      // Окно контекста задаётся у каждой модели; здесь остаётся только
      // порог, при котором предупреждать о заполнении.
      this.contextWarnPercent = Math.min(99, Math.max(1, parseInt(document.getElementById('s_ctx_warn').value) || 75));
      await this.agent.db.put('settings', {
        key: 'context',
        contextWarnPercent: this.contextWarnPercent,
      });

      // Ограничения работы агента при использовании tools.
      const limits = {
        maxToolSteps: Math.max(0, parseInt(document.getElementById('s_max_steps').value) || 0),
        maxTurnSeconds: Math.max(0, parseInt(document.getElementById('s_max_turn_sec').value) || 0),
        toolTimeoutSeconds: Math.max(0, parseInt(document.getElementById('s_tool_timeout_sec').value) || 0),
        maxToolCallsPerTurn: Math.max(0, parseInt(document.getElementById('s_max_calls').value) || 0),
        maxToolResponseChars: Math.max(500, parseInt(document.getElementById('s_max_resp_chars').value) || 20000),
        artifactThresholdChars: Math.max(0, parseInt(document.getElementById('s_artifact_threshold').value) || 0),
        subtaskMaxSteps: Math.min(30, Math.max(1, parseInt(document.getElementById('s_subtask_steps').value) || 10)),
        contextCompaction: !!document.getElementById('s_ctx_compaction')?.checked,
      };
      this.limits = limits;
      await this.agent.db.put('settings', { key: 'limits', ...limits });

      // Имя агента. Пустое поле — это НЕ сброс: имя уходит в системный
      // промпт, и агент без имени начал бы придумывать его заново.
      // Чтобы сменить имя, его надо ввести.
      const nameInput = document.getElementById('s_agent_name')?.value || '';
      if (nameInput.trim() && this.agent.about) {
        const res = await this.agent.about.setName(nameInput);
        if (!res.error) this.applyAgentName(res.name);
      }

      // Тема оформления.
      this.applyTheme(document.getElementById('s_theme').value);
      await this.agent.db.put('settings', { key: 'theme', value: this.theme });

      // Отображение хода вызова инструментов.
      this.toolVerbosity = document.getElementById('s_tool_verbosity').value;
      this.filesContextMode = document.getElementById('s_files_ctx').value;
      this.skillsPanelMode = document.getElementById('s_skills_mode').value;
      await this.agent.db.put('settings', { key: 'display', toolVerbosity: this.toolVerbosity, filesContextMode: this.filesContextMode, skillsPanelMode: this.skillsPanelMode });

      // Политика безопасности.
      const secCfg = {
        mode: document.getElementById('s_sec_mode').value,
        allowedHosts: document.getElementById('s_sec_hosts')?.value || '',
        maxWritesPerTurn: Math.max(0, parseInt(document.getElementById('s_sec_writes').value) || 20),
        maxCallsPerToolPerTurn: Math.max(1, parseInt(document.getElementById('s_sec_percall')?.value) || 25),
        allowedMcpHosts: document.getElementById('s_mcp_hosts')?.value || '',
        mcpLimits: {
          requireHttps: !!document.getElementById('s_mcp_https')?.checked,
          allowLocalServers: !!document.getElementById('s_mcp_local')?.checked,
          markUntrusted: !!document.getElementById('s_mcp_mark')?.checked,
          timeoutSeconds: Math.max(1, parseInt(document.getElementById('s_mcp_timeout')?.value) || 30),
          maxResponseChars: Math.max(1000, parseInt(document.getElementById('s_mcp_size')?.value) || 100000),
          maxCallsPerTurn: Math.max(1, parseInt(document.getElementById('s_mcp_calls')?.value) || 15),
        },
      };
      this.agent.security.configure(secCfg);
      await this.agent.db.put('settings', { key: 'security', ...secCfg });

      // Локальный прокси (инструмент proxy_fetch). Адрес не секрет,
      // но по нему ходят запросы с правами пользователя — храним отдельным
      // ключом, а не внутри security, чтобы не смешивать политику
      // подтверждений с настройкой канала.
      this.proxy = {
        baseUrl: (document.getElementById('s_proxy_url')?.value || '').trim(),
        allowSso: !!document.getElementById('s_proxy_sso')?.checked,
      };
      await this.agent.db.put('settings', { key: 'proxy', ...this.proxy });

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
    }, null, { wide: true });

    setTimeout(() => {
      // Переход к списку подключений. Настройки при этом закрываются:
      // два окна поверх друг друга — верный способ потерять, в каком
      // из них ты что-то менял.

      // Панель провайдеров рисуется отдельно: она перечитывает реестр и
      // перерисовывает только свой контейнер, не трогая остальные вкладки.
      this.renderProvidersPanel();

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

      // Подсказка режима меняется вместе с выбором — иначе смысл режимов
      // приходится угадывать по названию.
      const filesCtx = document.getElementById('s_files_ctx');
      if (filesCtx) filesCtx.value = this.filesContextMode || 'brief';
      const skMode = document.getElementById('s_skills_mode');
      if (skMode) skMode.value = this.skillsPanelMode || 'active';

      const secMode = document.getElementById('s_sec_mode');
      const syncSecHint = () => {
        const m = SecurityEngine.MODES[secMode.value];
        document.getElementById('sec_mode_hint').textContent = m ? m.hint : '';
        document.getElementById('sec_max_fields').hidden = secMode.value !== 'maximum';
      };
      secMode?.addEventListener('change', syncSecHint);
      syncSecHint();

      document.getElementById('sec-show-audit')?.addEventListener('click', () => this.showSecurityAudit());
      document.getElementById('sec-show-mcp')?.addEventListener('click', () => this.showMcpServers());

      // Проверка прокси. Берём адрес прямо из поля, а не из сохранённых
      // настроек: проверять хочется ДО сохранения формы, иначе «проверить»
      // означало бы «сначала сохрани, потом проверь, потом снова открой».
      // Генератор открывается поверх настроек. Окно настроек при этом
      // закрывается (два окна друг над другом — верный способ потерять,
      // где ты что менял), поэтому текущий адрес прокси генератор берёт
      // из уже сохранённого this.proxy, а не из поля формы.
      document.getElementById('sec-gen-proxy')?.addEventListener('click', () => this.showProxySetupModal());

      document.getElementById('sec-check-proxy')?.addEventListener('click', async () => {
        const out = document.getElementById('proxy_check_result');
        const base = (document.getElementById('s_proxy_url')?.value || '').trim();
        if (!base) { out.style.color = 'var(--warning)'; out.textContent = 'Адрес не задан'; return; }
        out.style.color = 'var(--text-muted)';
        out.textContent = 'Проверяю…';
        try {
          // Запрос без url= — прокси штатно отвечает 400 с описанием, и это
          // ровно то, что нужно: значит, он слушает и отвечает.
          const r = await fetch(base.replace(/\/+$/, '') + '/', { method: 'GET' });
          out.style.color = 'var(--success)';
          out.textContent = `Прокси отвечает (HTTP ${r.status})`;
        } catch (e) {
          out.style.color = 'var(--danger)';
          out.textContent = 'Не отвечает — запущен ли «node proxy/proxy.js»?';
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

  ,

  // Журнал решений политики: что агент запрашивал и чем закончилось.
  // Какие MCP-серверы реально подключены и сколько их инструментов
  // включено. Без этого списка «разрешённые серверы» настраиваются
  // вслепую: имена инструментов ничего не говорят об их происхождении.
  async showMcpServers() {
    const servers = await this.agent.tools.listMcpServers();
    const allowed = this.agent.security.allowedMcpHosts || [];

    const rows = servers.length ? servers.map(s => {
      const inList = !allowed.length || allowed.some(a => s.host === a || s.host.endsWith('.' + a));
      const tools = s.tools.map(t =>
        `<div style="font-size:11px;color:var(--text-muted);">${t.enabled ? '✅' : '⬜'} ${this._escHtml(t.name)}</div>`
      ).join('');
      return `
        <tr>
          <td style="vertical-align:top;">
            <div style="font-weight:600;">${this._escHtml(s.name || s.host)}</div>
            <div style="font-size:11px;color:var(--text-muted);word-break:break-all;">${this._escHtml(s.host)} · ${this._escHtml(s.url)}</div>
          </td>
          <td style="vertical-align:top;">${s.enabledCount} из ${s.tools.length}${tools}</td>
          <td style="vertical-align:top;">${
            !allowed.length ? '<span style="color:var(--text-muted);">список не задан</span>'
                            : (inList ? '✅ разрешён' : '⛔ заблокирован')
          }</td>
        </tr>`;
    }).join('')
      : '<tr><td colspan="3" style="color:var(--text-muted);">MCP-серверы не подключены.</td></tr>';

    this._showModal('🔌 Подключённые MCP-серверы', `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
        Инструменты сгруппированы по адресу сервера. Токены доступа здесь не показываются.
      </div>
      <table class="stats-table">
        <thead><tr><th>Сервер</th><th>Инструменты</th><th>Доступ</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`, null, null, { wide: true });
  },

  showSecurityAudit() {
    const log = this.agent.security.auditLog || [];
    const icon = { approved: '✅', denied: '🚫', blocked: '⛔', executed: '⚙️', switched: '🔀' };
    const label = {
      approved: 'разрешено', denied: 'отклонено вами', blocked: 'заблокировано режимом',
      executed: 'выполнено агентом', switched: 'переключение при отказе',
    };

    const rows = log.length ? log.map(e => `
      <tr>
        <td>${new Date(e.at).toLocaleTimeString('ru-RU')}</td>
        <td>${this._escHtml(e.tool || '')}</td>
        <td>${icon[e.decision] || ''} ${this._escHtml(label[e.decision] || e.decision)}</td>
        <td>${this._escHtml((e.risks || []).join('; ') || e.reason || e.detail || '')}</td>
      </tr>`).join('')
      : '<tr><td colspan="4" style="color:var(--text-muted);">Записей пока нет.</td></tr>';

    this._showModal('🛡 Журнал безопасности', `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
        Последние ${log.length} решений. Журнал хранится в памяти и очищается при перезагрузке.
      </div>
      <table class="stats-table">
        <thead><tr><th>Время</th><th>Инструмент</th><th>Решение</th><th>Причина</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`, null, null, { wide: true });
  }

});
