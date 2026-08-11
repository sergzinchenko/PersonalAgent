// Конструктор асинхронных функций. Обычный `new Function(...)` создаёт
// СИНХРОННУЮ функцию, внутри которой `await` — синтаксическая ошибка
// («await is only valid in async functions»). При этом инструменты почти
// всегда асинхронные (fetch, Notification.requestPermission, любые Web API
// на промисах), и системный промпт для LLM явно разрешает async. Компилируя
// через AsyncFunction, мы делаем тело handlerCode телом async-функции:
// `await` работает без обёрток, а `return` отдаёт значение как обычно.
// Синхронный код при этом продолжает работать без изменений — вызывающая
// сторона в любом случае делает await над результатом.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// ============================================================
//  TOOLS ENGINE — MCP-compatible tool system
// ============================================================
class ToolsEngine {
  constructor(db) {
    this.db = db;
    this.ui = null;            // ← ссылка на UI устанавливается извне
    this.folders = null;       // ← ссылка на FoldersEngine устанавливается извне (см. agent.js)
    this.registry = new Map();
    // Подробное логирование каждого tool-вызова (аргументы, результат) в
    // консоль. По умолчанию выключено — раньше писалось безусловно и могло
    // содержать чувствительные данные из аргументов/результатов инструментов.
    // Включить для отладки: agent.tools.debug = true (в DevTools console).
    this.debug = false;
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
        const urlStr = String(params.url || '').trim();
        let u;
        try {
          u = new URL(urlStr);
        } catch (e) {
          return { error: 'Некорректный URL' };
        }

        if (!/^https?:$/.test(u.protocol)) {
          return { error: 'Разрешены только http/https URL' };
        }
        if (this._isBlockedFetchHost(u.hostname)) {
          return { error: 'Запрос к локальным/приватным/служебным адресам запрещён из соображений безопасности' };
        }

        const method = String(params.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'POST') {
          return { error: 'Метод должен быть GET или POST' };
        }

        const resp = await fetch(u.toString(), { method });
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

	    // ═══════════ УПРАВЛЕНИЕ ПАПКАМИ ═══════════

    this.registerHandler('builtin_create_folder', async (params) => {
      try {
        if (!this.folders) return { error: 'FoldersEngine не подключён к ToolsEngine (this.folders)' };
        const kind = String(params.kind || '').toLowerCase();
        if (!['tool', 'skill', 'prompt'].includes(kind)) return { error: 'kind должен быть tool|skill|prompt' };
        const name = String(params.name || '').trim();
        if (!name) return { error: 'Требуется name' };
        const type = kind + 's';
        const parentId = await this._resolveFolderId(type, params.parent, { createMissing: true });
        // Саму запись создаёт FoldersEngine — единая точка правды для формата
        // папки (id/createdAt и т.д.), без дублирования здесь.
        const folder = await this.folders.create(type, name, parentId);
        this._refreshUI(type);
        return { success: true, id: folder.id, name: folder.name, parentId: folder.parentId };
      } catch (e) { return { error: e.message }; }
    });

    this.registerHandler('builtin_rename_folder', async (params) => {
      try {
        if (!this.folders) return { error: 'FoldersEngine не подключён к ToolsEngine (this.folders)' };
        const type = String(params.kind || '').toLowerCase() + 's';
        const id = await this._resolveFolderId(type, params.folder);
        if (!id) return { error: 'Папка не найдена' };
        await this.folders.rename(id, params.name);
        const f = await this.db.get('folders', id);
        this._refreshUI(type);
        return { success: true, id, name: f.name };
      } catch (e) { return { error: e.message }; }
    });

    this.registerHandler('builtin_move_folder', async (params) => {
      try {
        if (!this.folders) return { error: 'FoldersEngine не подключён к ToolsEngine (this.folders)' };
        const type = String(params.kind || '').toLowerCase() + 's';
        const id = await this._resolveFolderId(type, params.folder);
        if (!id) return { error: 'Папка не найдена' };
        const target = await this._resolveFolderId(type, params.to, { createMissing: true });
        if (id === target) return { error: 'Нельзя переместить папку в саму себя' };

        // FoldersEngine.move() уже содержит защиту от циклов (нельзя вложить
        // папку в саму себя/потомка) — она просто тихо не применит изменение
        // в этом случае, поэтому сверяем parentId до/после, чтобы вернуть
        // модели понятную ошибку вместо молчаливого "success" без эффекта.
        await this.folders.move(id, target);
        const after = await this.db.get('folders', id);
        if ((after.parentId || null) !== (target || null)) {
          return { error: 'Нельзя переместить папку в свою подпапку (цикл)' };
        }

        this._refreshUI(type);
        return { success: true, id, parentId: after.parentId };
      } catch (e) { return { error: e.message }; }
    });

    this.registerHandler('builtin_delete_folder', async (params) => {
      try {
        if (!this.folders) return { error: 'FoldersEngine не подключён к ToolsEngine (this.folders)' };

        const type = String(params.kind || '').toLowerCase() + 's';
        const id = await this._resolveFolderId(type, params.folder);
        if (!id) return { error: 'Папка не найдена' };

        // Считаем "до", чтобы вернуть модели информативный ответ —
        // саму мутацию делаем через FoldersEngine.remove(), которая уже
        // содержит эту же логику (поднять подпапки/элементы на уровень
        // выше, затем удалить папку). Раньше здесь была дублирующая копия
        // этой логики "инлайном".
        const subsCount = (await this.db.getAll('folders')).filter(f => f.parentId === id).length;
        const itemsCount = (await this.db.getAll(type)).filter(it => (it.parentId || null) === id).length;

        await this.folders.remove(id, type);
        this._refreshUI(type);
        return { success: true, deleted: id, movedSubfolders: subsCount, movedItems: itemsCount };
      } catch (e) { return { error: e.message }; }
    });

    // ═══════════ ПЕРЕМЕЩЕНИЕ ЭЛЕМЕНТОВ ═══════════

    this.registerHandler('builtin_move_item', async (params) => {
      try {
        const kind = String(params.kind || '').toLowerCase();
        if (!['tool', 'skill', 'prompt'].includes(kind)) return { error: 'kind должен быть tool|skill|prompt' };
        const type = kind + 's';
        const items = await this.db.getAll(type);
        let item = params.id ? items.find(i => i.id === params.id) : null;
        if (!item && params.name) item = items.find(i => (i.name || i.title) === params.name);
        if (!item) return { error: 'Элемент не найден (укажите id или точное name/title)' };
        const target = await this._resolveFolderId(type, params.to, { createMissing: true });
        item.parentId = target || null;
        await this.db.put(type, item);
        this._refreshUI(type);
        return { success: true, id: item.id, parentId: item.parentId };
      } catch (e) { return { error: e.message }; }
    });

    // ═══════════ SKILLS ═══════════

    this.registerHandler('builtin_create_skill', async (params) => {
      try {
        const name = String(params.name || '').trim();
        if (!name) return { error: 'Требуется name' };
        const parentId = await this._resolveFolderId('skills', params.folder, { createMissing: true });
        const def = {
          id: 'skill_' + uid(),
          name,
          description: String(params.description || '').trim(),
          systemPrompt: String(params.systemPrompt || '').trim(),
          icon: params.icon || '🤖',
          category: params.category || 'custom',
          enabled: params.enabled !== false,
          parentId: parentId || null,
        };
        await this.db.put('skills', def);
        this._refreshUI('skills');
        return { success: true, id: def.id, name: def.name };
      } catch (e) { return { error: e.message }; }
    });

    this.registerHandler('builtin_update_skill', async (params) => {
      try {
        const skills = await this.db.getAll('skills');
        let skill = params.id ? skills.find(s => s.id === params.id) : skills.find(s => s.name === params.name);
        if (!skill) return { error: 'Skill не найден' };
        ['name', 'description', 'systemPrompt', 'icon', 'category'].forEach(k => { if (params[k] !== undefined) skill[k] = params[k]; });
        if (params.enabled !== undefined) skill.enabled = !!params.enabled;
        if (params.folder !== undefined) skill.parentId = await this._resolveFolderId('skills', params.folder, { createMissing: true });
        await this.db.put('skills', skill);
        this._refreshUI('skills');
        return { success: true, id: skill.id };
      } catch (e) { return { error: e.message }; }
    });

    // ═══════════ PROMPTS ═══════════

    this.registerHandler('builtin_create_prompt', async (params) => {
      try {
        const title = String(params.title || '').trim();
        if (!title) return { error: 'Требуется title' };
        const content = String(params.content || '');
        const variables = [...new Set((content.match(/\{\{(\w+)\}\}/g) || []).map(v => v.replace(/\{\{|\}\}/g, '')))];
        const parentId = await this._resolveFolderId('prompts', params.folder, { createMissing: true });
        const def = {
          id: 'p_' + uid(),
          title, content,
          category: params.category || 'custom',
          tags: Array.isArray(params.tags) ? params.tags
              : (params.tags ? String(params.tags).split(',').map(s => s.trim()).filter(Boolean) : []),
          variables,
          createdAt: Date.now(),
          parentId: parentId || null,
        };
        await this.db.put('prompts', def);
        this._refreshUI('prompts');
        return { success: true, id: def.id, title: def.title, variables };
      } catch (e) { return { error: e.message }; }
    });

    this.registerHandler('builtin_update_prompt', async (params) => {
      try {
        const prompts = await this.db.getAll('prompts');
        let p = params.id ? prompts.find(x => x.id === params.id) : prompts.find(x => x.title === params.title);
        if (!p) return { error: 'Prompt не найден' };
        if (params.title !== undefined) p.title = params.title;
        if (params.category !== undefined) p.category = params.category;
        if (params.tags !== undefined) p.tags = Array.isArray(params.tags) ? params.tags : String(params.tags).split(',').map(s => s.trim()).filter(Boolean);
        if (params.content !== undefined) {
          p.content = params.content;
          p.variables = [...new Set((p.content.match(/\{\{(\w+)\}\}/g) || []).map(v => v.replace(/\{\{|\}\}/g, '')))];
        }
        if (params.folder !== undefined) p.parentId = await this._resolveFolderId('prompts', params.folder, { createMissing: true });
        await this.db.put('prompts', p);
        this._refreshUI('prompts');
        return { success: true, id: p.id };
      } catch (e) { return { error: e.message }; }
    });

    // ═══════════ TOOLS (редактирование; создание — через create_tool) ═══════════

    this.registerHandler('builtin_update_tool', async (params) => {
      try {
        const tools = await this.db.getAll('tools');
        let t = params.id ? tools.find(x => x.id === params.id) : tools.find(x => x.name === params.name);
        if (!t) return { error: 'Tool не найден' };

        if (params.newName !== undefined) {
          const nn = String(params.newName).trim();
          if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(nn)) return { error: 'newName некорректно' };
          if (tools.some(x => x.name === nn && x.id !== t.id)) return { error: 'Имя "' + nn + '" уже занято' };
          t.name = nn;
        }
        if (params.description !== undefined) t.description = String(params.description);
        if (params.parameters !== undefined) {
          const p = params.parameters;
          if (typeof p !== 'object' || p.type !== 'object' || typeof p.properties !== 'object')
            return { error: 'parameters должен быть JSON Schema { type:"object", properties:{...} }' };
          t.parameters = p;
        }
        let handlerChanged = false;
        if (params.handlerCode !== undefined) {
          if (t.builtin) return { error: 'Нельзя менять handlerCode встроенного инструмента' };
          try { new AsyncFunction('params', String(params.handlerCode)); }
          catch (e) { return { error: 'Ошибка в handlerCode: ' + e.message }; }
          t.handlerCode = String(params.handlerCode);
          handlerChanged = true;
        }

        // ─── Безопасность ───────────────────────────────────────────────
        // Если код инструмента изменился, он ПРИНУДИТЕЛЬНО выключается,
        // даже если в этом же вызове передали enabled:true. Изменённый
        // handlerCode — это новый, непроверенный код: разрешать модели
        // одним вызовом одновременно подменить логику И включить исполнение
        // означало бы, что она может незаметно (в т.ч. под влиянием
        // prompt injection из внешнего контента) превратить безобидный tool
        // во вредоносный и сразу же начать его использовать. Пользователь
        // должен вручную подтвердить это тумблером на вкладке Tools.
        if (handlerChanged) {
          t.enabled = false;
        } else if (params.enabled !== undefined) {
          t.enabled = !!params.enabled;
        }

        if (params.folder !== undefined) t.parentId = await this._resolveFolderId('tools', params.folder, { createMissing: true });

        await this.db.put('tools', t);
        if (handlerChanged) this.unregisterHandler(t.id);
        this._refreshUI('tools');
        return {
          success: true,
          id: t.id,
          name: t.name,
          enabled: t.enabled,
          needsUserConfirmation: handlerChanged,
          note: handlerChanged
            ? 'Код инструмента изменён, поэтому он выключен. Сообщи пользователю, что нужно включить его вручную на вкладке Tools после проверки.'
            : undefined,
        };
      } catch (e) { return { error: e.message }; }
    });

