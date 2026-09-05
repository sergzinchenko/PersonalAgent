// ============================================================
//  TOOL SANDBOX — исполнение кода инструментов в изоляции
// ============================================================
//
// ЗАЧЕМ. Инструмент с собственным кодом (handlerCode) писала модель, а
// исполнялся он через AsyncFunction прямо в контексте страницы: тот же
// origin, что и у приложения. Значит, ему были доступны IndexedDB с
// ключами провайдеров, localStorage, DOM, куки и сеть с правами
// пользователя. Единственным барьером оставалось ручное включение —
// то есть внимательность человека, читающего чужой код в модальном окне.
// Это самый опасный сценарий самомодификации: текст с внешней страницы
// подсказывает модели написать инструмент, пользователь включает его не
// вчитавшись, и код получает всё.
//
// ЧТО ВМЕСТО. Код исполняется в <iframe sandbox="allow-scripts"> — БЕЗ
// allow-same-origin. Это даёт уникальный (opaque) origin: у кадра нет
// доступа ни к DOM приложения, ни к его IndexedDB и localStorage, ни к
// кукам, и он не может ничего прочитать через parent. Общение — только
// сообщениями (postMessage), то есть через явно описанный протокол.
//
// СЕТЬ — ЧЕРЕЗ МОСТ. fetch внутри кадра подменён: запрос уходит наружу
// сообщением, его выполняет родитель и только после проверки адреса
// (те же запреты, что у http_fetch: localhost, приватные подсети,
// cloud-metadata; в максимальном режиме — белый список). Прямые каналы
// (XMLHttpRequest, WebSocket, EventSource, sendBeacon) в кадре
// обезврежены: иначе мост можно было бы обойти, и проверка адреса
// превратилась бы в формальность. Побочный, но важный эффект: теперь
// видно, куда ходят инструменты, — каждый такой запрос попадает в
// журнал безопасности.
//
// ТАЙМАУТ НАКОНЕЦ РАБОТАЕТ. Раньше зависший в синхронном цикле handler
// занимал поток навсегда: JS не умеет прерывать выполняющуюся функцию.
// Теперь по таймауту кадр удаляется целиком вместе с его циклом.
//
// ЧЕГО В ПЕСОЧНИЦЕ НЕТ. localStorage/indexedDB (для памяти есть
// инструмент persistent_memory), доступа к странице приложения и к его
// данным. Обращение к ним даёт понятную ошибку, а не молчаливый сбой.
//
// ТЕСТИРУЕМОСТЬ. Код кадра — это НАСТОЯЩАЯ функция (_runtime), которая
// сериализуется в srcdoc через toString(). Так её можно выполнить в
// тесте с поддельным каналом сообщений и проверить не «строку с кодом»,
// а фактическое поведение: что вернётся, что упадёт, что обезврежено.
class ToolSandbox {
  constructor({ fetchBridge = null, doc = null } = {}) {
    // Выполняет сетевой запрос за песочницу — после проверки адреса.
    // Ставится снаружи (ToolsEngine): здесь не место политике доступа.
    this.fetchBridge = fetchBridge;
    this.doc = doc || (typeof document !== 'undefined' ? document : null);
    this.frame = null;
    this.frameReady = null;      // промис готовности кадра
    this.pending = new Map();    // id → { resolve, timer }
    this.seq = 0;
    this._onMessageBound = (ev) => this._onMessage(ev);
    this._listening = false;
    // Поколение кадра. Растёт при каждом сносе: вызов, который начался до
    // сноса и ждал готовности, не должен потом «проснуться» и повиснуть на
    // ожидании ответа от кадра, которого уже нет.
    this._generation = 0;
  }

  // Сколько ждать готовности кадра. Кадр локальный и пустой, поэтому
  // счёт идёт на миллисекунды; секунда — это уже «что-то не так».
  static READY_TIMEOUT_MS = 3000;

