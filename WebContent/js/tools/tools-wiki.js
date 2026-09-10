// ============================================================
//  TOOLS WIKI — Confluence (On-Premise) и xWiki через REST API
// ============================================================
//
// Два набора инструментов к внутренним вики-системам. Оба on-premise,
// поэтому устроены одинаково и делят транспорт: адрес внутренний, CORS
// закрыт — запросы идут через локальный прокси (см. proxy_fetch).
//
// ── ОТКУДА ВЗЯТ СОСТАВ ──
// Набор собран по коллекциям Postman из папки api/ проекта
// (Confluence-REST-API.json и XWiki-REST-API.json): адреса, тела запросов
// и заголовки взяты оттуда, а не из общих представлений об этих API.
// Перенесено НЕ ВСЁ, и это решение, а не недоделка: коллекции описывают и
// то, что агенту в браузере делать нечем (загрузка вложения с диска —
// файла у него нет), и то, что без явной просьбы трогать не стоит вовсе
// (права доступа, группы пользователей, шаблоны, определения классов).
// Граница проведена по вопросу «нужно ли это, чтобы ответить на вопрос
// или внести правку»: чтение, поиск, структура, обсуждение и вложения —
// да; администрирование вики — нет, это работа человека в её интерфейсе.
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
// Чтение помечено 'read', запись — 'write', удаление — 'destroy', а не
// 'network', хотя запрос и уходит наружу. Категория 'network' существует
// ради случая, когда АДРЕС выбирает модель (http_fetch): там нужен вопрос
// про каждый хост. Здесь адрес задан пользователем в настройках и модели
// неподконтролен, а вот потолок изменений за ход и отдельный вопрос перед
// удалением страницы — как раз по делу.