    // ═══════════ ИНСПЕКЦИЯ ═══════════

    this.registerHandler('builtin_list_workspace', async (params) => {
      try {
        const kinds = params.kind ? [String(params.kind).toLowerCase()] : ['tool', 'skill', 'prompt'];
        const out = {};
        for (const kind of kinds) {
          const type = kind + 's';
          const folders = (await this.db.getAll('folders'))
            .filter(f => f.type === type)
            .map(f => ({ id: f.id, name: f.name, parentId: f.parentId || null }));
          const items = (await this.db.getAll(type)).map(it => ({
            id: it.id, name: it.name || it.title,
            enabled: it.enabled, builtin: !!it.builtin, parentId: it.parentId || null,
          }));
          out[type] = { folders, items };
        }
        return out;
      } catch (e) { return { error: e.message }; }
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

        // 3. Проверка, что handlerCode КОМПИЛИРУЕТСЯ (только статическая
        //    проверка синтаксиса). Раньше здесь ещё и реально исполнялся
        //    fn({}) «сухим прогоном» — то есть непроверенный, потенциально
        //    сгенерированный под влиянием prompt injection код выполнялся
        //    автоматически уже на этапе создания, ещё до какого-либо
        //    подтверждения пользователем. Сейчас мы только проверяем, что
        //    код синтаксически валиден, и не запускаем его.
        try {
          new AsyncFunction('params', handlerCode);
        } catch (e) {
          return { error: 'Синтаксическая ошибка в handlerCode: ' + e.message };
        }

        // 4. Запрет дублей по name
        const existing = await this.db.getAll('tools');
        if (existing.some(t => t.name === name)) {
          return { error: 'Tool с именем "' + name + '" уже существует' };
        }

        // ─── Безопасность ───────────────────────────────────────────────
        // 5. Новый LLM-созданный инструмент ВСЕГДА сохраняется выключенным,
        // независимо от того, что просит params.enabled. getEnabledToolsForAPI()
        // отдаёт модели только enabled:true инструменты — значит, только что
        // созданный tool не будет доступен для вызова, пока пользователь сам
        // не включит его тумблером на вкладке Tools, ознакомившись с кодом.
        // Это ключевой барьер против сценария, где модель (например, под
        // влиянием враждебного контента, полученного через http_fetch)
        // создаёт tool и в том же диалоге начинает его использовать.
        const def = {
          id: 'custom_' + name + '_' + Date.now(),
          name,
          description,
          parameters,
          handlerCode,       // ← исполняется через new AsyncFunction('params', handlerCode)
          enabled: false,
          builtin: false,
        };
        await this.db.put('tools', def);
        this._refreshUI('tools');

        return {
          success: true,
          id: def.id,
          name: def.name,
          enabled: false,
          needsUserConfirmation: true,
          note: 'Инструмент создан, но выключен по умолчанию из соображений безопасности. Сообщи пользователю, что нужно проверить код и включить его вручную на вкладке Tools, прежде чем им можно будет пользоваться.',
        };
      } catch (e) {
        return { error: e.message };
      }
    });
  }

