// ============================================================
//  TOOLS ENGINE — MCP-compatible tool system
// ============================================================
class ToolsEngine {
  constructor(db) {
    this.db = db;
    this.ui = null;            // ← ссылка на UI устанавливается извне
    this.registry = new Map();
    this._initBuiltinTools();
  }

  _initBuiltinTools() {
    // Built-in: current_time
    this.registerHandler('builtin_time', async () => {
      return { time: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    });

    // Built-in: calculator
    this.registerHandler('builtin_calc', async (params) => {
      try {
        const expr = params.expression;
        const fn = new Function('return ' + expr.replace(/[^0-9+\-*/().%\s]/g, ''));
        return { result: fn(), expression: expr };
      } catch (e) {
        return { error: e.message };
      }
    });

    // Built-in: local_storage read/write
    this.registerHandler('builtin_memory', async (params) => {
      if (params.action === 'read') {
        const val = localStorage.getItem('agent_memory_' + params.key);
        return { key: params.key, value: val ? JSON.parse(val) : null };
      } else if (params.action === 'write') {
        localStorage.setItem('agent_memory_' + params.key, JSON.stringify(params.value));
        return { success: true, key: params.key };
      } else if (params.action === 'list') {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.startsWith('agent_memory_')) keys.push(k.replace('agent_memory_', ''));
        }
        return { keys };
      }
      return { error: 'Unknown action' };
    });

    // Built-in: fetch URL (proxy-free, limited by CORS)
    this.registerHandler('builtin_fetch', async (params) => {
      try {
        const resp = await fetch(params.url, { method: params.method || 'GET' });
        const text = await resp.text();
        return { status: resp.status, body: text.substring(0, 4000) };
      } catch (e) {
        return { error: e.message };
      }
    });
    
    // Built-in: format JSON
    this.registerHandler('builtin_json_format', async (params) => {
      try {
        const indent = params.indent ?? 2;
        const obj = typeof params.json === 'string' ? JSON.parse(params.json) : params.json;
        const sortKeys = !!params.sort_keys;

        const replacer = sortKeys
          ? (function sortReplacer(key, value) {
              if (value && typeof value === 'object' && !Array.isArray(value)) {
                return Object.keys(value).sort().reduce((acc, k) => {
                  acc[k] = value[k];
                  return acc;
                }, {});
              }
              return value;
            })
          : null;

        const formatted = JSON.stringify(obj, replacer, indent);
        return { formatted };
      } catch (e) {
        return { error: 'Invalid JSON: ' + e.message };
      }
    });

    // Built-in: format XML
    this.registerHandler('builtin_xml_format', async (params) => {
      try {
        const indentSize = params.indent ?? 2;
        const pad = ' '.repeat(indentSize);
        const xml = String(params.xml || '');

        // Валидация через DOMParser
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const parseErr = doc.querySelector('parsererror');
        if (parseErr) {
          return { error: 'Invalid XML: ' + parseErr.textContent.trim() };
        }

        // Нормализуем: убираем переносы между тегами, затем разбиваем по тегам
        let level = 0;
        const xmlNorm = xml.replace(/>\s+</g, '><').trim();
        const tokens = xmlNorm.replace(/></g, '>\n<').split('\n');

        const lines = tokens.map((node) => {
          let indent = 0;
          if (/^<\/\w/.test(node)) {
            // закрывающий тег — уменьшаем уровень заранее
            level = Math.max(level - 1, 0);
            indent = level;
          } else if (/^<\w[^>]*[^\/]>$/.test(node) && !/^<.*<\/.*>$/.test(node)) {
            // открывающий тег без закрытия на той же строке
            indent = level;
            level++;
          } else {
            // самозакрывающийся тег, комментарий, объявление или <a>text</a>
            indent = level;
          }
          return pad.repeat(indent) + node;
        });

        return { formatted: lines.join('\n') };
      } catch (e) {
        return { error: 'XML format error: ' + e.message };
      }
    });

