// ============================================================
//  ARTIFACTS ENGINE — большие результаты инструментов вне контекста
// ============================================================
//
// ЗАЧЕМ. Результат вызова инструмента раньше целиком уходил в историю
// чата (сообщение role:'tool') и с этого момента отправлялся модели в
// КАЖДОМ следующем запросе хода. Одна выкачанная страница на 150 КБ —
// это десятки тысяч токенов, которые вытесняли из окна контекста и
// начало переписки, и системный промпт, причём навсегда: перечитать их
// модель не просила, но платила за них на каждом шаге.
//
// ЧТО ВМЕСТО. Большой результат целиком сохраняется здесь, а в контекст
// уходит короткая ШАПКА (digest): чем получено, сколько весит, из чего
// состоит, начало текста и идентификатор. Дальше модель сама решает,
// нужно ли содержимое, и берёт его порциями — artifact_read/artifact_grep
// (см. tools-artifacts.js). Работа с большим результатом становится
// такой же, как работа с файлом: открыл, нашёл нужное, закрыл.
//
// ВАЖНО ПРО МЕСТО НА ДИСКЕ. Расход хранилища от этого не растёт: раньше
// тот же текст лежал в сообщении, теперь — в отдельной записи. Артефакты
// удаляются вместе с чатом (removeByChat), как и его сообщения.
class ArtifactsEngine {
  constructor(db) {
    this.db = db;
    // Сколько символов начала показывать в шапке. Достаточно, чтобы
    // модель поняла, что перед ней и стоит ли читать дальше, и мало,
    // чтобы шапка сама не стала тем, от чего мы уходим.
    this.previewChars = 600;
  }