// ─── ХЕЛПЕР БЕЗОПАСНОСТИ: SSRF-защита для http_fetch ───
//
// Ограничивает http_fetch от обращений к локальным/приватным сетям —
// иначе LLM (в том числе под влиянием prompt injection из ранее
// полученного контента) могла бы дёргать внутренние сервисы пользователя
// (роутер, локальные dev-сервера) или облачные metadata-эндпоинты
// (169.254.169.254), которые часто не защищены аутентификацией.
// ВАЖНО: это защита только по имени хоста/литералу IP из URL, видимому в
// JS. Она НЕ защищает от DNS rebinding (домен, который резолвится в
// приватный IP уже во время самого fetch) — браузер не даёт JS
// разрешить имя в IP заранее. Для полной защиты такие запросы нужно
// проксировать через контролируемый бэкенд с проверкой на этапе
// установления соединения.
_isBlockedFetchHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');

  if (!h || h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }

  // IPv6: loopback (::1), link-local (fe80::/10), unique-local (fc00::/7)
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) {
    return true;
  }

  // IPv4 литерал
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    if (a === 127) return true;                        // loopback
    if (a === 10) return true;                          // private (RFC1918)
    if (a === 172 && b >= 16 && b <= 31) return true;    // private (RFC1918)
    if (a === 192 && b === 168) return true;             // private (RFC1918)
    if (a === 169 && b === 254) return true;             // link-local, включая cloud metadata (169.254.169.254)
    if (a === 0) return true;                             // "эта сеть"
  }

  return false;
}

