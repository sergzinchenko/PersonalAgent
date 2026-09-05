// ============================================================
//  LOG GUARD — что никогда не попадает в консоль браузера
// ============================================================
//
// ЗАЧЕМ. Журналирование (⚙ Настройки → Журналирование) включают, чтобы
// разобраться в проблеме, а потом показывают консоль коллеге, снимают
// с неё скриншот или прикладывают к обращению в поддержку. Поэтому две
// вещи не должны попадать туда НИ ПРИ КАКИХ условиях:
//
//   1. Системный промпт — устройство агента и его правила безопасности.
//      Зная точный текст, обойти правила заметно проще, чем не зная;
//      к тому же в нём сводка плана текущей задачи и имя пользователя.
//   2. Вызовы системных инструментов (папка «Системные») с их
//      аргументами и результатами: через них проходят содержимое памяти
//      агента, ответы пользователя на вопросы, тела артефактов и планы
//      задач — то есть ровно те данные, которых в общей консоли быть
//      не должно.
//
// ЗАПРЕТ НЕ ЗАВИСИТ ОТ НАСТРОЙКИ. Это не «ещё один уровень подробности»,
// который можно поднять: соответствующие ветки журналирования просто не
// печатают эти данные — ни в кратком виде, ни в подробном. Вместо них в
// консоль уходит пометка, что данные скрыты намеренно, — иначе первый же
// разбор упрётся в подозрение, что журнал сломан.
//
// ГДЕ ПРИМЕНЯЕТСЯ: llm/llm-gateway.js (тело запроса и ответ API) и
// tools/tools-executor.js (вызовы инструментов). Список системных
// инструментов сюда кладёт ToolsEngine.loadTools() — он же единственный,
// кто знает актуальный состав папки «Системные».
const LogGuard = {
  // Имена инструментов из папки «Системные». Имена, а не id: в теле
  // запроса и в ответе API инструмент назван именем.
  _systemTools: new Set(),

  setSystemTools(names) {
    this._systemTools = new Set((names || []).filter(Boolean));
  },

  isSystemTool(name) {
    return this._systemTools.has(String(name || ''));
  },

  // ── Сообщения запроса ──
  // Возвращает КОПИЮ: подменять содержимое настоящих сообщений нельзя,
  // они уходят в запрос.
  redactMessages(messages) {
    return (messages || []).map((m) => {
      if (!m || typeof m !== 'object') return m;

      if (m.role === 'system') {
        const len = typeof m.content === 'string' ? m.content.length : 0;
        return { role: 'system', content: `[скрыто: системный промпт, ${len} симв.]` };
      }

      // Результат системного инструмента приходит обратно в модель
      // сообщением role:'tool' — то же содержимое, что и в самом вызове.
      if (m.role === 'tool' && this.isSystemTool(m.name)) {
        return { ...m, content: '[скрыто: результат системного инструмента]' };
      }

      if (Array.isArray(m.tool_calls)) {
        return { ...m, tool_calls: this.redactToolCalls(m.tool_calls) };
      }

      return m;
    });
  },

  redactToolCalls(calls) {
    return (calls || []).map((c) => {
      if (!c || !c.function || !this.isSystemTool(c.function.name)) return c;
      return {
        ...c,
        function: { name: c.function.name, arguments: '[скрыто: аргументы системного инструмента]' },
      };
    });
  },

  // Тело запроса к API целиком: сообщения + описания инструментов.
  // Описания системных инструментов — это тоже часть системного промпта
  // по смыслу (модель читает их так же), поэтому и они не печатаются.
  redactBody(body) {
    const out = { ...(body || {}) };
    if (Array.isArray(out.messages)) out.messages = this.redactMessages(out.messages);
    if (Array.isArray(out.tools)) {
      out.tools = out.tools.map((t) => {
        const name = t && t.function && t.function.name;
        if (!this.isSystemTool(name)) return t;
        return { type: t.type, function: { name, description: '[скрыто: описание системного инструмента]' } };
      });
    }
    return out;
  },

  // Ответ API: в нём модель просит вызвать инструменты — среди них могут
  // быть системные, и аргументы вызова печатать нельзя.
  redactApiResponse(data) {
    if (!data || !Array.isArray(data.choices)) return data;
    return {
      ...data,
      choices: data.choices.map((ch) => {
        const calls = ch && ch.message && ch.message.tool_calls;
        if (!Array.isArray(calls)) return ch;
        return { ...ch, message: { ...ch.message, tool_calls: this.redactToolCalls(calls) } };
      }),
    };
  },

  // Одна пометка на сеанс: объясняет молчание журнала там, где иначе
  // оно выглядит как его поломка. Печатается при первом же скрытии.
  _noticed: false,
  notice() {
    if (this._noticed) return;
    this._noticed = true;
    console.info('%cℹ️ Журнал: системный промпт и вызовы системных инструментов не журналируются — намеренно и без возможности включить.',
      'color:#888;');
  },
};
