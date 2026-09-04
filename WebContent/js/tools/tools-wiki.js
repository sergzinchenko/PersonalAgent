// ============================================================
//  TOOLS WIKI — Confluence (On-Premise) и xWiki через REST API
// ============================================================
//
// Два набора инструментов к внутренним вики-системам. Оба on-premise,
// поэтому устроены одинаково и делят транспорт: адрес внутренний, CORS
// закрыт — запросы идут через локальный прокси (см. proxy_fetch).
//
// ── ГДЕ ЛЕЖАТ УЧЁТНЫЕ ДАННЫЕ ──
// Просьба была «сохранять в долговременную память». Хранятся они в БД
// (settings/wiki_confluence и settings/wiki_xwiki) и переживают перезапуск —
// то есть спрашивают их ровно один раз, как и просили. Но НЕ через
// persistent_memory, и на то две причины:
//
//   1. Системный навык прямо запрещает класть в память пароли и ключи.
//   2. Память читается моделью (persistent_memory read/list). Токен попал
//      бы в контекст диалога, а оттуда — в каждый последующий запрос к
//      провайдеру модели и в его логи.
//
// Секрет шифруется SecretsVault — тем же механизмом, что ключи провайдеров
// и токены MCP-серверов. Наружу (в ответах инструментов) он не отдаётся
// никогда: возвращается только адрес, имя пользователя и признак «настроено».
//
// ── ПОЧЕМУ СЕКРЕТ ВВОДИТСЯ В ФОРМЕ, А НЕ ЧЕРЕЗ ask_user ──
// Инструмент *_configure открывает форму интерфейса, и значение уходит из
// поля прямо в шифрованное хранилище. Если бы модель собирала токен через
// ask_user, он стал бы результатом вызова инструмента — то есть частью
// истории диалога, которая уходит провайдеру при каждом следующем запросе.
// Агент здесь инициирует запрос данных, но самих данных не видит.
//
// ── КАТЕГОРИИ БЕЗОПАСНОСТИ ──
// Чтение помечено 'read', запись — 'write', а не 'network', хотя запрос и
// уходит наружу. Категория 'network' существует ради случая, когда АДРЕС
// выбирает модель (http_fetch): там нужен вопрос про каждый хост. Здесь
// адрес задан пользователем в настройках и модели неподконтролен, а вот
// потолок изменений за ход для создания страниц — как раз по делу.