  // ── Код, который живёт внутри кадра ──
  // Сериализуется в srcdoc через toString(). Внутри нет доступа ни к чему
  // из этого файла: код выполняется в другом origin.
  //
  // ВАЖНО, ПОЧЕМУ ЭТО ПОЛЕ, А НЕ МЕТОД. У метода класса toString() отдаёт
  // сокращённую запись — «_runtime(bootstrap) { … }», — и она НЕ является
  // выражением-функцией: подставленная в «(…)()», она даёт синтаксическую
  // ошибку, кадр молча не запускается, а наружу выходит невнятное
  // «песочница не запустилась». Функция-выражение сериализуется в
  // «function (bootstrap) { … }» и подставляется корректно.
  static _runtime = function (bootstrap) {
    const g = bootstrap && bootstrap.global ? bootstrap.global : self;
    const post = (bootstrap && bootstrap.post) ? bootstrap.post
      : (msg) => g.parent.postMessage(msg, '*');

    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;

    // ── Обезвреживание прямых каналов ──
    // Всё, чем можно выйти в сеть мимо моста, и всё, что притворяется
    // хранилищем. Ошибка называет причину: молчаливый undefined отладить
    // невозможно, а «недоступно в песочнице» — можно.
    // Proxy, а не заглушка-функция: обращение бывает и вызовом
    // (new XMLHttpRequest()), и чтением свойства (localStorage.getItem).
    // Ошибка должна называть причину в обоих случаях, иначе разбираться
    // придётся с «undefined is not a function».
    const deny = (what, hint) => {
      const boom = () => {
        throw new Error('В песочнице инструментов ' + what + ' недоступен.' + (hint ? ' ' + hint : ''));
      };
      return new Proxy(function () {}, { get: boom, apply: boom, construct: boom, set: boom });
    };
    // Именно defineProperty, а не присваивание: localStorage, indexedDB и
    // подобное — это геттеры на прототипе Window, и присваивание им в
    // строгом режиме (а код класса всегда строгий) просто бросает
    // исключение, ничего не подменив. Собственное свойство на самом
    // объекте окна перекрывает прототипный геттер.
    const kill = (name, hint) => {
      const stub = deny(name, hint);
      try {
        Object.defineProperty(g, name, { configurable: true, get: () => stub, set: () => {} });
      } catch (_) {
        try { g[name] = stub; } catch (_2) { /* неперекрываемое свойство — не беда */ }
      }
    };
    kill('XMLHttpRequest', 'Используй fetch — он проходит проверку адреса.');
    kill('WebSocket', 'Постоянные соединения из инструментов не разрешены.');
    kill('EventSource', 'Постоянные соединения из инструментов не разрешены.');
    kill('importScripts', 'Загрузка стороннего кода в песочнице запрещена.');
    kill('localStorage', 'Для памяти между вызовами есть инструмент persistent_memory.');
    kill('sessionStorage', 'Для памяти между вызовами есть инструмент persistent_memory.');
    kill('indexedDB', 'Данные агента песочнице недоступны.');
    try { if (g.navigator && g.navigator.sendBeacon) g.navigator.sendBeacon = deny('sendBeacon'); } catch (_) {}

    // Выбор файла с диска в песочнице невозможен в принципе: File System
    // Access API требует того самого доступа к origin страницы, которого
    // здесь намеренно нет. Без этой подмены код упал бы на «undefined is
    // not a function» — и выглядело бы это как поломка, а не как граница.
    // Работа с файлами у агента и так своя: вкладка «Файлы» и инструменты
    // list_files / read_file, которым песочница не нужна.
    const filesHint = 'Файлы у агента берутся со вкладки «Файлы»: перечень — list_files, чтение — read_file.';
    kill('showOpenFilePicker', filesHint);
    kill('showSaveFilePicker', filesHint);
    kill('showDirectoryPicker', filesHint);

    // ── Мост fetch ──
    // Возвращает объект, похожий на Response настолько, насколько нужно
    // инструменту: ok/status/text()/json()/headers.get(). Полноценный
    // Response через границу сообщений не проходит — его нельзя
    // сериализовать, — а притворяться им целиком было бы обманом.
    const fetchWaiters = new Map();
    let fetchSeq = 0;
    g.fetch = function (url, init) {
      const id = 'f' + (++fetchSeq);
      const plainInit = {};
      if (init && typeof init === 'object') {
        if (init.method) plainInit.method = String(init.method);
        if (init.body !== undefined && typeof init.body === 'string') plainInit.body = init.body;
        if (init.headers) {
          plainInit.headers = {};
          try {
            if (typeof init.headers.forEach === 'function') init.headers.forEach((v, k) => { plainInit.headers[k] = String(v); });
            else for (const k of Object.keys(init.headers)) plainInit.headers[k] = String(init.headers[k]);
          } catch (_) { plainInit.headers = {}; }
        }
      }
      return new Promise((resolve, reject) => {
        fetchWaiters.set(id, { resolve, reject });
        post({ __ts: 1, type: 'fetch', id, url: String(url), init: plainInit });
      });
    };

    const makeResponse = (data) => {
      const headers = data.headers || {};
      const body = typeof data.body === 'string' ? data.body : '';
      return {
        ok: !!data.ok,
        status: data.status || 0,
        statusText: data.statusText || '',
        url: data.url || '',
        headers: {
          get: (k) => headers[String(k).toLowerCase()] ?? null,
          has: (k) => Object.prototype.hasOwnProperty.call(headers, String(k).toLowerCase()),
        },
        text: async () => body,
        json: async () => JSON.parse(body),
      };
    };

    const handle = async (msg) => {
      if (!msg || msg.__ts !== 1) return;

      if (msg.type === 'fetch-result') {
        const waiter = fetchWaiters.get(msg.id);
        if (!waiter) return;
        fetchWaiters.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error));
        else waiter.resolve(makeResponse(msg));
        return;
      }

