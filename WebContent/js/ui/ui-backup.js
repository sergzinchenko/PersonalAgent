// ============================================================
//  UI BACKUP — резервная копия агента: выгрузка и восстановление
// ============================================================
//
// Три окна на одну задачу «перенести агента целиком»:
//   showBackupExportModal   — что взять и под каким паролем;
//   showBackupImportModal   — что вернуть из файла и как поступить с тем,
//                             что уже есть;
//   offerFirstRunRestore    — то же восстановление, но предложенное само,
//                             при первом запуске.
//
// ПОЧЕМУ ПЕРВЫЙ ЗАПУСК — ОТДЕЛЬНЫЙ РАЗГОВОР. Восстановление из копии
// имеет смысл ровно один раз: в пустом агенте. Позже оно превращается в
// слияние двух состояний, а это уже осознанное действие из настроек.
// Поэтому предложение показывается там же, где раньше сразу спрашивали
// имя, и ДО этого вопроса: имя приедет из файла, и спрашивать его, чтобы
// через минуту заменить, — значит заставить человека выбирать дважды.
//
// СОСТАВ СТРОИТСЯ ИЗ BackupEngine.PARTS, а не пишется здесь руками:
// перечень того, что можно взять, — свойство данных (см. шапку
// engines/backup-engine.js). Появится новая часть — она сама окажется в
// обеих формах и в отчёте.

