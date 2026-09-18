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
  // onClose — если окно открыто посреди другого сценария (например, из
  // окна первого запуска), тот должен продолжиться после закрытия: окно у
  // приложения одно, и история заменяет собой то, откуда её открыли.
  async showWhatsNewModal({ onlyUnread = false, markRead = true, onClose = null } = {}) {
    const about = this.agent.about;
    if (!about) { onClose?.(); return; }
    let closed = false;
    const done = onClose ? () => { if (!closed) { closed = true; onClose(); } } : null;

    const list = onlyUnread ? await about.unread() : about.all();
    if (!list.length) {
      this._showModal('✨ Что нового', `
        <p style="font-size:13px;color:var(--text-secondary);">
          Непрочитанного нет. Всего релизов: ${about.releaseCount()}.
        </p>`, done, done);
      return;
    }

    // ── Раскладка по категориям ──
    // Тридцать релизов подряд читаются как сплошная лента, в которой
    // невозможно найти «а что там было про инструменты». Поэтому внутри
    // релиза пункты сгруппированы по категориям в постоянном порядке, а
    // сверху — фильтр: одна категория показывает только своё, и релизы
    // без её пунктов не мешают.
    const counts = about.categoryCounts(list);
    const filter = counts.length > 1
      ? `<div class="rel-filter" id="rel_filter">
           <button type="button" class="rel-chip rel-chip-all active" data-cat="">Все
             <span class="rel-count">${list.reduce((n, r) => n + about.itemsOf(r).length, 0)}</span></button>
           ${counts.map(c => `<button type="button" class="rel-chip" data-cat="${this._escHtml(c.id)}"
              title="${this._escHtml(c.hint || '')}">${c.icon} ${this._escHtml(c.label)}
              <span class="rel-count">${c.count}</span></button>`).join('')}
         </div>`
      : '';

    // От новых к старым: последнее сделанное интереснее первого.
    const rows = list.slice().reverse().map(r => {
      const byCat = new Map();
      for (const it of about.itemsOf(r)) {
        if (!byCat.has(it.cat)) byCat.set(it.cat, []);
        byCat.get(it.cat).push(it.text);
      }
      // Порядок категорий внутри релиза — общий для всех релизов: так
      // глаз находит нужную группу на том же месте, а не ищет заново.
      const groups = about.categories().concat([about.category('other')])
        .filter(c => byCat.has(c.id))
        .map(c => `
          <div class="rel-group" data-cat="${this._escHtml(c.id)}">
            <div class="rel-group-head">${c.icon} ${this._escHtml(c.label)}</div>
            <ul class="sec-risks">${byCat.get(c.id).map(t => `<li>${this._escHtml(t)}</li>`).join('')}</ul>
          </div>`).join('');
      return `
        <div class="form-group rel-release" data-cats="${[...byCat.keys()].map(c => this._escHtml(c)).join(' ')}">
          <label>Релиз ${r.n} — ${this._escHtml(r.title)}</label>
          ${groups}
        </div>`;
    }).join('');

    const title = onlyUnread ? '✨ Что нового' : '📜 История доработок';
    this._showModal(title, `
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
        ${onlyUnread
          ? `Появилось с вашего прошлого визита — ${list.length} ${this._plural(list.length, 'релиз', 'релиза', 'релизов')} из ${about.releaseCount()}.`
          : `Всего релизов: ${about.releaseCount()}. Показаны все, от новых к старым.`}
        Подробности любого пункта можно спросить у самого агента.
      </p>
      ${filter}
      <div id="rel_empty" class="rel-empty" hidden></div>
      ${rows}
    `, done, done, { wide: true });

    const close = document.querySelector('#modals .btn-primary');
    if (close) close.textContent = 'Понятно';

    // Фильтр — показ и сокрытие уже отрисованного: перерисовывать окно
    // ради него незачем, а прокрутка при этом остаётся на месте.
    const box = document.querySelector('#modals .modal');
    box?.querySelector('#rel_filter')?.addEventListener('click', (e) => {
      const chip = e.target.closest('.rel-chip');
      if (!chip) return;
      const cat = chip.dataset.cat || '';
      box.querySelectorAll('.rel-chip').forEach(b => b.classList.toggle('active', b === chip));
      box.querySelectorAll('.rel-group').forEach(g => { g.hidden = !!cat && g.dataset.cat !== cat; });
      let shown = 0;
      box.querySelectorAll('.rel-release').forEach(rel => {
        const has = !cat || (' ' + rel.dataset.cats + ' ').includes(' ' + cat + ' ');
        rel.hidden = !has;
        if (has) shown++;
      });
      const empty = box.querySelector('#rel_empty');
      if (empty) {
        empty.hidden = shown > 0;
        empty.textContent = shown > 0 ? '' : 'В этой категории пока ничего нет.';
      }
    });

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
