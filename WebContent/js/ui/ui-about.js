// ============================================================
//  UI ABOUT — имя агента, счётчик релизов, «Что нового»
// ============================================================
//
// Три вещи, которые говорят пользователю, С КЕМ он работает и что этот
// собеседник умеет сегодня: подпись в шапке, номер релиза рядом с ней и
// окно с непрочитанными возможностями.
//
// Почему имя спрашивается при первом запуске, а не подставляется молча:
// имя уходит в системный промпт, и агент на него отзывается. Придуманное
// за пользователя имя он начал бы считать своим — а пользователь узнал
// бы об этом, только столкнувшись с ним в ответе.

Object.assign(UI.prototype, {

  // Подпись в шапке и заголовок вкладки. Вызывается и при запуске, и
  // после переименования — в том числе из инструмента agent_name.
  applyAgentName(name) {
    const label = name || AboutEngine.FALLBACK_LABEL;
    const el = document.getElementById('agent-name');
    if (el) el.textContent = label;
    // Заголовок вкладки — это ещё и подпись в списке окон браузера:
    // с двумя открытыми агентами без имени их не различить.
    document.title = `${label} — Personal Assistant`;
    const logo = document.getElementById('app-logo');
    if (logo) {
      logo.title = name
        ? `Имя агента: ${label}. Изменить — ⚙ Настройки → Отображение или просто попросите агента.`
        : 'Имя агенту ещё не дано — задайте его в ⚙ Настройки → Отображение';
    }
  },

  // Значок релиза. unread > 0 — подсвечиваем: иначе о непрочитанном
  // напоминало бы только окно, которое пользователь уже закрыл.
  async updateReleaseBadge() {
    const badge = document.getElementById('release-badge');
    if (!badge || !this.agent.about) return;
    const total = this.agent.about.releaseCount();
    const unread = (await this.agent.about.unread()).length;
    badge.textContent = 'r' + total;
    badge.classList.toggle('has-unread', unread > 0);
    badge.title = unread
      ? `Релиз ${total}. Непрочитанных доработок: ${unread} — нажмите, чтобы посмотреть`
      : `Релиз ${total}. История доработок`;
  },

  // ── Вопрос об имени при первом запуске ──
  // Окно не даёт «сохранить пустоту»: пустое имя означало бы, что вопрос
  // задан впустую и при следующем запуске повторится. Отказ (Esc,
  // «Отмена») уважается — но тогда имя останется не заданным, и вопрос
  // действительно повторится: это честнее, чем назначить имя самим.
  askAgentName({ first = true } = {}) {
    return new Promise((resolve) => {
      const current = this.agent.about?.name || '';
      const intro = first
        ? 'У этого агента пока нет имени. Дайте ему имя — оно будет видно в шапке, ' +
          'и агент будет отзываться на него в разговоре.'
        : 'Как теперь называть агента?';

      this._showModal(first ? '👋 Знакомство' : '✏️ Имя агента', `
        <p style="font-size:13px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px;">
          ${this._escHtml(intro)}
        </p>
        <div class="form-group">
          <label>Имя агента</label>
          <input id="agent_name_input" maxlength="${AboutEngine.MAX_NAME}"
                 value="${this._escHtml(current)}" placeholder="Например: Ада, Помощник, Пятница">
          <div id="agent_name_err" style="font-size:11px;color:var(--danger);margin-top:4px;" hidden></div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
            До ${AboutEngine.MAX_NAME} символов. Изменить можно когда угодно —
            в ⚙ Настройки → Отображение или просто попросив агента переименоваться.
          </div>
        </div>
      `, async () => {
        const raw = document.getElementById('agent_name_input')?.value || '';
        const res = await this.agent.about.setName(raw);
        if (res.error) {
          // Окно закроется само после onSave, поэтому спрашиваем заново:
          // молча проглоченный пустой ввод выглядел бы как поломка.
          const again = await this.askAgentName({ first });
          resolve(again);
          return;
        }
        this.applyAgentName(res.name);
        resolve(res.name);
      }, () => resolve(null));

      setTimeout(() => {
        const input = document.getElementById('agent_name_input');
        if (!input) return;
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            document.querySelector('#modals .btn-primary')?.click();
          }
        });
      }, 50);
    });
  },

  // ── «Что нового» ──
  // Показывает возможности, а не изменения в коде (см. core/changelog.js).
  // markRead=true — обычный случай: окно показано, значит прочитано.
  async showWhatsNewModal({ onlyUnread = false, markRead = true } = {}) {
    const about = this.agent.about;
    if (!about) return;

    const list = onlyUnread ? await about.unread() : about.all();
    if (!list.length) {
      this._showModal('✨ Что нового', `
        <p style="font-size:13px;color:var(--text-secondary);">
          Непрочитанного нет. Всего релизов: ${about.releaseCount()}.
        </p>`, null);
      return;
    }

    // От новых к старым: последнее сделанное интереснее первого.
    const rows = list.slice().reverse().map(r => `
      <div class="form-group">
        <label>Релиз ${r.n} — ${this._escHtml(r.title)}</label>
        <ul class="sec-risks">${r.items.map(i => `<li>${this._escHtml(i)}</li>`).join('')}</ul>
      </div>`).join('');

    const title = onlyUnread ? '✨ Что нового' : '📜 История доработок';
    this._showModal(title, `
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
        ${onlyUnread
          ? `Появилось с вашего прошлого визита — ${list.length} ${this._plural(list.length, 'релиз', 'релиза', 'релизов')} из ${about.releaseCount()}.`
          : `Всего релизов: ${about.releaseCount()}. Показаны все, от новых к старым.`}
        Подробности любого пункта можно спросить у самого агента.
      </p>
      ${rows}
    `, null, null, { wide: true });

    const close = document.querySelector('#modals .btn-primary');
    if (close) close.textContent = 'Понятно';

    if (markRead) {
      await about.markRead(about.releaseCount());
      await this.updateReleaseBadge();
    }
  },

  // Показывает окно само — но только тому, кто уже пользовался агентом.
  // Новичку нечего «догонять»: для него всё приложение — одна новость,
  // поэтому отметка ставится молча, а история остаётся доступной по
  // значку релиза и через самого агента.
  async checkWhatsNew() {
    const about = this.agent.about;
    if (!about) return;
    const seen = await about.lastSeenRelease();
    if (seen === null) {
      await about.markRead(about.releaseCount());
      await this.updateReleaseBadge();
      return;
    }
    const unread = await about.unread();
    await this.updateReleaseBadge();
    if (!unread.length) return;
    await this.showWhatsNewModal({ onlyUnread: true, markRead: true });
  },

  _plural(n, one, few, many) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  },

});