    // Built-in: password generator
    this.registerHandler('builtin_password', async (params) => {
      const length = Math.min(Math.max(parseInt(params.length) || 16, 1), 4096);

      const sets = {
        lowercase: 'abcdefghijklmnopqrstuvwxyz',
        uppercase: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        digits: '0123456789',
        symbols: '!@#$%^&*()-_=+[]{};:,.<>?/|~',
      };

      // По умолчанию включены буквы и цифры, если ничего не указано
      const useLower = params.lowercase !== false;
      const useUpper = params.uppercase !== false;
      const useDigits = params.digits !== false;
      const useSymbols = params.symbols === true;

      let pool = '';
      const required = [];
      if (useLower)   { pool += sets.lowercase; required.push(sets.lowercase); }
      if (useUpper)   { pool += sets.uppercase; required.push(sets.uppercase); }
      if (useDigits)  { pool += sets.digits;    required.push(sets.digits); }
      if (useSymbols) { pool += sets.symbols;   required.push(sets.symbols); }

      // Исключение неоднозначных символов (0/O/1/l/I)
      if (params.exclude_ambiguous === true) {
        const ambiguous = /[0O1lI|]/g;
        pool = pool.replace(ambiguous, '');
      }

      if (!pool) {
        return { error: 'Не выбран ни один набор символов' };
      }

      const rand = (max) => {
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        return buf[0] % max;
      };

      const chars = [];
      // Гарантируем хотя бы один символ из каждого выбранного набора
      for (const set of required) {
        const filtered = params.exclude_ambiguous === true
          ? set.replace(/[0O1lI|]/g, '')
          : set;
        if (filtered.length && chars.length < length) {
          chars.push(filtered[rand(filtered.length)]);
        }
      }
      while (chars.length < length) {
        chars.push(pool[rand(pool.length)]);
      }
      // Перемешиваем (Fisher-Yates)
      for (let i = chars.length - 1; i > 0; i--) {
        const j = rand(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
      }

      const password = chars.slice(0, length).join('');
      return { password, length: password.length };
    });

    // Built-in: ask user a question (красивый модальный диалог, с fallback на prompt)
    this.registerHandler('builtin_ask_user', async (params) => {
      const question = String(params.question || 'Введите ответ:');
      const defaultVal = params.default || '';

      if (this.ui && typeof this.ui.askUser === 'function') {
        return await this.ui.askUser(question, defaultVal);
      }

      // Fallback, если UI не подключён к движку
      const answer = window.prompt(question, defaultVal);
      return answer === null
        ? { answered: false, answer: null }
        : { answered: true, answer };
    });
    // Built-in: create_tool — LLM создаёт новый tool для tools-engine
    this.registerHandler('builtin_create_tool', async (params) => {
      try {
        const name = String(params.name || '').trim();
        const description = String(params.description || '').trim();
        const handlerCode = String(params.handlerCode || '');
        const parameters = params.parameters || { type: 'object', properties: {}, required: [] };

        // 1. Валидация имени (совместимо с function.name в API)
        if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(name)) {
          return { error: 'Некорректное имя: разрешены [a-zA-Z0-9_], начало не с цифры, до 64 символов' };
        }
        if (!description) return { error: 'Требуется непустое description' };

        // 2. Валидация JSON-схемы параметров
        if (typeof parameters !== 'object' || parameters.type !== 'object' || typeof parameters.properties !== 'object') {
          return { error: 'parameters должен быть JSON Schema вида { type:"object", properties:{...}, required:[...] }' };
        }

        // 3. Проверка, что handlerCode компилируется (тело функции с доступом только к params)
        let fn;
        try {
          fn = new Function('params', handlerCode);
        } catch (e) {
          return { error: 'Синтаксическая ошибка в handlerCode: ' + e.message };
        }

        // 4. Запрет дублей по name
        const existing = await this.db.getAll('tools');
        if (existing.some(t => t.name === name)) {
          return { error: 'Tool с именем "' + name + '" уже существует' };
        }

        // 5. Сухой прогон (best-effort): не должен бросать синхронно на пустом вводе
        try { await fn({}); } catch (_) { /* ошибки рантайма на пустом вводе допустимы */ }

        // 6. Сохранение в БД в формате, который понимает executeTool()
        const def = {
          id: 'custom_' + name + '_' + Date.now(),
          name,
          description,
          parameters,
          handlerCode,       // ← исполняется через new Function('params', handlerCode)
          enabled: params.enabled !== false,
          builtin: false,
        };
        await this.db.put('tools', def);

        return { success: true, id: def.id, name: def.name, enabled: def.enabled };
      } catch (e) {
        return { error: e.message };
      }
    });
  }

  registerHandler(toolId, handler) {
    if (!this.registry.has(toolId)) {
      this.registry.set(toolId, { handler });
    } else {
      this.registry.get(toolId).handler = handler;
    }
  }

  _builtinDefs() {
	    return [
	      {
	        id: 'builtin_time',
	        name: 'get_current_time',
	        description: 'Возвращает текущие дату и время с часовым поясом',
	        parameters: { type: 'object', properties: {}, required: [] },
	        enabled: true,
	        builtin: true,
	      },
	      {
	        id: 'builtin_calc',
	        name: 'calculator',
	        description: 'Вычисляет математическое выражение',
	        parameters: {
	          type: 'object',
	          properties: { expression: { type: 'string', description: 'Математическое выражение, например 2+2*3' } },
	          required: ['expression'],
	        },
	        enabled: true,
	        builtin: true,
	      },
	      {
	        id: 'builtin_memory',
	        name: 'persistent_memory',
	        description: 'Читает/записывает данные в персистентную память агента. Actions: read, write, list',
	        parameters: {
	          type: 'object',
	          properties: {
	            action: { type: 'string', enum: ['read', 'write', 'list'] },
	            key: { type: 'string', description: 'ключ для чтения/записи' },
	            value: { description: 'значение для записи (любой тип)' },
	          },
	          required: ['action'],
	        },
	        enabled: true,
	        builtin: true,
	      },
	      {
	        id: 'builtin_fetch',
	        name: 'http_fetch',
	        description: 'Выполняет HTTP-запрос к указанному URL (ограничено CORS)',
	        parameters: {
	          type: 'object',
	          properties: {
	            url: { type: 'string', description: 'URL для запроса' },
	            method: { type: 'string', enum: ['GET', 'POST'], description: 'HTTP метод' },
	          },
	          required: ['url'],
	        },
	        enabled: true,
	        builtin: true,
	      },
	      {
	        id: 'builtin_json_format',
	        name: 'format_json',
	        description: 'Форматирует (prettify) JSON-строку или объект с заданным отступом',
	        parameters: {
	          type: 'object',
	          properties: {
	            json: { type: 'string', description: 'JSON-строка или объект для форматирования' },
	            indent: { type: 'number', description: 'Размер отступа в пробелах (по умолчанию 2)' },
	            sort_keys: { type: 'boolean', description: 'Сортировать ключи по алфавиту' },
	          },
	          required: ['json'],
	        },
	        enabled: true,
	        builtin: true,
	      },
	      {
	        id: 'builtin_xml_format',
	        name: 'format_xml',
	        description: 'Форматирует (prettify) XML-строку с отступами и проверкой валидности',
	        parameters: {
	          type: 'object',
	          properties: {
	            xml: { type: 'string', description: 'XML-строка для форматирования' },
	            indent: { type: 'number', description: 'Размер отступа в пробелах (по умолчанию 2)' },
	          },
	          required: ['xml'],
	        },
	        enabled: true,
	        builtin: true,
	      },
	      {
	        id: 'builtin_password',
	        name: 'generate_password',
	        description: 'Генерирует криптостойкий случайный пароль заданной длины с управлением набором символов',
	        parameters: {
	          type: 'object',
	          properties: {
	            length: { type: 'number', description: 'Длина пароля (по умолчанию 16)' },
	            lowercase: { type: 'boolean', description: 'Включать строчные буквы (по умолчанию true)' },
	            uppercase: { type: 'boolean', description: 'Включать заглавные буквы (по умолчанию true)' },
	            digits: { type: 'boolean', description: 'Включать цифры (по умолчанию true)' },
	            symbols: { type: 'boolean', description: 'Включать спецсимволы (по умолчанию false)' },
	            exclude_ambiguous: { type: 'boolean', description: 'Исключить неоднозначные символы (0 O 1 l I |)' },
	          },
	          required: ['length'],
	        },
	        enabled: true,
	        builtin: true,
	      },
	      {
	        id: 'builtin_ask_user',
	        name: 'ask_user',
	        description: 'Задаёт вопрос пользователю и возвращает его ответ. Используй, когда нужна информация, которой нет в диалоге',
	        parameters: {
	          type: 'object',
	          properties: {
	            question: { type: 'string', description: 'Текст вопроса пользователю' },
	            default: { type: 'string', description: 'Значение по умолчанию (опционально)' },
	          },
	          required: ['question'],
	        },
	        enabled: false,
	        builtin: true,
	      },
	      {
	          id: 'builtin_create_tool',
	          name: 'create_tool',
	          description: 'Создаёт и регистрирует новый инструмент в tools-engine. ' +
	            'Передай name (snake_case), description, parameters (JSON Schema с type:"object") ' +
	            'и handlerCode — ТЕЛО JS-функции, которая получает объект params и возвращает результат ' +
	            '(можно async, доступен только аргумент params, никаких this/db/import). ' +
	            'Результат — обычный объект; при ошибке верни { error: "..." }.',
	          parameters: {
	            type: 'object',
	            properties: {
	              name: { type: 'string', description: 'Имя функции, ^[a-zA-Z_][a-zA-Z0-9_]*$, напр. slugify_text' },
	              description: { type: 'string', description: 'Что делает инструмент и когда его вызывать' },
	              parameters: {
	                type: 'object',
	                description: 'JSON Schema входных параметров: { type:"object", properties:{...}, required:[...] }',
	              },
	              handlerCode: {
	                type: 'string',
	                description: 'Тело JS-функции. Пример: "return { result: params.a + params.b };"',
	              },
	              enabled: { type: 'boolean', description: 'Включить сразу (по умолчанию true)' },
	            },
	            required: ['name', 'description', 'parameters', 'handlerCode'],
	          },
	          enabled: true,
	          builtin: true,
	        },
	    ];
	  }

	  async loadTools() {
	    const existing = await this.db.getAll('tools');
	    const existingIds = new Set(existing.map(t => t.id));

	    // Досеиваем встроенные tools, которых ещё нет в базе
	    const missing = this._builtinDefs().filter(def => !existingIds.has(def.id));
	    for (const def of missing) {
	      await this.db.put('tools', def);
	    }

	    return missing.length ? await this.db.getAll('tools') : existing;
	  }

  async getEnabledToolsForAPI() {
    const tools = await this.loadTools();
    return tools
      .filter(t => t.enabled)
      .map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
  }

  async executeTool(toolName, args) {
	    var parsedArgs;
	    try {
	      parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
	    } catch (e) {
	      parsedArgs = args;
	    }

	    console.group('%c🔧 TOOL CALL', 'color:#f39c12;font-weight:bold;font-size:13px;');
	    console.log('%cTool:', 'color:#888;', toolName);
	    console.log('%cArguments:', 'color:#888;');
	    console.dir(parsedArgs);
	    console.log('%cTimestamp:', 'color:#888;', new Date().toISOString());
	    var t0 = performance.now();

	    var result;

	    try {
	      const tools = await this.loadTools();
	      const tool = tools.find(function (t) { return t.name === toolName; });

	      if (!tool) {
	        result = { error: 'Tool "' + toolName + '" not found' };
	      } else if (tool.handlerCode) {
	        // ← ИСТОЧНИК ИСТИНЫ: персистентный код редактируемого инструмента.
	        //   Компилируется заново на каждый вызов из актуальной записи в БД,
	        //   поэтому правки из UI применяются сразу, без перезагрузки страницы.
	        try {
	          const fn = new Function('params', tool.handlerCode);
	          result = await fn(parsedArgs);
	        } catch (e) {
	          result = { error: 'Execution error: ' + e.message };
	        }
	      } else {
	        // Нет собственного кода → нативный обработчик из реестра
	        // (встроенные инструменты и MCP).
	        const entry = this.registry.get(tool.id);
	        if (entry && entry.handler) {
	          try {
	            result = await entry.handler(parsedArgs);
	          } catch (e) {
	            result = { error: e.message };
	          }
	        } else {
	          result = { error: 'No handler registered for tool "' + toolName + '"' };
	        }
	      }
	    } catch (e) {
	      result = { error: 'Tool engine error: ' + e.message };
	      console.error('%c🔧 TOOL ENGINE ERROR', 'color:red;font-weight:bold', e);
	    } finally {
	      var elapsed = (performance.now() - t0).toFixed(0);
	      if (result && result.error) {
	        console.log('%c❌ Error:', 'color:#e74c3c;');
	      } else {
	        console.log('%c✅ Result:', 'color:#00b894;');
	      }
	      console.dir(result);
	      console.log('%cElapsed:', 'color:#888;', elapsed + 'ms');
	      console.groupEnd();
	    }

	    return result;
	  }
  
  unregisterHandler(toolId) {
	    this.registry.delete(toolId);
  }
  /*
  async executeTool(toolName, args) {
	    var parsedArgs;
	    try {
	      parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
	    } catch(e) {
	      parsedArgs = args;
	    }

	    console.group('%c🔧 TOOL CALL', 'color:#f39c12;font-weight:bold;font-size:13px;');
	    console.log('%cTool:', 'color:#888;', toolName);
	    console.log('%cArguments:', 'color:#888;');
	    console.dir(parsedArgs);
	    console.log('%cTimestamp:', 'color:#888;', new Date().toISOString());
	    var t0 = performance.now();

	    var result;

	    try {                                         // ← ДОБАВЛЕН try
	      const tools = await this.loadTools();
	      const tool = tools.find(function(t) { return t.name === toolName; });

	      if (!tool) {
	        result = { error: 'Tool "' + toolName + '" not found' };
	      } else {
	        const entry = this.registry.get(tool.id);

	        if (entry && entry.handler) {
	          try {
	            result = await entry.handler(parsedArgs);
	          } catch (e) {
	            result = { error: e.message };
	          }
	        } else if (tool.handlerCode) {
	          try {
	            const fn = new Function('params', tool.handlerCode);
	            result = await fn(parsedArgs);
	          } catch (e) {
	            result = { error: 'Execution error: ' + e.message };
	          }
	        } else {
	          result = { error: 'No handler registered for tool "' + toolName + '"' };
	        }
	      }
	    } catch (e) {                                 // ← ДОБАВЛЕН catch
	      result = { error: 'Tool engine error: ' + e.message };
	      console.error('%c🔧 TOOL ENGINE ERROR', 'color:red;font-weight:bold', e);
	    } finally {                                   // ← ДОБАВЛЕН finally
	      var elapsed = (performance.now() - t0).toFixed(0);

	      // ← ИСПРАВЛЕНО: ошибки теперь логируются с ❌, а не с ✅
	      if (result && result.error) {
	        console.log('%c❌ Error:', 'color:#e74c3c;');
	      } else {
	        console.log('%c✅ Result:', 'color:#00b894;');
	      }
	      console.dir(result);
	      console.log('%cElapsed:', 'color:#888;', elapsed + 'ms');
	      console.groupEnd();                         // ← гарантированно закрывается
	    }

	    return result;
	  }
	  */
}