ToolsEngine.HANDLER_CONTRIBUTORS.push(function registerWikiHandlers() {

  // ── Хранилище учётных данных ──

  const SETTINGS_KEY = { confluence: 'wiki_confluence', xwiki: 'wiki_xwiki' };
  const TITLES = { confluence: 'Confluence', xwiki: 'xWiki' };

  this._wikiSettingsKey = (kind) => SETTINGS_KEY[kind];

  // Читает настройки и расшифровывает секрет. Секрет остаётся внутри
  // движка: наружу его не отдаёт ни один обработчик.
  this._wikiConfig = async (kind) => {
    let saved = null;
    try { saved = await this.db.get('settings', SETTINGS_KEY[kind]); } catch (_) { saved = null; }
    if (!saved) return { configured: false, kind };
    const secret = await SecretsVault.decrypt(this.db, saved.secret || '');
    return {
      configured: !!(saved.baseUrl && secret),
      kind,
      baseUrl: String(saved.baseUrl || '').replace(/\/+$/, ''),
      user: saved.user || '',
      secret,
    };
  };

  // Вызывается из формы интерфейса (ui-editors.js), не из обработчиков.
  this._wikiSaveConfig = async (kind, { baseUrl, user, secret }) => {
    const rec = {
      key: SETTINGS_KEY[kind],
      baseUrl: String(baseUrl || '').trim().replace(/\/+$/, ''),
      user: String(user || '').trim(),
      secret: await SecretsVault.encrypt(this.db, String(secret || '')),
      savedAt: Date.now(),
    };
    await this.db.put('settings', rec);
    return { baseUrl: rec.baseUrl, user: rec.user };
  };

  this._wikiForget = async (kind) => {
    await this.db.delete('settings', SETTINGS_KEY[kind]);
    return true;
  };

  const notConfigured = (kind) => ({
    error: `${TITLES[kind]} не настроен: неизвестен адрес или не задан доступ.`,
    hint: `Вызови ${kind}_configure — откроется форма, куда пользователь введёт адрес и ` +
          'данные для входа. Не спрашивай токен или пароль сам и не проси прислать его сообщением: ' +
          'он не должен попадать в переписку.',
    needsConfiguration: true,
  });

  // ── Транспорт ──
  // On-premise вики почти всегда закрыта CORS и живёт на внутреннем адресе,
  // поэтому по умолчанию идём через локальный прокси. Если он не настроен,
  // пробуем напрямую — вдруг адрес доступен и CORS открыт, — и объясняем,
  // что делать, если не вышло.
  this._wikiRequest = async (kind, { method = 'GET', path, body = null, contentType = null, accept = 'application/json' }) => {
    const cfg = await this._wikiConfig(kind);
    if (!cfg.configured) return { error: notConfigured(kind).error, needsConfiguration: true };

    const target = cfg.baseUrl + path;
    const headers = { Accept: accept };
    if (contentType) headers['Content-Type'] = contentType;
    // Confluence On-Premise: персональный токен передаётся как Bearer.
    // xWiki: Basic из логина и пароля.
    headers.Authorization = kind === 'confluence'
      ? 'Bearer ' + cfg.secret
      : 'Basic ' + btoa(unescape(encodeURIComponent(cfg.user + ':' + cfg.secret)));

    const proxy = await this._proxyConfig();
    const url = proxy.baseUrl
      ? proxy.baseUrl.replace(/\/+$/, '') + '/?url=' + encodeURIComponent(target)
      : target;

    let resp;
    try {
      resp = await fetch(url, { method, headers, ...(body !== null ? { body } : {}) });
    } catch (e) {
      return {
        error: `Не удалось обратиться к ${TITLES[kind]} (${target}): ${e.message}`,
        hint: proxy.baseUrl
          ? 'Прокси не отвечает — скажи пользователю запустить «node proxy/proxy.js».'
          : 'Адрес внутренний, и браузер, скорее всего, заблокировал запрос по CORS. ' +
            'Скажи пользователю настроить локальный прокси: ⚙ Настройки → Безопасность → «Локальный прокси».',
      };
    }

    const text = await resp.text();

    // Сбой проверки сертификата прокси отдаёт разобранным — доносим как есть.
    if (resp.status === 502) {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
      if (parsed && parsed.tlsError) {
        return { error: parsed.error, tlsError: true, code: parsed.code, howToFix: parsed.howToFix };
      }
    }

    if (resp.status === 401 || resp.status === 403) {
      return {
        error: `${TITLES[kind]} отклонил доступ (HTTP ${resp.status}).`,
        hint: kind === 'confluence'
          ? 'Токен недействителен, истёк или у него нет прав на этот объект. ' +
            'Предложи пользователю перенастроить доступ через confluence_configure.'
          : 'Логин или пароль не подошли, либо у учётной записи нет прав. ' +
            'Предложи пользователю перенастроить доступ через xwiki_configure.',
        status: resp.status,
      };
    }
    if (resp.status === 404) {
      return { error: `${TITLES[kind]}: объект не найден (HTTP 404) по адресу ${path}`, status: 404 };
    }
    if (!resp.ok) {
      return { error: `${TITLES[kind]} ответил HTTP ${resp.status}: ` + text.slice(0, 500), status: resp.status };
    }

    if (accept.includes('json')) {
      try { return { ok: true, data: JSON.parse(text) }; }
      catch (_) { return { error: `${TITLES[kind]} вернул не JSON: ` + text.slice(0, 300) }; }
    }
    return { ok: true, text };
  };

  // Разметку вики модель читать не обязана: из XHTML Confluence и
  // XWiki-синтаксиса вытаскиваем текст. Преобразование заведомо грубое —
  // таблицы и макросы теряются, поэтому в ответе есть и признак усечения.
  const toPlainText = (html) => String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const clip = async (text) => {
    const limit = (await this._toolLimits()).maxResponseChars;
    const s = String(text || '');
    return { text: s.slice(0, limit), truncated: s.length > limit, length: s.length };
  };

  // ═══════════ CONFLUENCE ═══════════

  this.registerHandler('builtin_confluence_configure', async () => {
    const ui = this.ui;
    if (!ui || typeof ui.showWikiConfigModal !== 'function') {
      return { error: 'Форма настройки недоступна (интерфейс не подключён)' };
    }
    const res = await ui.showWikiConfigModal('confluence');
    if (!res || res.cancelled) return { cancelled: true, note: 'Пользователь закрыл форму, ничего не сохранено.' };
    return {
      success: true, baseUrl: res.baseUrl,
      note: 'Адрес и токен сохранены в зашифрованном виде и переживут перезапуск. ' +
            'Токен тебе не передаётся и в переписке не появляется.',
    };
  });

  this.registerHandler('builtin_confluence_status', async () => {
    const cfg = await this._wikiConfig('confluence');
    if (!cfg.configured) return notConfigured('confluence');
    const r = await this._wikiRequest('confluence', { path: '/rest/api/space?limit=1' });
    return {
      configured: true,
      baseUrl: cfg.baseUrl,
      reachable: !r.error,
      error: r.error,
      note: 'Токен хранится зашифрованным и не отдаётся ни в одном ответе.',
    };
  });

  this.registerHandler('builtin_confluence_search', async (params) => {
    const cql = String(params.cql || '').trim();
    const text = String(params.text || '').trim();
    if (!cql && !text) return { error: 'Нужен text (простой поиск) или cql (точный запрос)' };
    const query = cql || `text ~ "${text.replace(/"/g, '\\"')}"`;
    const limit = Math.min(Math.max(parseInt(params.limit, 10) || 10, 1), 50);

    const r = await this._wikiRequest('confluence', {
      path: `/rest/api/content/search?cql=${encodeURIComponent(query)}&limit=${limit}`,
    });
    if (r.error) return r;

    const results = (r.data.results || []).map((it) => ({
      id: it.id, type: it.type, title: it.title,
      space: it.space?.key || it._expandable?.space?.split('/').pop(),
      url: cfgUrl(r, it),
    }));
    return { query, found: r.data.size ?? results.length, results };

    function cfgUrl(_r, it) {
      const webui = it._links?.webui || '';
      return webui || undefined;
    }
  });

  this.registerHandler('builtin_confluence_get_page', async (params) => {
    const id = String(params.page_id || '').trim();
    const title = String(params.title || '').trim();
    const space = String(params.space || '').trim();

    let path;
    if (id) {
      path = `/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,version,space`;
    } else if (title) {
      path = '/rest/api/content?expand=body.storage,version,space&title=' + encodeURIComponent(title) +
             (space ? '&spaceKey=' + encodeURIComponent(space) : '');
    } else {
      return { error: 'Нужен page_id или title (можно вместе со space)' };
    }

    const r = await this._wikiRequest('confluence', { path });
    if (r.error) return r;

    const page = id ? r.data : (r.data.results || [])[0];
    if (!page) return { error: 'Страница не найдена', status: 404 };

    const body = await clip(toPlainText(page.body?.storage?.value));
    return {
      id: page.id, title: page.title,
      space: page.space?.key,
      version: page.version?.number,
      content: body.text,
      truncated: body.truncated,
      contentLength: body.length,
      note: body.truncated ? 'Текст сокращён по общему пределу ответа инструмента.' : undefined,
    };
  });

  this.registerHandler('builtin_confluence_create_page', async (params) => {
    const space = String(params.space || '').trim();
    const title = String(params.title || '').trim();
    const content = String(params.content || '');
    if (!space || !title) return { error: 'Нужны space и title' };

    const payload = {
      type: 'page', title,
      space: { key: space },
      body: { storage: { value: content, representation: 'storage' } },
    };
    if (params.parent_id) payload.ancestors = [{ id: String(params.parent_id) }];

    const r = await this._wikiRequest('confluence', {
      method: 'POST', path: '/rest/api/content',
      contentType: 'application/json', body: JSON.stringify(payload),
    });
    if (r.error) return r;
    return { success: true, id: r.data.id, title: r.data.title, version: r.data.version?.number };
  });

  this.registerHandler('builtin_confluence_update_page', async (params) => {
    const id = String(params.page_id || '').trim();
    if (!id) return { error: 'Нужен page_id' };

    // Confluence требует номер следующей версии. Берём текущий сам, а не
    // просим у модели: она его выдумает, и правка молча уйдёт в конфликт.
    const cur = await this._wikiRequest('confluence', {
      path: `/rest/api/content/${encodeURIComponent(id)}?expand=version,space`,
    });
    if (cur.error) return cur;

    const payload = {
      id, type: 'page',
      title: String(params.title || cur.data.title),
      space: { key: cur.data.space?.key },
      version: { number: (cur.data.version?.number || 0) + 1, message: params.comment || 'Изменено агентом' },
      body: { storage: { value: String(params.content || ''), representation: 'storage' } },
    };

    const r = await this._wikiRequest('confluence', {
      method: 'PUT', path: `/rest/api/content/${encodeURIComponent(id)}`,
      contentType: 'application/json', body: JSON.stringify(payload),
    });
    if (r.error) return r;
    return { success: true, id: r.data.id, title: r.data.title, version: r.data.version?.number };
  });

  this.registerHandler('builtin_confluence_list_spaces', async (params) => {
    const limit = Math.min(Math.max(parseInt(params.limit, 10) || 25, 1), 100);
    const r = await this._wikiRequest('confluence', { path: `/rest/api/space?limit=${limit}` });
    if (r.error) return r;
    return {
      spaces: (r.data.results || []).map((s) => ({ key: s.key, name: s.name, type: s.type })),
    };
  });

  // ═══════════ XWIKI ═══════════
  //
  // Адрес страницы в REST xWiki собирается из вложенных пространств:
  // Space.Sub.Page → /spaces/Space/spaces/Sub/pages/Page
  const xwikiPagePath = (space, page) => {
    const parts = String(space || 'Main').split('.').filter(Boolean);
    return '/rest/wikis/xwiki' + parts.map((p) => '/spaces/' + encodeURIComponent(p)).join('') +
           '/pages/' + encodeURIComponent(page);
  };

  this.registerHandler('builtin_xwiki_configure', async () => {
    const ui = this.ui;
    if (!ui || typeof ui.showWikiConfigModal !== 'function') {
      return { error: 'Форма настройки недоступна (интерфейс не подключён)' };
    }
    const res = await ui.showWikiConfigModal('xwiki');
    if (!res || res.cancelled) return { cancelled: true, note: 'Пользователь закрыл форму, ничего не сохранено.' };
    return {
      success: true, baseUrl: res.baseUrl, user: res.user,
      note: 'Адрес и учётная запись сохранены, пароль зашифрован и переживёт перезапуск. ' +
            'Пароль тебе не передаётся и в переписке не появляется.',
    };
  });

  this.registerHandler('builtin_xwiki_status', async () => {
    const cfg = await this._wikiConfig('xwiki');
    if (!cfg.configured) return notConfigured('xwiki');
    const r = await this._wikiRequest('xwiki', { path: '/rest/wikis?media=json' });
    return {
      configured: true, baseUrl: cfg.baseUrl, user: cfg.user,
      reachable: !r.error, error: r.error,
      note: 'Пароль хранится зашифрованным и не отдаётся ни в одном ответе.',
    };
  });

  this.registerHandler('builtin_xwiki_search', async (params) => {
    const q = String(params.query || '').trim();
    if (!q) return { error: 'Нужен query' };
    const limit = Math.min(Math.max(parseInt(params.limit, 10) || 10, 1), 50);
    const r = await this._wikiRequest('xwiki', {
      path: `/rest/wikis/xwiki/search?q=${encodeURIComponent(q)}&scope=content&number=${limit}&media=json`,
    });
    if (r.error) return r;
    const items = r.data.searchResults || [];
    return {
      query: q, found: items.length,
      results: items.map((it) => ({
        title: it.title, space: it.space, page: it.pageName,
        url: it.pageFullName || it.id, author: it.author,
      })),
    };
  });

  this.registerHandler('builtin_xwiki_get_page', async (params) => {
    const space = String(params.space || '').trim();
    const page = String(params.page || '').trim();
    if (!page) return { error: 'Нужен page (и обычно space, например Main)' };

    const r = await this._wikiRequest('xwiki', { path: xwikiPagePath(space, page) + '?media=json' });
    if (r.error) return r;

    const body = await clip(toPlainText(r.data.content));
    return {
      space: r.data.space, page: r.data.name, title: r.data.title,
      version: r.data.version,
      content: body.text, truncated: body.truncated, contentLength: body.length,
      note: body.truncated ? 'Текст сокращён по общему пределу ответа инструмента.' : undefined,
    };
  });

  // В xWiki создание и обновление — один и тот же PUT: страница создаётся,
  // если её нет. Разделено на два инструмента намеренно: у них разный смысл
  // для модели и разный вес для политики (перезапись существующей страницы —
  // не то же самое, что создание новой).
  const xwikiPut = async (params, { overwrite }) => {
    const space = String(params.space || '').trim();
    const page = String(params.page || '').trim();
    if (!page) return { error: 'Нужен page (и обычно space)' };

    const path = xwikiPagePath(space, page);
    if (!overwrite) {
      const exists = await this._wikiRequest('xwiki', { path: path + '?media=json' });
      if (!exists.error) {
        return {
          error: `Страница ${space}.${page} уже существует.`,
          hint: 'Чтобы изменить её, вызови xwiki_update_page — так правка существующего ' +
                'не происходит по недоразумению.',
        };
      }
    }

    const form = 'title=' + encodeURIComponent(String(params.title || page)) +
                 '&content=' + encodeURIComponent(String(params.content || ''));
    const r = await this._wikiRequest('xwiki', {
      method: 'PUT', path, body: form,
      contentType: 'application/x-www-form-urlencoded',
    });
    if (r.error) return r;
    return { success: true, space: r.data?.space ?? space, page: r.data?.name ?? page, version: r.data?.version };
  };

  this.registerHandler('builtin_xwiki_create_page', (params) => xwikiPut(params, { overwrite: false }));
  this.registerHandler('builtin_xwiki_update_page', (params) => xwikiPut(params, { overwrite: true }));

  this.registerHandler('builtin_xwiki_list_spaces', async () => {
    const r = await this._wikiRequest('xwiki', { path: '/rest/wikis/xwiki/spaces?media=json' });
    if (r.error) return r;
    return {
      spaces: (r.data.spaces || []).map((s) => ({ name: s.name, home: s.home, wiki: s.wiki })),
    };
  });
});


