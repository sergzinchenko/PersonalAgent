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
// ── ОГРАДА ОТ ОБФУСКАТОРА ──
// Продакшен-сборка (scripts/build-prod.js) прогоняет весь бандл через
// javascript-obfuscator. Для любого другого класса это безобидно, а
// здесь ломало песочницу насмерть, и только в собранной версии: тело
// _runtime после обфускации ссылается на расшифровщик строк, который
// живёт в бандле СНАРУЖИ функции. Сериализованная через toString() и
// подставленная в srcdoc, она теряла это окружение и падала с
// ReferenceError на первой же строке — кадр не отвечал «готов», ход
// упирался в таймаут, а пользователь видел «Не удалось запустить
// песочницу инструментов» и не мог пользоваться своими инструментами.
// Прятать этот класс всё равно бессмысленно: его код виден в кадре
// через DevTools. Сборка дополнительно проверяет, что рантайм остался
// самодостаточным, — см. assertSandboxRuntimeRuns в build-prod.js.
// javascript-obfuscator:disable
class ToolSandbox {
  constructor({ fetchBridge = null, hostBridge = null, doc = null } = {}) {
    // Выполняет сетевой запрос за песочницу — после проверки адреса.
    // Ставится снаружи (ToolsEngine): здесь не место политике доступа.
    this.fetchBridge = fetchBridge;
    // Выполняет за песочницу то, чего в изолированном кадре нет в
    // принципе: сохранение файла на диск пользователя. Ставится снаружи
    // (ToolsEngine) — здесь не место ни политике, ни работе с DOM.
    this.hostBridge = hostBridge;
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
    const filesHint = 'Файлы у агента берутся со вкладки «Файлы»: перечень — list_files, ' +
      'чтение — read_file. Чтобы ОТДАТЬ файл пользователю, вызови await agent_download(...).';
    kill('showOpenFilePicker', filesHint);
    kill('showSaveFilePicker', filesHint);
    kill('showDirectoryPicker', filesHint);
    // Ещё один молчаливый тупик: без allow-popups окно из кадра не
    // открывается, а window.open возвращает null — код продолжает
    // работу, будто всё получилось.
    kill('open', 'Окна из песочницы не открываются. Файл пользователю — agent_download({ name, content }).');

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

    // ── Мост к приложению ──
    // Всё, чего в изолированном кадре нет и быть не может, но что
    // инструменту нужно по делу. Пока такое одно: отдать пользователю
    // файл. Сам кадр этого не умеет — у него нет доступа к странице, а
    // браузер запрещает скачивание из <iframe sandbox> без
    // allow-downloads (выдавать который значило бы разрешить кадру
    // ронять файлы на диск без ведома приложения). Поэтому кадр только
    // ПРОСИТ, а решает и выполняет родитель.
    const hostWaiters = new Map();
    let hostSeq = 0;
    const hostCall = (kind, payload) => new Promise((resolve, reject) => {
      const id = 'h' + (++hostSeq);
      hostWaiters.set(id, { resolve, reject });
      post({ __ts: 1, type: 'host', kind, id, payload });
    });

    // Принимает и agent_download({ name, content }), и
    // agent_download(name, content, mime): модель пишет и так, и так, а
    // разница между «не сработало» и «вызвал не той формой» из кадра не
    // видна — там просто не появился файл.
    g.agent_download = function (a, b, c) {
      const o = (a && typeof a === 'object' && !Array.isArray(a)) ? a : { name: a, content: b, mime: c };
      let content = o.content;
      // Объект и массив сериализуем сами: иначе в файл уходит
      // «[object Object]», и обнаруживается это уже после скачивания.
      if (content !== null && typeof content === 'object' && !o.base64) {
        try { content = JSON.stringify(content, null, 2); } catch (_) { content = String(content); }
      }
      return hostCall('download', {
        name: String(o.name || o.filename || ''),
        content: content === undefined || content === null ? '' : String(content),
        mime: o.mime ? String(o.mime) : '',
        // Двоичный файл (картинка, архив, xlsx) кодируется в base64 —
        // через границу сообщений байты иначе не проходят.
        base64: !!o.base64,
      });
    };

    // ── Экранная форма ──
    //
    // ЗАЧЕМ. Инструмент часто не может работать без данных, которых нет
    // ни в разговоре, ни в настройках: выбрать одно из пятидесяти
    // значений, ввести параметры расчёта, подтвердить список перед
    // отправкой. Спрашивать это перепиской — долго и ненадёжно, а
    // ask_user умеет ровно один вопрос с одним ответом.
    //
    // ПОЧЕМУ ОПИСАНИЕ, А НЕ HTML. Кадр отделён от приложения именно
    // потому, что его код пишет модель: у него нет доступа ни к базе, ни
    // к ключам, ни к странице. Разрешить ему вставлять свой HTML в окно
    // приложения — значит отдать всё это обратно, причём молча: разметка
    // исполняется уже в origin приложения. Поэтому кадр ОПИСЫВАЕТ форму
    // (поля, их типы и подписи), а рисует её приложение — с экранированием
    // и своими стилями. Набор полей закрывает обычные задачи; произвольная
    // вёрстка внутри диалога — не задача инструмента.
    //
    // Возвращает { submitted: true, values: {...} } либо
    // { submitted: false } — если человек закрыл окно.
    // ── Срок ответа ──
    // Окно ждёт человека, а человек может не вернуться к экрану вовсе.
    // Поэтому у каждой формы есть обратный отсчёт: по умолчанию — предел
    // времени на вызов инструмента, но его можно задать своим (seconds)
    // или снять совсем (seconds: 0). Что вернуть, когда время вышло,
    // решает инструмент: onTimeout — это заранее заданный ответ, и он
    // приходит так же, как если бы его ввёл человек, только с пометкой
    // timedOut. Без onTimeout истёкший срок — отказ.
    g.agent_form = async function (spec) {
      const o = (spec && typeof spec === 'object') ? spec : {};
      const res = await hostCall('form', {
        title: String(o.title || 'Данные для инструмента'),
        description: o.description ? String(o.description) : '',
        submitLabel: o.submitLabel ? String(o.submitLabel) : '',
        fields: Array.isArray(o.fields) ? o.fields : [],
        seconds: o.seconds,
      });
      if (res && res.timedOut && o.onTimeout && typeof o.onTimeout === 'object') {
        return { submitted: true, timedOut: true, values: o.onTimeout };
      }
      return res;
    };

    // ── Своё окно с произвольной вёрсткой ──
    //
    // agent_form описывает поля, а рисует их приложение — этого хватает
    // для ввода, но не для всего: таблица с отбором, предпросмотр, схема,
    // холст. Рисовать такое приложение за инструмент не может, а пускать
    // его разметку в окно приложения нельзя — она исполнилась бы в его
    // origin, со всеми его данными.
    //
    // Выход в том, что у кадра УЖЕ есть свой документ и свой origin.
    // Приложение не рисует ничего: оно лишь показывает этот кадр как
    // модальное окно — размером, рамкой и затемнением вокруг. Внутри
    // инструмент делает что угодно: document.body его собственный, и
    // дотянуться из него до приложения по-прежнему нельзя.
    //
    //   const res = await agent_dialog({ title: 'Выбор', width: 720 }, (done) => {
    //     document.body.innerHTML = '<h2>…</h2><button id="ok">Готово</button>';
    //     document.getElementById('ok').onclick = () => done({ picked: 3 });
    //   });
    //
    // Ответ обязателен: окно существует ради него. Закрыл человек —
    // придёт { closed: true }, и это отказ, а не пустой результат.
    g.agent_dialog = async function (spec, render) {
      const o = (spec && typeof spec === 'object') ? spec : {};
      if (typeof render !== 'function') {
        return { closed: true, error: 'agent_dialog: вторым аргументом нужна функция отрисовки' };
      }
      // Содержимое документа возвращаем как было: кадр переживает вызов
      // и обслуживает следующие инструменты.
      const savedBody = document.body.innerHTML;
      const savedClass = document.body.className;

      let finish;
      const answer = new Promise((resolve) => { finish = resolve; });
      // Человек закрыл окно крестиком или клавишей — приложение скажет
      // об этом сюда; для инструмента это такой же ответ, как и любой
      // другой, просто отрицательный.
      g.__dialogClosedByUser = () => finish({ closed: true });
      // Срок ответа вышел. Заранее заданный ответ (onTimeout) приходит
      // так же, как ответ человека, только с пометкой timedOut; без него
      // истёкший срок — отказ.
      g.__dialogTimedOut = () => finish(o.onTimeout && typeof o.onTimeout === 'object'
        ? { closed: false, timedOut: true, value: o.onTimeout }
        : { closed: true, timedOut: true });

      // Отказ приложения приходит сюда исключением (так устроен мост):
      // отдаём его инструменту обычным ответом, чтобы окно, которое не
      // открылось, не роняло весь вызов.
      try {
        await hostCall('dialog', {
          action: 'open',
          title: String(o.title || 'Окно инструмента'),
          width: Math.min(1400, Math.max(320, parseInt(o.width, 10) || 720)),
          height: Math.min(900, Math.max(220, parseInt(o.height, 10) || 480)),
          seconds: o.seconds,
        });
      } catch (e) {
        g.__dialogClosedByUser = null;
        return { closed: true, error: (e && e.message) || String(e) };
      }

      // Подсказки при наведении — так же, как в окнах приложения: любому
      // элементу с классом hint и атрибутом title достаётся знак вопроса
      // и курсор-подсказка. Стиль кладётся один раз и переживает окно:
      // тело документа восстанавливается, заголовок — нет, и так и надо.
      if (!document.getElementById('agent-hint-style')) {
        const st = document.createElement('style');
        st.id = 'agent-hint-style';
        st.textContent =
          '.hint{cursor:help}' +
          '.hint::after{content:"?";display:inline-block;margin-left:5px;width:14px;height:14px;' +
          'line-height:14px;text-align:center;border-radius:50%;background:#e4e4ea;color:#555;' +
          'font:600 10px/14px system-ui,sans-serif;vertical-align:1px}' +
          '.hint:hover::after{background:#6c5ce7;color:#fff}';
        (document.head || document.documentElement).appendChild(st);
      }

      try {
        document.body.innerHTML = '';
        await render((value) => finish({ closed: false, value }));
        return await answer;
      } finally {
        g.__dialogClosedByUser = null;
        g.__dialogTimedOut = null;
        document.body.innerHTML = savedBody;
        document.body.className = savedClass;
        // Ответа приложения тут не ждём: инструменту он ничего не даёт, а
        // потеряйся он — вызов повис бы уже ПОСЛЕ того, как всё сделано.
        try { hostCall('dialog', { action: 'close' }); } catch (_) {}
      }
    };

    // ── Старый способ «скачать файл» тоже должен работать ──
    //
    // ЧТО БЫЛО. Модель пишет привычное: new Blob → URL.createObjectURL →
    // <a download> → a.click(). В кадре это НЕ падает: и Blob, и
    // createObjectURL, и сам элемент там есть, click() отрабатывает без
    // ошибки. А файла не появляется — браузер запрещает скачивание из
    // <iframe sandbox> без allow-downloads и делает это МОЛЧА. Инструмент
    // возвращал «файл сохранён», пользователь шёл в «Загрузки» и не
    // находил ничего. Хуже молчаливого отказа не бывает: по нему не
    // понять даже, где искать причину.
    //
    // ЧТО ВМЕСТО. Клик по ссылке со скачиванием перехватывается, и файл
    // уходит тем же мостом, что и agent_download: содержимое достаётся из
    // Blob (или из data:-адреса) и передаётся приложению, а оно уже
    // отдаёт файл пользователю. Так начинают работать и уже написанные
    // инструменты, которые никто не будет переписывать.
    //
    // ЧЕСТНОСТЬ ОТВЕТА. click() синхронный и ничего не возвращает, а
    // передача файла асинхронна. Поэтому начатые скачивания дожидаются
    // ПЕРЕД тем, как отдать результат инструмента (см. handle): иначе
    // «успех» снова мог бы оказаться неправдой.
    const blobUrls = new Map();
    try {
      const U = g.URL;
      if (U && typeof U.createObjectURL === 'function') {
        const realCreate = U.createObjectURL.bind(U);
        U.createObjectURL = function (obj) {
          const url = realCreate(obj);
          try { blobUrls.set(url, obj); } catch (_) {}
          return url;
        };
        if (typeof U.revokeObjectURL === 'function') {
          const realRevoke = U.revokeObjectURL.bind(U);
          U.revokeObjectURL = function (url) {
            // Содержимое НЕ забываем: инструменты почти всегда отзывают
            // адрес сразу после click(), а передать файл наружу мы к
            // этому моменту ещё не успели.
            try { realRevoke(url); } catch (_) {}
          };
        }
      }
    } catch (_) { /* нет URL — нечего и перехватывать */ }

    const pendingDownloads = [];

    const bytesToBase64 = (buffer) => {
      const bytes = new Uint8Array(buffer);
      let bin = '';
      const CHUNK = 0x8000;   // apply() не принимает мегабайты аргументов
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(bin);
    };

    const blobToBuffer = (blob) => {
      if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error('не удалось прочитать содержимое файла'));
        fr.readAsArrayBuffer(blob);
      });
    };

    const deliverAnchor = async (name, href) => {
      const url = String(href || '');
      const blob = blobUrls.get(url);
      if (blob) {
        // Отдаём ровно те байты, что собрал инструмент: base64 проходит
        // границу сообщений одинаково и для текста, и для картинки.
        const buffer = await blobToBuffer(blob);
        return hostCall('download', {
          name, mime: blob.type || '', content: bytesToBase64(buffer), base64: true,
        });
      }
      if (url.slice(0, 5) === 'data:') {
        const comma = url.indexOf(',');
        if (comma < 0) throw new Error('испорченный data:-адрес');
        const meta = url.slice(5, comma);
        const body = url.slice(comma + 1);
        const isB64 = /;base64$/i.test(meta);
        return hostCall('download', {
          name, mime: meta.replace(/;base64$/i, ''),
          content: isB64 ? body : decodeURIComponent(body), base64: isB64,
        });
      }
      throw new Error(
        'ссылка на скачивание ведёт не на данные инструмента (' + url.slice(0, 40) + '). ' +
        'Собери содержимое сам и отдай его через agent_download({ name, content }).');
    };

    const startDownload = (name, href) => {
      const p = deliverAnchor(name, href);
      pendingDownloads.push(p);
      // Отказ разбирается в handle перед отправкой результата; здесь —
      // только чтобы среда не жаловалась на «необработанное отклонение».
      p.catch(() => {});
    };

    try {
      const A = g.HTMLAnchorElement;
      if (A && A.prototype && typeof A.prototype.click === 'function') {
        const realClick = A.prototype.click;
        A.prototype.click = function () {
          const wants = typeof this.hasAttribute === 'function' && this.hasAttribute('download');
          if (!wants) return realClick.call(this);
          startDownload(this.getAttribute('download') || 'file', this.getAttribute('href') || '');
        };
      }
      // Тот же перехват для ссылки, по которой «кликают» событием, а не
      // методом. Работает для ссылок, добавленных в документ; до
      // отдельно созданного элемента событие не доходит — и как раз он
      // закрыт подменой click() выше.
      if (g.document && typeof g.document.addEventListener === 'function') {
        g.document.addEventListener('click', (ev) => {
          const el = ev && ev.target && typeof ev.target.closest === 'function'
            ? ev.target.closest('a[download]') : null;
          if (!el) return;
          ev.preventDefault();
          startDownload(el.getAttribute('download') || 'file', el.getAttribute('href') || '');
        }, true);
      }
    } catch (_) { /* нет DOM-ссылок — перехватывать нечего */ }

    const handle = async (msg) => {
      if (!msg || msg.__ts !== 1) return;

      if (msg.type === 'host-result') {
        const waiter = hostWaiters.get(msg.id);
        if (!waiter) return;
        hostWaiters.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error));
        else waiter.resolve(msg.value);
        return;
      }

      // Приложение сообщает, что модальное окно закрыл человек. Это не
      // отмена вызова: инструмент получит ответ и решит сам, что делать.
      if (msg.type === 'dialog-closed') {
        try { if (typeof g.__dialogClosedByUser === 'function') g.__dialogClosedByUser(); } catch (_) {}
        return;
      }

      // Срок ответа вышел: окно закрывается тем ответом, который
      // инструмент задал заранее.
      if (msg.type === 'dialog-timeout') {
        try { if (typeof g.__dialogTimedOut === 'function') g.__dialogTimedOut(); } catch (_) {}
        return;
      }

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

      // ── Файлы досылаются до того, как объявлен результат ──
      // Скачивание начинается синхронным click(), а доходит до
      // приложения асинхронно: без ожидания инструмент успевал вернуть
      // «файл сохранён» раньше, чем выяснялось, что не сохранён. Отказ
      // не прячем — он приезжает вместе с результатом, потому что
      // остальную работу инструмент, возможно, выполнил.
      if (pendingDownloads.length) {
        const results = await Promise.all(
          pendingDownloads.splice(0).map((p) => p.then(() => null, (e) => (e && e.message) || String(e))));
        const failed = results.filter(Boolean);
        if (failed.length) {
          const why = 'Файл не сохранён: ' + failed.join('; ');
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            if (!value.error) value.download_error = why;
          } else if (value === undefined || value === null) {
            value = { error: why };
          } else {
            value = { result: value, download_error: why };
          }
        }
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
    // Кадр этой попытки виден и таймауту, и обработчику load. Замыкание,
    // а не this.frame: пока идёт ожидание, кадр могли снести, и тогда
    // this.frame — уже чужой.
    let loaded = false;

    const frame = this.doc.createElement('iframe');
    // Ровно одно разрешение: исполнять скрипты. allow-same-origin здесь
    // НЕТ и быть не может — именно его отсутствие делает origin кадра
    // уникальным и отрезает его от данных приложения.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;left:-9999px;';
    frame.srcdoc = ToolSandbox.frameSource();
    // Различаем два разных отказа. Кадр не загрузился вовсе — это одно
    // (браузер не дал создать документ). Кадр загрузился, но не ответил
    // «готов» — совсем другое: его скрипт не выполнился или упал, и
    // причина почти всегда снаружи (политика CSP страницы, расширение
    // браузера, испорченный сборкой код рантайма). Без этого различия
    // наружу уходило одно и то же «песочница не запустилась», по
    // которому починить было нечего.
    frame.addEventListener('load', () => { loaded = true; });

    if (!this._listening) {
      (this.doc.defaultView || window).addEventListener('message', this._onMessageBound);
      this._listening = true;
    }
    (this.doc.body || this.doc.documentElement).appendChild(frame);
    this.frame = frame;

    this.frameReady = new Promise((resolve, reject) => {
      // Готовность СНИМАЕТ таймер готовности. Раньше промис выполнялся, а
      // таймер оставался взведённым и через три секунды после создания
      // кадра срабатывал всегда: сносил уже работающий кадр вместе со
      // всем, что в нём исполнялось. Короткие вызовы успевали закончиться
      // раньше и ничего не замечали, а всё, что длиннее трёх секунд, —
      // прежде всего инструменты с формой, где ждут человека, — теряло
      // кадр посреди работы. Ответ из формы уходил в пустоту, вызов висел
      // до собственного таймаута, и в консоли не появлялось ничего.
      this._resolveReady = (value) => {
        clearTimeout(this._readyTimer);
        this._readyTimer = null;
        resolve(value);
      };
      this._readyTimer = setTimeout(() => {
        // ВАЖНО: состояние сбрасываем. Раньше неудачный запуск оставлял
        // в this.frameReady навсегда отклонённый промис, и первая же
        // осечка выключала свои инструменты до перезагрузки страницы —
        // каждый следующий вызов получал ту же ошибку, даже когда
        // причина давно исчезла. Теперь следующий вызов начинает заново.
        this._teardownFrame();
        reject(new Error(loaded
          ? 'кадр загрузился, но его код не выполнился. Обычно это политика ' +
            'безопасности страницы (CSP) или расширение браузера, блокирующее ' +
            'скрипты во встроенных кадрах'
          : 'кадр не загрузился за ' + ToolSandbox.READY_TIMEOUT_MS + ' мс'));
      }, ToolSandbox.READY_TIMEOUT_MS);
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
    let generation = this._generation;
    try {
      await this._ensureFrame();
    } catch (e) {
      // Одна повторная попытка. Самая частая причина осечки —
      // случайность: кадр снесли по таймауту соседнего вызова, вкладка
      // подтормозила на загрузке страницы, система ушла в своп. Сдаваться
      // после первой такой — значит терять работающий инструмент на
      // ровном месте; вторая попытка стоит доли секунды.
      try {
        generation = this._generation;
        await this._ensureFrame();
      } catch (e2) {
        return { error: 'Не удалось запустить песочницу инструментов: ' + e2.message +
          '. Инструменты с собственным кодом сейчас не работают; встроенные — работают.' };
      }
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

      // Ожидание человека продлевает таймаут: форма открыта, и пока она
      // открыта, «инструмент не ответил» — неправда. Продление приходит
      // от родителя (см. ToolSandbox.extendTimeout).
      const entryRef = { timer: null };
      const timer = timeoutMs > 0 ? setTimeout(() => {
        // Сначала ответ вызывающей стороне, потом снос: destroy() закрывает
        // все ожидания разом, и если сделать его первым, наружу уйдёт
        // общее «песочница остановлена» вместо причины — таймаута.
        done({ error: 'Timeout: инструмент не ответил за ' + timeoutMs + ' мс' });
        // Кадр сносим целиком: зависший синхронный цикл иначе продолжит
        // занимать поток — ради этого песочница отчасти и затевалась.
        this.destroy('остановлена по таймауту');
      }, timeoutMs) : null;

      entryRef.timer = timer;
      this.pending.set(id, { done, timer, timeoutMs, rearm: (extraMs) => {
        const cur = this.pending.get(id);
        // Таймера может не быть вовсе — его сняло удержание; тогда
        // взводим заново на полный срок: столько инструменту и
        // причиталось до того, как открылось окно.
        if (!cur || !timeoutMs) return;
        if (cur.timer) clearTimeout(cur.timer);
        cur.timer = setTimeout(() => {
          cur.done({ error: 'Timeout: инструмент не ответил за ' + timeoutMs + ' мс' });
          this.destroy('остановлена по таймауту');
        }, timeoutMs);
      } });
      this._send({ __ts: 1, type: 'run', id, code: String(code || ''), params: params ?? {} });
    });
  }

  // ── Пока ждём человека, таймаут не идёт ──
  //
  // Продлевать срок ПОСЛЕ закрытия окна недостаточно: пока человек
  // заполняет форму, старый срок успевает истечь, и кадр сносится прямо
  // из-под открытого окна. Поэтому ожидание оформлено как удержание:
  // hold() останавливает отсчёт, release() возвращает его и добавляет
  // отсчёту столько, сколько ждали.
  holdTimeout() {
    this._holds = (this._holds || 0) + 1;
    for (const entry of this.pending.values()) {
      if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    }
  }

  releaseTimeout(waitedMs) {
    this._holds = Math.max(0, (this._holds || 0) - 1);
    if (this._holds > 0) return;
    for (const entry of this.pending.values()) {
      try { entry.rearm?.(waitedMs); } catch (_) {}
    }
  }

  // Сообщить кадру, что модальное окно закрыл человек. Вызов при этом
  // продолжается: инструмент сам решит, что вернуть.
  notifyDialogClosed() {
    this._send({ __ts: 1, type: 'dialog-closed' });
  }

  // Сообщить кадру, что вышел срок ответа.
  notifyDialogTimeout() {
    this._send({ __ts: 1, type: 'dialog-timeout' });
  }

  _send(msg) {
    try {
      this.frame.contentWindow.postMessage(msg, '*');
    } catch (e) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        entry.done({ error: 'Песочница недоступна: ' + e.message });
        return;
      }
      // Ответ моста или fetch своей записи в pending не имеет: он
      // принадлежит вызову, который ждёт в кадре. Кадра нет — значит, и
      // этот вызов ответа уже не дождётся. Молчать нельзя: снаружи это
      // выглядит как зависший агент без единой строчки в консоли.
      console.error('Песочница инструментов: сообщение «' + (msg && msg.type) +
        '» не доставлено — кадра уже нет.', e && e.message);
      for (const [, pend] of this.pending) {
        pend.done({ error: 'Песочница инструментов остановилась посреди вызова: ' +
          'ответ не доставлен (' + ((e && e.message) || 'кадр недоступен') + ')' });
      }
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

    if (msg.type === 'host') {
      this._bridgeHost(msg);
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

  // Просьба кадра к приложению (пока это только «отдай файл
  // пользователю»). Решение принимает не песочница: она лишь переносит
  // вопрос наружу — туда, где есть и политика, и доступ к странице.
  async _bridgeHost(msg) {
    let out;
    if (typeof this.hostBridge !== 'function') {
      out = { error: 'Приложение не предоставило песочнице этой возможности' };
    } else {
      try {
        out = await this.hostBridge({ kind: msg.kind, payload: msg.payload || {} });
      } catch (e) {
        out = { error: (e && e.message) || String(e) };
      }
    }
    out = out || {};
    this._send({ __ts: 1, type: 'host-result', id: msg.id, error: out.error || null, value: out.value });
  }

  // Снос кадра БЕЗ отмены ожиданий: нужен там, где кадр оказался
  // негодным, но отвечать вызывающей стороне будет кто-то другой (см.
  // таймаут готовности). destroy() ниже делает то же самое и вдобавок
  // закрывает все ожидания.
  _teardownFrame() {
    this._generation++;
    clearTimeout(this._readyTimer);
    this._readyTimer = null;
    try { this.frame && this.frame.remove(); } catch (_) {}
    this.frame = null;
    this.frameReady = null;
    this._resolveReady = null;
  }

  destroy(reason = 'остановлена') {
    this._teardownFrame();
    // Ожидания закрываем ДО очистки набора: done() ищет свою запись
    // именно в нём и на уже очищенном молча ничего не делает — вызов
    // повис бы навсегда.
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.done({ error: 'Песочница инструментов ' + reason });
    }
    this.pending.clear();
  }
}
// javascript-obfuscator:enable