// ─── ХЕЛПЕРЫ ДЛЯ УПРАВЛЕНИЯ ИЕРАРХИЕЙ ───

	async _allFolders(type) {
		// Делегируем в FoldersEngine — единственный источник правды для
		// списка папок. Фоллбэк на прямой запрос к db оставлен на случай,
		// если this.folders почему-то не подключён (см. agent.js).
		if (this.folders) return this.folders.all(type);
		const all = await this.db.getAll('folders');
		return all.filter(f => f.type === type);
	}

	// ref: id папки | путь "A/B/C" | имя | пусто(null) = корень.
	// createMissing=true — недостающие сегменты пути создаются.
	async _resolveFolderId(type, ref, { createMissing = false } = {}) {
		if (ref === undefined || ref === null || ref === '') return null;
		const folders = await this._allFolders(type);

		const byId = folders.find(f => f.id === ref);
		if (byId) return byId.id;

		const segs = String(ref).split('/').map(s => s.trim()).filter(Boolean);
		let parentId = null, current = null;
		for (const seg of segs) {
		let found = folders.find(f => (f.parentId || null) === parentId && f.name.toLowerCase() === seg.toLowerCase());
		if (!found) {
			if (!createMissing) return null;
			found = this.folders
				? await this.folders.create(type, seg, parentId)
				: await (async () => {
					const f = { id: 'folder_' + uid(), type, name: seg, parentId, createdAt: Date.now() };
					await this.db.put('folders', f);
					return f;
				})();
			folders.push(found);
		}
		parentId = found.id;
		current = found;
		}
		return current ? current.id : null;
	}

	_refreshUI(type) {
		const ui = this.ui;
		if (!ui) return;
		try {
		ui.refreshSidebar && ui.refreshSidebar();
		if (type === 'tools') ui.renderTools && ui.renderTools();
		else if (type === 'skills') { ui.renderSkills && ui.renderSkills(); ui.updateChatToolbar && ui.updateChatToolbar(); }
		else if (type === 'prompts') ui.renderPrompts && ui.renderPrompts();
		} catch (_) {}
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
	        description: 'Выполняет HTTP-запрос к указанному URL (ограничено CORS). Из соображений безопасности ' +
	          'запрещены не-http(s) протоколы и запросы к localhost/приватным сетям/cloud-metadata адресам.',
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
	            'Результат — обычный объект; при ошибке верни { error: "..." }. ' +
	            'ВАЖНО: инструмент ВСЕГДА создаётся выключенным (enabled:false) — это осознанное ' +
	            'ограничение безопасности, обойти его нельзя. Он не станет доступен для вызова, ' +
	            'пока пользователь сам не включит его тумблером на вкладке Tools. После создания ' +
	            'обязательно сообщи пользователю, что нужно проверить код и включить инструмент вручную.',
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
	                description: 'Тело JS-функции, выполняется как тело ASYNC-функции — await можно использовать напрямую на верхнем уровне. Пример: "const r = await fetch(params.url); return { status: r.status };"',
	              },
	              enabled: { type: 'boolean', description: 'Игнорируется: новый инструмент всегда создаётся выключенным до подтверждения пользователем.' },
	            },
	            required: ['name', 'description', 'parameters', 'handlerCode'],
	          },
	          enabled: true,
	          builtin: true,
	        },
				      {
	        id: 'builtin_list_workspace',
	        name: 'list_workspace',
	        description: 'Возвращает списки папок и объектов (tools/skills/prompts) с их id, name и parentId. ' +
	          'Вызывай ПЕРЕД изменением/перемещением, чтобы узнать актуальные id.',
	        parameters: {
	          type: 'object',
	          properties: {
	            kind: { type: 'string', enum: ['tool', 'skill', 'prompt'], description: 'Ограничить одним типом (опционально)' },
	          },
	          required: [],
	        },
	        enabled: true, builtin: true,
	      },
	      {
	        id: 'builtin_create_folder',
	        name: 'create_folder',
	        description: 'Создаёт папку для tools/skills/prompts.',
	        parameters: {
	          type: 'object',
	          properties: {
	            kind: { type: 'string', enum: ['tool', 'skill', 'prompt'], description: 'Тип раздела' },
	            name: { type: 'string', description: 'Название папки' },
	            parent: { type: 'string', description: 'Родитель: id папки или путь "A/B". Пусто = корень. Недостающие папки пути создаются.' },
	          },
	          required: ['kind', 'name'],
	        },
	        enabled: true, builtin: true,
	      },
	      {
	        id: 'builtin_rename_folder',
	        name: 'rename_folder',
	        description: 'Переименовывает папку.',
	        parameters: {
	          type: 'object',
	          properties: {
	            kind: { type: 'string', enum: ['tool', 'skill', 'prompt'] },
	            folder: { type: 'string', description: 'id папки или путь "A/B"' },
	            name: { type: 'string', description: 'Новое название' },
	          },
	          required: ['kind', 'folder', 'name'],
	        },
	        enabled: true, builtin: true,
	      },
	      {
	        id: 'builtin_move_folder',
	        name: 'move_folder',
	        description: 'Перемещает папку внутрь другой папки (или в корень). Защита от циклов.',
	        parameters: {
	          type: 'object',
	          properties: {
	            kind: { type: 'string', enum: ['tool', 'skill', 'prompt'] },
	            folder: { type: 'string', description: 'Перемещаемая папка: id или путь' },
	            to: { type: 'string', description: 'Целевой родитель: id/путь. Пусто = корень.' },
	          },
	          required: ['kind', 'folder'],
	        },
	        enabled: true, builtin: true,
	      },
	      {
	        id: 'builtin_delete_folder',
	        name: 'delete_folder',
	        description: 'Удаляет папку. Вложенные подпапки и элементы поднимаются на уровень выше (не удаляются).',
	        parameters: {
	          type: 'object',
	          properties: {
	            kind: { type: 'string', enum: ['tool', 'skill', 'prompt'] },
	            folder: { type: 'string', description: 'id папки или путь' },
	          },
	          required: ['kind', 'folder'],
	        },
	        enabled: false, builtin: true,
	      },
	      {
	        id: 'builtin_move_item',
	        name: 'move_item',
	        description: 'Перемещает объект (tool/skill/prompt) в указанную папку или в корень.',
	        parameters: {
	          type: 'object',
	          properties: {
	            kind: { type: 'string', enum: ['tool', 'skill', 'prompt'] },
	            id: { type: 'string', description: 'id объекта (предпочтительно)' },
	            name: { type: 'string', description: 'Или точное name/title объекта' },
	            to: { type: 'string', description: 'Папка назначения: id/путь. Пусто = корень.' },
	          },
	          required: ['kind'],
	        },
	        enabled: true, builtin: true,
	      },
	      {
	        id: 'builtin_create_skill',
	        name: 'create_skill',
	        description: 'Создаёт новый skill (навык с system prompt).',
	        parameters: {
	          type: 'object',
	          properties: {
	            name: { type: 'string' },
	            description: { type: 'string' },
	            systemPrompt: { type: 'string', description: 'Системный промпт навыка' },
	            icon: { type: 'string', description: 'Эмодзи-иконка (по умолчанию 🤖)' },
	            category: { type: 'string' },
	            enabled: { type: 'boolean', description: 'Включить навык сразу (по умолчанию false)' },
	            folder: { type: 'string', description: 'Папка: id/путь. Пусто = корень.' },
	          },
	          required: ['name', 'systemPrompt'],
	        },
	        enabled: true, builtin: true,
	      },
	      {
	        id: 'builtin_update_skill',
	        name: 'update_skill',
	        description: 'Изменяет существующий skill. Меняются только переданные поля.',
	        parameters: {
	          type: 'object',
	          properties: {
	            id: { type: 'string', description: 'id skill (предпочтительно)' },
	            name: { type: 'string', description: 'Новое имя, либо ключ поиска, если id не задан' },
	            description: { type: 'string' },
	            systemPrompt: { type: 'string' },
	            icon: { type: 'string' },
	            category: { type: 'string' },
	            enabled: { type: 'boolean' },
	            folder: { type: 'string', description: 'Переместить в папку: id/путь' },
	          },
	          required: [],
	        },
	        enabled: true, builtin: true,
	      },
	      {
	        id: 'builtin_create_prompt',
	        name: 'create_prompt',
	        description: 'Создаёт промпт. Переменные вида {{name}} извлекаются автоматически.',
	        parameters: {
	          type: 'object',
	          properties: {
	            title: { type: 'string' },
	            content: { type: 'string', description: 'Текст промпта, можно с {{переменными}}' },
	            category: { type: 'string' },
	            tags: { type: 'string', description: 'Теги через запятую' },
	            folder: { type: 'string', description: 'Папка: id/путь. Пусто = корень.' },
	          },
	          required: ['title', 'content'],
	        },
	        enabled: true, builtin: true,
	      },
	      {
	        id: 'builtin_update_prompt',
	        name: 'update_prompt',
	        description: 'Изменяет промпт. Меняются только переданные поля; переменные пересчитываются при смене content.',
	        parameters: {
	          type: 'object',
	          properties: {
	            id: { type: 'string', description: 'id промпта (предпочтительно)' },
	            title: { type: 'string' },
	            content: { type: 'string' },
	            category: { type: 'string' },
	            tags: { type: 'string', description: 'Теги через запятую' },
	            folder: { type: 'string', description: 'Переместить в папку: id/путь' },
	          },
	          required: [],
	        },
	        enabled: true, builtin: true,
	      },
	      {
	        id: 'builtin_update_tool',
	        name: 'update_tool',
	        description: 'Изменяет существующий tool: описание, parameters, handlerCode (только для кастомных), enabled, папку, имя. ' +
	          'Меняются только переданные поля. ВАЖНО: если в этом вызове передан handlerCode, инструмент ' +
	          'ПРИНУДИТЕЛЬНО выключается (даже если одновременно передан enabled:true) — это защита от ' +
	          'подмены кода с немедленным включением. После изменения кода сообщи пользователю, что нужно ' +
	          'проверить его и включить инструмент вручную на вкладке Tools.',
	        parameters: {
	          type: 'object',
	          properties: {
	            id: { type: 'string', description: 'id инструмента (предпочтительно)' },
	            name: { type: 'string', description: 'Или текущее имя для поиска' },
	            newName: { type: 'string', description: 'Новое имя (snake_case)' },
	            description: { type: 'string' },
	            parameters: { type: 'object', description: 'JSON Schema { type:"object", properties:{...} }' },
	            handlerCode: { type: 'string', description: 'Тело JS-функции (только для не-builtin). Выполняется как тело async-функции — await доступен напрямую.' },
	            enabled: { type: 'boolean' },
	            folder: { type: 'string', description: 'Переместить в папку: id/путь' },
	          },
	          required: [],
	        },
	        enabled: true, builtin: true,
	      },
	    ];
	  }

  // Регистрирует native-обработчик для MCP-инструмента (проксирует вызов на
  // внешний MCP-сервер через JSON-RPC tools/call). Используется и при первом
  // импорте с сервера (showAddMCPServerModal в ui.js), и при каждой загрузке
  // приложения в loadTools() — обработчики живут только в this.registry
  // (в памяти), а в БД для MCP-tool сохраняются только метаданные
  // (mcpServer/mcpToken), поэтому без повторной регистрации на старте
  // ранее импортированные MCP-инструменты «ломались» бы после релоада
  // страницы: executeTool() не находил бы для них обработчик.
  // ВАЖНО: toolRecord.mcpToken здесь ожидается уже РАСШИФРОВАННЫМ (обычная
  // строка) — в БД он хранится зашифрованным через SecretsVault, вызывающий
  // код (loadTools()/showAddMCPServerModal) отвечает за расшифровку/наличие
  // plaintext-значения до вызова этого метода.
  _registerMcpHandler(toolRecord) {
    const { id, name, mcpServer, mcpToken } = toolRecord;
    if (!mcpServer) return;
    this.registerHandler(id, async (params) => {
      const headers = { 'Content-Type': 'application/json' };
      if (mcpToken) headers['Authorization'] = 'Bearer ' + mcpToken;
      const resp = await fetch(mcpServer, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name, arguments: params },
          id: Date.now(),
        }),
      });
      const data = await resp.json();
      return data.result?.content?.[0]?.text || data.result || data;
    });
  }

	  async loadTools() {
	    const existing = await this.db.getAll('tools');
	    const existingIds = new Set(existing.map(t => t.id));

	    // Досеиваем встроенные tools, которых ещё нет в базе
	    const missing = this._builtinDefs().filter(def => !existingIds.has(def.id));
	    for (const def of missing) {
	      await this.db.put('tools', def);
	    }

	    const all = missing.length ? await this.db.getAll('tools') : existing;

	    // Восстанавливаем обработчики MCP-инструментов, не переживающие релоад (см. комментарий выше).
	    for (const t of all) {
	      if (t.mcpServer && !this.registry.has(t.id)) {
	        // mcpToken в БД хранится зашифрованным (SecretsVault) — расшифровываем
	        // перед тем, как передать в handler, который держит его в памяти
	        // в замыкании как обычную строку (нужен для заголовка Authorization).
	        const plainToken = await SecretsVault.decrypt(this.db, t.mcpToken);
	        this._registerMcpHandler({ ...t, mcpToken: plainToken });
	      }
	    }

	    return all;
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

  // timeoutMs — ограничение на выполнение ОДНОГО вызова инструмента.
  // Нужно, потому что handlerCode пишет LLM: бесконечный цикл или зависший
  // fetch внутри него иначе повесил бы всю цепочку ответа навсегда.
  // ВАЖНО: JS не умеет прерывать уже запущенный синхронный код — таймаут
  // отпускает ожидание и возвращает ошибку, но сам handler, если он завис
  // в синхронном цикле, продолжит занимать поток. Это ограничение среды;
  // полноценное прерывание требует исполнения в Worker с terminate().
  async executeTool(toolName, args, { timeoutMs = 0 } = {}) {
	    var parsedArgs;
	    try {
	      parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
	    } catch (e) {
	      parsedArgs = args;
	    }

	    if (this.debug) {
	    console.group('%c🔧 TOOL CALL', 'color:#f39c12;font-weight:bold;font-size:13px;');
	    console.log('%cTool:', 'color:#888;', toolName);
	    console.log('%cArguments:', 'color:#888;');
	    console.dir(parsedArgs);
	    console.log('%cTimestamp:', 'color:#888;', new Date().toISOString());
	    }
	    var t0 = performance.now();

	    var result;

	    // Обёртка гонки с таймаутом (см. комментарий к сигнатуре метода).
	    const withTimeout = (promise) => {
	      if (!timeoutMs || timeoutMs <= 0) return promise;
	      return Promise.race([
	        promise,
	        new Promise((resolve) => setTimeout(
	          () => resolve({ error: 'Timeout: инструмент не ответил за ' + timeoutMs + ' мс' }),
	          timeoutMs
	        )),
	      ]);
	    };

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
	          const fn = new AsyncFunction('params', tool.handlerCode);
	          result = await withTimeout(Promise.resolve(fn(parsedArgs)));
	        } catch (e) {
	          result = { error: 'Execution error: ' + e.message };
	        }
	      } else {
	        // Нет собственного кода → нативный обработчик из реестра
	        // (встроенные инструменты и MCP).
	        const entry = this.registry.get(tool.id);
	        if (entry && entry.handler) {
	          try {
	            result = await withTimeout(Promise.resolve(entry.handler(parsedArgs)));
	          } catch (e) {
	            result = { error: e.message };
	          }
	        } else {
	          result = { error: 'No handler registered for tool "' + toolName + '"' };
	        }
	      }
	    } catch (e) {
	      result = { error: 'Tool engine error: ' + e.message };
	      // Ошибку самого движка (не хендлера) логируем всегда, без this.debug —
	      // это внутренний сбой, а не рутинный tool-вызов, полезно видеть сразу.
	      console.error('🔧 TOOL ENGINE ERROR:', toolName, e);
	    } finally {
	      var elapsed = (performance.now() - t0).toFixed(0);
	      if (this.debug) {
	      if (result && result.error) {
	        console.log('%c❌ Error:', 'color:#e74c3c;');
	      } else {
	        console.log('%c✅ Result:', 'color:#00b894;');
	      }
	      console.dir(result);
	      console.log('%cElapsed:', 'color:#888;', elapsed + 'ms');
	      console.groupEnd();
	      }
	    }

	    return result;
	  }
  
  unregisterHandler(toolId) {
	    this.registry.delete(toolId);
  }
 
}