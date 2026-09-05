// ============================================================
//  TOOLS API IMPORT — комплекты «навык + инструменты» из описаний API
// ============================================================
//
// Три инструмента и один исполнитель:
//   api_import            — разобрать описание и собрать комплект;
//   api_bundle_configure  — открыть форму секрета (секрет вводит человек);
//   api_bundle_list       — что уже импортировано и в каком состоянии;
//   _executeApiCall       — выполнение импортированного вызова.
//
// Почему исполнитель здесь, а не в песочнице: импортированный инструмент —
// это описание запроса, а не код (см. engines/api-import-engine.js).
// Выполняет его само приложение, потому что только оно имеет право
// достать секрет из хранилища. Модель секрета не видит ни при импорте,
// ни при вызове.

ToolsEngine.HANDLER_CONTRIBUTORS.push(function registerApiImportHandlers() {

  // Достаёт текст описания: либо он передан целиком, либо его надо
  // скачать. Скачивание идёт по тем же правилам, что и http_fetch, —
  // адрес выбирает модель, и приватные сети закрыты.
  this._fetchApiSpec = async function (url, transport) {
    let u;
    try { u = new URL(String(url)); } catch (_) { return { error: 'Некорректный URL описания' }; }
    if (!/^https?:$/.test(u.protocol)) return { error: 'Разрешены только http/https' };

    if (transport === 'proxy') {
      const res = await this.executeTool('proxy_fetch',
        { url: u.toString(), method: 'GET' }, { bypassSecurity: true });
      if (res && res.error) return res;
      return { text: String(res.body || '') };
    }

    if (this._isBlockedFetchHost(u.hostname)) {
      return {
        error: 'Адрес локальный или приватный — прямой запрос запрещён.',
        hint: 'Для внутренних адресов используй transport: "proxy" (нужен запущенный локальный прокси).',
      };
    }
    try {
      const resp = await fetch(u.toString(), { headers: { Accept: 'application/json, text/xml, */*' } });
      if (!resp.ok) return { error: 'Описание не скачалось: HTTP ' + resp.status };
      return { text: await resp.text() };
    } catch (e) {
      return { error: 'Описание не скачалось: ' + (e && e.message || e) };
    }
  };


  this.registerHandler('builtin_api_import', async (params) => {
    const eng = this.apiImport;
    if (!eng) return { error: 'Импорт API недоступен' };
    if (!this.folders) return { error: 'Папки недоступны' };

    const p = params || {};
    const transport = p.transport === 'proxy' ? 'proxy' : 'direct';

    // ── Откуда описание ──
    let text = typeof p.source === 'string' ? p.source : '';
    if (!text && p.url) {
      const got = await this._fetchApiSpec(p.url, transport);
      if (got.error) return got;
      text = got.text;
    }
    if (!text) {
      return {
        error: 'Нужен источник описания: url или source (текст файла).',
        hint: 'Если файл лежит у пользователя — сначала прочитай его read_file и передай текст в source.',
      };
    }

    const spec = eng.parse(text, { format: p.format, baseUrl: p.baseUrl });
    if (spec.error) return spec;

    // ── Отбор операций ──
    // Крупное описание не надо (и нельзя) тащить в один комплект: и
    // контекст, и внимание пользователя не бесконечны. Фильтр и окно
    // существуют ровно для работы по частям — см. навык-импортёр.
    let list = spec.endpoints;
    const only = String(p.only || '').trim().toLowerCase();
    if (only) {
      list = list.filter(e =>
        (e.path || e.url || '').toLowerCase().includes(only) ||
        (e.name || '').toLowerCase().includes(only) ||
        (e.tags || []).some(t => String(t).toLowerCase().includes(only)));
    }
    const total = list.length;
    const offset = Math.max(0, parseInt(p.offset, 10) || 0);
    const limit = Math.min(ApiImportEngine.MAX_ENDPOINTS, Math.max(1, parseInt(p.limit, 10) || 25));
    const slice = list.slice(offset, offset + limit);

    const overview = {
      format: spec.format,
      formatLabel: ApiImportEngine.FORMATS[spec.format] || spec.format,
      api: spec.name,
      baseUrl: spec.baseUrl,
      operationsFound: spec.endpoints.length,
      operationsMatchingFilter: total,
      authGuess: (spec.authHint && spec.authHint.type) || 'none',
    };

    // Разведка перед импортом: сколько операций и какие. Именно с неё
    // начинается работа по плану, если описание большое.
    if (p.dryRun) {
      return {
        ok: true, dryRun: true, ...overview,
        operations: list.slice(0, 80).map(e => ({
          method: e.method, path: e.path || e.url, summary: e.summary || e.name, tags: e.tags,
        })),
        note: total > limit
          ? `Операций больше, чем стоит брать за один раз. Импортируй частями: ` +
            `only (фильтр по пути, имени или разделу), limit и offset. Заведи план задачи (task_plan).`
          : 'Можно импортировать одним вызовом: повтори без dryRun.',
      };
    }

    if (!slice.length) {
      return { error: 'Под фильтр не попало ни одной операции', ...overview };
    }

    // Дозагрузка в уже существующий комплект: имя то же — считаем, что
    // продолжаем начатое, а не заводим второй набор с тем же смыслом.
    const wantedName = String(p.name || spec.name || 'API').slice(0, 60);
    const existing = await eng.get(wantedName);

    const res = await eng.createBundle({
      spec, name: wantedName, endpoints: slice,
      folders: this.folders, transport,
      existingBundle: existing,
    });
    if (res.error) return res;

    this._refreshUI('tools');
    try { this.ui && this.ui.renderSkills && this.ui.renderSkills(); } catch (_) {}

    const remaining = Math.max(0, total - (offset + slice.length));
    return {
      ok: true,
      ...overview,
      bundle: res.bundle.name,
      bundleId: res.bundle.id,
      folder: res.folder.name,
      skill: res.skill.name,
      toolsCreated: res.tools.map(t => t.name),
      toolsTotalInBundle: res.bundle.toolCount,
      remaining,
      enabled: false,
      needsAuth: !(res.bundle.auth && res.bundle.auth.secret) && res.bundle.auth.type !== 'none',
      testPlan: ApiImportEngine.testPlan(res.bundle.name, res.tools),
      note:
        'Инструменты и навык созданы ВЫКЛЮЧЕННЫМИ — включает их пользователь. ' +
        (remaining ? `Осталось операций: ${remaining} — продолжай с offset=${offset + slice.length}. ` : '') +
        'Дальше: 1) если сервису нужен ключ или логин — вызови api_bundle_configure ' +
        '(секрет вводит пользователь в форме, тебе он не передаётся); ' +
        '2) покажи пользователю план тестирования из testPlan и предложи начать с первого шага.',
    };
  });


  this.registerHandler('builtin_api_bundle_configure', async (params) => {
    const eng = this.apiImport;
    if (!eng) return { error: 'Импорт API недоступен' };
    const bundle = await eng.get(String((params && params.bundle) || ''));
    if (!bundle) {
      const all = await eng.list();
      return {
        error: 'Набор не найден',
        available: all.map(b => b.name),
        hint: all.length ? 'Укажи один из перечисленных.' : 'Сначала импортируй описание API (api_import).',
      };
    }
    const ui = this.ui;
    if (!ui || typeof ui.showApiAuthModal !== 'function') {
      return { error: 'Форма настройки недоступна (интерфейс не подключён)' };
    }

    const res = await ui.showApiAuthModal(bundle.id);
    if (!res || res.cancelled) {
      return { cancelled: true, note: 'Пользователь закрыл форму — ничего не сохранено.' };
    }
    if (res.error) return res;
    return {
      success: true, bundle: bundle.name, authType: res.authType, hasSecret: res.hasSecret,
      baseUrl: res.baseUrl,
      note: 'Секрет сохранён в зашифрованном виде и подставляется в запросы приложением. ' +
            'Тебе он не передаётся и в переписке не появляется.',
    };
  });


  this.registerHandler('builtin_api_bundle_list', async () => {
    const eng = this.apiImport;
    if (!eng) return { error: 'Импорт API недоступен' };
    const all = await eng.list();
    const tools = await this.db.getAll('tools');
    return {
      ok: true,
      bundles: all.map(b => {
        const own = tools.filter(t => t.apiCall && t.apiCall.bundleId === b.id);
        return {
          name: b.name, id: b.id, format: b.format, baseUrl: b.baseUrl,
          transport: b.transport,
          tools: own.length,
          enabledTools: own.filter(t => t.enabled).length,
          authType: (b.auth && b.auth.type) || 'none',
          // Сам секрет не отдаётся никогда — только факт его наличия.
          hasSecret: !!(b.auth && b.auth.secret),
        };
      }),
      note: all.length ? 'Инструменты набора включает пользователь на вкладке Tools.' : 'Наборов пока нет.',
    };
  });

});


