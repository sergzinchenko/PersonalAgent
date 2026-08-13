// ============================================================
//  UI TRANSFER — экспорт и импорт (шифрование паролем)
// ============================================================
//
// Выборочный экспорт раздела и импорт зашифрованного архива с восстановлением структуры папок.

Object.assign(UI.prototype, {

  // ── Массовый экспорт чатов с выбором ──
  // Показывает все чаты с указанием папки; по умолчанию отмечены те,
  // что лежат в выбранной сейчас папке (или все, если выбран корень).
  async showChatsExportModal() {
    const chats = await this.agent.db.getAll('chats');
    if (!chats.length) {
      alert('Нет чатов для выгрузки.');
      return;
    }

    const folders = await this.agent.folders.all('chats');
    const byId = {};
    folders.forEach(f => { byId[f.id] = f; });
    const pathOf = (pid) => {
      if (!pid) return 'Корень';
      const names = [];
      let p = pid, guard = new Set();
      while (p && byId[p] && !guard.has(p)) { guard.add(p); names.unshift(byId[p].name); p = byId[p].parentId; }
      return names.join('/') || 'Корень';
    };

    const sel = this.folderSelection.chats;
    const preselect = (c) => !sel || (c.parentId || null) === sel;

    const rows = chats
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(c => `
        <label class="check-row">
          <input type="checkbox" class="chat-sel" value="${this._escHtml(c.id)}" ${preselect(c) ? 'checked' : ''}>
          <span>${this._escHtml(c.title || '(без названия)')}</span>
          <span class="sel-folder">📁 ${this._escHtml(pathOf(c.parentId))}</span>
        </label>`).join('');

    this._showModal('📦 Экспорт чатов', `
      <div class="form-group">
        <label>Какие чаты выгрузить <span id="chats-sel-count" style="color:var(--text-muted);font-weight:400;"></span></label>
        <div style="display:flex;gap:8px;margin:6px 0;">
          <button type="button" class="btn btn-secondary btn-sm" id="chats-sel-all">Выделить все</button>
          <button type="button" class="btn btn-secondary btn-sm" id="chats-sel-none">Снять все</button>
        </div>
        <div class="sel-list">${rows}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">
          В архив попадут переписка целиком, структура папок, статистика,
          а также модель-автор каждого ответа и тайминги.
        </div>
      </div>
      <div class="form-group">
        <label class="check-row" style="margin:0;">
          <input type="checkbox" id="chats_enc_on"> 🔒 Зашифровать архив паролем
        </label>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
          Без пароля файл остаётся обычным JSON — его удобно просматривать и обрабатывать.
          С паролем применяется то же шифрование, что и для архивов tools/skills/промптов.
        </div>
      </div>
      <div id="chats_enc_fields" hidden>
        <div class="form-group">
          <label>Пароль</label>
          <input id="chats_pass" type="password" placeholder="минимум 8 символов">
        </div>
        <div class="form-group">
          <label>Повторите пароль</label>
          <input id="chats_pass2" type="password" placeholder="ещё раз">
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">
          Восстановить пароль невозможно — без него архив не открыть.
        </div>
      </div>
      <button class="btn btn-primary btn-sm" id="chats-do-export">📦 Скачать архив</button>
      <span id="chats-exp-status" style="font-size:12px;margin-left:8px;"></span>
    `, null, null, { modal: true, wide: true });

    setTimeout(() => {
      const boxes = () => Array.from(document.querySelectorAll('.chat-sel'));
      const count = () => {
        const el = document.getElementById('chats-sel-count');
        if (el) el.textContent = `— выбрано ${boxes().filter(b => b.checked).length} из ${boxes().length}`;
      };
      boxes().forEach(b => b.addEventListener('change', count));
      document.getElementById('chats-sel-all')?.addEventListener('click', () => { boxes().forEach(b => b.checked = true); count(); });
      document.getElementById('chats-sel-none')?.addEventListener('click', () => { boxes().forEach(b => b.checked = false); count(); });
      count();

      // Поля пароля показываем только при включённом шифровании —
      // по умолчанию выгрузка остаётся простым JSON.
      const encBox = document.getElementById('chats_enc_on');
      encBox?.addEventListener('change', () => {
        document.getElementById('chats_enc_fields').hidden = !encBox.checked;
      });

      document.getElementById('chats-do-export')?.addEventListener('click', async () => {
        const status = document.getElementById('chats-exp-status');
        const ids = boxes().filter(b => b.checked).map(b => b.value);
        if (!ids.length) {
          status.textContent = '❌ не выбран ни один чат';
          status.style.color = 'var(--danger)';
          return;
        }

        let password = '';
        if (encBox?.checked) {
          password = document.getElementById('chats_pass').value;
          const repeat = document.getElementById('chats_pass2').value;
          if (password.length < 8) {
            status.textContent = '❌ пароль короче 8 символов';
            status.style.color = 'var(--danger)';
            return;
          }
          if (password !== repeat) {
            status.textContent = '❌ пароли не совпадают';
            status.style.color = 'var(--danger)';
            return;
          }
        }

        status.textContent = password ? '⏳ Шифрую архив...' : '⏳ Готовлю архив...';
        status.style.color = 'var(--warning)';

        // Работу делает встроенный инструмент — тот же, что доступен агенту.
        const res = await this.agent.tools.executeTool('export_chats',
          password ? { chatIds: ids, password } : { chatIds: ids });
        if (res && res.error) {
          status.textContent = '❌ ' + res.error;
          status.style.color = 'var(--danger)';
        } else {
          status.textContent = `✅ Чатов: ${res.chats}, сообщений: ${res.messages}, папок: ${res.folders}` +
            (res.encrypted ? ' · зашифровано' : '');
          status.style.color = 'var(--success)';
        }
      });
    }, 50);
  },

  // ── Импорт архива чатов ──
  showChatsImportDialog() {
    this._showModal('📥 Импорт чатов', `
      <div class="form-group">
        <label>Файл архива (.json)</label>
        <input id="chats_imp_file" type="file" accept="application/json,.json">
      </div>
      <div class="form-group">
        <label>Режим</label>
        <label class="check-row"><input type="radio" name="chats_imp_mode" value="merge" checked> Добавить (чаты с существующими id пропускаются)</label>
        <label class="check-row"><input type="radio" name="chats_imp_mode" value="overwrite"> Перезаписать чаты с совпадающими id</label>
      </div>
      <div class="form-group">
        <label>Пароль <span style="color:var(--text-muted);font-weight:400;">— только для зашифрованных архивов</span></label>
        <input id="chats_imp_pass" type="password" placeholder="оставьте пустым, если архив не зашифрован">
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">
        Подходит архив, созданный кнопкой «Экспорт чатов» — как обычный, так и зашифрованный
        (определяется автоматически). Структура папок восстанавливается;
        папка с тем же именем на том же уровне переиспользуется, а не дублируется.
      </div>
      <button class="btn btn-primary btn-sm" id="chats-do-import">📥 Загрузить</button>
      <span id="chats-imp-status" style="font-size:12px;margin-left:8px;"></span>
    `, null, null, { modal: true, wide: true });

    setTimeout(() => {
      document.getElementById('chats-do-import')?.addEventListener('click', async () => {
        const status = document.getElementById('chats-imp-status');
        const fileInput = document.getElementById('chats_imp_file');
        if (!fileInput.files || !fileInput.files[0]) {
          status.textContent = '❌ файл не выбран';
          status.style.color = 'var(--danger)';
          return;
        }
        status.textContent = '⏳ Загружаю...';
        status.style.color = 'var(--warning)';

        const content = await fileInput.files[0].text();
        const mode = document.querySelector('input[name="chats_imp_mode"]:checked')?.value || 'merge';
        const password = document.getElementById('chats_imp_pass').value;

        const res = await this.agent.tools.executeTool('import_chats',
          { content, mode, open: false, ...(password ? { password } : {}) });
        if (res && res.error) {
          // Инструмент сам распознаёт зашифрованный архив и просит пароль —
          // подсказываем это явно, а не показываем сухую ошибку.
          status.textContent = res.needsPassword
            ? '🔒 Архив зашифрован — введите пароль'
            : '❌ ' + res.error;
          status.style.color = 'var(--danger)';
        } else {
          status.textContent = `✅ Чатов: ${res.chats}, сообщений: ${res.messages}` +
            (res.skipped ? `, пропущено: ${res.skipped}` : '') +
            (res.foldersCreated ? `, папок создано: ${res.foldersCreated}` : '');
          status.style.color = 'var(--success)';
        }
      });
    }, 50);
  },

  // ── Экспорт текущего чата ──
  // Кнопка не делает работу сама, а вызывает встроенный инструмент
  // export_chat — ту же логику, что доступна и агенту. Так формат
  // выгрузки один и тот же независимо от того, кто её инициировал.
  showChatExportModal() {
    if (!this.currentChatId) {
      alert('Сначала откройте чат, который нужно выгрузить.');
      return;
    }

    this._showModal('⬆ Экспорт чата', `
      <div class="form-group">
        <label>Формат файла</label>
        <select id="chat_exp_format">
          <option value="markdown">Markdown — текст с хронологией</option>
          <option value="html">HTML — готовый к просмотру документ</option>
          <option value="json">JSON — данные (подходит для обратного импорта)</option>
          <option value="excel">Excel — таблица сообщений</option>
        </select>
      </div>
      <label class="check-row">
        <input type="checkbox" id="chat_exp_tools" checked> Включать вызовы инструментов и их результаты
      </label>
      <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
        Обратно загрузить чат можно только из формата JSON — остальные предназначены для чтения.
      </div>
      <div style="margin-top:12px;">
        <button class="btn btn-primary btn-sm" id="chat-do-export">⬆ Скачать файл</button>
        <span id="chat-exp-status" style="font-size:12px;margin-left:8px;"></span>
      </div>
    `, null, null, { modal: true });

    setTimeout(() => {
      document.getElementById('chat-do-export')?.addEventListener('click', async () => {
        const status = document.getElementById('chat-exp-status');
        status.textContent = '⏳ Готовлю файл...';
        status.style.color = 'var(--warning)';

        const res = await this.agent.tools.executeTool('export_chat', {
          format: document.getElementById('chat_exp_format').value,
          chatId: this.currentChatId,
          includeToolCalls: document.getElementById('chat_exp_tools').checked,
        });

        if (res && res.error) {
          status.textContent = '❌ ' + res.error;
          status.style.color = 'var(--danger)';
        } else {
          status.textContent = `✅ ${res.filename} (${res.messages} сообщений)`;
          status.style.color = 'var(--success)';
        }
      });
    }, 50);
  },

  // ── Импорт чата из файла ──
  // Тоже через встроенный инструмент import_chat: файл читается здесь,
  // а разбор и создание записей выполняет инструмент.
  showChatImportDialog() {
    const folderNote = this.folderSelection.chats
      ? 'Чат будет помещён в выбранную сейчас папку.'
      : 'Чат будет создан в корне дерева чатов.';

    this._showModal('⬇ Импорт чата', `
      <div class="form-group">
        <label>Файл выгрузки (.json)</label>
        <input id="chat_imp_file" type="file" accept="application/json,.json">
      </div>
      <div class="form-group">
        <label>Название чата</label>
        <input id="chat_imp_title" placeholder="пусто — взять из файла">
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">
        Подходит файл, выгруженный в формате JSON. ${folderNote}
      </div>
      <button class="btn btn-primary btn-sm" id="chat-do-import">⬇ Загрузить чат</button>
      <span id="chat-imp-status" style="font-size:12px;margin-left:8px;"></span>
    `, null, null, { modal: true });

    setTimeout(() => {
      document.getElementById('chat-do-import')?.addEventListener('click', async () => {
        const status = document.getElementById('chat-imp-status');
        const fileInput = document.getElementById('chat_imp_file');

        if (!fileInput.files || !fileInput.files[0]) {
          status.textContent = '❌ файл не выбран';
          status.style.color = 'var(--danger)';
          return;
        }

        status.textContent = '⏳ Загружаю...';
        status.style.color = 'var(--warning)';

        const content = await fileInput.files[0].text();
        const title = document.getElementById('chat_imp_title').value.trim();

        const res = await this.agent.tools.executeTool('import_chat', {
          content,
          title: title || undefined,
        });

        if (res && res.error) {
          status.textContent = '❌ ' + res.error;
          status.style.color = 'var(--danger)';
        } else {
          status.textContent = `✅ «${res.title}» — ${res.messages} сообщений`;
          status.style.color = 'var(--success)';
          // Инструмент сам открыл импортированный чат и обновил дерево;
          // закрываем окно, чтобы результат было видно.
          setTimeout(() => { document.getElementById('modals').innerHTML = ''; }, 900);
        }
      });
    }, 50);
  },


  // ── Выборочный экспорт одного раздела ──
  // Вызывается из шапки панели и учитывает, в какой папке пользователь
  // сейчас находится: по умолчанию предлагается текущая папка со всем
  // вложенным. Импорта здесь намеренно нет — он живёт только в полном
  // окне (⚙ Настройки → Отображение).
  async showSelectiveExportModal(section) {
    const titles = { tools: '🔧 инструментов', skills: '🧩 навыков', prompts: '📋 промптов' };
    if (!titles[section]) return; // раздел не распознан — окно не открываем

    // Берём ВЕСЬ состав раздела, включая встроенные инструменты: список
    // здесь должен совпадать с тем, что пользователь видит в панели.
    // Раньше builtin отфильтровывались молча, и состав папки в окне
    // экспорта не сходился с экраном.
    const allItems = await this.agent.db.getAll(section);
    const allFolders = (await this.agent.db.getAll('folders')).filter(f => f.type === section);

    const currentFolder = this.folderSelection[section] || null;
    const path = await this._folderPath(section, currentFolder);

    // Состояние модалки живёт здесь: переключение охвата перерисовывает
    // только список, не пересоздавая окно.
    // ВАЖНО: unchecked хранит id, которые пользователь СНЯЛ вручную.
    // Хранить именно снятые, а не отмеченные, нужно потому, что при
    // смене охвата в список приходят новые объекты — они должны быть
    // отмечены по умолчанию, а ранее снятые остаться снятыми.
    const state = {
      scope: currentFolder ? 'subtree' : 'all',
      unchecked: new Set(),
    };

    this._showModal(`⬆ Экспорт ${titles[section]}`, `
      <div class="form-group">
        <label>Откуда выгружать</label>
        <div class="folder-breadcrumb" style="margin-bottom:8px;">${path}</div>
        <select id="sel-scope">
          <option value="current">Только эта папка (без вложенных)</option>
          <option value="subtree">Эта папка со вложенными</option>
          <option value="all">Весь раздел целиком</option>
        </select>
      </div>
      <div class="form-group">
        <label>Объекты <span id="sel-count" style="color:var(--text-muted);font-weight:400;"></span></label>
        <div style="display:flex;gap:8px;margin:6px 0;">
          <button type="button" class="btn btn-secondary btn-sm" id="sel-all">Выделить все</button>
          <button type="button" class="btn btn-secondary btn-sm" id="sel-none">Снять все</button>
        </div>
        <div class="sel-list" id="sel-list"></div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">
          Папки отмеченных объектов выгружаются автоматически вместе со всей цепочкой родителей.
        </div>
      </div>
      <div class="form-group">
        <label>Пароль для шифрования архива</label>
        <input id="sel_pass" type="password" placeholder="минимум 8 символов">
      </div>
      <div class="form-group">
        <label>Повторите пароль</label>
        <input id="sel_pass2" type="password" placeholder="ещё раз">
      </div>
      <button class="btn btn-primary btn-sm" id="sel-export-btn">⬆ Скачать зашифрованный архив</button>
      <span id="sel-status" style="font-size:12px;margin-left:8px;"></span>
    `, null, null, { modal: true, wide: true });

    // Все папки-потомки заданной (для охвата «со вложенными»)
    const descendants = (rootId) => {
      const out = new Set([rootId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of allFolders) {
          if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
        }
      }
      return out;
    };

    const itemsForScope = () => {
      if (state.scope === 'all') return allItems;
      if (state.scope === 'current') {
        return allItems.filter(it => (it.parentId || null) === currentFolder);
      }
      // subtree
      if (!currentFolder) return allItems; // корень со вложенными = весь раздел
      const set = descendants(currentFolder);
      return allItems.filter(it => it.parentId && set.has(it.parentId));
    };

    const folderName = (id) => allFolders.find(x => x.id === id)?.name || null;

    const renderList = () => {
      const items = itemsForScope();
      // При смене охвата сохраняем ранее снятые галочки, а новые
      // элементы добавляем уже отмеченными.
      const list = document.getElementById('sel-list');
      if (!list) return;
      list.innerHTML = items.length ? items.map(it => `
        <label class="check-row">
          <input type="checkbox" class="sel-item" value="${this._escHtml(it.id)}" ${state.unchecked.has(it.id) ? '' : 'checked'}>
          <span>${it.icon ? it.icon + ' ' : ''}${this._escHtml(it.title || it.name || it.id)}</span>
          ${it.builtin ? '<span class="sel-badge" title="Встроенный инструмент: его код поставляется вместе с приложением. В архив уедут только размещение в папке и признак включения.">встроенный</span>' : ''}
          ${it.parentId ? `<span class="sel-folder">📁 ${this._escHtml(folderName(it.parentId) || '—')}</span>` : ''}
        </label>`).join('')
        : '<div style="color:var(--text-muted);font-size:13px;">В выбранной области нет объектов.</div>';

      list.querySelectorAll('.sel-item').forEach(b => {
        b.addEventListener('change', () => {
          if (b.checked) state.unchecked.delete(b.value); else state.unchecked.add(b.value);
          updateCount();
        });
      });
      updateCount();
    };

    const updateCount = () => {
      const boxes = Array.from(document.querySelectorAll('.sel-item'));
      const n = boxes.filter(b => b.checked).length;
      const el = document.getElementById('sel-count');
      if (el) el.textContent = `— выбрано ${n} из ${boxes.length}`;
    };

    setTimeout(() => {
      const scopeSel = document.getElementById('sel-scope');
      if (scopeSel) {
        scopeSel.value = state.scope;
        scopeSel.addEventListener('change', () => { state.scope = scopeSel.value; renderList(); });
      }
      document.getElementById('sel-all')?.addEventListener('click', () => {
        document.querySelectorAll('.sel-item').forEach(b => { b.checked = true; state.unchecked.delete(b.value); });
        updateCount();
      });
      document.getElementById('sel-none')?.addEventListener('click', () => {
        document.querySelectorAll('.sel-item').forEach(b => { b.checked = false; state.unchecked.add(b.value); });
        updateCount();
      });
      document.getElementById('sel-export-btn')?.addEventListener('click', () => this._doSelectiveExport(section));
      renderList();
    }, 50);
  },


  async _doSelectiveExport(section) {
    const status = document.getElementById('sel-status');
    const setErr = (msg) => { status.textContent = '❌ ' + msg; status.style.color = 'var(--danger)'; };

    const pass = document.getElementById('sel_pass').value;
    const pass2 = document.getElementById('sel_pass2').value;
    if (pass.length < 8) return setErr('пароль короче 8 символов');
    if (pass !== pass2) return setErr('пароли не совпадают');

    const chosenIds = new Set(
      Array.from(document.querySelectorAll('.sel-item')).filter(b => b.checked).map(b => b.value)
    );
    if (!chosenIds.size) return setErr('не выбрано ни одного объекта');

    status.textContent = '⏳ Шифрую...';
    status.style.color = 'var(--warning)';

    try {
      let items = (await this.agent.db.getAll(section)).filter(i => chosenIds.has(i.id));
      if (section === 'tools') {
        // mcpToken — секрет чужого сервера, в переносимый архив не идёт.
        // Встроенные инструменты выгружаются как метаданные: своего
        // handlerCode у них нет (код поставляется с приложением), но их
        // размещение в папках и признак enabled — это состояние
        // пользователя, которое имеет смысл переносить.
        items = items.map(t => { const { mcpToken, ...rest } = t; return rest; });
      }

      // Выгружаем только те папки, которые реально нужны выбранным
      // объектам, — вместе со всей цепочкой родителей, иначе на импорте
      // подпапка осталась бы без своего родителя.
      // Ограничиваем разделом: папки tools/skills/prompts лежат в одном
      // store и различаются полем type.
      const allFolders = (await this.agent.db.getAll('folders')).filter(f => f.type === section);
      const byId = {};
      allFolders.forEach(f => { byId[f.id] = f; });
      const needed = new Set();
      for (const it of items) {
        let p = it.parentId;
        const guard = new Set();
        while (p && byId[p] && !guard.has(p)) {
          guard.add(p);
          needed.add(p);
          p = byId[p].parentId;
        }
      }

      const payload = {
        version: 1,
        createdAt: new Date().toISOString(),
        partial: true,
        sections: {
          [section]: { items, folders: allFolders.filter(f => needed.has(f.id)) },
        },
      };

      const envelope = await ArchiveCrypto.encryptPayload(payload, pass);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url;
      a.download = `ai-agent-${section}-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);

      status.textContent = `✅ Выгружено: ${items.length}, папок: ${payload.sections[section].folders.length}`;
      status.style.color = 'var(--success)';
    } catch (e) {
      setErr(e.message);
    }
  },


  // ──────────────────────────────────────────────
  //  ЭКСПОРТ / ИМПОРТ (tools, skills, prompts + папки)
  //  Архив шифруется паролем пользователя (ArchiveCrypto:
  //  PBKDF2-SHA256 → AES-GCM, см. crypto-utils.js).
  // ──────────────────────────────────────────────
  // ── Импорт раздела из зашифрованного архива ──
  // Вызывается из шапки панели (кнопка «📥 Импорт»). Раздел определяется
  // тем, откуда нажали; из архива берётся соответствующий блок.
  // section === null → импорт всех разделов, что есть в файле.
  showImportModal(section = null) {
    const titles = { tools: '🔧 инструментов', skills: '🧩 навыков', prompts: '📋 промптов' };
    const what = titles[section] || 'данных';

    this._showModal(`\u2193 Импорт ${what}`, `
      <div class="form-group">
        <label>Файл архива (.json)</label>
        <input id="imp_file" type="file" accept="application/json,.json">
      </div>
      <div class="form-group">
        <label>Пароль архива</label>
        <input id="imp_pass" type="password" placeholder="пароль, заданный при экспорте">
      </div>
      <div class="form-group">
        <label>Режим импорта</label>
        <label class="check-row"><input type="radio" name="imp_mode" value="merge" checked> Добавить к существующим (дубликаты по id пропускаются)</label>
        <label class="check-row"><input type="radio" name="imp_mode" value="overwrite"> Перезаписать элементы с совпадающими id</label>
      </div>
      ${section ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">
        Из архива будет взят только раздел «${this._escHtml(what)}». Остальные разделы, если они есть в файле, пропускаются.
      </div>` : ''}
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">
        Папки восстанавливаются вместе со структурой; папка с тем же именем на том же уровне переиспользуется, а не дублируется.
        Инструменты с собственным кодом всегда добавляются <strong>выключенными</strong> — включите их вручную после проверки кода.
      </div>
      <button class="btn btn-primary btn-sm" id="do-import-btn">\u2193 Расшифровать и импортировать</button>
      <span id="imp-status" style="font-size:12px;margin-left:8px;"></span>
    `, null, null, { modal: true, wide: true });

    setTimeout(() => {
      document.getElementById('do-import-btn')?.addEventListener('click', () => this._doImport(section));
    }, 50);
  },


  // section !== null → импортируем только этот раздел, остальные блоки
  // архива игнорируем (кнопка вызвана из конкретной панели).
  async _doImport(section = null) {
    const status = document.getElementById('imp-status');
    const fileInput = document.getElementById('imp_file');
    const pass = document.getElementById('imp_pass').value;
    const mode = document.querySelector('input[name="imp_mode"]:checked')?.value || 'merge';

    const setErr = (msg) => { status.textContent = '❌ ' + msg; status.style.color = 'var(--danger)'; };

    if (!fileInput.files || !fileInput.files[0]) return setErr('файл не выбран');
    if (!pass) return setErr('введите пароль');

    status.textContent = '⏳ Расшифровываю...';
    status.style.color = 'var(--warning)';

    try {
      const text = await fileInput.files[0].text();
      let envelope;
      try { envelope = JSON.parse(text); }
      catch (e) { return setErr('файл не является корректным JSON'); }

      const payload = await ArchiveCrypto.decryptPayload(envelope, pass);

      let added = 0, skipped = 0, foldersAdded = 0, foldersReused = 0;

      for (const [sectionKey, block] of Object.entries(payload.sections || {})) {
        if (!['tools', 'skills', 'prompts'].includes(sectionKey)) continue;
        // Импорт вызван из конкретной панели — берём только её раздел.
        if (section && sectionKey !== section) continue;

        // ── Папки ──
        // Импортируем ДО элементов, чтобы их parentId указывал на реально
        // существующие записи. Сопоставление не только по id: одна и та же
        // по смыслу папка на другой машине имеет другой id, поэтому папку
        // с тем же именем на том же уровне ПЕРЕИСПОЛЬЗУЕМ, а не дублируем.
        const existingFolders = await this.agent.db.getAll('folders');

        // Старый id из архива → фактический id в этой базе.
        const folderIdMap = {};
        const incoming = block.folders || [];
        const incomingById = {};
        incoming.forEach(f => { incomingById[f.id] = f; });

        // Обрабатываем сверху вниз: родитель должен быть сопоставлен раньше
        // ребёнка, иначе уровень вложенности определится неверно.
        const depthOf = (f) => {
          let d = 0, p = f.parentId;
          const seen = new Set();
          while (p && incomingById[p] && !seen.has(p)) { seen.add(p); d++; p = incomingById[p].parentId; }
          return d;
        };
        const ordered = incoming.slice().sort((a, b) => depthOf(a) - depthOf(b));

        const norm = (s) => String(s || '').trim().toLowerCase();

        for (const f of ordered) {
          const mappedParent = f.parentId ? (folderIdMap[f.parentId] || f.parentId) : null;

          // 1) Совпадение по id — та же самая папка, ничего не создаём.
          const sameId = existingFolders.find(e => e.id === f.id);
          if (sameId && mode !== 'overwrite') {
            folderIdMap[f.id] = sameId.id;
            foldersReused++;
            continue;
          }

          // 2) Совпадение по имени на том же уровне и в том же разделе —
          //    переиспользуем существующую папку.
          const twin = existingFolders.find(e =>
            e.type === f.type &&
            (e.parentId || null) === (mappedParent || null) &&
            norm(e.name) === norm(f.name)
          );
          if (twin) {
            folderIdMap[f.id] = twin.id;
            foldersReused++;
            continue;
          }

          const record = { ...f, parentId: mappedParent };
          await this.agent.db.put('folders', record);
          existingFolders.push(record);
          folderIdMap[f.id] = record.id;
          foldersAdded++;
        }

        const existingItems = await this.agent.db.getAll(sectionKey);
        const existingIds = new Set(existingItems.map(i => i.id));

        for (const item of (block.items || [])) {
          const record = { ...item };
          // parentId элемента перемаппим — иначе он указывал бы на id
          // папки из чужой базы, которую мы переиспользовали под другим id.
          if (record.parentId) {
            record.parentId = folderIdMap[record.parentId] || record.parentId;
          }

          // Встроенный инструмент обрабатываем ДО общей проверки на дубли:
          // локально он существует всегда, поэтому иначе всегда попадал бы
          // в «пропущено» и его размещение в папке не переносилось бы.
          // Описание и parameters берём локальные (они поставляются с
          // приложением и могут быть новее архива), из архива — только
          // пользовательское состояние: папку и признак включения.
          if (sectionKey === 'tools' && record.builtin) {
            const local = existingItems.find(i => i.id === record.id);
            if (local) {
              local.parentId = record.parentId ?? null;
              if (typeof record.enabled === 'boolean') local.enabled = record.enabled;
              await this.agent.db.put(sectionKey, local);
              added++;
            } else {
              // Локально такого builtin нет (другая версия приложения) —
              // пропускаем: без обработчика в реестре он не заработает.
              skipped++;
            }
            continue;
          }

          if (existingIds.has(item.id) && mode !== 'overwrite') { skipped++; continue; }

          // Тот же принцип, что и для create_tool: чужой исполняемый код
          // не должен становиться активным без явного решения пользователя.
          if (sectionKey === 'tools' && record.handlerCode) record.enabled = false;

          await this.agent.db.put(sectionKey, record);
          added++;
        }
      }

      status.textContent = `✅ Импортировано: ${added}, папок создано: ${foldersAdded}` +
        `${foldersReused ? `, папок переиспользовано: ${foldersReused}` : ''}` +
        `${skipped ? `, пропущено: ${skipped}` : ''}`;
      status.style.color = 'var(--success)';

      await this.agent.tools.loadTools();
      this.renderTools();
      this.renderSkills();
      this.renderPrompts();
      this.refreshSidebar();
      this.updateChatToolbar();
    } catch (e) {
      setErr(e.message);
    }
  }

});