ToolsEngine.DEF_CONTRIBUTORS.push(function wikiDefs() {
  const NEVER_ASK = 'НИКОГДА не спрашивай токен, пароль или логин сообщением в чате и не принимай их ' +
    'текстом: они попали бы в историю диалога и ушли бы провайдеру модели. Данные вводит сам ' +
    'пользователь в форме, которую открывает инструмент *_configure.';

  return [
    // ── Confluence ──
    {
      id: 'builtin_confluence_configure',
      name: 'confluence_configure',
      description: 'Открывает пользователю форму подключения к Confluence On-Premise: адрес сервера и ' +
        'персональный токен доступа (PAT). Значения сохраняются надолго (токен — в зашифрованном виде) ' +
        'и переживают перезапуск, спрашивать их повторно не нужно. ' + NEVER_ASK,
      parameters: { type: 'object', properties: {}, required: [] },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_status',
      name: 'confluence_status',
      description: 'Показывает, настроено ли подключение к Confluence, и проверяет связь с сервером. ' +
        'Вызывай первым, если не уверен, что доступ уже настроен. Токен не возвращается.',
      parameters: { type: 'object', properties: {}, required: [] },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_search',
      name: 'confluence_search',
      description: 'Ищет страницы в Confluence. Для простого поиска передай text, для точного — cql ' +
        '(язык запросов Confluence, например: space = DOCS and type = page and text ~ "отпуск").',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Простой поисковый запрос по тексту' },
          cql: { type: 'string', description: 'Запрос на CQL — если нужен точный отбор' },
          limit: { type: 'number', description: 'Сколько результатов вернуть (1–50, по умолчанию 10)' },
        },
        required: [],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_get_page',
      name: 'confluence_get_page',
      description: 'Читает страницу Confluence по page_id либо по title (можно уточнить space). ' +
        'Возвращает текст без разметки — таблицы и макросы при этом теряются.',
      parameters: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Идентификатор страницы (предпочтительно)' },
          title: { type: 'string', description: 'Или точный заголовок' },
          space: { type: 'string', description: 'Ключ пространства — уточняет поиск по заголовку' },
        },
        required: [],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_create_page',
      name: 'confluence_create_page',
      description: 'Создаёт страницу в Confluence. content — в формате storage (XHTML Confluence); ' +
        'обычный текст с абзацами <p>…</p> подходит. Перед созданием покажи пользователю, ' +
        'что и куда собираешься записать.',
      parameters: {
        type: 'object',
        properties: {
          space: { type: 'string', description: 'Ключ пространства' },
          title: { type: 'string', description: 'Заголовок страницы' },
          content: { type: 'string', description: 'Содержимое в формате storage (XHTML)' },
          parent_id: { type: 'string', description: 'id родительской страницы — если нужна вложенность' },
        },
        required: ['space', 'title', 'content'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_update_page',
      name: 'confluence_update_page',
      description: 'Перезаписывает содержимое страницы Confluence. Номер версии инструмент берёт с ' +
        'сервера сам. ВНИМАНИЕ: content заменяет тело страницы ЦЕЛИКОМ — сначала прочитай её ' +
        'через confluence_get_page и согласуй правку с пользователем.',
      parameters: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Идентификатор страницы' },
          content: { type: 'string', description: 'Новое содержимое целиком, формат storage (XHTML)' },
          title: { type: 'string', description: 'Новый заголовок, если нужно сменить' },
          comment: { type: 'string', description: 'Комментарий к версии' },
        },
        required: ['page_id', 'content'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_list_spaces',
      name: 'confluence_list_spaces',
      description: 'Перечисляет пространства Confluence: ключ, название, тип. Полезно, чтобы узнать ' +
        'ключ пространства перед поиском или созданием страницы.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Сколько вернуть (1–100, по умолчанию 25)' } },
        required: [],
      },
      enabled: false, builtin: true,
    },

    // ── xWiki ──
    {
      id: 'builtin_xwiki_configure',
      name: 'xwiki_configure',
      description: 'Открывает пользователю форму подключения к xWiki On-Premise: адрес, имя учётной ' +
        'записи и пароль (Basic-авторизация). Значения сохраняются надолго (пароль — в зашифрованном ' +
        'виде) и переживают перезапуск. ' + NEVER_ASK,
      parameters: { type: 'object', properties: {}, required: [] },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_status',
      name: 'xwiki_status',
      description: 'Показывает, настроено ли подключение к xWiki, и проверяет связь. Пароль не возвращается.',
      parameters: { type: 'object', properties: {}, required: [] },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_search',
      name: 'xwiki_search',
      description: 'Ищет страницы в xWiki по тексту.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос' },
          limit: { type: 'number', description: 'Сколько результатов (1–50, по умолчанию 10)' },
        },
        required: ['query'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_get_page',
      name: 'xwiki_get_page',
      description: 'Читает страницу xWiki. space — пространство (вложенные через точку: Docs.Team), ' +
        'page — имя страницы. Возвращает текст без разметки.',
      parameters: {
        type: 'object',
        properties: {
          space: { type: 'string', description: 'Пространство, например Main или Docs.Team' },
          page: { type: 'string', description: 'Имя страницы' },
        },
        required: ['page'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_create_page',
      name: 'xwiki_create_page',
      description: 'Создаёт страницу в xWiki. Если такая страница уже есть, вернёт ошибку и предложит ' +
        'xwiki_update_page — чтобы существующее не перезаписывалось по недоразумению. ' +
        'content — в синтаксисе XWiki 2.1.',
      parameters: {
        type: 'object',
        properties: {
          space: { type: 'string', description: 'Пространство (по умолчанию Main)' },
          page: { type: 'string', description: 'Имя страницы' },
          title: { type: 'string', description: 'Заголовок (по умолчанию совпадает с именем)' },
          content: { type: 'string', description: 'Содержимое в синтаксисе XWiki 2.1' },
        },
        required: ['page', 'content'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_update_page',
      name: 'xwiki_update_page',
      description: 'Перезаписывает страницу xWiki ЦЕЛИКОМ. ВНИМАНИЕ: content заменяет всё содержимое — ' +
        'сначала прочитай страницу через xwiki_get_page и согласуй правку с пользователем.',
      parameters: {
        type: 'object',
        properties: {
          space: { type: 'string', description: 'Пространство' },
          page: { type: 'string', description: 'Имя страницы' },
          title: { type: 'string', description: 'Заголовок' },
          content: { type: 'string', description: 'Новое содержимое целиком, синтаксис XWiki 2.1' },
        },
        required: ['page', 'content'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_list_spaces',
      name: 'xwiki_list_spaces',
      description: 'Перечисляет пространства xWiki.',
      parameters: { type: 'object', properties: {}, required: [] },
      enabled: false, builtin: true,
    },
  ];
});