// ── Исполнение импортированного вызова ──
// Отдельной примесью к ToolsEngine: вызывается из tools-executor.js, когда
// у инструмента есть apiCall.
Object.assign(ToolsEngine.prototype, {

  async _executeApiCall(tool, params) {
    const call = tool.apiCall || {};
    const bundle = await this.db.get('api_bundles', call.bundleId);
    if (!bundle) {
      return { error: 'Набор, к которому относится инструмент, удалён. Импортируй описание заново.' };
    }

    const p = params || {};

    // ── Адрес ──
    let raw = call.url || '';
    if (!raw) {
      const base = String(bundle.baseUrl || '').replace(/\/+$/, '');
      if (!base) {
        return {
          error: 'У набора «' + bundle.name + '» не задан базовый адрес.',
          hint: 'Пользователь задаёт его в форме: вызови api_bundle_configure.',
        };
      }
      raw = base + (call.path || '');
    }
    // Подстановки вида {id} и :id — из аргументов вызова.
    const missing = [];
    for (const name of (call.pathParams || [])) {
      const val = p[name];
      if (val === undefined || val === null || val === '') { missing.push(name); continue; }
      raw = raw.replace('{' + name + '}', encodeURIComponent(String(val)))
               .replace(':' + name, encodeURIComponent(String(val)))
               .replace('{{' + name + '}}', encodeURIComponent(String(val)));
    }
    if (missing.length) return { error: 'Не заданы обязательные параметры пути: ' + missing.join(', ') };

    let u;
    try { u = new URL(raw); } catch (_) { return { error: 'Не удалось собрать адрес запроса: ' + raw }; }
    if (!/^https?:$/.test(u.protocol)) return { error: 'Разрешены только http/https' };

    for (const name of (call.queryParams || [])) {
      const val = p[name];
      if (val !== undefined && val !== null && val !== '') u.searchParams.set(name, String(val));
    }

    // ── Заголовки ──
    const headers = {};
    if (call.contentType) headers['Content-Type'] = call.contentType;
    for (const name of (call.headerParams || [])) {
      const val = p[name];
      if (val !== undefined && val !== null && val !== '') headers[name] = String(val);
    }
    if (call.soap && call.soap.action) headers.SOAPAction = '"' + call.soap.action + '"';

    // ── Авторизация ──
    // Секрет расшифровывается здесь и живёт ровно до конца запроса: ни в
    // аргументах, ни в результате, ни в переписке его нет.
    const auth = bundle.auth || { type: 'none' };
    if (auth.type && auth.type !== 'none') {
      const secret = auth.secret ? await SecretsVault.decrypt(this.db, auth.secret) : '';
      if (!secret && auth.type !== 'basic') {
        return {
          error: 'Для набора «' + bundle.name + '» не задан секрет авторизации.',
          hint: 'Вызови api_bundle_configure — пользователь введёт его в форме.',
          needsAuth: true,
        };
      }
      if (auth.type === 'bearer') headers.Authorization = 'Bearer ' + secret;
      else if (auth.type === 'header') headers[auth.name || 'X-API-Key'] = secret;
      else if (auth.type === 'query') u.searchParams.set(auth.name || 'api_key', secret);
      else if (auth.type === 'basic') {
        try { headers.Authorization = 'Basic ' + btoa((auth.user || '') + ':' + secret); }
        catch (_) { return { error: 'Не удалось собрать Basic-авторизацию' }; }
      }
    }

    // ── Тело ──
    let body;
    if (call.hasBody && p.body !== undefined && p.body !== null && p.body !== '') {
      body = typeof p.body === 'string' ? p.body : JSON.stringify(p.body);
      if (call.soap) {
        const ns = call.soap.version === '1.2'
          ? 'http://www.w3.org/2003/05/soap-envelope'
          : 'http://schemas.xmlsoap.org/soap/envelope/';
        // Конверт добавляем сами: модель должна думать о содержимом
        // операции, а не о том, как называется обёртка в этой версии SOAP.
        if (!/<(\w+:)?Envelope[\s>]/i.test(body)) {
          body = '<?xml version="1.0" encoding="utf-8"?>' +
            '<soap:Envelope xmlns:soap="' + ns + '"><soap:Body>' + body + '</soap:Body></soap:Envelope>';
        }
      }
    } else if (call.hasBody) {
      return { error: 'Не задано тело запроса (аргумент body)' };
    }

    const method = String(call.method || 'GET').toUpperCase();

    // ── Отправка ──
    // Через локальный прокси — если набор так настроен: внутренние
    // адреса из браузера иначе недостижимы (CORS и приватные сети).
    if (bundle.transport === 'proxy') {
      const res = await this.executeTool('proxy_fetch', {
        url: u.toString(), method,
        headers: Object.fromEntries(Object.entries(headers)
          .filter(([k]) => /^(content-type|authorization)$/i.test(k))),
        body,
      }, { bypassSecurity: true });
      if (res && res.error) return res;
      return this._shapeApiResult(res.status, res.body, u, method, bundle);
    }

    if (this._isBlockedFetchHost(u.hostname)) {
      return {
        error: 'Адрес локальный или приватный — прямой запрос запрещён.',
        hint: 'Переключи набор на локальный прокси: api_bundle_configure, режим «через прокси».',
      };
    }

    try {
      const init = { method, headers };
      if (body !== undefined && !['GET', 'HEAD'].includes(method)) init.body = body;
      const resp = await fetch(u.toString(), init);
      const text = await resp.text();
      return this._shapeApiResult(resp.status, text, u, method, bundle);
    } catch (e) {
      return { error: 'Запрос не выполнен: ' + (e && e.message || e) };
    }
  },

  // Общий вид результата: короткий, разобранный, с понятным объяснением
  // кодов авторизации — иначе модель начинает «чинить» параметры там, где
  // дело в ключе.
  async _shapeApiResult(status, text, u, method, bundle) {
    const limit = (await this._toolLimits()).maxResponseChars;
    const full = String(text || '');
    const short = full.length > limit ? full.slice(0, limit) : full;

    let data;
    try { data = JSON.parse(short); } catch (_) { data = undefined; }

    const out = {
      status,
      url: u.origin + u.pathname,
      method,
      truncated: full.length > limit,
    };
    if (data !== undefined) out.data = data; else out.body = short;

    if (status === 401 || status === 403) {
      out.error = 'Сервис ответил ' + status + ': нет доступа.';
      out.hint = 'Скорее всего дело в секрете или правах, а не в параметрах вызова. ' +
        'Предложи пользователю перенастроить доступ: api_bundle_configure для набора «' + bundle.name + '».';
    } else if (status >= 400) {
      out.error = 'Сервис ответил ' + status + '. Разбери тело ответа: в нём обычно сказано, что не так.';
    }
    return out;
  },

});


