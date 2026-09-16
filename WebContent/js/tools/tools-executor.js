// ============================================================
//  TOOLS EXECUTOR — исполнение инструмента и шлюз безопасности
// ============================================================
//
// Единственная точка, через которую проходит ЛЮБОЙ вызов инструмента,
// откуда бы он ни пришёл: от модели, из интерфейса, из другого
// инструмента. Поэтому проверки безопасности стоят здесь, а не в
// обработчиках — иначе новый инструмент легко забыть закрыть.

// Сколько байт разрешено отдать одним файлом из песочницы. Ограничение
// не про безопасность, а про исправность: строка в несколько сотен
// мегабайт не переживёт границу сообщений и уронит вкладку, а понятный
// отказ подскажет разбить выгрузку на части.
ToolsEngine.MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

Object.assign(ToolsEngine.prototype, {

  // timeoutMs — ограничение на выполнение ОДНОГО вызова инструмента.
  // Нужно, потому что handlerCode пишет LLM: бесконечный цикл или зависший
  // fetch внутри него иначе повесил бы всю цепочку ответа навсегда.
  // ВАЖНО: JS не умеет прерывать уже запущенный синхронный код — таймаут
  // отпускает ожидание и возвращает ошибку, но сам handler, если он завис
  // в синхронном цикле, продолжит занимать поток. Это ограничение среды;
  // полноценное прерывание требует исполнения в Worker с terminate().
  //
  // ── ОЖИДАНИЕ ЧЕЛОВЕКА ТАЙМАУТОМ НЕ ОГРАНИЧИВАЕТСЯ ──
  // Инструмент, открывающий форму (ask_user, любой *_configure, импорт
  // API с подтверждением имён), ждёт не код, а ЧЕЛОВЕКА. Общий таймаут
  // вызова означал здесь буквально «отвечай за тридцать секунд»: пока
  // пользователь печатал, гонка заканчивалась ошибкой «Timeout», агент
  // шёл дальше без ответа, а сам ответ, введённый через минуту, уходил
  // в никуда — окно-то уже никто не слушал. Такие инструменты помечены
  // в описании как interactive, и таймаут их не касается.
  //
  // Время такого ожидания возвращается наружу (humanWaitMs) и
  // вычитается из бюджета хода: раздумье человека — не работа агента.
  async executeTool(toolName, args, { timeoutMs = 0, bypassSecurity = false } = {}) {
	    var parsedArgs;
	    try {
	      parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
	    } catch (e) {
	      parsedArgs = args;
	    }

	    // ── Политика безопасности ──
	    // Единая точка проверки: любой инструмент, откуда бы он ни вызывался,
	    // проходит здесь. bypassSecurity ставится только для вызовов, которые
	    // инициировал сам пользователь кнопкой интерфейса — переспрашивать
	    // о том, что человек только что нажал, бессмысленно.
	    // Запись инструмента нужна и политике, и отметке о внешних данных
	    // ниже — читаем один раз.
	    let toolRec = null;
	    try {
	      toolRec = (await this.loadTools()).find(t => t.name === toolName) || null;
	    } catch (_) { /* загрузка списка не должна ронять вызов */ }

	    // Сколько в этом вызове ждали ЧЕЛОВЕКА, а не машину.
	    let humanWaitMs = 0;

	    if (this.security && !bypassSecurity) {
	      let verdict;
	      const checkStarted = Date.now();
	      try {
	        verdict = await this.security.check(toolName, parsedArgs, toolRec);
	      } catch (e) {
	        verdict = { allow: true }; // сбой политики не должен ломать работу
	      }
	      // Проверка без вопроса занимает миллисекунды; всё, что дольше
	      // секунды, — открытое окно подтверждения, то есть человек.
	      const checkMs = Date.now() - checkStarted;
	      if (checkMs > 1000) humanWaitMs += checkMs;

	      if (verdict && verdict.allow === false) {
	        this.security.audit({ tool: toolName, decision: 'blocked', reason: verdict.reason });
	        return { error: 'Заблокировано политикой безопасности: ' + verdict.reason, blocked: true };
	      }

	      if (verdict && verdict.confirm) {
	        const approve = this.security.confirmFn;
	        if (typeof approve === 'function') {
	          const answer = await approve({
	            toolName,
	            category: verdict.category,
	            risks: verdict.risks || [],
	            args: parsedArgs,
	            host: verdict.host,
	            // Раньше эти два поля до окна не доходили: пометка «ответ не
	            // запоминается» не показывалась даже там, где она и была
	            // главным условием разрешения (SSO через прокси).
	            noRemember: !!verdict.noRemember,
	            quarantine: !!verdict.quarantine,
	          });
	          if (!answer || !answer.approved) {
	            this.security.audit({ tool: toolName, decision: 'denied', risks: verdict.risks });
	            return {
	              error: 'Операция отклонена пользователем',
	              denied: true,
	              hint: 'Пользователь не разрешил это действие. Не пытайся выполнить его обходным путём — ' +
	                    'спроси, что делать дальше.',
	            };
	          }
	          // «Больше не спрашивать про этот адрес» — только на сессию.
	          // MCP-хосты держим в отдельном списке: разрешение «звонить
	          // на этот MCP-сервер» и разрешение «сходить по этому адресу
	          // через http_fetch» — разные по смыслу решения.
	          if (answer.rememberHost && verdict.host) {
	            if (verdict.mcp) this.security.approvedMcpHosts.add(verdict.host);
	            else this.security.approvedHosts.add(verdict.host);
	          }
	          this.security.audit({ tool: toolName, decision: 'approved', risks: verdict.risks });
	        }
	      }
	      this.security._count(this.security.categoryOf(toolName, toolRec), toolName);
	    }

	    // ── Что не журналируется никогда ──
	    // Вызовы инструментов из папки «Системные» в консоль не попадают
	    // ни в каком виде: через них проходят память агента, ответы
	    // пользователя, тела артефактов и планы задач. Это не уровень
	    // подробности, который можно поднять, — см. core/log-guard.js.
	    const silent = LogGuard.isSystemTool(toolName);
	    if (this.debug && silent) LogGuard.notice();
	    const logCall = this.debug && !silent;

	    if (logCall) {
	    console.group('%c🔧 TOOL CALL', 'color:#f39c12;font-weight:bold;font-size:13px;');
	    console.log('%cTool:', 'color:#888;', toolName);
	    console.log('%cArguments:', 'color:#888;');
	    console.dir(parsedArgs);
	    console.log('%cTimestamp:', 'color:#888;', new Date().toISOString());
	    }
	    var t0 = performance.now();

	    var result;

	    // Обёртка гонки с таймаутом (см. комментарий к сигнатуре метода).
	    // interactive снимает таймаут: там ждут человека, а не код.
	    const interactive = !!(toolRec && toolRec.interactive);
	    const runStarted = Date.now();

	    // ── Срок вызова подвижен ──
	    // Инструмент со своим кодом может открыть форму (agent_form), и
	    // заранее об этом неизвестно: пометку interactive ставят только
	    // встроенным. Поэтому срок хранится в объекте, а мост формы
	    // отодвигает его на время, которое человек провёл в окне.
	    const budget = { deadline: timeoutMs > 0 ? Date.now() + timeoutMs : 0 };
	    this._activeBudget = budget;
	    const withTimeout = (promise) => {
	      if (interactive || !timeoutMs || timeoutMs <= 0) return promise;
	      return Promise.race([
	        promise,
	        new Promise((resolve) => {
	          // Ждём ровно до срока и проверяем его заново: срок подвижен —
	          // открытая форма отодвигает его на время, которое человек
	          // провёл в окне. Перевзвод вместо опроса по таймеру: лишних
	          // пробуждений нет, а точность та же.
	          let timer = null;
	          const stop = () => clearTimeout(timer);
	          const arm = () => {
	            const left = budget.deadline - Date.now();
	            if (left <= 0) {
	              resolve({ error: 'Timeout: инструмент не ответил за ' + timeoutMs + ' мс' });
	              return;
	            }
	            timer = setTimeout(arm, left);
	          };
	          arm();
	          promise.then(stop, stop);
	        }),
	      ]);
	    };

	    try {
	      const tools = await this.loadTools();
	      const tool = tools.find(function (t) { return t.name === toolName; });

	      if (!tool) {
	        result = { error: 'Tool "' + toolName + '" not found' };
	      } else if (!tool.enabled && !bypassSecurity) {
	        // Модель не получает описание выключенного инструмента в схеме
	        // (см. getEnabledToolsForAPI), но может всё равно попытаться его
	        // вызвать — по имени из истории диалога или по памяти о нём из
	        // предыдущего хода, когда он ещё был включён. Без этой проверки
	        // вызов бы тихо выполнился в обход тумблера на вкладке Tools.
	        result = { error: 'Инструмент "' + toolName + '" отключён и недоступен для вызова.' };
	      } else if (tool.apiCall) {
	        // ← Импортированный вызов чужого API: не код, а описание запроса
	        //   (см. engines/api-import-engine.js). Выполняет его само
	        //   приложение — только оно вправе достать секрет авторизации
	        //   из шифрованного хранилища и подставить его в заголовок.
	        result = await withTimeout(this._executeApiCall(tool, parsedArgs));
	      } else if (tool.handlerCode) {
	        // ← ИСТОЧНИК ИСТИНЫ: персистентный код редактируемого инструмента.
	        //   Берётся из актуальной записи в БД на каждый вызов, поэтому
	        //   правки из UI применяются сразу, без перезагрузки страницы.
	        //
	        //   Исполняется в ИЗОЛИРОВАННОМ КАДРЕ (core/tool-sandbox.js), а
	        //   не здесь: код писала модель, и в контексте страницы ему были
	        //   бы доступны ключи провайдеров в IndexedDB, DOM приложения и
	        //   сеть с правами пользователя. Таймаут песочница обрабатывает
	        //   сама — и, в отличие от прежнего AsyncFunction, действительно
	        //   прерывает зависший код, снося кадр целиком.
	        try {
	          result = await this.sandbox.run(tool.handlerCode, parsedArgs, { timeoutMs });
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
	      // Только имя и сообщение об ошибке: сам объект исключения у
	      // системного инструмента может нести его данные.
	      console.error('🔧 TOOL ENGINE ERROR:', toolName, silent ? e.message : e);
	    } finally {
	      // ── Отметка о внешних данных ──
	      // Успешный вызов, принёсший в ход содержимое извне (страница,
	      // файл, вики, MCP-сервер), переводит ход в карантин: дальнейшая
	      // самомодификация в нём подтверждается вручную независимо от
	      // режима (см. engines/security-engine.js). Именно так выглядит
	      // сценарий инъекции: «прочитал страницу → создал инструмент».
	      if (this.security && result && !result.error) {
	        try { this.security.noteExternal(toolName, toolRec); } catch (_) {}
	      }

	      var elapsed = (performance.now() - t0).toFixed(0);
	      if (logCall) {
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

	    // У инструмента-формы всё его время — это ожидание человека:
	    // сама работа там в несколько миллисекунд. Считать точнее нечего,
	    // да и незачем: бюджет хода существует, чтобы останавливать
	    // зациклившегося агента, а не считать секунды человека.
	    if (interactive) humanWaitMs += Date.now() - runStarted;
	    if (humanWaitMs > 0) {
	      try { this.ui?.noteHumanWait?.(humanWaitMs); } catch (_) {}
	    }

	    return result;
	  },


	  // ── Мост к приложению для песочницы ──
  // Кадр инструмента изолирован намеренно и полностью: у него нет ни
  // страницы, ни диска, ни права начать скачивание (браузер запрещает
  // его в <iframe sandbox> без allow-downloads, а выдать это разрешение
  // значило бы позволить чужому коду ронять файлы на диск молча).
  // Из-за этого инструмент, который ДОЛЖЕН отдать результат файлом —
  // отчёт, выгрузка, картинка, — упирался в стену: File System Access в
  // кадре обезврежен, a.click() ничего не делает. Теперь кадр просит, а
  // файл отдаёт приложение — оно же и записывает это в журнал.
  async _sandboxHost({ kind, payload }) {
    if (kind === 'download') return this._sandboxDownload(payload || {});
    if (kind === 'form') return this._sandboxForm(payload || {});
    return { error: 'Песочница попросила о неизвестном действии: ' + kind };
  },

  // ── Форма по описанию из песочницы ──
  //
  // Описание приходит из кода, написанного моделью, поэтому проверяется
  // здесь, а не на стороне отрисовки: полей не больше тридцати, подписи
  // обрезаются, тип поля — только из известного списка. Разметки в
  // описании нет вовсе (см. agent_form в core/tool-sandbox.js), и всё,
  // что попадает на экран, экранируется при отрисовке.
  //
  // Время, которое человек провёл в форме, не считается работой
  // инструмента: таймаут вызова продлевается, а бюджет хода сдвигается —
  // как и при любом другом ожидании человека (см. humanWaitMs).
  async _sandboxForm(spec) {
    const ui = this.ui;
    if (!ui || typeof ui.showToolFormModal !== 'function') {
      return { error: 'Формы недоступны: интерфейс не подключён', submitted: false };
    }

    const FIELD_TYPES = new Set(['text', 'textarea', 'number', 'select', 'checkbox',
      'radio', 'password', 'date', 'info']);
    const str = (v, max) => String(v === undefined || v === null ? '' : v).slice(0, max);

    const fields = (Array.isArray(spec.fields) ? spec.fields : [])
      .slice(0, 30)
      .map((f, i) => {
        const raw = (f && typeof f === 'object') ? f : {};
        const type = FIELD_TYPES.has(raw.type) ? raw.type : 'text';
        const out = {
          type,
          name: str(raw.name || raw.id || ('field_' + (i + 1)), 64),
          label: str(raw.label || raw.title || raw.name || '', 200),
          hint: str(raw.hint || raw.description || '', 300),
          placeholder: str(raw.placeholder, 120),
          required: !!raw.required,
        };
        if (type === 'info') { out.text = str(raw.text || raw.label || '', 1000); return out; }
        if (type === 'checkbox') { out.value = !!raw.value; return out; }
        if (type === 'number') {
          out.value = raw.value === undefined || raw.value === null ? '' : Number(raw.value);
          if (raw.min !== undefined) out.min = Number(raw.min);
          if (raw.max !== undefined) out.max = Number(raw.max);
          if (raw.step !== undefined) out.step = Number(raw.step);
          return out;
        }
        if (type === 'select' || type === 'radio') {
          out.options = (Array.isArray(raw.options) ? raw.options : []).slice(0, 100).map((o) => (
            (o && typeof o === 'object')
              ? { value: str(o.value ?? o.label, 200), label: str(o.label ?? o.value, 200) }
              : { value: str(o, 200), label: str(o, 200) }
          ));
          out.value = str(raw.value, 200);
          return out;
        }
        out.value = str(raw.value, type === 'textarea' ? 20000 : 2000);
        if (type === 'textarea') out.rows = Math.min(20, Math.max(2, parseInt(raw.rows, 10) || 4));
        return out;
      });

    if (!fields.some(f => f.type !== 'info')) {
      return { error: 'В форме нет ни одного поля для ввода', submitted: false };
    }

    const startedAt = Date.now();
    let res;
    try {
      res = await ui.showToolFormModal({
        title: str(spec.title, 120) || 'Данные для инструмента',
        description: str(spec.description, 1000),
        submitLabel: str(spec.submitLabel, 40),
        fields,
      });
    } catch (e) {
      return { error: 'Форму показать не удалось: ' + ((e && e.message) || e), submitted: false };
    }

    const waited = Date.now() - startedAt;
    // Форма открыта — значит, ждали человека. Таймаут вызова отодвигаем,
    // бюджет хода тоже: иначе инструмент с формой обрывался бы ровно на
    // том месте, ради которого он написан.
    try { this.sandbox?.extendTimeout?.(waited); } catch (_) {}
    if (this._activeBudget && this._activeBudget.deadline) this._activeBudget.deadline += waited;
    try { this.ui?.noteHumanWait?.(waited); } catch (_) {}

    return res && res.submitted
      ? { submitted: true, values: res.values || {} }
      : { submitted: false, values: {} };
  },

  async _sandboxDownload({ name, content, mime, base64 }) {
    const sec = this.security;
    // Имя приходит от кода, написанного моделью. Каталоги из него
    // вырезаем: «../../важное.txt» браузер бы и так не принял, но
    // молчаливое переименование хуже понятного правила.
    let filename = String(name || '')
      .replace(/[/\\]/g, '_')
      .replace(/[\u0000-\u001f<>:"|?*]/g, '')
      .trim().slice(0, 120);
    if (!filename || /^\.+$/.test(filename)) filename = 'file-' + Date.now() + '.txt';

    const text = typeof content === 'string' ? content : String(content ?? '');
    const limit = ToolsEngine.MAX_DOWNLOAD_BYTES;
    const mb = Math.round(limit / 1048576);

    let blob;
    try {
      if (base64) {
        const clean = text.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
        const bin = atob(clean);
        if (bin.length > limit) {
          return { error: `Файл больше допустимых ${mb} МБ (${bin.length} байт). Отдай его частями.` };
        }
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
      } else {
        if (text.length > limit) {
          return { error: `Файл больше допустимых ${mb} МБ (${text.length} символов). Отдай его частями.` };
        }
        // BOM — по той же причине, что и в _downloadFile: без него Excel
        // открывает кириллицу в CSV нечитаемой.
        const type = mime || this._guessDownloadMime(filename);
        const needsBom = /csv|excel|html/.test(type);
        blob = new Blob([needsBom ? '\uFEFF' + text : text], { type });
      }
    } catch (e) {
      return { error: base64
        ? 'Содержимое не является корректным base64: ' + ((e && e.message) || 'ошибка декодирования')
        : 'Не удалось собрать файл: ' + ((e && e.message) || 'ошибка') };
    }

    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      // Ссылка добавляется в документ, а не кликается «на весу»: часть
      // браузеров игнорирует клик по элементу вне дерева документа, и
      // скачивание тогда не начинается — тихо, без ошибки.
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();
      // Отзываем не сразу: часть браузеров начинает читать blob уже
      // после возврата из click(), и мгновенный revoke обрывал бы
      // скачивание на нуле байт.
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      return { error: 'Браузер не начал скачивание: ' + ((e && e.message) || 'неизвестная причина') };
    }

    sec && sec.audit({ tool: 'sandbox_download', decision: 'executed',
      detail: filename + ' · ' + blob.size + ' байт' });

    // Формулировка осторожная намеренно. Дальше файл в руках браузера:
    // он может спросить, куда сохранять, или отказать по своим правилам
    // (запрет автоматических загрузок), и подтвердить сохранение
    // страница не может. Обещать «файл сохранён» — значит повторить ту
    // самую неправду, из-за которой всё это и переделывалось.
    return { value: { ok: true, filename, bytes: blob.size,
      note: 'Файл передан браузеру на скачивание. Если браузер спросит разрешение, ' +
        'пользователю нужно его дать; обычно файл попадает в папку загрузок.' } };
  },

  // Тип по расширению: браузер по нему выбирает, чем открывать файл, а
  // модель про mime вспоминает не всегда.
  _guessDownloadMime(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    return {
      txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
      xml: 'application/xml', html: 'text/html', htm: 'text/html', js: 'text/javascript',
      css: 'text/css', yml: 'text/yaml', yaml: 'text/yaml', svg: 'image/svg+xml',
    }[ext] || 'text/plain';
  },

  // ── Мост сети для песочницы ──
	  // Код инструмента не ходит в сеть сам: его fetch подменён и уходит
	  // сюда сообщением (см. core/tool-sandbox.js). Здесь — единственное
	  // место, где решается, выпускать ли запрос. Проверки те же, что у
	  // http_fetch, и по той же причине: адрес выбирает код, написанный
	  // моделью, а значит — потенциально текст с внешней страницы.
	  async _sandboxFetch({ url, init }) {
	    let u;
	    try { u = new URL(String(url)); }
	    catch (_) { return { error: 'Некорректный URL: ' + url }; }

	    if (!/^https?:$/.test(u.protocol)) {
	      return { error: 'Из инструмента разрешены только http/https запросы' };
	    }
	    if (this._isBlockedFetchHost(u.hostname)) {
	      return { error: 'Запрос к локальным/приватным/служебным адресам запрещён из соображений безопасности' };
	    }

	    // Максимальный режим: белый список сильнее всего остального.
	    // Спрашивать подтверждение на каждый запрос здесь намеренно не
	    // стали: инструмент вызывают ради работы, и десяток вопросов
	    // подряд приучает нажимать «да», не читая. Вместо вопроса —
	    // запись в журнале безопасности, которую видно постфактум.
	    const sec = this.security;
	    if (sec && sec.mode === 'maximum' && (sec.allowedHosts || []).length) {
	      const host = u.hostname.toLowerCase();
	      const ok = sec.allowedHosts.some(a => host === a || host.endsWith('.' + a));
	      if (!ok) {
	        sec.audit({ tool: 'sandbox_fetch', decision: 'blocked', host,
	          reason: 'Адрес вне белого списка (максимальный режим)' });
	        return { error: `Адрес ${host} не входит в список разрешённых` };
	      }
	    }

	    const method = String((init && init.method) || 'GET').toUpperCase();
	    try {
	      const resp = await fetch(u.toString(), {
	        method,
	        headers: (init && init.headers) || undefined,
	        body: (init && init.body !== undefined && method !== 'GET' && method !== 'HEAD') ? init.body : undefined,
	      });
	      const text = await resp.text();
	      const limit = (await this._toolLimits()).maxResponseChars;
	      const headers = {};
	      try { resp.headers.forEach((v, k) => { headers[String(k).toLowerCase()] = v; }); } catch (_) {}

	      sec && sec.audit({ tool: 'sandbox_fetch', decision: 'executed', host: u.hostname,
	        detail: method + ' ' + u.origin + u.pathname + ' → ' + resp.status });

	      return {
	        ok: resp.ok, status: resp.status, statusText: resp.statusText,
	        url: u.toString(), headers,
	        body: text.length > limit ? text.slice(0, limit) : text,
	      };
	    } catch (e) {
	      sec && sec.audit({ tool: 'sandbox_fetch', decision: 'blocked', host: u.hostname,
	        reason: (e && e.message) || 'сетевая ошибка' });
	      return { error: 'Запрос не выполнен: ' + ((e && e.message) || 'сетевая ошибка') };
	    }
	  },

});