  // ── Разделение результата на «метаданные» и «тело» ──
  // Инструменты возвращают объект, где почти весь объём — одно поле:
  // http_fetch → { status, url, body }, read_file → { path, text }.
  // Класть в артефакт весь объект значило бы прятать и status с url,
  // которые модели нужны сразу и стоят копейки. Поэтому доминирующее
  // строковое поле (больше 60% объёма) выносится в тело артефакта, а
  // остальные поля остаются в шапке как есть.
  _split(result) {
    const whole = JSON.stringify(result);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return { meta: null, field: null, text: whole };
    }
    let best = null, bestLen = 0;
    for (const [k, v] of Object.entries(result)) {
      if (typeof v !== 'string') continue;
      if (v.length > bestLen) { best = k; bestLen = v.length; }
    }
    if (!best || bestLen < whole.length * 0.6) {
      return { meta: null, field: null, text: whole };
    }
    const meta = {};
    for (const [k, v] of Object.entries(result)) {
      if (k === best) continue;
      // Второстепенные поля тоже могут оказаться немаленькими —
      // подрезаем, иначе шапка распухнет ровно тем, от чего уходим.
      meta[k] = (typeof v === 'string' && v.length > 300) ? v.slice(0, 300) + '…' : v;
    }
    return { meta, field: best, text: result[best] };
  }

  // ── Структура содержимого одной строкой ──
  // «JSON-объект, ключи верхнего уровня: items(50), total, nextPage» —
  // этого обычно хватает, чтобы решить, что читать дальше, и не читать
  // ничего лишнего.
  _outline(text) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return `JSON-массив, элементов: ${parsed.length}`;
        const all = Object.keys(parsed);
        const keys = Object.entries(parsed).slice(0, 25).map(([k, v]) =>
          Array.isArray(v) ? `${k}(${v.length})` : k);
        return `JSON-объект, ключи верхнего уровня: ${keys.join(', ')}` +
               (all.length > 25 ? ' …' : '');
      } catch (_) { /* не JSON — ниже общий случай */ }
    }
    if (/^\s*</.test(text)) return 'разметка (HTML/XML)';
    return 'текст';
  }

  // Сохраняет результат и возвращает запись артефакта.
  async store({ chatId, toolName, args, result }) {
    const { meta, field, text } = this._split(result);
    const rec = {
      id: 'af_' + uid(),
      chatId,
      toolName,
      // Аргументы вызова нужны, чтобы через сутки понять, что это за
      // артефакт, — но только как справка, поэтому коротко.
      argsBrief: this._brief(args),
      field,
      meta,
      text,
      chars: text.length,
      lines: text.split('\n').length,
      outline: this._outline(text),
      createdAt: Date.now(),
    };
    await this.db.put('artifacts', rec);
    return rec;
  }

  _brief(args) {
    let s;
    try { s = typeof args === 'string' ? args : JSON.stringify(args); }
    catch (_) { s = String(args); }
    s = s || '';
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  }

  // ── Шапка, которая уходит в контекст вместо содержимого ──
  // Составлена так, чтобы модель без дополнительных объяснений понимала:
  // содержимое не потеряно, вот его размер и вот чем его взять.
  digest(rec) {
    const out = {
      artifact_id: rec.id,
      tool: rec.toolName,
      chars: rec.chars,
      lines: rec.lines,
      outline: rec.outline,
      preview: rec.text.slice(0, this.previewChars) + (rec.chars > this.previewChars ? '…' : ''),
      hint: 'Полный результат сохранён вне контекста и НЕ потерян. Читай его порциями: ' +
        `artifact_read({ id: "${rec.id}", offset, limit }) — участок текста, ` +
        `artifact_grep({ id: "${rec.id}", pattern }) — строки по регулярному выражению. ` +
        'Не выдумывай содержимое, которого не видел, и не проси пользователя повторить вызов.',
    };
    if (rec.field) out.body_field = rec.field;
    if (rec.meta) Object.assign(out, rec.meta);
    return out;
  }

  async get(id) {
    return this.db.get('artifacts', id);
  }

  // Чтение окном. offset/limit в СИМВОЛАХ: инструменты возвращают текст,
  // а не строки фиксированной длины, и «прочитать со 100-й строки» без
  // индексации всё равно означало бы пройти текст целиком.
  async read(id, { offset = 0, limit = 4000 } = {}) {
    const rec = await this.get(id);
    if (!rec) return { error: `Артефакт "${id}" не найден. Возможно, чат с ним удалён.` };

    const from = Math.max(0, Math.min(offset | 0, rec.chars));
    const size = Math.max(1, Math.min(limit | 0 || 4000, 20000));
    const chunk = rec.text.slice(from, from + size);
    const end = from + chunk.length;
    return {
      artifact_id: rec.id,
      offset: from,
      next_offset: end < rec.chars ? end : null,
      chars: rec.chars,
      returned: chunk.length,
      eof: end >= rec.chars,
      text: chunk,
    };
  }

  // Поиск по регулярному выражению: обычно нужен один фрагмент из
  // большого документа, и последовательное чтение окнами ради него —
  // это те же токены, от которых мы уходили.
  async grep(id, pattern, { ignoreCase = true, context = 0, max = 20 } = {}) {
    const rec = await this.get(id);
    if (!rec) return { error: `Артефакт "${id}" не найден. Возможно, чат с ним удалён.` };

    let re;
    try {
      re = new RegExp(pattern, ignoreCase ? 'i' : '');
    } catch (e) {
      return { error: 'Некорректное регулярное выражение: ' + e.message };
    }

    const lines = rec.text.split('\n');
    const ctx = Math.max(0, Math.min(context | 0, 5));
    const cap = Math.max(1, Math.min(max | 0 || 20, 100));
    const matches = [];
    for (let i = 0; i < lines.length && matches.length < cap; i++) {
      if (!re.test(lines[i])) continue;
      const from = Math.max(0, i - ctx);
      const to = Math.min(lines.length - 1, i + ctx);
      matches.push({
        line: i + 1,
        text: lines.slice(from, to + 1).join('\n').slice(0, 1000),
      });
    }
    return {
      artifact_id: rec.id,
      pattern,
      total_lines: lines.length,
      matches,
      truncated: matches.length >= cap,
    };
  }

  async list(chatId) {
    const all = chatId
      ? await this.db.getAllByIndex('artifacts', 'chatId', chatId)
      : await this.db.getAll('artifacts');
    return all
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(r => ({
        artifact_id: r.id,
        tool: r.toolName,
        args: r.argsBrief,
        chars: r.chars,
        lines: r.lines,
        outline: r.outline,
        createdAt: new Date(r.createdAt).toISOString(),
      }));
  }

  // Артефакты чата живут ровно столько, сколько сам чат: осиротевшие
  // записи иначе тихо копились бы, занимая место в браузере.
  async removeByChat(chatId) {
    const all = await this.db.getAllByIndex('artifacts', 'chatId', chatId);
    if (!all.length) return 0;
    await this.db.deleteAll('artifacts', all.map(a => a.id));
    return all.length;
  }
}