Object.assign(UI.prototype, {

  // ── Выгрузка ──
  showBackupExportModal() {
    const rows = BackupEngine.PARTS.map(p => `
      <label class="check-row" title="${this._escHtml(p.hint)}">
        <input type="checkbox" class="bk-part" value="${p.id}" checked>
        <span>${p.icon} ${this._escHtml(p.label)}</span>
        ${p.secrets ? '<span class="sel-badge" title="В этой части есть ключи и токены доступа.">доступы</span>' : ''}
      </label>
      <div class="bk-hint">${this._escHtml(p.hint)}</div>`).join('');

    this._showModal('💾 Резервная копия агента', `
      <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:12px;">
        Один файл, из которого агента можно поднять заново — на другой машине,
        в другом браузере или после переустановки. Отметьте, что в него положить.
      </div>

      <div class="form-group">
        <label>Состав копии <span id="bk-count" style="color:var(--text-muted);font-weight:400;"></span></label>
        <div style="display:flex;gap:8px;margin:6px 0;">
          <button type="button" class="btn btn-secondary btn-sm" id="bk-all">Отметить всё</button>
          <button type="button" class="btn btn-secondary btn-sm" id="bk-none">Снять всё</button>
        </div>
        <div class="sel-list">${rows}</div>
      </div>

      <div class="form-group">
        <label class="check-row" style="margin:0;">
          <input type="checkbox" id="bk_secrets" checked> Включить ключи доступа
        </label>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
          Ключи от сервисов моделей, токены MCP-серверов и доступы к вики. Без них копия
          остаётся полезной — вернутся все настройки и содержимое, — но подключения
          придётся ввести заново.
        </div>
      </div>

      <div class="form-group">
        <label>Пароль</label>
        <input id="bk_pass" type="password" placeholder="минимум 8 символов">
      </div>
      <div class="form-group">
        <label>Повторите пароль</label>
        <input id="bk_pass2" type="password" placeholder="ещё раз">
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">
        Пароль обязателен: в копии лежат доступы к вашим сервисам, и файл без пароля
        был бы связкой ключей в папке «Загрузки». Восстановить пароль невозможно —
        без него копию не открыть.
      </div>

      <button class="btn btn-primary btn-sm" id="bk-do-export">💾 Скачать копию</button>
      <span id="bk-status" style="font-size:12px;margin-left:8px;"></span>
    `, null, null, { wide: true });

    setTimeout(() => {
      const boxes = () => Array.from(document.querySelectorAll('.bk-part'));
      const count = () => {
        const el = document.getElementById('bk-count');
        if (el) el.textContent = `— выбрано ${boxes().filter(b => b.checked).length} из ${boxes().length}`;
      };
      boxes().forEach(b => b.addEventListener('change', count));
      document.getElementById('bk-all')?.addEventListener('click', () => { boxes().forEach(b => b.checked = true); count(); });
      document.getElementById('bk-none')?.addEventListener('click', () => { boxes().forEach(b => b.checked = false); count(); });
      count();
      document.getElementById('bk-do-export')?.addEventListener('click', () => this._doBackupExport());
    }, 50);
  },


  async _doBackupExport() {
    const status = document.getElementById('bk-status');
    const setErr = (msg) => { status.textContent = '❌ ' + msg; status.style.color = 'var(--danger)'; };

    const parts = Array.from(document.querySelectorAll('.bk-part')).filter(b => b.checked).map(b => b.value);
    if (!parts.length) return setErr('не выбрана ни одна часть');

    const pass = document.getElementById('bk_pass').value;
    if (pass.length < 8) return setErr('пароль короче 8 символов');
    if (pass !== document.getElementById('bk_pass2').value) return setErr('пароли не совпадают');

    const includeSecrets = document.getElementById('bk_secrets').checked;

    status.textContent = '⏳ Собираю и шифрую...';
    status.style.color = 'var(--warning)';

    try {
      const payload = await this.agent.backup.collect(parts, { includeSecrets });
      const envelope = await ArchiveCrypto.encryptPayload(payload, pass);

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const name = (this.agent.about?.name || 'agent').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 24);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ai-agent-backup-${name}-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);

      const total = Object.values(payload.counts || {}).reduce((s, n) => s + n, 0);
      status.textContent = `✅ Частей: ${parts.length}, записей: ${total}` +
        (includeSecrets ? ' · с ключами доступа' : ' · без ключей доступа');
      status.style.color = 'var(--success)';
    } catch (e) {
      setErr(e.message);
    }
  },


  // ── Восстановление ──
  // firstRun — окно открыто само, в пустом агенте: тогда у него другой
  // заголовок, другое вступление и кнопка «начать с нуля» вместо отмены,
  // а после успеха страница перезагружается (см. _doBackupImport).
  showBackupImportModal({ firstRun = false } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };

      const intro = firstRun
        ? 'Если этот агент у вас уже был — на другой машине или до переустановки, — ' +
          'верните его из резервной копии. Приедут имя, настройки, инструменты, навыки и переписка.'
        : 'Восстановление из файла, созданного кнопкой «Скачать копию». ' +
          'Отметьте, что именно вернуть.';

      // Восстановление запускает своя кнопка внутри окна: она появляется
      // только после того, как копия открыта и состав виден. Общей
      // «Сохранить» здесь нечего сохранять — она прячется ниже, — но
      // обработчик у неё всё же есть: между отрисовкой и setTimeout есть
      // мгновение, когда по ней можно попасть, а окно, закрывшееся без
      // ответа, подвесило бы ожидающего (при первом запуске — сам запуск).
      this._showModal(firstRun ? '📂 Восстановить агента из копии' : '📂 Восстановление из копии', `
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:12px;">
          ${this._escHtml(intro)}
        </div>

        <div class="form-group">
          <label>Файл копии (.json)</label>
          <input id="bkr_file" type="file" accept="application/json,.json">
        </div>
        <div class="form-group">
          <label>Пароль копии</label>
          <input id="bkr_pass" type="password" placeholder="пароль, заданный при выгрузке">
        </div>

        <button class="btn btn-secondary btn-sm" id="bkr-open">🔓 Открыть копию</button>
        <span id="bkr-open-status" style="font-size:12px;margin-left:8px;"></span>

        <div id="bkr-content" hidden style="margin-top:14px;">
          <div id="bkr-about" style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:10px;"></div>

          <div class="form-group">
            <label>Что вернуть <span id="bkr-count" style="color:var(--text-muted);font-weight:400;"></span></label>
            <div style="display:flex;gap:8px;margin:6px 0;">
              <button type="button" class="btn btn-secondary btn-sm" id="bkr-all">Отметить всё</button>
              <button type="button" class="btn btn-secondary btn-sm" id="bkr-none">Снять всё</button>
            </div>
            <div class="sel-list" id="bkr-list"></div>
          </div>

          <div class="form-group">
            <label>Что делать с тем, что уже есть</label>
            <label class="check-row"><input type="radio" name="bkr_mode" value="merge" checked> Добавить недостающее — существующее не трогать</label>
            <label class="check-row"><input type="radio" name="bkr_mode" value="overwrite"> Заменить совпадающие записи содержимым копии</label>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
              В пустом агенте разницы нет. Системные инструменты и навыки не заменяются
              никогда — их код поставляется с приложением.
            </div>
          </div>

          <div class="form-group">
            <label class="check-row" style="margin:0;">
              <input type="checkbox" id="bkr_enable_code"> Сразу включить инструменты с собственным кодом
            </label>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
              По умолчанию такие инструменты приезжают выключенными: их код исполняется
              в этой вкладке по решению модели. Отмечайте, только если копия ваша
              и вы знаете, что в ней.
            </div>
          </div>

          <button class="btn btn-primary btn-sm" id="bkr-do">📂 Восстановить</button>
          <span id="bkr-status" style="font-size:12px;margin-left:8px;"></span>
        </div>
      `, () => done(false), () => done(false), { wide: true });

      setTimeout(() => {
        const save = document.querySelector('#modals .modal-actions .btn-primary');
        if (save) save.hidden = true;
        // Первый запуск: «Отмена» здесь означает «начну с нуля» — так и
        // подписываем, иначе выбор выглядит как отказ от чего-то.
        const cancel = document.querySelector('#modals .modal-actions .btn-secondary');
        if (cancel && firstRun) cancel.textContent = 'Начать с нуля';

        document.getElementById('bkr-open')?.addEventListener('click', () => this._openBackupFile());
        document.getElementById('bkr-all')?.addEventListener('click', () => {
          document.querySelectorAll('.bkr-part').forEach(b => b.checked = true);
          this._syncBackupRestoreCount();
        });
        document.getElementById('bkr-none')?.addEventListener('click', () => {
          document.querySelectorAll('.bkr-part').forEach(b => b.checked = false);
          this._syncBackupRestoreCount();
        });
        document.getElementById('bkr-do')?.addEventListener('click', () => this._doBackupImport({ firstRun, done }));
      }, 50);
    });
  },


  // Расшифровывает файл и показывает его состав. Разделено на два шага
  // намеренно: до расшифровки неизвестно ни что внутри, ни от кого копия,
  // а выбирать состав вслепую — значит выбирать наугад.
  async _openBackupFile() {
    const status = document.getElementById('bkr-open-status');
    const setErr = (msg) => { status.textContent = '❌ ' + msg; status.style.color = 'var(--danger)'; };

    const fileInput = document.getElementById('bkr_file');
    if (!fileInput.files || !fileInput.files[0]) return setErr('файл не выбран');
    const pass = document.getElementById('bkr_pass').value;
    if (!pass) return setErr('введите пароль');

    status.textContent = '⏳ Расшифровываю...';
    status.style.color = 'var(--warning)';

    try {
      const text = await fileInput.files[0].text();
      let envelope;
      try { envelope = JSON.parse(text); }
      catch (_) { return setErr('файл не является корректным JSON'); }

      const payload = await ArchiveCrypto.decryptPayload(envelope, pass);
      const info = BackupEngine.describe(payload);

      // Payload держим в поле объекта, а не в разметке: он большой и
      // содержит ключи доступа — в DOM ему делать нечего.
      this._pendingBackup = payload;

      const when = info.createdAt ? new Date(info.createdAt).toLocaleString('ru-RU') : 'неизвестно когда';
      document.getElementById('bkr-about').innerHTML =
        `Копия агента ${info.agentName ? '«' + this._escHtml(info.agentName) + '»' : 'без имени'}, ` +
        `сделана ${this._escHtml(when)}` +
        (info.appRelease ? `, релиз ${info.appRelease}` : '') + '. ' +
        (info.includesSecrets
          ? 'Ключи доступа в копии есть.'
          : '<b>Ключей доступа в копии нет</b> — подключения придётся ввести заново.');

      document.getElementById('bkr-list').innerHTML = info.parts.map(p => `
        <label class="check-row" title="${this._escHtml(p.hint)}">
          <input type="checkbox" class="bkr-part" value="${p.id}" checked>
          <span>${p.icon} ${this._escHtml(p.label)}</span>
          <span class="sel-folder">${p.count} ${this._plural(p.count, 'запись', 'записи', 'записей')}</span>
        </label>`).join('') || '<div style="color:var(--text-muted);font-size:13px;">Копия пуста.</div>';

      document.querySelectorAll('.bkr-part').forEach(b =>
        b.addEventListener('change', () => this._syncBackupRestoreCount()));

      document.getElementById('bkr-content').hidden = false;
      this._syncBackupRestoreCount();

      status.textContent = '✅ Копия открыта';
      status.style.color = 'var(--success)';
    } catch (e) {
      this._pendingBackup = null;
      document.getElementById('bkr-content').hidden = true;
      setErr(e.message);
    }
  },


  _syncBackupRestoreCount() {
    const boxes = Array.from(document.querySelectorAll('.bkr-part'));
    const el = document.getElementById('bkr-count');
    if (el) el.textContent = `— выбрано ${boxes.filter(b => b.checked).length} из ${boxes.length}`;
  },


  async _doBackupImport({ firstRun = false, done } = {}) {
    const status = document.getElementById('bkr-status');
    const setErr = (msg) => { status.textContent = '❌ ' + msg; status.style.color = 'var(--danger)'; };

    const payload = this._pendingBackup;
    if (!payload) return setErr('копия не открыта');

    const parts = Array.from(document.querySelectorAll('.bkr-part')).filter(b => b.checked).map(b => b.value);
    if (!parts.length) return setErr('не выбрана ни одна часть');

    const mode = document.querySelector('input[name="bkr_mode"]:checked')?.value || 'merge';
    const enableImportedCode = !!document.getElementById('bkr_enable_code')?.checked;

    status.textContent = '⏳ Восстанавливаю...';
    status.style.color = 'var(--warning)';

    try {
      const report = await this.agent.backup.apply(payload, { parts, mode, enableImportedCode });

      // Ключи доступа больше не нужны ни в памяти, ни в поле объекта.
      this._pendingBackup = null;

      const bits = [`восстановлено ${report.added}`];
      if (report.replaced) bits.push(`заменено ${report.replaced}`);
      if (report.skipped) bits.push(`пропущено ${report.skipped}`);
      if (report.foldersAdded) bits.push(`папок создано ${report.foldersAdded}`);
      if (report.memoryKeys) bits.push(`записей памяти ${report.memoryKeys}`);
      if (report.disabledTools) bits.push(`инструментов оставлено выключенными ${report.disabledTools}`);

      status.textContent = '✅ ' + bits.join(', ') +
        // Копия без ключей доступа выглядит успешно восстановленной, но
        // агент не сможет обратиться ни к одной модели. Сказать об этом
        // надо здесь: следующий экран — уже перезагруженное приложение.
        (payload.includesSecrets ? '' : ' · ключей доступа в копии не было — введите их заново');
      status.style.color = 'var(--success)';

      // Половина восстановленного уже прочитана в память при запуске:
      // настройки лежат в LLMGateway и в UI, провайдеры — в реестре,
      // инструменты — в исполнителе. Дописать их в базу мало; честный
      // способ показать агента таким, каким он приехал, — поднять его
      // заново. Пауза — чтобы отчёт успели прочитать.
      setTimeout(() => location.reload(), firstRun ? 1400 : 2200);
      done?.(true);
    } catch (e) {
      setErr(e.message);
    }
  },


  // ── Предложение при первом запуске ──
  // Возвращает true, если восстановление запущено (страница вот-вот
  // перезагрузится и спрашивать имя уже не нужно).
  async offerFirstRunRestore() {
    const wants = await new Promise((resolve) => {
      let settled = false;
      this._showModal('👋 Первый запуск', `
        <p style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:10px;">
          Если этот агент у вас уже был — на другой машине или до переустановки, —
          верните его из резервной копии: приедут имя, настройки, подключения,
          инструменты, навыки и переписка.
        </p>
        <p style="font-size:13px;color:var(--text-secondary);line-height:1.6;">
          Копии нет? Тогда начнём с чистого листа — и первым делом придумаем агенту имя.
        </p>
      `, () => { settled = true; resolve(true); }, () => { if (!settled) resolve(false); });

      // Кнопки окна общие для всего приложения («Отмена» / «Сохранить»),
      // а здесь выбирают между двумя равноправными путями — подписи
      // должны называть именно их, иначе «Сохранить» предлагает сохранить
      // то, чего ещё нет.
      const save = document.querySelector('#modals .modal-actions .btn-primary');
      if (save) save.textContent = '📂 Восстановить из файла';
      const cancel = document.querySelector('#modals .modal-actions .btn-secondary');
      if (cancel) cancel.textContent = 'Начать с нуля';
    });

    if (!wants) return false;
    return await this.showBackupImportModal({ firstRun: true });
  },

});