ToolsEngine.DEF_CONTRIBUTORS.push(function apiImportDefs() {
  return [
    {
      id: 'builtin_api_import',
      name: 'api_import',
      description:
        'Собирает комплект «навык + набор инструментов» из описания чужого API. Инструменты создаются ' +
        'в отдельной папке набора, навык описывает работу с ними, всё — выключенным.\n' +
        'Форматы: OpenAPI/Swagger (JSON), коллекция Postman (v2), WSDL 1.1 (SOAP), HAR (записанные ' +
        'запросы браузера), экспорт Insomnia, интроспекция GraphQL. Формат определяется сам.\n' +
        'Источник: url (скачаю сам) или source (текст описания, например прочитанный read_file).\n' +
        'СНАЧАЛА вызывай с dryRun: true — узнаешь, сколько операций внутри. Если их много, импортируй ' +
        'частями (only/limit/offset) и веди план задачи (task_plan): описание на сотни операций ' +
        'не нужно ни пользователю, ни контексту целиком.\n' +
        'Секрет авторизации здесь НЕ передаётся: для него есть api_bundle_configure с формой для человека.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Адрес описания API (swagger.json, ?wsdl, экспорт коллекции)' },
          source: { type: 'string', description: 'Текст описания, если файл уже прочитан' },
          format: {
            type: 'string',
            enum: ['auto', 'openapi', 'postman', 'wsdl', 'har', 'insomnia', 'graphql'],
            description: 'По умолчанию auto — формат определяется по содержимому',
          },
          name: { type: 'string', description: 'Название набора. Совпадение с существующим = дозагрузка в него' },
          baseUrl: { type: 'string', description: 'Базовый адрес сервиса, если в описании его нет' },
          transport: {
            type: 'string', enum: ['direct', 'proxy'],
            description: 'proxy — качать описание и ходить в сервис через локальный прокси (внутренние адреса)',
          },
          only: { type: 'string', description: 'Взять только операции, где встречается эта строка (путь, имя, раздел)' },
          limit: { type: 'number', description: 'Сколько операций взять за раз. По умолчанию 25, максимум 60' },
          offset: { type: 'number', description: 'С какой операции продолжать — для импорта частями' },
          dryRun: { type: 'boolean', description: 'Только разобрать и показать состав, ничего не создавая' },
        },
        required: [],
      },
      enabled: true,
      builtin: true,
    },
    {
      id: 'builtin_api_bundle_configure',
      name: 'api_bundle_configure',
      description:
        'Открывает пользователю форму доступа к сервису импортированного набора: базовый адрес, ' +
        'способ авторизации (Bearer, ключ в заголовке или в параметре, Basic), сам секрет и режим ' +
        'отправки (напрямую или через локальный прокси).\n' +
        'Секрет вводит ЧЕЛОВЕК и он сохраняется зашифрованным. Никогда не проси прислать токен ' +
        'сообщением и не принимай его текстом: он остался бы в истории диалога.',
      parameters: {
        type: 'object',
        properties: { bundle: { type: 'string', description: 'Название или id набора' } },
        required: ['bundle'],
      },
      enabled: true,
      builtin: true,
    },
    {
      id: 'builtin_api_bundle_list',
      name: 'api_bundle_list',
      description: 'Перечисляет импортированные наборы API: сколько инструментов, сколько включено, ' +
        'задан ли секрет, куда ходит. Сам секрет не показывается.',
      parameters: { type: 'object', properties: {}, required: [] },
      enabled: true,
      builtin: true,
    },
  ];
});
