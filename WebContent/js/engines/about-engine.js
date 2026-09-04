// ============================================================
//  ABOUT ENGINE — имя агента и история его доработок
// ============================================================
//
// ЗАЧЕМ ОДИН ДВИЖОК НА ДВА ВОПРОСА. И имя, и перечень релизов отвечают
// на один и тот же вопрос: «кто это и чем он стал». Оба нужны в трёх
// местах сразу — в шапке, в системном промпте и в инструментах, — и оба
// живут в settings, а не в собственном хранилище: это одна короткая
// запись, которой не нужны ни индексы, ни перебор.
//
// ИМЯ — НЕ УКРАШЕНИЕ. Оно уходит в системный промпт: агент должен
// отзываться на своё имя и не выдумывать себе другое. Поэтому пустое имя
// здесь не хранится вовсе — вместо него отсутствие имени, по которому
// интерфейс при запуске понимает, что имя надо спросить. Подставлять
// молча «AI Agent» и считать это именем нельзя: тогда вопрос никогда бы
// не задался, а агент утверждал бы, что его так зовут.
//
// ОТМЕТКА «ПРОЧИТАНО» — номер последнего показанного релиза, а не
// список. Релизы дописываются только в конец (см. changelog.js), поэтому
// одного числа достаточно, и оно не растёт со временем.
class AboutEngine {
  constructor(db) {
    this.db = db;
    // Кэш в памяти: имя запрашивается на каждый системный промпт, то есть
    // на каждый запрос к модели. Источник правды — база; кэш обновляется
    // только здесь, в load() и setName().
    this._name = null;
  }

  // Имя показывается в шапке и уходит в промпт, поэтому и длина, и
  // переводы строк ограничены: многострочное «имя» разъехалось бы в
  // вёрстке и вклинилось бы в промпт лишними строками.
  static MAX_NAME = 40;

  // Как называть агента, пока имя не задано. Это подпись в интерфейсе,
  // а НЕ имя: в промпт она не попадает (см. пояснение выше).
  static FALLBACK_LABEL = 'AI Agent';

  // Управляющие символы заменяются пробелом посимвольно, а не регулярным
  // выражением с диапазоном: диапазон управляющих символов в исходнике —
  // это те же управляющие символы внутри файла, и любой инструмент,
  // который его перепишет, легко их испортит.
  static normalizeName(raw) {
    const src = String(raw == null ? '' : raw);
    let out = '';
    for (const ch of src) {
      const code = ch.codePointAt(0);
      out += (code < 32 || code === 127) ? ' ' : ch;
    }
    return out.replace(/\s+/g, ' ').trim().slice(0, AboutEngine.MAX_NAME);
  }

  async load() {
    const rec = await this.db.get('settings', 'identity');
    this._name = rec && rec.name ? AboutEngine.normalizeName(rec.name) : null;
    return this._name;
  }

  // Имя или null. Null означает «имя ещё не давали» — см. шапку файла.
  get name() {
    return this._name || null;
  }

  // То, чем можно подписать интерфейс в любом случае.
  get label() {
    return this._name || AboutEngine.FALLBACK_LABEL;
  }

  async setName(raw) {
    const name = AboutEngine.normalizeName(raw);
    if (!name) return { error: 'Имя не может быть пустым.' };
    const prev = this._name;
    const rec = (await this.db.get('settings', 'identity')) || { key: 'identity' };
    await this.db.put('settings', { ...rec, key: 'identity', name, renamedAt: Date.now() });
    this._name = name;
    return { ok: true, name, previous: prev };
  }

  // ── История доработок ──
  releaseCount() { return APP_RELEASE_COUNT; }

  latest() { return latestRelease(); }

  all() { return APP_RELEASES.slice(); }

  byNumber(n) { return releaseByNumber(n); }

  async lastSeenRelease() {
    const rec = await this.db.get('settings', 'changelog');
    return rec && typeof rec.lastSeen === 'number' ? rec.lastSeen : null;
  }

  // Непрочитанные релизы. lastSeen === null означает базу, заведённую до
  // появления истории (или совсем новую): что считать «непрочитанным» в
  // этом случае, решает вызывающая сторона — здесь честно возвращается всё.
  async unread() {
    const seen = await this.lastSeenRelease();
    return releasesSince(seen || 0);
  }

  async markRead(n) {
    const upTo = Number.isFinite(Number(n)) ? Number(n) : APP_RELEASE_COUNT;
    const rec = (await this.db.get('settings', 'changelog')) || { key: 'changelog' };
    // Только вперёд: показ старого релиза не должен означать «а всё, что
    // после него, ты снова не видел».
    const prev = typeof rec.lastSeen === 'number' ? rec.lastSeen : 0;
    const next = Math.max(prev, upTo);
    await this.db.put('settings', { ...rec, key: 'changelog', lastSeen: next, seenAt: Date.now() });
    return next;
  }
}