ToolsEngine.HANDLER_CONTRIBUTORS.push(function registerWikiHandlers() {

  // ── Хранилище учётных данных ──

  const SETTINGS_KEY = { confluence: 'wiki_confluence', xwiki: 'wiki_xwiki' };
  const TITLES = { confluence: 'Confluence', xwiki: 'xWiki' };

  this._wikiSettingsKey = (kind) => SETTINGS_KEY[kind];

  // Адрес приводим к корню приложения: и «…/xwiki», и «…/xwiki/rest»
  // человек одинаково законно называет адресом вики (в коллекции Postman
  // baseUrl — как раз со /rest на конце), а путь инструменты дописывают
  // сами. Без этого второй вариант давал бы /rest/rest/… и глухую 404,
  // которую пользователь никак не связал бы с лишним словом в поле.
  const normalizeBase = (url) => String(url || '').trim()
    .replace(/\/+$/, '')
    .replace(/\/rest$/i, '');

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
      baseUrl: normalizeBase(saved.baseUrl),
      user: saved.user || '',
      // Имя вики есть только у xWiki: одна установка держит несколько вик
      // сразу (xwiki, eawiki, …), и пространства в каждой свои. Раньше
      // здесь было зашито 'xwiki' — на установке, где рабочая вика зовётся
      // иначе, все запросы уходили в несуществующую и отвечали 404.
      wiki: saved.wiki || (kind === 'xwiki' ? 'xwiki' : ''),
      secret,
    };
  };

  // Вызывается из формы интерфейса (ui-editors.js), не из обработчиков.
  this._wikiSaveConfig = async (kind, { baseUrl, user, secret, wiki }) => {
    const rec = {
      key: SETTINGS_KEY[kind],
      baseUrl: normalizeBase(baseUrl),
      user: String(user || '').trim(),
      secret: await SecretsVault.encrypt(this.db, String(secret || '')),
      savedAt: Date.now(),
    };
    if (kind === 'xwiki') rec.wiki = String(wiki || '').trim() || 'xwiki';
    await this.db.put('settings', rec);
    return { baseUrl: rec.baseUrl, user: rec.user, wiki: rec.wiki };
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

  // Разбор неуспешного ответа. Отдельной функцией, потому что нужен и до
  // чтения текста, и до чтения двоичного тела: «доступ отклонён» важнее
  // содержимого страницы ошибки, какой бы она ни пришла.
  const wikiFailure = async (kind, resp, path, binary) => {
    if (resp.ok) return null;

    let text = '';
    try { text = await resp.text(); } catch (_) { text = ''; }

    // Сбой проверки сертификата прокси отдаётся уже разобранным — доносим
    // как есть: пользователю нужен не «HTTP 502», а имя проблемы.
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
    return { error: `${TITLES[kind]} ответил HTTP ${resp.status}: ` + text.slice(0, 500), status: resp.status };
  };

  // ── Транспорт ──
  // On-premise вики почти всегда закрыта CORS и живёт на внутреннем адресе,
  // поэтому по умолчанию идём через локальный прокси. Если он не настроен,
  // пробуем напрямую — вдруг адрес доступен и CORS открыт, — и объясняем,
  // что делать, если не вышло.
  this._wikiRequest = async (kind, { method = 'GET', path, body = null, contentType = null, accept = 'application/json', binary = false }) => {
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

    const failure = await wikiFailure(kind, resp, path, binary);
    if (failure) return failure;

    if (binary) {
      if (typeof resp.blob !== 'function') return { error: 'Двоичный ответ в этой среде не читается.' };
      return { ok: true, blob: await resp.blob(), contentType: resp.headers?.get?.('Content-Type') || '' };
    }

    const text = await resp.text();
    if (accept.includes('json')) {
      try { return { ok: true, data: JSON.parse(text) }; }
      catch (_) { return { error: `${TITLES[kind]} вернул не JSON: ` + text.slice(0, 300) }; }
    }
    return { ok: true, text };
  };

  // Разметку вики модель читать не обязана: из XHTML Confluence и
  // отрендеренного HTML xWiki вытаскиваем текст. Преобразование заведомо
  // грубое — таблицы и макросы теряются, — поэтому у чтения есть и режим
  // «как есть»: format: 'storage' у Confluence, format: 'source' у xWiki.
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

  const intIn = (v, def, min, max) => Math.min(Math.max(parseInt(v, 10) || def, min), max);

  // Экранирование для XML-тел xWiki (комментарии, свойства объектов —
  // именно так их принимает REST, см. коллекцию). Без него угловая скобка
  // в тексте ломала бы разбор на стороне вики, а «&» в ссылке превращал
  // запрос в неправильный XML.
  const xmlEsc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  // Отдать файл пользователю. Там, где скачивание невозможно, возвращает
  // объяснимую ошибку: молчаливый отказ выглядел бы как успех, после
  // которого файла нигде нет.
  const deliverFile = (blob, filename) => {
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' ||
        typeof document === 'undefined' || !document.createElement) {
      return { error: 'Сохранить файл не удалось: в этой среде скачивание недоступно.' };
    }
    const safe = String(filename || 'attachment').split(/[\\/]/).pop() || 'attachment';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safe;
    a.click();
    if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    return { saved: safe, size: blob.size };
  };

  // ═══════════════════════════════════════════════════════════
  //  CONFLUENCE
  // ═══════════════════════════════════════════════════════════
  //
  // Используется REST v1 (/rest/api) — она есть и в Server/Data Center, и
  // в Cloud. Вторая ветка из коллекции (/api/v2) существует только в
  // Cloud, а эти инструменты объявлены как «внутренний Confluence»:
  // поддерживать две ветки ради второго случая значило бы удваивать
  // каждый обработчик ради среды, которой у пользователя нет.

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

    // /user/current — то же, что проверяет коллекция: он отвечает не
    // «сервер жив», а «токен принят и вот чьими правами мы работаем».
    // Разница существенная: список пространств бывает пустым и у гостя.
    const me = await this._wikiRequest('confluence', { path: '/rest/api/user/current' });
    if (!me.error) {
      return {
        configured: true, baseUrl: cfg.baseUrl, reachable: true,
        account: me.data?.username || me.data?.accountId,
        displayName: me.data?.displayName,
        note: 'Токен хранится зашифрованным и не отдаётся ни в одном ответе.',
      };
    }

    // Часть сборок закрывает /user/current — тогда проверяем связь так же,
    // как раньше: одним пространством.
    const spaces = await this._wikiRequest('confluence', { path: '/rest/api/space?limit=1' });
    return {
      configured: true,
      baseUrl: cfg.baseUrl,
      reachable: !spaces.error,
      error: spaces.error,
      note: 'Токен хранится зашифрованным и не отдаётся ни в одном ответе.',
    };
  });

  this.registerHandler('builtin_confluence_list_spaces', async (params) => {
    const limit = intIn(params.limit, 25, 1, 100);
    const start = intIn(params.start, 0, 0, 100000);
    const type = ['global', 'personal'].includes(params.type) ? params.type : '';
    const r = await this._wikiRequest('confluence', {
      path: `/rest/api/space?limit=${limit}&start=${start}` + (type ? `&type=${type}` : ''),
    });
    if (r.error) return r;
    const spaces = (r.data.results || []).map((s) => ({ key: s.key, name: s.name, type: s.type }));
    return {
      spaces,
      start,
      more: (r.data.size ?? spaces.length) >= limit
        ? 'Показаны не все: повтори с start = ' + (start + limit) : undefined,
    };
  });

  this.registerHandler('builtin_confluence_list_pages', async (params) => {
    const space = String(params.space || '').trim();
    const parentId = String(params.parent_id || '').trim();
    if (!space && !parentId) return { error: 'Нужен space (страницы пространства) или parent_id (дочерние страницы)' };
    const limit = intIn(params.limit, 25, 1, 100);
    const start = intIn(params.start, 0, 0, 100000);

    const path = parentId
      ? `/rest/api/content/${encodeURIComponent(parentId)}/child/page?limit=${limit}&start=${start}&expand=version`
      : `/rest/api/space/${encodeURIComponent(space)}/content/page?limit=${limit}&start=${start}` +
        `&depth=${params.depth === 'root' ? 'root' : 'all'}`;

    const r = await this._wikiRequest('confluence', { path });
    if (r.error) return r;
    const pages = (r.data.results || []).map((p) => ({
      id: p.id, title: p.title, version: p.version?.number, url: p._links?.webui,
    }));
    return {
      of: parentId ? { parentId } : { space },
      count: pages.length,
      pages,
      start,
      more: pages.length >= limit ? 'Показаны не все: повтори с start = ' + (start + limit) : undefined,
    };
  });

  this.registerHandler('builtin_confluence_search', async (params) => {
    const cql = String(params.cql || '').trim();
    const text = String(params.text || '').trim();
    if (!cql && !text) return { error: 'Нужен text (простой поиск) или cql (точный запрос)' };
    const limit = intIn(params.limit, 10, 1, 50);
    const start = intIn(params.start, 0, 0, 100000);

    let query = cql;
    if (!query) {
      const parts = [`text ~ "${text.replace(/"/g, '\\"')}"`];
      if (params.space) parts.push(`space = "${String(params.space).replace(/"/g, '')}"`);
      if (params.type) parts.push(`type = "${String(params.type).replace(/"/g, '')}"`);
      query = parts.join(' and ');
    }

    const r = await this._wikiRequest('confluence', {
      path: `/rest/api/content/search?cql=${encodeURIComponent(query)}&limit=${limit}&start=${start}`,
    });
    if (r.error) return r;

    const results = (r.data.results || []).map((it) => ({
      id: it.id, type: it.type, title: it.title,
      space: it.space?.key || it._expandable?.space?.split('/').pop(),
      url: it._links?.webui || undefined,
    }));
    return {
      query, found: r.data.size ?? results.length, results, start,
      more: results.length >= limit ? 'Показаны не все: повтори с start = ' + (start + limit) : undefined,
    };
  });

  this.registerHandler('builtin_confluence_get_page', async (params) => {
    const id = String(params.page_id || '').trim();
    const title = String(params.title || '').trim();
    const space = String(params.space || '').trim();
    // 'storage' — исходник страницы как есть. Он нужен для правки: писать
    // изменённое тело, вычитав только текст без разметки, значит стереть
    // разметку целиком (см. предупреждение у confluence_update_page).
    const format = ['text', 'storage', 'view'].includes(params.format) ? params.format : 'text';
    const bodyExpand = format === 'view' ? 'body.view' : 'body.storage';
    const expand = `${bodyExpand},version,space,ancestors`;

    let path;
    if (id) {
      path = `/rest/api/content/${encodeURIComponent(id)}?expand=${expand}`;
    } else if (title) {
      path = `/rest/api/content?expand=${expand}&title=` + encodeURIComponent(title) +
             (space ? '&spaceKey=' + encodeURIComponent(space) : '');
    } else {
      return { error: 'Нужен page_id или title (можно вместе со space)' };
    }

    const r = await this._wikiRequest('confluence', { path });
    if (r.error) return r;

    const page = id ? r.data : (r.data.results || [])[0];
    if (!page) return { error: 'Страница не найдена', status: 404 };

    const raw = format === 'view' ? page.body?.view?.value : page.body?.storage?.value;
    const body = await clip(format === 'storage' ? raw : toPlainText(raw));
    const ancestors = (page.ancestors || []).map((a) => ({ id: a.id, title: a.title }));

    return {
      id: page.id, title: page.title,
      space: page.space?.key,
      version: page.version?.number,
      url: page._links?.webui,
      parent: ancestors.length ? ancestors[ancestors.length - 1] : undefined,
      format,
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
      type: params.type === 'blogpost' ? 'blogpost' : 'page',
      title,
      space: { key: space },
      body: { storage: { value: content, representation: 'storage' } },
    };
    if (params.parent_id) payload.ancestors = [{ id: String(params.parent_id) }];

    const r = await this._wikiRequest('confluence', {
      method: 'POST', path: '/rest/api/content',
      contentType: 'application/json', body: JSON.stringify(payload),
    });
    if (r.error) return r;
    return {
      success: true, id: r.data.id, title: r.data.title,
      version: r.data.version?.number, url: r.data._links?.webui,
    };
  });

  this.registerHandler('builtin_confluence_update_page', async (params) => {
    const id = String(params.page_id || '').trim();
    if (!id) return { error: 'Нужен page_id' };

    // Confluence требует номер следующей версии. Берём текущий сам, а не
    // просим у модели: она его выдумает, и правка молча уйдёт в конфликт.
    const cur = await this._wikiRequest('confluence', {
      path: `/rest/api/content/${encodeURIComponent(id)}?expand=version,space,ancestors`,
    });
    if (cur.error) return cur;

    const payload = {
      id, type: cur.data.type || 'page',
      title: String(params.title || cur.data.title),
      space: { key: cur.data.space?.key },
      version: { number: (cur.data.version?.number || 0) + 1, message: params.comment || 'Изменено агентом' },
      body: { storage: { value: String(params.content || ''), representation: 'storage' } },
    };
    // Смена родителя тем же вызовом — так же, как это делает коллекция:
    // отдельного «переместить страницу» в API нет.
    if (params.parent_id) payload.ancestors = [{ id: String(params.parent_id) }];

    const r = await this._wikiRequest('confluence', {
      method: 'PUT', path: `/rest/api/content/${encodeURIComponent(id)}`,
      contentType: 'application/json', body: JSON.stringify(payload),
    });
    if (r.error) return r;
    return {
      success: true, id: r.data.id, title: r.data.title,
      version: r.data.version?.number, url: r.data._links?.webui,
    };
  });

  this.registerHandler('builtin_confluence_delete_page', async (params) => {
    const id = String(params.page_id || '').trim();
    if (!id) return { error: 'Нужен page_id' };

    // Что именно удаляем — выясняем ДО удаления: после него имя страницы
    // уже неоткуда взять, а в отчёте пользователю нужен заголовок, а не
    // голый номер.
    const cur = await this._wikiRequest('confluence', {
      path: `/rest/api/content/${encodeURIComponent(id)}?expand=space`,
    });
    if (cur.error) return cur;

    const r = await this._wikiRequest('confluence', {
      method: 'DELETE', path: `/rest/api/content/${encodeURIComponent(id)}?status=current`,
      accept: '*/*',
    });
    if (r.error) return r;
    return {
      success: true, id,
      title: cur.data?.title, space: cur.data?.space?.key,
      note: 'Страница перемещена в корзину пространства. Восстановить или удалить окончательно ' +
            'можно в интерфейсе Confluence — этот инструмент корзину не трогает.',
    };
  });

  this.registerHandler('builtin_confluence_labels', async (params) => {
    const id = String(params.page_id || '').trim();
    const action = String(params.action || 'list').toLowerCase();
    if (!id) return { error: 'Нужен page_id' };

    if (action === 'list') {
      const r = await this._wikiRequest('confluence', {
        path: `/rest/api/content/${encodeURIComponent(id)}/label`,
      });
      if (r.error) return r;
      return { page_id: id, labels: (r.data.results || []).map((l) => ({ name: l.name, prefix: l.prefix })) };
    }

    if (action === 'add') {
      const labels = (Array.isArray(params.labels) ? params.labels : [params.labels])
        .map((l) => String(l || '').trim()).filter(Boolean);
      if (!labels.length) return { error: 'Нужен labels — список меток' };
      const r = await this._wikiRequest('confluence', {
        method: 'POST', path: `/rest/api/content/${encodeURIComponent(id)}/label`,
        contentType: 'application/json',
        body: JSON.stringify(labels.map((name) => ({ prefix: 'global', name }))),
      });
      if (r.error) return r;
      return { success: true, page_id: id, added: labels, labels: (r.data.results || []).map((l) => l.name) };
    }

    if (action === 'remove') {
      const label = String(params.label || '').trim();
      if (!label) return { error: 'Нужен label — какую метку снять' };
      const r = await this._wikiRequest('confluence', {
        method: 'DELETE',
        path: `/rest/api/content/${encodeURIComponent(id)}/label/${encodeURIComponent(label)}`,
        accept: '*/*',
      });
      if (r.error) return r;
      return { success: true, page_id: id, removed: label };
    }

    return { error: 'action должен быть list, add или remove' };
  });

  this.registerHandler('builtin_confluence_comments', async (params) => {
    const id = String(params.page_id || '').trim();
    const action = String(params.action || 'list').toLowerCase();
    if (!id) return { error: 'Нужен page_id' };

    if (action === 'list') {
      const limit = intIn(params.limit, 25, 1, 100);
      const r = await this._wikiRequest('confluence', {
        path: `/rest/api/content/${encodeURIComponent(id)}/child/comment` +
              `?expand=body.storage,version,history&limit=${limit}`,
      });
      if (r.error) return r;
      const comments = [];
      for (const c of (r.data.results || [])) {
        const body = await clip(toPlainText(c.body?.storage?.value));
        comments.push({
          id: c.id,
          author: c.history?.createdBy?.displayName,
          created: c.history?.createdDate,
          text: body.text,
          truncated: body.truncated || undefined,
        });
      }
      return { page_id: id, count: comments.length, comments };
    }

    if (action === 'add') {
      const content = String(params.content || '').trim();
      if (!content) return { error: 'Нужен content — текст комментария в формате storage (XHTML)' };
      const r = await this._wikiRequest('confluence', {
        method: 'POST', path: '/rest/api/content',
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'comment',
          container: { id, type: 'page' },
          body: { storage: { value: content, representation: 'storage' } },
        }),
      });
      if (r.error) return r;
      return { success: true, page_id: id, comment_id: r.data.id };
    }

    return { error: 'action должен быть list или add' };
  });

  this.registerHandler('builtin_confluence_attachments', async (params) => {
    const pageId = String(params.page_id || '').trim();
    const action = String(params.action || 'list').toLowerCase();
    if (!pageId) return { error: 'Нужен page_id' };

    const listPath = `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment` +
                     `?limit=${intIn(params.limit, 25, 1, 100)}&expand=version`;

    if (action === 'list') {
      const r = await this._wikiRequest('confluence', { path: listPath });
      if (r.error) return r;
      return {
        page_id: pageId,
        attachments: (r.data.results || []).map((a) => ({
          id: a.id, name: a.title,
          mediaType: a.metadata?.mediaType,
          size: a.extensions?.fileSize,
          version: a.version?.number,
        })),
      };
    }

    if (action === 'download') {
      const attId = String(params.attachment_id || '').trim();
      if (!attId) return { error: 'Нужен attachment_id — возьми его из action: "list"' };

      // Имя файла берём из перечня вложений: в самом ответе на скачивание
      // его может не быть, а сохранять файл под номером вложения — значит
      // отдать пользователю нечто без расширения, которое он не откроет.
      let filename = String(params.filename || '').trim();
      if (!filename) {
        const list = await this._wikiRequest('confluence', { path: listPath });
        if (!list.error) {
          const found = (list.data.results || []).find((a) => a.id === attId);
          if (found) filename = found.title;
        }
      }

      const r = await this._wikiRequest('confluence', {
        path: `/rest/api/content/${encodeURIComponent(pageId)}/child/attachment/` +
              `${encodeURIComponent(attId)}/download`,
        accept: '*/*', binary: true,
      });
      if (r.error) return r;

      const done = deliverFile(r.blob, filename || attId);
      if (done.error) return done;
      return {
        success: true, page_id: pageId, attachment_id: attId, savedAs: done.saved, size: done.size,
        note: 'Файл сохранён пользователю. Его содержимое тебе не передавалось: ' +
              'скажи, что файл скачан, и не описывай, что внутри.',
      };
    }

    return { error: 'action должен быть list или download' };
  });

  this.registerHandler('builtin_confluence_convert_markup', async (params) => {
    const value = String(params.value || '');
    if (!value) return { error: 'Нужен value — текст для преобразования' };
    const from = ['wiki', 'storage', 'editor'].includes(params.from) ? params.from : 'wiki';
    const to = ['storage', 'view'].includes(params.to) ? params.to : 'storage';

    const r = await this._wikiRequest('confluence', {
      method: 'POST', path: `/rest/api/contentbody/convert/${to}`,
      contentType: 'application/json',
      body: JSON.stringify({ value, representation: from }),
    });
    if (r.error) return r;
    const out = await clip(r.data?.value);
    return {
      from, to, value: out.text, truncated: out.truncated || undefined,
      note: to === 'storage'
        ? 'Готово для content в confluence_create_page / confluence_update_page.'
        : undefined,
    };
  });

  // ═══════════════════════════════════════════════════════════
  //  XWIKI
  // ═══════════════════════════════════════════════════════════
  //
  // Адрес страницы в REST xWiki собирается из имени вики и вложенных
  // пространств: вика eawiki, пространство Docs.Team, страница WebHome →
  // /rest/wikis/eawiki/spaces/Docs/spaces/Team/pages/WebHome

  const xwikiRoot = async (params) => {
    const cfg = await this._wikiConfig('xwiki');
    const wiki = String(params?.wiki || cfg.wiki || 'xwiki').trim();
    return '/rest/wikis/' + encodeURIComponent(wiki);
  };

  const spaceSegments = (space) => String(space || 'Main').split('.').filter(Boolean)
    .map((p) => '/spaces/' + encodeURIComponent(p)).join('');

  // Путь страницы (или её подресурса: history, comments, attachments…).
  const xwikiPagePath = async (params, tail = '') => {
    const page = String(params.page || '').trim();
    return (await xwikiRoot(params)) + spaceSegments(params.space) +
           '/pages/' + encodeURIComponent(page) + tail;
  };

  this.registerHandler('builtin_xwiki_configure', async () => {
    const ui = this.ui;
    if (!ui || typeof ui.showWikiConfigModal !== 'function') {
      return { error: 'Форма настройки недоступна (интерфейс не подключён)' };
    }
    const res = await ui.showWikiConfigModal('xwiki');
    if (!res || res.cancelled) return { cancelled: true, note: 'Пользователь закрыл форму, ничего не сохранено.' };
    return {
      success: true, baseUrl: res.baseUrl, user: res.user, wiki: res.wiki,
      note: 'Адрес, имя вики и учётная запись сохранены, пароль зашифрован и переживёт перезапуск. ' +
            'Пароль тебе не передаётся и в переписке не появляется.',
    };
  });

  this.registerHandler('builtin_xwiki_status', async () => {
    const cfg = await this._wikiConfig('xwiki');
    if (!cfg.configured) return notConfigured('xwiki');
    const r = await this._wikiRequest('xwiki', { path: '/rest/wikis?media=json' });
    if (r.error) {
      return {
        configured: true, baseUrl: cfg.baseUrl, user: cfg.user, wiki: cfg.wiki,
        reachable: false, error: r.error,
        note: 'Пароль хранится зашифрованным и не отдаётся ни в одном ответе.',
      };
    }
    const wikis = (r.data.wikis || []).map((w) => w.name || w.id).filter(Boolean);
    // Настроенное имя вики проверяем сразу: без этого первая же попытка
    // прочитать страницу отвечала бы «объект не найден», и причина —
    // опечатка в имени вики — осталась бы неочевидной.
    const known = !wikis.length || wikis.includes(cfg.wiki);
    return {
      configured: true, baseUrl: cfg.baseUrl, user: cfg.user, wiki: cfg.wiki,
      reachable: true, wikis,
      warning: known ? undefined
        : `В настройках указана вика «${cfg.wiki}», а сервер знает: ${wikis.join(', ')}. ` +
          'Скажи об этом пользователю и предложи xwiki_configure.',
      note: 'Пароль хранится зашифрованным и не отдаётся ни в одном ответе.',
    };
  });

  this.registerHandler('builtin_xwiki_list_wikis', async () => {
    const r = await this._wikiRequest('xwiki', { path: '/rest/wikis?media=json' });
    if (r.error) return r;
    return { wikis: (r.data.wikis || []).map((w) => ({ id: w.id, name: w.name })) };
  });

  this.registerHandler('builtin_xwiki_list_spaces', async (params) => {
    const r = await this._wikiRequest('xwiki', { path: (await xwikiRoot(params)) + '/spaces?media=json' });
    if (r.error) return r;
    return {
      spaces: (r.data.spaces || []).map((s) => ({ name: s.name, home: s.home, wiki: s.wiki })),
    };
  });

  this.registerHandler('builtin_xwiki_list_pages', async (params) => {
    const space = String(params.space || '').trim();
    if (!space) return { error: 'Нужен space — пространство, страницы которого перечислить' };
    const r = await this._wikiRequest('xwiki', {
      path: (await xwikiRoot(params)) + spaceSegments(space) + '/pages?media=json',
    });
    if (r.error) return r;
    const items = r.data.pageSummaries || r.data.pages || [];
    return {
      space,
      count: items.length,
      pages: items.map((p) => ({
        page: p.name, title: p.title, fullName: p.fullName, parent: p.parent || undefined,
      })),
    };
  });

  this.registerHandler('builtin_xwiki_search', async (params) => {
    const q = String(params.query || '').trim();
    if (!q) return { error: 'Нужен query' };
    const limit = intIn(params.limit, 10, 1, 50);
    // scope: где искать. content — по тексту, name/title — по имени и
    // заголовку страницы, objects — по значениям свойств объектов.
    const allowed = ['content', 'name', 'title', 'objects'];
    const scopes = (Array.isArray(params.scope) ? params.scope : [params.scope || 'content'])
      .map((s) => String(s || '').trim()).filter((s) => allowed.includes(s));
    const scopeQuery = (scopes.length ? scopes : ['content']).map((s) => '&scope=' + s).join('');

    const r = await this._wikiRequest('xwiki', {
      path: (await xwikiRoot(params)) + `/search?q=${encodeURIComponent(q)}${scopeQuery}` +
            `&number=${limit}&media=json`,
    });
    if (r.error) return r;
    const items = r.data.searchResults || [];
    return {
      query: q, scope: scopes.length ? scopes : ['content'], found: items.length,
      results: items.map((it) => ({
        title: it.title, space: it.space, page: it.pageName,
        url: it.pageFullName || it.id, author: it.author, modified: it.modified,
      })),
    };
  });

  this.registerHandler('builtin_xwiki_get_page', async (params) => {
    const page = String(params.page || '').trim();
    if (!page) return { error: 'Нужен page (и обычно space, например Main)' };
    // 'source' — исходник в синтаксисе XWiki 2.1, как он лежит на сервере.
    // Это и есть то, что нужно для правки; 'text' — отрендеренная страница
    // без разметки, для чтения глазами и пересказа.
    const format = params.format === 'text' ? 'text' : 'source';
    const version = String(params.version || '').trim();
    const base = await xwikiPagePath(params, version ? '/history/' + encodeURIComponent(version) : '');

    if (format === 'text') {
      const rendered = await this._wikiRequest('xwiki', { path: base, accept: 'text/html' });
      if (rendered.error) return rendered;
      const body = await clip(toPlainText(rendered.text));
      return {
        space: params.space, page, version: version || undefined, format,
        content: body.text, truncated: body.truncated, contentLength: body.length,
        note: 'Показан отрендеренный текст без разметки. Для правки возьми format: "source".',
      };
    }

    const r = await this._wikiRequest('xwiki', { path: base + '?media=json' });
    if (r.error) return r;
    const body = await clip(r.data.content);
    return {
      space: r.data.space, page: r.data.name, title: r.data.title,
      version: r.data.version, author: r.data.author, modified: r.data.modified,
      parent: r.data.parent || undefined,
      syntax: r.data.syntax,
      format,
      content: body.text, truncated: body.truncated, contentLength: body.length,
      note: body.truncated ? 'Текст сокращён по общему пределу ответа инструмента.' : undefined,
    };
  });

  // В xWiki создание и обновление — один и тот же PUT: страница создаётся,
  // если её нет. Разделено на два инструмента намеренно: у них разный смысл
  // для модели и разный вес для политики (перезапись существующей страницы —
  // не то же самое, что создание новой).
  const xwikiPut = async (params, { overwrite }) => {
    const page = String(params.page || '').trim();
    if (!page) return { error: 'Нужен page (и обычно space)' };

    const path = await xwikiPagePath(params);
    if (!overwrite) {
      const exists = await this._wikiRequest('xwiki', { path: path + '?media=json' });
      if (!exists.error) {
        return {
          error: `Страница ${params.space || 'Main'}.${page} уже существует.`,
          hint: 'Чтобы изменить её, вызови xwiki_update_page — так правка существующего ' +
                'не происходит по недоразумению.',
        };
      }
    }

    const fields = [
      'title=' + encodeURIComponent(String(params.title || page)),
      'content=' + encodeURIComponent(String(params.content || '')),
    ];
    if (params.parent) fields.push('parent=' + encodeURIComponent(String(params.parent)));
    if (params.syntax) fields.push('syntax=' + encodeURIComponent(String(params.syntax)));

    const r = await this._wikiRequest('xwiki', {
      method: 'PUT', path, body: fields.join('&'),
      contentType: 'application/x-www-form-urlencoded',
    });
    if (r.error) return r;
    return {
      success: true,
      space: r.data?.space ?? params.space, page: r.data?.name ?? page,
      version: r.data?.version,
    };
  };

  this.registerHandler('builtin_xwiki_create_page', (params) => xwikiPut(params, { overwrite: false }));
  this.registerHandler('builtin_xwiki_update_page', (params) => xwikiPut(params, { overwrite: true }));

  this.registerHandler('builtin_xwiki_delete_page', async (params) => {
    const page = String(params.page || '').trim();
    if (!page) return { error: 'Нужен page (и обычно space)' };
    const path = await xwikiPagePath(params);

    // Читаем перед удалением: после него ни заголовка, ни версии уже не
    // получить, а пользователю нужно понимать, что именно исчезло.
    const cur = await this._wikiRequest('xwiki', { path: path + '?media=json' });
    if (cur.error) return cur;

    const r = await this._wikiRequest('xwiki', { method: 'DELETE', path, accept: '*/*' });
    if (r.error) return r;
    return {
      success: true, space: params.space || 'Main', page,
      title: cur.data?.title, wasVersion: cur.data?.version,
      note: 'В xWiki удаление страницы через REST необратимо: корзины у этого вызова нет.',
    };
  });

  this.registerHandler('builtin_xwiki_history', async (params) => {
    const page = String(params.page || '').trim();
    if (!page) return { error: 'Нужен page (и обычно space)' };
    const r = await this._wikiRequest('xwiki', {
      path: (await xwikiPagePath(params, '/history')) + '?media=json',
    });
    if (r.error) return r;
    const items = r.data.historySummaries || r.data.history || [];
    const limit = intIn(params.limit, 20, 1, 100);
    return {
      space: params.space || 'Main', page,
      versions: items.slice(-limit).reverse().map((h) => ({
        version: h.version, modified: h.modified, author: h.modifier || h.author, comment: h.comment,
      })),
      note: 'Чтобы прочитать конкретную версию, вызови xwiki_get_page с параметром version.',
    };
  });

  this.registerHandler('builtin_xwiki_comments', async (params) => {
    const page = String(params.page || '').trim();
    const action = String(params.action || 'list').toLowerCase();
    if (!page) return { error: 'Нужен page (и обычно space)' };

    if (action === 'list') {
      const r = await this._wikiRequest('xwiki', {
        path: (await xwikiPagePath(params, '/comments')) + '?media=json',
      });
      if (r.error) return r;
      const comments = [];
      for (const c of (r.data.comments || [])) {
        const body = await clip(c.text);
        comments.push({ id: c.id, author: c.author, date: c.date, text: body.text });
      }
      return { space: params.space || 'Main', page, count: comments.length, comments };
    }

    if (action === 'add') {
      const text = String(params.text || '').trim();
      if (!text) return { error: 'Нужен text — текст комментария' };
      const r = await this._wikiRequest('xwiki', {
        method: 'POST', path: await xwikiPagePath(params, '/comments'),
        contentType: 'application/xml',
        body: `<comment xmlns="http://www.xwiki.org"><text>${xmlEsc(text)}</text></comment>`,
      });
      if (r.error) return r;
      return { success: true, space: params.space || 'Main', page };
    }

    return { error: 'action должен быть list или add' };
  });

  this.registerHandler('builtin_xwiki_attachments', async (params) => {
    const page = String(params.page || '').trim();
    const action = String(params.action || 'list').toLowerCase();
    if (!page) return { error: 'Нужен page (и обычно space)' };

    if (action === 'list') {
      const r = await this._wikiRequest('xwiki', {
        path: (await xwikiPagePath(params, '/attachments')) + '?media=json',
      });
      if (r.error) return r;
      return {
        space: params.space || 'Main', page,
        attachments: (r.data.attachments || []).map((a) => ({
          name: a.name, size: a.size, version: a.version, author: a.author, date: a.date,
        })),
      };
    }

    if (action === 'download') {
      const name = String(params.name || '').trim();
      if (!name) return { error: 'Нужен name — имя вложения, возьми его из action: "list"' };
      const r = await this._wikiRequest('xwiki', {
        path: await xwikiPagePath(params, '/attachments/' + encodeURIComponent(name)),
        accept: '*/*', binary: true,
      });
      if (r.error) return r;
      const done = deliverFile(r.blob, name);
      if (done.error) return done;
      return {
        success: true, space: params.space || 'Main', page, savedAs: done.saved, size: done.size,
        note: 'Файл сохранён пользователю. Его содержимое тебе не передавалось: ' +
              'скажи, что файл скачан, и не описывай, что внутри.',
      };
    }

    return { error: 'action должен быть list или download' };
  });

  this.registerHandler('builtin_xwiki_objects', async (params) => {
    const page = String(params.page || '').trim();
    const action = String(params.action || 'list').toLowerCase();
    if (!page) return { error: 'Нужен page (и обычно space)' };

    if (action === 'list') {
      const r = await this._wikiRequest('xwiki', {
        path: (await xwikiPagePath(params, '/objects')) + '?media=json',
      });
      if (r.error) return r;
      const items = r.data.objectSummaries || r.data.objects || [];
      return {
        space: params.space || 'Main', page,
        objects: items.map((o) => ({ className: o.className, number: o.number, headline: o.headline })),
      };
    }

    const className = String(params.class_name || '').trim();
    const number = String(params.number ?? '0').trim();
    if (!className) return { error: 'Нужен class_name — класс объекта (например XWiki.XWikiUsers)' };
    const objPath = await xwikiPagePath(params,
      `/objects/${encodeURIComponent(className)}/${encodeURIComponent(number)}/properties`);

    if (action === 'get') {
      const r = await this._wikiRequest('xwiki', { path: objPath + '?media=json' });
      if (r.error) return r;
      const props = r.data.properties || [];
      const out = {};
      for (const p of props) out[p.name] = p.value;
      return { space: params.space || 'Main', page, className, number, properties: out };
    }

    if (action === 'set') {
      const props = params.properties && typeof params.properties === 'object' ? params.properties : null;
      const names = props ? Object.keys(props) : [];
      if (!names.length) return { error: 'Нужен properties — объект «свойство: значение»' };
      const xml = '<properties xmlns="http://www.xwiki.org">' +
        names.map((n) => `<property name="${xmlEsc(n)}"><value>${xmlEsc(props[n])}</value></property>`).join('') +
        '</properties>';
      const r = await this._wikiRequest('xwiki', {
        method: 'POST', path: objPath, contentType: 'application/xml', body: xml, accept: '*/*',
      });
      if (r.error) return r;
      return {
        success: true, space: params.space || 'Main', page, className, number, updated: names,
        note: 'Изменены только перечисленные свойства, остальные не тронуты.',
      };
    }

    return { error: 'action должен быть list, get или set' };
  });
});


