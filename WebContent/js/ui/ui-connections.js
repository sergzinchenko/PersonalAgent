// ============================================================
//  UI CONNECTIONS — провайдеры и их модели на одной вкладке
// ============================================================
//
// Раскрывающийся список: провайдер, внутри — его модели. Разделять их по
// разным окнам было неудобно, потому что настраивают их всегда вместе:
// добавил провайдера — сразу выбираешь у него модели.
//
// Панель живёт внутри вкладки настроек и перерисовывает только свой
// контейнер: полная перерисовка окна сбрасывала бы остальные вкладки к
// сохранённым значениям, теряя несохранённые правки.

Object.assign(UI.prototype, {

  // ── Отрисовка ──

  async renderProvidersPanel() {
    const box = document.getElementById('providers-panel');
    if (!box) return;
    const reg = this.agent.models;
    await reg.load();

    this._openProviders = this._openProviders || new Set();

    box.innerHTML = reg.connections.length
      ? reg.connections.map(c => this._providerBlock(c, reg)).join('')
      : `<div style="color:var(--text-muted);font-size:13px;padding:14px;text-align:center;
                     border:1px dashed var(--border);border-radius:6px;">
           Провайдеров пока нет.<br>Добавьте первого — это адрес API и ключ доступа.
         </div>`;

    this._bindProvidersPanel();
  },

  _providerBlock(c, reg) {
    const open = this._openProviders.has(c.id);
    const models = c.models || [];
    const hasSecret = !!(c.apiKey || c.customHeaderValue);

    const modelRows = models.length ? models.map(m => {
      const tier = LLMRegistry.TIERS[m.tier] || LLMRegistry.TIERS.balanced;
      const ref = reg.refOf(c.id, m.id);
      const isDefault = reg.defaultRef === ref;
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-top:1px solid var(--border);">
          <span title="${this._escHtml(tier.hint)}">${tier.icon}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;">
              ${this._escHtml(m.label || m.name)}
              ${isDefault ? '<span style="font-size:10px;color:var(--accent);"> — по умолчанию</span>' : ''}
            </div>
            <div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${this._escHtml(m.name)} · ${this._escHtml(tier.label)} ·
              ${m.contextWindow ? 'окно ' + this._fmtLimit(m.contextWindow) : 'окно не задано'} ·
              max_tokens ${m.maxTokens}
            </div>
          </div>
          <button class="btn btn-secondary" data-mact="default" data-conn="${c.id}" data-model="${m.id}"
                  style="padding:3px 7px;font-size:11px;" ${isDefault ? 'disabled' : ''}
                  title="Использовать в новых чатах">★</button>
          <button class="btn btn-secondary" data-mact="edit" data-conn="${c.id}" data-model="${m.id}"
                  style="padding:3px 7px;font-size:11px;">✎</button>
          <button class="btn btn-secondary" data-mact="del" data-conn="${c.id}" data-model="${m.id}"
                  style="padding:3px 7px;font-size:11px;">🗑</button>
        </div>`;
    }).join('') : `
        <div style="padding:8px;border-top:1px solid var(--border);font-size:12px;color:var(--text-muted);">
          Моделей нет. Нажмите «Загрузить у провайдера», чтобы выбрать из доступных.
        </div>`;

    return `
      <div style="border:1px solid var(--border);border-radius:6px;margin-bottom:8px;
                  ${c.enabled === false ? 'opacity:.55;' : ''}">
        <div style="display:flex;align-items:center;gap:8px;padding:8px;cursor:pointer;"
             data-pact="toggle" data-conn="${c.id}">
          <span style="font-size:11px;width:12px;">${open ? '▾' : '▸'}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:13px;">
              ${this._escHtml(c.name)}
              <span style="font-weight:400;font-size:11px;color:var(--text-muted);">
                · ${models.length} ${this._plural(models.length, 'модель', 'модели', 'моделей')}
              </span>
            </div>
            <div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${this._escHtml(c.apiUrl || 'адрес не задан')}
              ${hasSecret ? '' : ' · <span style="color:var(--danger,#e74c3c);">нет ключа</span>'}
            </div>
          </div>
          <button class="btn btn-secondary" data-pact="test" data-conn="${c.id}"
                  style="padding:4px 8px;font-size:11px;">Проверить</button>
          <button class="btn btn-secondary" data-pact="edit" data-conn="${c.id}"
                  style="padding:4px 8px;font-size:11px;">✎</button>
          <button class="btn btn-secondary" data-pact="del" data-conn="${c.id}"
                  style="padding:4px 8px;font-size:11px;">🗑</button>
        </div>

        ${open ? `
          <div style="background:var(--bg-secondary,rgba(128,128,128,.06));">
            ${modelRows}
            <div style="display:flex;gap:6px;padding:8px;border-top:1px solid var(--border);">
              <button class="btn btn-secondary" data-pact="fetch" data-conn="${c.id}"
                      style="flex:1;padding:5px;font-size:11px;">⬇ Загрузить у провайдера</button>
              <button class="btn btn-secondary" data-pact="addmodel" data-conn="${c.id}"
                      style="flex:1;padding:5px;font-size:11px;">+ Добавить вручную</button>
            </div>
          </div>` : ''}
      </div>`;
  },

  // Склонение после числа — иначе получается «1 моделей».
  _plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  },

  _bindProvidersPanel() {
    const box = document.getElementById('providers-panel');
    if (!box) return;
    const reg = this.agent.models;

    box.onclick = async (e) => {
      const mbtn = e.target.closest('[data-mact]');
      if (mbtn) {
        e.stopPropagation();
        const { conn, model } = mbtn.dataset;
        if (mbtn.dataset.mact === 'edit') return this.showModelEditor(conn, model);
        if (mbtn.dataset.mact === 'default') {
          await reg.setDefault(reg.refOf(conn, model));
          this.updateModelDisplay?.();
          this.updateChatToolbar?.();
          return this.renderProvidersPanel();
        }
        if (mbtn.dataset.mact === 'del') {
          const r = reg.resolve(reg.refOf(conn, model));
          const yes = await this._confirm(
            `Убрать модель «${r ? (r.model.label || r.model.name) : model}» из набора? ` +
            'Чаты, где она выбрана, вернутся к модели по умолчанию.',
            { title: 'Удаление модели', danger: true });
          if (!yes) return;
          await reg.removeModel(conn, model);
          this.updateChatToolbar?.();
          return this.renderProvidersPanel();
        }
        return;
      }

      const pbtn = e.target.closest('[data-pact]');
      if (!pbtn) return;
      const id = pbtn.dataset.conn;
      const act = pbtn.dataset.pact;

      if (act === 'toggle') {
        if (this._openProviders.has(id)) this._openProviders.delete(id);
        else this._openProviders.add(id);
        return this.renderProvidersPanel();
      }

      e.stopPropagation();

      if (act === 'edit') return this.showProviderEditor(id);
      if (act === 'addmodel') return this.showModelEditor(id, null);
      if (act === 'fetch') return this.showModelPicker(id);

      if (act === 'test') {
        pbtn.textContent = '…';
        const r = await reg.testConnection(id);
        pbtn.textContent = r.ok ? `✓ ${r.modelCount}` : '✗';
        pbtn.title = r.ok ? `Ответ за ${r.latencyMs} мс, моделей: ${r.modelCount}` : ('Ошибка: ' + r.error);
        return;
      }

      if (act === 'del') {
        const c = reg.connections.find(x => x.id === id);
        const n = c ? (c.models || []).length : 0;
        const yes = await this._confirm(
          `Удалить провайдера «${c ? c.name : id}»?` +
          (n ? ` Вместе с ним удалятся ${n} ${this._plural(n, 'модель', 'модели', 'моделей')}.` : '') +
          ' Ключ доступа будет стёрт.',
          { title: 'Удаление провайдера', danger: true });
        if (!yes) return;
        await reg.removeConnection(id);
        this.updateModelDisplay?.();
        this.updateChatToolbar?.();
        return this.renderProvidersPanel();
      }
    };

    const add = document.getElementById('providers-add');
    if (add) add.onclick = () => this.showProviderEditor(null);
  },

  // ── Редактор провайдера ──

  async showProviderEditor(id) {
    const reg = this.agent.models;
    const c = id ? reg.connections.find(x => x.id === id) : null;
    const v = (k, d) => (c && c[k] !== undefined && c[k] !== null ? c[k] : d);
    const isCustom = v('authType', 'bearer') === 'custom';

    this._showModal(c ? '✎ ' + this._escHtml(c.name) : '+ Новый провайдер', `
      <div class="form-group">
        <label>Название</label>
        <input id="pe_name" value="${this._escHtml(v('name', ''))}" placeholder="OpenAI, локальный Ollama, OpenRouter…">
      </div>
      <div class="form-group">
        <label>Адрес API (без /chat/completions)</label>
        <input id="pe_url" value="${this._escHtml(v('apiUrl', ''))}" placeholder="https://api.openai.com/v1">
      </div>
      <div class="form-group">
        <label>Способ авторизации</label>
        <div style="display:flex;gap:16px;margin-top:4px;">
          <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:13px;">
            <input type="radio" name="pe_auth" value="bearer" style="width:auto;" ${isCustom ? '' : 'checked'}> Bearer
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:13px;">
            <input type="radio" name="pe_auth" value="custom" style="width:auto;" ${isCustom ? 'checked' : ''}> Свой заголовок
          </label>
        </div>
      </div>
      <div id="pe_bearer" style="display:${isCustom ? 'none' : 'block'};">
        <div class="form-group">
          <label>Ключ доступа</label>
          <input id="pe_key" type="password" value="${this._escHtml(v('apiKey', ''))}" placeholder="sk-...">
        </div>
      </div>
      <div id="pe_custom" style="display:${isCustom ? 'block' : 'none'};">
        <div class="form-group">
          <label>Имя заголовка</label>
          <input id="pe_hname" value="${this._escHtml(v('customHeaderName', ''))}" placeholder="X-API-Key">
        </div>
        <div class="form-group">
          <label>Значение заголовка</label>
          <input id="pe_hvalue" type="password" value="${this._escHtml(v('customHeaderValue', ''))}">
        </div>
      </div>
      <div class="form-group">
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;">
          <input type="checkbox" id="pe_enabled" style="width:auto;" ${v('enabled', true) ? 'checked' : ''}>
          Провайдер включён
        </label>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
          Ключ хранится в браузере в зашифрованном виде. Это защищает от просмотра базы,
          но не от кода, выполняющегося на этой же странице.
        </div>
      </div>
    `, async () => {
      const name = document.getElementById('pe_name').value.trim();
      const apiUrl = document.getElementById('pe_url').value.trim();
      if (!name || !apiUrl) {
        await this._confirm('Нужны название и адрес API — провайдер не сохранён.', { title: 'Не хватает данных' });
        return this.showProviderEditor(id);
      }
      const saved = await reg.saveConnection({
        id: c ? c.id : undefined,
        name, apiUrl,
        authType: document.querySelector('input[name="pe_auth"]:checked')?.value || 'bearer',
        // Пустое поле при редактировании означает «не менять»: иначе
        // заход в редактор ради переименования стирал бы ключ.
        apiKey: document.getElementById('pe_key').value || (c ? c.apiKey : ''),
        customHeaderName: document.getElementById('pe_hname').value.trim(),
        customHeaderValue: document.getElementById('pe_hvalue').value || (c ? c.customHeaderValue : ''),
        enabled: document.getElementById('pe_enabled').checked,
        order: c ? c.order : reg.connections.length,
      });
      // Новый провайдер сразу раскрыт: следующий шаг — добавить модели,
      // и прятать его за лишним кликом незачем.
      this._openProviders.add(saved.id);
      await this._backToProviders();
    }, () => this._backToProviders());

    document.querySelectorAll('input[name="pe_auth"]').forEach(r => {
      r.addEventListener('change', () => {
        const custom = document.querySelector('input[name="pe_auth"]:checked').value === 'custom';
        document.getElementById('pe_bearer').style.display = custom ? 'none' : 'block';
        document.getElementById('pe_custom').style.display = custom ? 'block' : 'none';
      });
    });
  },

  // ── Выбор моделей из списка провайдера ──

  async showModelPicker(connId) {
    const reg = this.agent.models;
    const conn = reg.connections.find(c => c.id === connId);
    if (!conn) return;

    this._showModal('⬇ Модели у «' + this._escHtml(conn.name) + '»',
      '<div id="mp_body" style="padding:20px;text-align:center;color:var(--text-muted);">Запрашиваю список…</div>',
      // Своей формы для сохранения нет — модели добавляются кнопками
      // внутри списка. «Сохранить» здесь равнозначно «Отмена»: закрыть
      // и вернуться к настройкам.
      () => this._backToProviders(), () => this._backToProviders(), { wide: true });

    const res = await reg.fetchAvailable(connId);
    const body = document.getElementById('mp_body');
    if (!body) return;

    if (res.error) {
      body.style.padding = '10px';
      body.style.textAlign = 'left';
      body.innerHTML = `
        <div style="color:var(--danger,#e74c3c);font-size:13px;margin-bottom:8px;">${this._escHtml(res.error)}</div>
        <div style="font-size:12px;color:var(--text-muted);">
          Список моделей отдают не все провайдеры. Модель можно добавить вручную —
          кнопкой «Добавить вручную» в карточке провайдера.
        </div>`;
      return;
    }

    const existing = new Set((conn.models || []).map(m => m.name));

    // Провайдеры отдают в том же списке эмбеддинги, озвучку и генерацию
    // изображений. Для чата они не годятся, поэтому убраны под спойлер,
    // но не выброшены совсем: у самодельных сборок имена бывают любые.
    const isChatty = (n) => !/embed|whisper|tts|audio|speech|image|dall|rerank|moderation|guard/i.test(n);
    const chatModels = res.models.filter(isChatty);
    const others = res.models.filter(n => !isChatty(n));

    const row = (n) => {
      const has = existing.has(n);
      const tier = LLMRegistry.TIERS[LLMRegistry.guessTier(n)];
      const ctx = LLMRegistry.guessContextWindow(n);
      return `
        <div class="mp-row" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border);">
          <span title="${this._escHtml(tier.hint)}">${tier.icon}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this._escHtml(n)}</div>
            <div style="font-size:11px;color:var(--text-muted);">
              предположительно: ${this._escHtml(tier.label)}${ctx ? ' · окно ' + this._fmtLimit(ctx) : ' · окно неизвестно'}
            </div>
          </div>
          <button class="btn ${has ? 'btn-secondary' : 'btn-success'}" data-pick="${this._escHtml(n)}"
                  style="padding:4px 10px;font-size:11px;" ${has ? 'disabled' : ''}>
            ${has ? 'уже добавлена' : '+ Добавить'}
          </button>
        </div>`;
    };

    body.style.padding = '0';
    body.style.textAlign = 'left';
    body.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
        Класс сложности и окно контекста подставлены по названию — это догадка,
        API их не сообщает. Проверьте при добавлении.
      </div>
      <input id="mp_filter" placeholder="Фильтр по названию" style="width:100%;margin-bottom:8px;">
      <div id="mp_list" style="max-height:45vh;overflow-y:auto;border:1px solid var(--border);border-radius:6px;">
        ${chatModels.map(row).join('') || '<div style="padding:10px;color:var(--text-muted);">Ничего не нашлось.</div>'}
      </div>
      ${others.length ? `
        <details style="margin-top:8px;">
          <summary style="font-size:12px;color:var(--text-muted);cursor:pointer;">
            Ещё ${others.length}: эмбеддинги, озвучка, изображения — для чата не годятся
          </summary>
          <div style="max-height:25vh;overflow-y:auto;border:1px solid var(--border);border-radius:6px;margin-top:6px;">
            ${others.map(row).join('')}
          </div>
        </details>` : ''}
    `;

    document.getElementById('mp_filter')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      body.querySelectorAll('.mp-row').forEach(d => {
        d.style.display = d.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });

    body.querySelectorAll('button[data-pick]').forEach(b => {
      b.addEventListener('click', () => this.showModelEditor(connId, null, b.dataset.pick));
    });
  },

  // ── Редактор модели ──

  async showModelEditor(connId, modelId, presetName) {
    const reg = this.agent.models;
    const conn = reg.connections.find(c => c.id === connId);
    if (!conn) return;
    const m = modelId ? (conn.models || []).find(x => x.id === modelId) : null;

    const name = m ? m.name : (presetName || '');
    const tier = m ? m.tier : LLMRegistry.guessTier(name);
    const ctx = m ? m.contextWindow : LLMRegistry.guessContextWindow(name);

    const tierOptions = Object.entries(LLMRegistry.TIERS).map(([k, t]) =>
      `<option value="${k}" ${tier === k ? 'selected' : ''}>${t.icon} ${this._escHtml(t.label)} — ${this._escHtml(t.hint)}</option>`
    ).join('');

    this._showModal(m ? '✎ Модель' : '+ Модель у «' + this._escHtml(conn.name) + '»', `
      <div class="form-group">
        <label>Идентификатор модели (уходит в API)</label>
        <input id="me_name" value="${this._escHtml(name)}" placeholder="gpt-4o-mini">
      </div>
      <div class="form-group">
        <label>Как называть в интерфейсе</label>
        <input id="me_label" value="${this._escHtml(m ? m.label : '')}" placeholder="необязательно — иначе показывается идентификатор">
      </div>
      <div class="form-group">
        <label>Класс сложности</label>
        <select id="me_tier">${tierOptions}</select>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
          Влияет только на подсказку при выборе модели в чате: по идентификаторам вроде
          «qwen2.5-72b-instruct» непонятно, за чем к этой модели идти.
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        <div class="form-group" style="flex:1;">
          <label>Окно контекста</label>
          <input type="number" id="me_ctx" min="0" value="${ctx}" placeholder="0 — неизвестно">
        </div>
        <div class="form-group" style="flex:1;">
          <label>max_tokens</label>
          <input type="number" id="me_tokens" min="1" value="${m ? m.maxTokens : (ctx || 4096)}">
        </div>
        <div class="form-group" style="flex:1;">
          <label>Температура</label>
          <input type="number" id="me_temp" step="0.1" min="0" max="2" value="${m ? m.temperature : 0.7}">
        </div>
      </div>
      <div class="form-group">
        <label>Заметка</label>
        <input id="me_notes" value="${this._escHtml(m ? m.notes : '')}" placeholder="например: дорогая, беречь — или: только для черновиков">
      </div>
      <div style="font-size:11px;color:var(--text-muted);line-height:1.5;">
        Окно контекста API не сообщает, поэтому оно задаётся здесь: по нему считается
        индикатор заполнения и подрезается история длинных чатов. max_tokens по умолчанию
        равен окну контекста и следует за ним при правке — уменьшите вручную, если нужен
        меньший потолок длины ответа.
      </div>
    `, async () => {
      const nm = document.getElementById('me_name').value.trim();
      if (!nm) {
        await this._confirm('Нужен идентификатор модели — она не сохранена.', { title: 'Не хватает данных' });
        return this.showModelEditor(connId, modelId, presetName);
      }
      const saved = await reg.saveModel(connId, {
        id: m ? m.id : undefined,
        name: nm,
        label: document.getElementById('me_label').value.trim(),
        tier: document.getElementById('me_tier').value,
        contextWindow: document.getElementById('me_ctx').value,
        maxTokens: document.getElementById('me_tokens').value,
        temperature: parseFloat(document.getElementById('me_temp').value) || 0.7,
        notes: document.getElementById('me_notes').value,
      });
      // Первая модель в реестре сразу становится моделью по умолчанию —
      // иначе после настройки «с нуля» чат остался бы без модели.
      if (saved && !reg.resolve(reg.defaultRef)) await reg.setDefault(reg.refOf(connId, saved.id));

      this._openProviders.add(connId);
      this.updateModelDisplay?.();
      this.updateChatToolbar?.();
      await this._backToProviders();
    }, () => this._backToProviders());

    // max_tokens следует за окном контекста, пока пользователь не тронул
    // его вручную, — иначе выставленное здесь-же значение по умолчанию
    // застыло бы, даже когда пользователь исправляет угаданное окно.
    let tokensTouched = false;
    document.getElementById('me_tokens')?.addEventListener('input', () => { tokensTouched = true; });
    document.getElementById('me_ctx')?.addEventListener('input', (e) => {
      if (tokensTouched) return;
      const tokensInput = document.getElementById('me_tokens');
      if (tokensInput) tokensInput.value = e.target.value || 4096;
    });
  },

  // Возврат из вложенного окна: пользователь должен оказаться там, откуда
  // ушёл, а не на первой вкладке настроек.
  async _backToProviders() {
    await this.showSettingsModal();
    setTimeout(() => {
      document.querySelector('.settings-tab-btn[data-settings-tab="models"]')?.click();
    }, 0);
  },

});