      if (msg.type !== 'run') return;

      let value;
      try {
        const fn = new AsyncFn('params', msg.code);
        value = await fn(msg.params);
      } catch (e) {
        post({ __ts: 1, type: 'error', id: msg.id, message: (e && e.message) || String(e) });
        return;
      }

      // Результат уходит через границу сообщений, то есть обязан быть
      // сериализуемым. Функция, DOM-узел или объект с циклом сюда не
      // пролезут — говорим об этом прямо, а не роняем кадр.
      try {
        post({ __ts: 1, type: 'result', id: msg.id, value });
      } catch (_) {
        try {
          post({ __ts: 1, type: 'result', id: msg.id, value: JSON.parse(JSON.stringify(value)) });
        } catch (e2) {
          post({
            __ts: 1, type: 'error', id: msg.id,
            message: 'Инструмент вернул значение, которое нельзя передать наружу ' +
                     '(функция, DOM-узел или циклическая ссылка). Возвращай обычный объект.',
          });
        }
      }
    };

    g.addEventListener('message', (ev) => { handle(ev.data); });
    post({ __ts: 1, type: 'ready' });

    return { handle, makeResponse };   // для теста; в кадре не используется
  };

  // Содержимое srcdoc. Отдельным методом — чтобы тест мог проверить сам
  // документ (что в нём нет ничего лишнего), не создавая кадра.
  static frameSource() {
    return '<!doctype html><meta charset="utf-8"><script>(' +
      ToolSandbox._runtime.toString() + ')();<\/script>';
  }

  _ensureFrame() {
    if (this.frame && this.frameReady) return this.frameReady;
    if (!this.doc || !this.doc.createElement) {
      return Promise.reject(new Error('Песочница недоступна: нет DOM для создания кадра'));
    }

    const frame = this.doc.createElement('iframe');
    // Ровно одно разрешение: исполнять скрипты. allow-same-origin здесь
    // НЕТ и быть не может — именно его отсутствие делает origin кадра
    // уникальным и отрезает его от данных приложения.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;left:-9999px;';
    frame.srcdoc = ToolSandbox.frameSource();

    if (!this._listening) {
      (this.doc.defaultView || window).addEventListener('message', this._onMessageBound);
      this._listening = true;
    }
    (this.doc.body || this.doc.documentElement).appendChild(frame);
    this.frame = frame;

    this.frameReady = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._readyTimer = setTimeout(
        () => reject(new Error('Песочница инструментов не запустилась')), ToolSandbox.READY_TIMEOUT_MS);
    });
    // Пустой обработчик на КОПИИ промиса: если кадр снесли раньше, чем он
    // успел ответить, отказ никто не ждёт — и среда сообщила бы о
    // «необработанном отклонении», хотя обрабатывать его уже незачем.
    // Сам this.frameReady при этом продолжает отклоняться для тех, кто
    // его действительно ждёт.
    this.frameReady.catch(() => {});
    return this.frameReady;
  }

  // Единственный вход. Возвращает результат инструмента либо { error }.
  async run(code, params, { timeoutMs = 0 } = {}) {
    const generation = this._generation;
    try {
      await this._ensureFrame();
    } catch (e) {
      return { error: 'Не удалось запустить песочницу инструментов: ' + e.message };
    }
    // Пока ждали готовности, кадр могли снести — например, по таймауту
    // соседнего вызова. Отвечаем отказом, а не ждём ответа от несуществующего.
    if (generation !== this._generation) {
      return { error: 'Песочница инструментов была остановлена' };
    }

    const id = 'r' + (++this.seq);
    return new Promise((resolve) => {
      const done = (value) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        resolve(value);
      };

      const timer = timeoutMs > 0 ? setTimeout(() => {
        // Сначала ответ вызывающей стороне, потом снос: destroy() закрывает
        // все ожидания разом, и если сделать его первым, наружу уйдёт
        // общее «песочница остановлена» вместо причины — таймаута.
        done({ error: 'Timeout: инструмент не ответил за ' + timeoutMs + ' мс' });
        // Кадр сносим целиком: зависший синхронный цикл иначе продолжит
        // занимать поток — ради этого песочница отчасти и затевалась.
        this.destroy('остановлена по таймауту');
      }, timeoutMs) : null;

      this.pending.set(id, { done, timer });
      this._send({ __ts: 1, type: 'run', id, code: String(code || ''), params: params ?? {} });
    });
  }

  _send(msg) {
    try {
      this.frame.contentWindow.postMessage(msg, '*');
    } catch (e) {
      const entry = this.pending.get(msg.id);
      if (entry) entry.done({ error: 'Песочница недоступна: ' + e.message });
    }
  }

  // Проверка отправителя — по окну, а не по origin: у песочницы origin
  // равен "null", и сверять его бессмысленно. Чужие сообщения (из других
  // кадров или расширений) до обработки не доходят.
  _onMessage(ev) {
    // Кадра нет — принимать нечего: сообщение пришло не от нас, и
    // «ничьё» сообщение не должно разрешать ожидания.
    if (!this.frame || ev.source !== this.frame.contentWindow) return;
    const msg = ev.data;
    if (!msg || msg.__ts !== 1) return;

    if (msg.type === 'ready') {
      if (this._resolveReady) this._resolveReady(true);
      return;
    }

    if (msg.type === 'fetch') {
      this._bridgeFetch(msg);
      return;
    }

    const entry = this.pending.get(msg.id);
    if (!entry) return;
    if (msg.type === 'result') entry.done(msg.value);
    else if (msg.type === 'error') entry.done({ error: msg.message });
  }

  async _bridgeFetch(msg) {
    let out;
    if (typeof this.fetchBridge !== 'function') {
      out = { error: 'Сетевые запросы из инструментов не разрешены' };
    } else {
      try {
        out = await this.fetchBridge({ url: msg.url, init: msg.init || {} });
      } catch (e) {
        out = { error: (e && e.message) || String(e) };
      }
    }
    this._send({ __ts: 1, type: 'fetch-result', id: msg.id, ...out });
  }

  destroy(reason = 'остановлена') {
    this._generation++;
    clearTimeout(this._readyTimer);
    this._readyTimer = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.done({ error: 'Песочница инструментов ' + reason });
    }
    this.pending.clear();
    try { this.frame && this.frame.remove(); } catch (_) {}
    this.frame = null;
    this.frameReady = null;
    this._resolveReady = null;
  }
}