ToolsEngine.DEF_CONTRIBUTORS.push(function wikiDefs() {
  const NEVER_ASK = 'НИКОГДА не спрашивай токен, пароль или логин сообщением в чате и не принимай их ' +
    'текстом: они попали бы в историю диалога и ушли бы провайдеру модели. Данные вводит сам ' +
    'пользователь в форме, которую открывает инструмент *_configure.';

  const WHOLE_PAGE = 'ВНИМАНИЕ: content заменяет тело страницы ЦЕЛИКОМ — сначала прочитай её ' +
    'и согласуй правку с пользователем.';

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
      description: 'Показывает, настроено ли подключение к Confluence, проверяет связь и сообщает, ' +
        'от чьего имени работает агент. Вызывай первым, если не уверен, что доступ уже настроен. ' +
        'Токен не возвращается.',
      parameters: { type: 'object', properties: {}, required: [] },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_list_spaces',
      name: 'confluence_list_spaces',
      description: 'Перечисляет пространства Confluence: ключ, название, тип. Полезно, чтобы узнать ' +
        'ключ пространства перед поиском или созданием страницы.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Сколько вернуть (1–100, по умолчанию 25)' },
          start: { type: 'number', description: 'Сколько пропустить — для следующей страницы списка' },
          type: { type: 'string', enum: ['global', 'personal'], description: 'Только общие или только личные' },
        },
        required: [],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_list_pages',
      name: 'confluence_list_pages',
      description: 'Перечисляет страницы: либо все страницы пространства (space), либо дочерние ' +
        'страницы конкретной страницы (parent_id). Возвращает id и заголовки без содержимого — ' +
        'это способ увидеть структуру, не вычитывая её целиком.',
      parameters: {
        type: 'object',
        properties: {
          space: { type: 'string', description: 'Ключ пространства' },
          parent_id: { type: 'string', description: 'Или id родительской страницы — тогда вернутся её дети' },
          depth: { type: 'string', enum: ['all', 'root'], description: 'Для space: все страницы или только верхнего уровня' },
          limit: { type: 'number', description: 'Сколько вернуть (1–100, по умолчанию 25)' },
          start: { type: 'number', description: 'Сколько пропустить — для следующей страницы списка' },
        },
        required: [],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_search',
      name: 'confluence_search',
      description: 'Ищет страницы в Confluence. Для простого поиска передай text (можно сузить ' +
        'параметрами space и type), для точного — cql (язык запросов Confluence, например: ' +
        'space = DOCS and type = page and text ~ "отпуск").',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Простой поисковый запрос по тексту' },
          cql: { type: 'string', description: 'Запрос на CQL — если нужен точный отбор' },
          space: { type: 'string', description: 'Ограничить поиск пространством (только вместе с text)' },
          type: { type: 'string', enum: ['page', 'blogpost', 'comment', 'attachment'], description: 'Что искать (только вместе с text)' },
          limit: { type: 'number', description: 'Сколько результатов вернуть (1–50, по умолчанию 10)' },
          start: { type: 'number', description: 'Сколько пропустить — для следующей страницы результатов' },
        },
        required: [],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_get_page',
      name: 'confluence_get_page',
      description: 'Читает страницу Confluence по page_id либо по title (можно уточнить space). ' +
        'format: "text" — текст без разметки (по умолчанию, для чтения и пересказа); ' +
        '"storage" — исходник страницы в формате storage (XHTML), который и нужен для правки; ' +
        '"view" — отрендеренный вид. В режиме "text" таблицы и макросы теряются.',
      parameters: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Идентификатор страницы (предпочтительно)' },
          title: { type: 'string', description: 'Или точный заголовок' },
          space: { type: 'string', description: 'Ключ пространства — уточняет поиск по заголовку' },
          format: { type: 'string', enum: ['text', 'storage', 'view'], description: 'Как вернуть содержимое' },
        },
        required: [],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_create_page',
      name: 'confluence_create_page',
      description: 'Создаёт страницу в Confluence. content — в формате storage (XHTML Confluence); ' +
        'обычный текст с абзацами <p>…</p> подходит, а разметку Confluence-wiki можно преобразовать ' +
        'через confluence_convert_markup. Перед созданием покажи пользователю, что и куда собираешься записать.',
      parameters: {
        type: 'object',
        properties: {
          space: { type: 'string', description: 'Ключ пространства' },
          title: { type: 'string', description: 'Заголовок страницы' },
          content: { type: 'string', description: 'Содержимое в формате storage (XHTML)' },
          parent_id: { type: 'string', description: 'id родительской страницы — если нужна вложенность' },
          type: { type: 'string', enum: ['page', 'blogpost'], description: 'Страница или запись блога (по умолчанию page)' },
        },
        required: ['space', 'title', 'content'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_update_page',
      name: 'confluence_update_page',
      description: 'Перезаписывает содержимое страницы Confluence, при необходимости меняет заголовок ' +
        'и родителя. Номер версии инструмент берёт с сервера сам. ' + WHOLE_PAGE + ' Читай её ' +
        'через confluence_get_page с format: "storage" — иначе правка сотрёт всю разметку.',
      parameters: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Идентификатор страницы' },
          content: { type: 'string', description: 'Новое содержимое целиком, формат storage (XHTML)' },
          title: { type: 'string', description: 'Новый заголовок, если нужно сменить' },
          parent_id: { type: 'string', description: 'Новый родитель — этим же вызовом страница переносится' },
          comment: { type: 'string', description: 'Комментарий к версии' },
        },
        required: ['page_id', 'content'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_delete_page',
      name: 'confluence_delete_page',
      description: 'Удаляет страницу Confluence — она уходит в корзину пространства. ' +
        'Вызывай только по прямой просьбе пользователя и назови ему заголовок страницы до удаления, ' +
        'а не после: сам по себе page_id ни о чём не говорит.',
      parameters: {
        type: 'object',
        properties: { page_id: { type: 'string', description: 'Идентификатор страницы' } },
        required: ['page_id'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_labels',
      name: 'confluence_labels',
      description: 'Метки страницы Confluence: action "list" — показать, "add" — добавить (labels — ' +
        'список имён), "remove" — снять одну (label). Существующие метки при добавлении сохраняются.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove'], description: 'Что сделать (по умолчанию list)' },
          page_id: { type: 'string', description: 'Идентификатор страницы' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Метки для action: add' },
          label: { type: 'string', description: 'Метка для action: remove' },
        },
        required: ['page_id'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_comments',
      name: 'confluence_comments',
      description: 'Комментарии страницы Confluence: action "list" — прочитать (текст без разметки), ' +
        '"add" — добавить свой (content в формате storage, например <p>текст</p>). ' +
        'Комментарий виден всем — согласуй текст с пользователем перед отправкой.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add'], description: 'Что сделать (по умолчанию list)' },
          page_id: { type: 'string', description: 'Идентификатор страницы' },
          content: { type: 'string', description: 'Текст комментария для action: add, формат storage' },
          limit: { type: 'number', description: 'Сколько комментариев вернуть (1–100, по умолчанию 25)' },
        },
        required: ['page_id'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_attachments',
      name: 'confluence_attachments',
      description: 'Вложения страницы Confluence: action "list" — перечислить (имя, тип, размер, id), ' +
        '"download" — сохранить файл пользователю по attachment_id. Содержимое файла тебе НЕ ' +
        'передаётся: после скачивания скажи, что файл сохранён, но не описывай, что внутри.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'download'], description: 'Что сделать (по умолчанию list)' },
          page_id: { type: 'string', description: 'Идентификатор страницы' },
          attachment_id: { type: 'string', description: 'Что скачать — id из action: list' },
          filename: { type: 'string', description: 'Имя файла при сохранении (по умолчанию — как во вложении)' },
          limit: { type: 'number', description: 'Сколько вложений перечислить (1–100, по умолчанию 25)' },
        },
        required: ['page_id'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_confluence_convert_markup',
      name: 'confluence_convert_markup',
      description: 'Преобразует разметку силами самого Confluence: from "wiki" → to "storage" — ' +
        'превратить привычную вики-разметку (h1. Заголовок, *жирный*) в формат, который принимают ' +
        'confluence_create_page и confluence_update_page; from "storage" → to "view" — посмотреть, ' +
        'как содержимое отобразится. Пиши разметку через этот инструмент, а не собирай XHTML на глаз.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'Исходный текст' },
          from: { type: 'string', enum: ['wiki', 'storage', 'editor'], description: 'Формат исходного текста (по умолчанию wiki)' },
          to: { type: 'string', enum: ['storage', 'view'], description: 'Во что преобразовать (по умолчанию storage)' },
        },
        required: ['value'],
      },
      enabled: false, builtin: true,
    },

    // ── xWiki ──
    {
      id: 'builtin_xwiki_configure',
      name: 'xwiki_configure',
      description: 'Открывает пользователю форму подключения к xWiki On-Premise: адрес, имя вики ' +
        '(на одной установке их бывает несколько), имя учётной записи и пароль (Basic-авторизация). ' +
        'Значения сохраняются надолго (пароль — в зашифрованном виде) и переживают перезапуск. ' + NEVER_ASK,
      parameters: { type: 'object', properties: {}, required: [] },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_status',
      name: 'xwiki_status',
      description: 'Показывает, настроено ли подключение к xWiki, проверяет связь и сверяет имя вики ' +
        'из настроек с тем, что знает сервер. Пароль не возвращается.',
      parameters: { type: 'object', properties: {}, required: [] },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_list_wikis',
      name: 'xwiki_list_wikis',
      description: 'Перечисляет вики на этой установке xWiki. Нужен, когда страница не находится: ' +
        'возможно, она в другой вике, а не в той, что задана в настройках.',
      parameters: { type: 'object', properties: {}, required: [] },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_list_spaces',
      name: 'xwiki_list_spaces',
      description: 'Перечисляет пространства xWiki.',
      parameters: {
        type: 'object',
        properties: { wiki: { type: 'string', description: 'Другая вика, если не та, что в настройках' } },
        required: [],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_list_pages',
      name: 'xwiki_list_pages',
      description: 'Перечисляет страницы пространства xWiki: имя, заголовок, родитель — без ' +
        'содержимого. Способ увидеть, что есть в пространстве, не вычитывая страницы.',
      parameters: {
        type: 'object',
        properties: {
          space: { type: 'string', description: 'Пространство, например Main или Docs.Team' },
          wiki: { type: 'string', description: 'Другая вика, если не та, что в настройках' },
        },
        required: ['space'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_search',
      name: 'xwiki_search',
      description: 'Ищет страницы в xWiki. scope задаёт, где искать: content (по тексту, ' +
        'по умолчанию), name, title, objects — можно перечислить несколько.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос' },
          scope: { type: 'array', items: { type: 'string', enum: ['content', 'name', 'title', 'objects'] }, description: 'Где искать' },
          limit: { type: 'number', description: 'Сколько результатов (1–50, по умолчанию 10)' },
          wiki: { type: 'string', description: 'Другая вика, если не та, что в настройках' },
        },
        required: ['query'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_get_page',
      name: 'xwiki_get_page',
      description: 'Читает страницу xWiki. space — пространство (вложенные через точку: Docs.Team), ' +
        'page — имя страницы. format: "source" — исходник в синтаксисе XWiki 2.1 (по умолчанию, ' +
        'и именно он нужен для правки), "text" — отрендеренный текст без разметки. ' +
        'version читает старую версию (номера — в xwiki_history).',
      parameters: {
        type: 'object',
        properties: {
          space: { type: 'string', description: 'Пространство, например Main или Docs.Team' },
          page: { type: 'string', description: 'Имя страницы' },
          format: { type: 'string', enum: ['source', 'text'], description: 'Исходник или отрендеренный текст' },
          version: { type: 'string', description: 'Номер версии, например 2.1 — по умолчанию текущая' },
          wiki: { type: 'string', description: 'Другая вика, если не та, что в настройках' },
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
          parent: { type: 'string', description: 'Родительская страница, например Docs.WebHome' },
          syntax: { type: 'string', description: 'Синтаксис содержимого, по умолчанию xwiki/2.1' },
          wiki: { type: 'string', description: 'Другая вика, если не та, что в настройках' },
        },
        required: ['page', 'content'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_update_page',
      name: 'xwiki_update_page',
      description: 'Перезаписывает страницу xWiki ЦЕЛИКОМ. ' + WHOLE_PAGE + ' Читай её через ' +
        'xwiki_get_page с format: "source" — тогда правишь ровно то, что лежит на сервере.',
      parameters: {
        type: 'object',
        properties: {
          space: { type: 'string', description: 'Пространство' },
          page: { type: 'string', description: 'Имя страницы' },
          title: { type: 'string', description: 'Заголовок' },
          content: { type: 'string', description: 'Новое содержимое целиком, синтаксис XWiki 2.1' },
          parent: { type: 'string', description: 'Родительская страница' },
          syntax: { type: 'string', description: 'Синтаксис содержимого, по умолчанию xwiki/2.1' },
          wiki: { type: 'string', description: 'Другая вика, если не та, что в настройках' },
        },
        required: ['page', 'content'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_delete_page',
      name: 'xwiki_delete_page',
      description: 'Удаляет страницу xWiki. В отличие от Confluence корзины здесь нет — удаление ' +
        'необратимо. Вызывай только по прямой просьбе пользователя и сначала назови ему заголовок ' +
        'страницы, которую собираешься удалить.',
      parameters: {
        type: 'object',
        properties: {
          space: { type: 'string', description: 'Пространство' },
          page: { type: 'string', description: 'Имя страницы' },
          wiki: { type: 'string', description: 'Другая вика, если не та, что в настройках' },
        },
        required: ['page'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_history',
      name: 'xwiki_history',
      description: 'История версий страницы xWiki: номер версии, дата, автор, комментарий. ' +
        'Прочитать конкретную версию можно через xwiki_get_page с параметром version.',
      parameters: {
        type: 'object',
        properties: {
          space: { type: 'string', description: 'Пространство' },
          page: { type: 'string', description: 'Имя страницы' },
          limit: { type: 'number', description: 'Сколько последних версий показать (1–100, по умолчанию 20)' },
          wiki: { type: 'string', description: 'Другая вика, если не та, что в настройках' },
        },
        required: ['page'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_comments',
      name: 'xwiki_comments',
      description: 'Комментарии страницы xWiki: action "list" — прочитать, "add" — добавить свой ' +
        '(text). Комментарий виден всем — согласуй текст с пользователем перед отправкой.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add'], description: 'Что сделать (по умолчанию list)' },
          space: { type: 'string', description: 'Пространство' },
          page: { type: 'string', description: 'Имя страницы' },
          text: { type: 'string', description: 'Текст комментария для action: add' },
          wiki: { type: 'string', description: 'Другая вика, если не та, что в настройках' },
        },
        required: ['page'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_attachments',
      name: 'xwiki_attachments',
      description: 'Вложения страницы xWiki: action "list" — перечислить (имя, размер, версия), ' +
        '"download" — сохранить файл пользователю по name. Содержимое файла тебе НЕ передаётся: ' +
        'после скачивания скажи, что файл сохранён, но не описывай, что внутри.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'download'], description: 'Что сделать (по умолчанию list)' },
          space: { type: 'string', description: 'Пространство' },
          page: { type: 'string', description: 'Имя страницы' },
          name: { type: 'string', description: 'Имя вложения для action: download' },
          wiki: { type: 'string', description: 'Другая вика, если не та, что в настройках' },
        },
        required: ['page'],
      },
      enabled: false, builtin: true,
    },
    {
      id: 'builtin_xwiki_objects',
      name: 'xwiki_objects',
      description: 'Объекты страницы xWiki — структурированные данные, приложенные к странице ' +
        '(карточки, записи справочников, настройки). action "list" — какие объекты есть, ' +
        '"get" — значения свойств одного объекта, "set" — изменить перечисленные свойства ' +
        '(остальные не трогаются). Правку согласуй с пользователем: за объектами обычно стоят таблицы и отчёты.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'set'], description: 'Что сделать (по умолчанию list)' },
          space: { type: 'string', description: 'Пространство' },
          page: { type: 'string', description: 'Имя страницы' },
          class_name: { type: 'string', description: 'Класс объекта, например XWiki.XWikiUsers (для get и set)' },
          number: { type: 'number', description: 'Номер объекта этого класса на странице (обычно 0)' },
          properties: { type: 'object', description: 'Для set: свойства и их новые значения' },
          wiki: { type: 'string', description: 'Другая вика, если не та, что в настройках' },
        },
        required: ['page'],
      },
      enabled: false, builtin: true,
    },
  ];
});
