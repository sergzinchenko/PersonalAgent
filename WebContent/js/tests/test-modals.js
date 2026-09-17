// ============================================================
//  ТЕСТ: модальность диалоговых окон
// ============================================================
//
// Проверяет Цикл 29: КАЖДОЕ окно строго модально — клик мимо окна
// (по затемнённому оверлею) не закрывает его и не теряет введённое.
// Закрыть можно только кнопками «Отмена»/«Сохранить» или клавишей Esc.
//
// Нужен настоящий DOM: суть проверки — какие обработчики реально висят
// на оверлее и что происходит с разметкой после клика.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + extra : '')); }
};

const ROOT = path.join(__dirname, '..', '..');
const tick = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

(async () => {
  const rawHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const html = rawHtml.replace(/<script src="[^"]+"><\/script>\s*/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const document = window.document;

  window.AbortController = window.AbortController || class { constructor() { this.signal = {}; } abort() {} };
  window.performance = window.performance || { now: () => Date.now() };
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = undefined;
  window.Notification = { requestPermission: async () => 'granted' };
  window.localStorage = window.localStorage || { getItem() { return null; }, setItem() {}, removeItem() {} };

  // Один общий eval — см. пояснение в test-chat-switching.js.
  const files = [
    'js/core/markdown.js',
    'js/core/log-guard.js',
    'js/core/tool-sandbox.js',
    'js/core/binary-formats.js',
    'js/engines/folders-engine.js',
    'js/llm/llm-registry.js',
    'js/ui/ui-core.js',
    'js/ui/ui-navigation.js',
    'js/ui/ui-chat.js',
    'js/ui/ui-subtask.js',
    'js/ui/ui-compaction.js',
    'js/ui/ui-resume.js',
    'js/ui/ui-metrics.js',
    'js/ui/ui-settings.js',
    'js/ui/ui-connections.js',
    'js/ui/code-highlight.js',
    'js/ui/ui-editors.js',
    'js/ui/ui-review.js',
    'js/ui/ui-transfer.js',
    'js/ui/ui-about.js',
    'js/ui/ui-backup.js',
  ];
  window.eval(files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n') + '\nwindow.__UI = UI;\n');
  const UI = window.__UI;

  const agent = {
    db: { async get() { return null; }, async getAll() { return []; }, async put() {}, async delete() {} },
    llm: { isConfigured: () => false },
    models: { allModels: () => [], describe: () => null },
    skills: { loadSkills: async () => [], toolIdsOf: () => [] },
    tools: { loadTools: async () => [] },
    files: { all: async () => [] },
  };
  const ui = new UI(agent);
  ui.refreshSidebar = async () => {};
  ui.updateChatToolbar = async () => {};

  const overlay = () => document.querySelector('.modal-overlay');
  const clickOverlay = () => {
    // Именно клик ПО ОВЕРЛЕЮ, а не по окну: e.target === сам оверлей.
    const el = overlay();
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  };
  const pressEsc = () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  console.log('\n── Клик мимо окна ──');
  let cancelled = 0, saved = 0;
  ui._showModal('Форма', '<input id="probe" value="черновик">', () => { saved++; }, () => { cancelled++; });
  ok('окно открылось', !!overlay());

  document.getElementById('probe').value = 'важный несохранённый текст';
  clickOverlay();
  await tick();
  ok('клик по оверлею НЕ закрыл окно', !!overlay());
  ok('введённое не потеряно', document.getElementById('probe')?.value === 'важный несохранённый текст');
  ok('onCancel при этом не вызывался', cancelled === 0);

  console.log('\n── Штатные способы закрыть ──');
  document.querySelector('.modal-actions .btn-secondary').click();
  await tick();
  ok('«Отмена» закрывает окно', !overlay());
  ok('и вызывает onCancel ровно один раз', cancelled === 1, String(cancelled));

  ui._showModal('Форма 2', '<input id="probe2">', () => { saved++; }, () => { cancelled++; });
  document.querySelector('.modal-actions .btn-primary').click();
  await tick();
  ok('«Сохранить» закрывает окно', !overlay());
  ok('и вызывает onSave', saved === 1, String(saved));
  ok('onCancel при сохранении не вызывается', cancelled === 1);

  console.log('\n── Esc ──');
  ui._showModal('Форма 3', '<input id="probe3">', null, () => { cancelled++; });
  pressEsc();
  await tick();
  ok('Esc закрывает окно', !overlay());
  ok('Esc равносилен «Отмене»', cancelled === 2, String(cancelled));

  // Esc после закрытия не должен ничего делать — слушатель снимает себя.
  pressEsc();
  await tick();
  ok('после закрытия Esc уже ничего не трогает', cancelled === 2, String(cancelled));

  console.log('\n── Окно, открывающее следующее окно ──');
  // onSave может увести пользователя в другую форму (так устроен переход
  // «модель → список провайдеров»): подменённое окно нельзя стирать.
  let firstCancelled = 0, secondCancelled = 0;
  ui._showModal('Первое', '<input id="first">', () => {
    ui._showModal('Второе', '<input id="second">', null, () => { secondCancelled++; });
  }, () => { firstCancelled++; });
  document.querySelector('.modal-actions .btn-primary').click();
  await tick();
  ok('второе окно осталось открытым', !!overlay());
  ok('это именно второе окно', !!document.getElementById('second'));

  pressEsc();
  await tick();
  ok('Esc закрывает видимое (второе) окно', !overlay());
  ok('и вызывает onCancel именно второго окна', secondCancelled === 1, String(secondCancelled));
  ok('onCancel первого окна не срабатывает задним числом', firstCancelled === 0, String(firstCancelled));

  // Окно может быть заменено и напрямую, без «Отмены»/«Сохранить» —
  // так делает, например, повторный показ формы после ошибки. Слушатель
  // прежнего окна при этом остаётся висеть и обязан быть безвредным.
  ui._showModal('A', '<input id="a">', null, () => { firstCancelled++; });
  ui._showModal('B', '<input id="b">', null, () => { secondCancelled++; });
  pressEsc();
  await tick();
  ok('заменённое окно закрылось', !overlay());
  ok('сработал onCancel только видимого окна', secondCancelled === 2 && firstCancelled === 0,
     `first=${firstCancelled} second=${secondCancelled}`);

  console.log('\n── _confirm и _prompt тоже модальны ──');
  const confirmPromise = ui._confirm('Точно?', { title: 'Вопрос' });
  clickOverlay();
  await tick();
  ok('подтверждение не закрылось кликом мимо', !!overlay());
  document.querySelector('.modal-actions .btn-secondary').click();
  ok('и вернуло false при отмене', (await confirmPromise) === false);

  const promptPromise = ui._prompt('Название', 'исходное');
  await tick(6);
  clickOverlay();
  await tick();
  ok('ввод значения не закрылся кликом мимо', !!overlay());
  document.getElementById('pv_input').value = 'новое';
  document.querySelector('.modal-actions .btn-primary').click();
  ok('и вернул введённое значение', (await promptPromise) === 'новое');

  console.log('\n── Включение навыка в чате: разбор его инструментов ──');
  // Навык включён, два его инструмента выключены. Диалог должен предложить
  // включить именно их, и включить ровно отмеченные — не молча все.
  {
    const tools = new Map([
      ['t1', { id: 't1', name: 'search_files', enabled: false }],
      ['t2', { id: 't2', name: 'read_file', enabled: false }],
      ['t3', { id: 't3', name: 'calculator', enabled: true }],
    ]);
    const skill = { id: 's1', name: 'Аналитик', toolIds: ['t1', 't2', 't3'] };

    ui.agent.db.get = async (store, id) => (store === 'tools' ? tools.get(id) : null);
    ui.agent.db.put = async (store, o) => { if (store === 'tools') tools.set(o.id, o); };
    ui.agent.skills.disabledToolsOf = async () => [tools.get('t1'), tools.get('t2')];
    ui.renderTools = () => {};

    const shown = ui._offerEnableSkillTools(skill);
    await tick();
    ok('диалог о выключенных инструментах показан', !!overlay());
    ok('в нём перечислены только выключенные',
       document.querySelectorAll('[data-enable-tool]').length === 2,
       String(document.querySelectorAll('[data-enable-tool]').length));
    ok('по умолчанию отмечены все',
       [...document.querySelectorAll('[data-enable-tool]')].every(cb => cb.checked));

    clickOverlay();
    await tick();
    ok('клик мимо не закрывает и этот диалог', !!overlay());

    // Снимаем галочку со второго — включиться должен только первый.
    document.querySelector('[data-enable-tool="t2"]').checked = false;
    document.querySelector('.modal-actions .btn-primary').click();
    await shown;
    await tick();
    ok('включён отмеченный инструмент', tools.get('t1').enabled === true);
    ok('не отмеченный остался выключенным', tools.get('t2').enabled === false);
    ok('о включении сказано в чате',
       /включён инструмент/.test(document.getElementById('chat-messages').textContent),
       document.getElementById('chat-messages').textContent.slice(-120));

    // Отказ ничего не включает.
    tools.get('t1').enabled = false;
    const second = ui._offerEnableSkillTools(skill);
    await tick();
    document.querySelector('.modal-actions .btn-secondary').click();
    await second;
    await tick();
    ok('«Отмена» оставляет инструменты как были', tools.get('t1').enabled === false);

    // Если выключенных нет — диалога быть не должно.
    ui.agent.skills.disabledToolsOf = async () => [];
    await ui._offerEnableSkillTools(skill);
    await tick();
    ok('без выключенных инструментов диалог не показывается', !overlay());
  }

  console.log('\n── Генератор файлов прокси ──');
  {
    // config.js правят руками после генерации, поэтому важно не только
    // «что-то сгенерировалось», а что это валидный модуль с нужными
    // значениями — иначе прокси упадёт при старте с непонятной ошибкой.
    const cfgText = ui._buildProxyConfigJs({
      port: 3100, methods: ['GET', 'POST'], allowlist: ['intranet.corp.local', "o'brien.test"],
      bodyMb: 25, curlBin: 'C:\\tools\\curl.exe', useNtlm: true, useNegotiate: false,
      insecure: true, ssoTimeout: 45, ssoMb: 7,
    });

    // Выполняем как настоящий CommonJS-модуль.
    const moduleObj = { exports: {} };
    new Function('module', 'exports', cfgText)(moduleObj, moduleObj.exports);
    const cfg = moduleObj.exports;

    ok('config.js — исполняемый модуль', !!cfg && typeof cfg === 'object');
    ok('порт подставлен', cfg.port === 3100, String(cfg.port));
    ok('методы подставлены', cfg.allowedMethods.join(',') === 'GET,POST');
    ok('белый список подставлен', cfg.allowlist.length === 2);
    ok('кавычка в имени хоста не ломает файл', cfg.allowlist[1] === "o'brien.test", cfg.allowlist[1]);
    ok('обратные слэши в пути к curl не съедены', cfg.sso.curlBin === 'C:\\tools\\curl.exe', cfg.sso.curlBin);
    ok('мегабайты переведены в байты', cfg.maxRequestBodyBytes === 25 * 1024 * 1024);
    ok('флаги SSO перенесены', cfg.sso.useNtlm === true && cfg.sso.useNegotiate === false && cfg.sso.insecure === true);
    ok('таймаут и предел SSO перенесены',
       cfg.sso.timeoutSec === 45 && cfg.sso.maxResponseBytes === 7 * 1024 * 1024);
    ok('комментарии сохранены — файл предназначен для правки руками',
       /Белый список хостов/.test(cfgText));

    // TLS-раздел: без него сгенерированный config.js не даст справиться с
    // корпоративным сертификатом, а это самая частая причина 502.
    const tlsCfg = (() => {
      const text = ui._buildProxyConfigJs({
        port: 3000, methods: ['GET'], allowlist: [], bodyMb: 10, curlBin: 'curl',
        useNtlm: true, useNegotiate: true, insecure: false, ssoTimeout: 60, ssoMb: 20,
        caFile: 'C:\\corp\\ca.pem', tlsInsecureHosts: ['intranet.corp.local'], tlsInsecure: false,
      });
      const m = { exports: {} };
      new Function('module', 'exports', text)(m, m.exports);
      return { cfg: m.exports, text };
    })();
    ok('в config.js есть раздел tls', !!tlsCfg.cfg.tls);
    ok('путь к CA перенесён без потери слэшей', tlsCfg.cfg.tls.caFile === 'C:\\corp\\ca.pem', tlsCfg.cfg.tls.caFile);
    ok('исключения по хостам перенесены',
       tlsCfg.cfg.tls.insecureHosts.join(',') === 'intranet.corp.local');
    ok('глобальное отключение по умолчанию выключено', tlsCfg.cfg.tls.insecure === false);
    ok('в комментариях CA назван лучшим вариантом', /ЛУЧШИЙ ВАРИАНТ/.test(tlsCfg.text));
    ok('а отключение проверки — крайним', /КРАЙНИЙ СЛУЧАЙ/.test(tlsCfg.text));

    const bat = ui._buildProxyLauncher('bat');
    ok('bat переходит в свою папку', /cd \/d "%~dp0"/.test(bat));
    ok('bat проверяет наличие node', /where node/.test(bat));
    ok('bat не закрывается сразу', /pause/.test(bat));
    ok('bat с CRLF — иначе Windows его не выполнит', bat.includes('\r\n'));
    const sh = ui._buildProxyLauncher('sh');
    ok('sh с шебангом и без CRLF', sh.startsWith('#!/bin/sh') && !sh.includes('\r\n'));
  }

  // ══════════════════════════════════════════════
  console.log('\n── Форма, заказанная инструментом ──');
  {
    const spec = {
      title: 'Заявка <b>важная</b>',
      description: 'Заполните поля',
      fields: [
        { type: 'info', text: 'пояснение' },
        { name: 'city', label: 'Город', type: 'text', value: 'Москва' },
        { name: 'qty', label: 'Сколько', type: 'number', value: 3, min: 1, max: 10 },
        { name: 'kind', label: 'Тип', type: 'select', value: 'b',
          options: [{ value: 'a', label: 'А' }, { value: 'b', label: '<i>Б</i>' }] },
        { name: 'urgent', label: 'Срочно', type: 'checkbox', value: true },
        { name: 'note', label: 'Заметка', type: 'textarea', rows: 3, value: 'текст' },
        { name: 'way', label: 'Способ', type: 'radio', value: 'two',
          options: [{ value: 'one', label: 'Первый' }, { value: 'two', label: 'Второй' }] },
      ],
    };

    const promise = ui.showToolFormModal(spec);
    await tick();

    const modal = document.querySelector('#modals');
    ok('окно формы открылось', /Заявка/.test(modal.textContent));
    // Разметка из описания не должна становиться разметкой на экране:
    // описание пишет модель, и это её код просил показать форму.
    ok('разметка в заголовке не исполняется',
       !modal.querySelector('b') && /<b>важная<\/b>/.test(modal.textContent), modal.textContent.slice(0, 80));
    ok('и в подписях вариантов тоже',
       !modal.querySelector('select i') && /<i>Б<\/i>/.test(modal.querySelector('select').textContent));
    ok('сказано, что форму заказал инструмент', /инструмент/.test(modal.textContent));

    ok('поля отрисованы по типам',
       !!modal.querySelector('input[type="text"]') && !!modal.querySelector('input[type="number"]') &&
       !!modal.querySelector('select') && !!modal.querySelector('input[type="checkbox"]') &&
       !!modal.querySelector('textarea') && !!modal.querySelector('input[type="radio"]'));
    ok('значения по умолчанию расставлены',
       modal.querySelector('input[type="text"]').value === 'Москва' &&
       modal.querySelector('select').value === 'b' &&
       modal.querySelector('input[type="checkbox"]').checked === true &&
       modal.querySelector('textarea').value === 'текст');
    ok('границы числового поля переданы',
       modal.querySelector('input[type="number"]').getAttribute('min') === '1' &&
       modal.querySelector('input[type="number"]').getAttribute('max') === '10');

    // Правим и отправляем.
    modal.querySelector('input[type="text"]').value = 'Тверь';
    modal.querySelector('input[type="number"]').value = '7';
    modal.querySelector('input[type="checkbox"]').checked = false;
    document.querySelector('#modals .btn-primary').click();
    const res = await promise;

    ok('форма вернула введённое', res.submitted === true && res.values.city === 'Тверь', JSON.stringify(res));
    // Число должно вернуться числом: иначе инструмент сложит его как
    // строку, и ошибка обнаружится далеко от места, где сделана.
    ok('число возвращается числом', res.values.qty === 7 && typeof res.values.qty === 'number',
       typeof res.values.qty);
    ok('галочка — логическим значением', res.values.urgent === false);
    ok('выбранный вариант переключателя вернулся', res.values.way === 'two', String(res.values.way));

    // Закрытие без отправки — отказ.
    const p2 = ui.showToolFormModal({ title: 'Ещё', fields: [{ name: 'x', label: 'X', type: 'text' }] });
    await tick();
    document.querySelector('#modals .btn-secondary')?.click();
    const res2 = await p2;
    ok('закрытие окна — отказ, а не пустые значения', res2.submitted === false, JSON.stringify(res2));
  }

  // ══════════════════════════════════════════════
  console.log('\n── Окно инструмента: кадр песочницы на экране ──');
  {
    // Главное обещание: кадр НЕ ПЕРЕЕЗЖАЕТ по дереву. Перенос <iframe>
    // перезагружает его документ — то есть убивает инструмент, который
    // прямо сейчас показывает это окно.
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    const hidden = 'position:absolute;width:0;height:0;border:0;left:-9999px;';
    frame.style.cssText = hidden;
    document.body.appendChild(frame);
    const parentBefore = frame.parentNode;

    let asked = 0;
    ui.showSandboxDialog({
      frame, title: 'Отчёт <b>за квартал</b>', width: 800, height: 400,
      onClose: () => { asked++; },
    });

    const shell = document.querySelector('.sandbox-dialog');
    ok('окно появилось', !!shell);
    ok('кадр остался на своём месте в дереве', frame.parentNode === parentBefore);
    ok('и не стал потомком рамки окна', !shell.contains(frame));
    ok('кадр показан на экране', /position:\s*fixed/.test(frame.style.cssText) &&
       frame.style.width === '800px', frame.style.cssText);
    ok('сказано, что окно нарисовал инструмент', /окно инструмента/.test(shell.textContent));

    // Заголовок приходит из кода инструмента — текстом, и только текстом.
    ok('разметка в заголовке не исполняется',
       !shell.querySelector('.sandbox-dialog-title b') &&
       /<b>за квартал<\/b>/.test(shell.querySelector('.sandbox-dialog-title').textContent));

    // Закрытие — просьба к инструменту, а не снос окна: ответ обязателен,
    // и что вернуть, решает он сам.
    shell.querySelector('.sandbox-dialog-close').dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }));
    ok('крестик просит инструмент закрыться', asked === 1);
    ok('но окно остаётся до его ответа', !!document.querySelector('.sandbox-dialog'));
    pressEsc();
    ok('Esc делает то же самое', asked === 2);

    ui.closeSandboxDialog();
    ok('после ответа окно снято', !document.querySelector('.sandbox-dialog'));
    // Сравниваем по смыслу, а не посимвольно: браузер переписывает
    // cssText по-своему (0 → 0px), и точное совпадение строк ничего бы
    // не проверяло, кроме форматирования.
    ok('кадр вернулся в прежнее невидимое состояние',
       frame.style.position === 'absolute' && parseInt(frame.style.left, 10) < -1000 &&
       parseInt(frame.style.width, 10) === 0 && frame.getAttribute('aria-hidden') === 'true',
       frame.style.cssText);
    ok('и по-прежнему на месте — документ не перезагружался',
       frame.parentNode === parentBefore);
    pressEsc();
    ok('после закрытия Esc окна уже не касается', asked === 2);

    // Размеры приходят из кода инструмента: окно больше экрана — поломка.
    ui.showSandboxDialog({ frame, title: 'Огромное', width: 99999, height: 99999, onClose: () => {} });
    const w = parseInt(document.querySelector('.sandbox-dialog-frame').style.width, 10);
    ok('окно не вылезает за пределы экрана', w <= (window.innerWidth || 1024), String(w));
    ui.closeSandboxDialog();

    ok('без кадра окно не открывается молча', (() => {
      try { ui.showSandboxDialog({ title: 'Ничего' }); return false; } catch (_) { return true; }
    })());
  }

  // ══════════════════════════════════════════════
  console.log('\n── Карточка модели ──');
  {
    // Три числовых поля в ряд и отчёт пробы в 520 пикселей не помещались,
    // а простыня пояснений занимала как раз то место, где полезнее
    // показывать выясненное о модели.
    ui.agent.models = {
      connections: [{ id: 'c1', name: 'Провайдер', models: [] }],
      allModels: () => [], describe: () => null,
    };
    // Закрытие карточки возвращает в настройки — целого окна настроек
    // этой проверке не нужно, поэтому возврат заглушен.
    ui._backToProviders = async () => { document.getElementById('modals').innerHTML = ''; };
    await ui.showModelEditor('c1', null, 'gpt-4o-mini');
    await tick();

    const modal = document.querySelector('#modals .modal');
    ok('карточка модели открылась', !!modal && /Модель/.test(modal.textContent));
    ok('у неё своя раскладка — шире прочих окон', modal.classList.contains('modal-model'));

    const labels = Array.from(modal.querySelectorAll('.lbl-hint'));
    const hintOf = (text) => labels.find(l => l.textContent.includes(text));
    ok('пояснения стали подсказками при наведении',
       ['Окно контекста', 'max_tokens', 'Температура'].every(t => {
         const l = hintOf(t);
         return l && (l.getAttribute('title') || '').length > 40;
       }), labels.map(l => l.textContent).join('/'));
    // Знак вопроса рисует стиль (.lbl-hint::after), лишней разметки в
    // подписи нет — только класс.
    ok('о подсказке видно, что она есть', labels.length >= 3 && labels.every(l => !l.querySelector('span')));
    ok('пояснение к классу сложности тоже стало подсказкой',
       /подсказку при выборе модели/.test((hintOf('Класс сложности') || { getAttribute: () => '' }).getAttribute('title') || ''));
    ok('та же подсказка и на самом поле',
       (document.getElementById('me_ctx').getAttribute('title') || '').length > 40);

    // Простыни под формой больше нет — место занял отчёт пробы.
    ok('длинных пояснений в форме не осталось',
       !/приложение подрезает историю, сворачивает переписку/.test(modal.textContent),
       modal.textContent.slice(-200));

    const report = document.getElementById('me_probe');
    const notes = document.getElementById('me_notes');
    ok('отчёт пробы стоит ниже «Заметки»',
       !!report && !!notes &&
       (notes.compareDocumentPosition(report) & window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    ok('до пробы там сказано, что в этом месте появится',
       /Определить/.test(report.textContent) && /рассужден/.test(report.textContent),
       report.textContent.slice(0, 80));

    // Закрываем именно кнопкой окна: первая .btn-secondary в карточке —
    // это «Определить» рядом с полем окна контекста.
    document.querySelector('#modals .modal-actions .btn-secondary')?.click();
  }

  // ══════════════════════════════════════════════
  console.log('\n── Сколько ещё ждут ответа ──');
  {
    // Окно ждёт человека, а ход агента всё это время стоит. Человек может
    // отойти от экрана и не вернуться — поэтому видно, сколько его ещё
    // ждут, и по истечении срока окно отвечает само.
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    const p1 = ui.showToolFormModal({
      title: 'Со сроком', seconds: 1,
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    });
    await tick();
    const box = document.getElementById('tf_wait');
    ok('в форме виден обратный отсчёт', !!box && box.hidden === false);
    ok('и сказано, что будет, когда время выйдет',
       /закроется ответом/.test(box.getAttribute('title') || ''), box.getAttribute('title'));
    ok('отсчёт можно остановить', !!document.getElementById('tf_wait_stop'));

    const timedOut = await Promise.race([p1, wait(2500).then(() => 'не дождались')]);
    ok('по истечении срока форма отвечает сама',
       timedOut && timedOut.timedOut === true && timedOut.submitted === false,
       JSON.stringify(timedOut));
    ok('и окно закрывается', !document.querySelector('#modals .modal'));

    // Остановленный отсчёт не срабатывает: человек у экрана и ответит сам.
    const p2 = ui.showToolFormModal({
      title: 'Со стопом', seconds: 1,
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    });
    await tick();
    document.getElementById('tf_wait_stop').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const held = await Promise.race([p2, wait(2500).then(() => 'ещё ждём')]);
    ok('остановленный отсчёт окно не закрывает', held === 'ещё ждём', JSON.stringify(held));
    ok('и это видно', /остановлен/.test(document.getElementById('tf_wait').textContent));
    ok('кнопка остановки исчезает — второй раз останавливать нечего',
       !document.getElementById('tf_wait_stop'));
    document.querySelector('#modals .modal-actions .btn-primary').click();
    const after = await p2;
    ok('после остановки ответ принимается как обычно', after.submitted === true, JSON.stringify(after));

    // Без срока отсчёта нет вовсе: инструмент вправе ждать сколько угодно.
    const p3 = ui.showToolFormModal({ title: 'Без срока', fields: [{ name: 'x', label: 'X', type: 'text' }] });
    await tick();
    ok('без заданного срока отсчёта не появляется', !document.getElementById('tf_wait'));
    document.querySelector('#modals .modal-actions .btn-secondary').click();
    await p3;

    // То же самое в окне инструмента — отсчёт там в заголовке.
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;left:-9999px;';
    document.body.appendChild(frame);
    let expired = 0;
    ui.showSandboxDialog({ frame, title: 'Со сроком', seconds: 1, onClose: () => {}, onExpire: () => { expired++; } });
    const head = document.querySelector('.sandbox-dialog-head #sd_wait');
    ok('в заголовке окна тоже виден отсчёт', !!head && head.hidden === false);
    await wait(1400);
    ok('по истечении срока окно сообщает об этом инструменту', expired === 1, String(expired));
    ok('и это написано прямо в заголовке', /время вышло/.test(head.textContent), head.textContent);
    ui.closeSandboxDialog();
    await wait(1200);
    ok('после закрытия отсчёт не продолжает тикать', expired === 1, String(expired));
  }

  // ══════════════════════════════════════════════
  console.log('\n── Подсказки к полям — при наведении ──');
  {
    // Правило одно на все окна: мелкий текст под полем уходит в title.
    // Проверяем на разметке, повторяющей реальные формы приложения.
    ui._showModal('Проверка', `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">
        Вступление к разделу — не пояснение к полю.
      </div>
      <div class="form-group" id="g_plain">
        <label>Таймаут, секунд</label>
        <input id="h_timeout" type="number">
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
          Зависший инструмент вернёт <code>ошибку</code> вместо ожидания.
        </div>
      </div>
      <div class="form-group" id="g_rows">
        <label class="check-row"><input type="checkbox" id="h_https"> Требовать https</label>
        <div style="font-size:11px;color:var(--text-muted);margin:2px 0 8px 22px;">По http токен уходит открытым.</div>
        <label class="check-row"><input type="checkbox" id="h_local"> Разрешить localhost</label>
        <div style="font-size:11px;color:var(--text-muted);margin:2px 0 0 22px;">Нужно для сервера на этой машине.</div>
      </div>
      <div class="form-group" id="g_radio">
        <label>Режим</label>
        <label class="check-row"><input type="radio" name="m"> Мягкий</label>
        <label class="check-row"><input type="radio" name="m"> Строгий</label>
        <div style="font-size:11px;color:var(--text-muted);">Как агент спрашивает разрешение.</div>
      </div>
      <div class="form-group" id="g_buttons">
        <button class="btn btn-secondary btn-sm" id="h_check">Проверить</button>
        <button class="btn btn-secondary btn-sm" id="h_gen">Сгенерировать файлы</button>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">Соберёт config.js по вашим значениям.</div>
      </div>
      <div class="form-group" id="g_keep">
        <label>Ключ</label>
        <input id="h_key">
        <div style="font-size:11px;color:var(--warning);">Ключ хранится в браузере — осторожно.</div>
        <div id="h_status" style="font-size:11px;color:var(--text-muted);">проверяется…</div>
        <div style="font-size:11px;color:var(--text-muted);">Получить ключ: <a href="#">здесь</a></div>
        <div class="keep-visible" style="font-size:11px;color:var(--text-muted);">Оставлено на виду намеренно.</div>
      </div>
    `, null, null);
    await tick();
    const modal = document.querySelector('#modals .modal');
    const lbl = (sel) => modal.querySelector(sel);

    const plainLabel = lbl('#g_plain label');
    ok('пояснение ушло в подсказку подписи',
       /Зависший инструмент вернёт ошибку вместо ожидания/.test(plainLabel.getAttribute('title') || ''),
       plainLabel.getAttribute('title'));
    ok('подпись помечена знаком вопроса', plainLabel.classList.contains('lbl-hint'));
    ok('та же подсказка над самим полем',
       /Зависший/.test(document.getElementById('h_timeout').getAttribute('title') || ''));
    ok('мелкого текста под полем больше нет', !/Зависший/.test(lbl('#g_plain').textContent));

    const rows = modal.querySelectorAll('#g_rows label');
    ok('у каждого флажка — своя подсказка',
       /открытым/.test(rows[0].getAttribute('title') || '') && /этой машине/.test(rows[1].getAttribute('title') || '') &&
       !/этой машине/.test(rows[0].getAttribute('title') || ''),
       [rows[0].getAttribute('title'), rows[1].getAttribute('title')].join(' | '));

    const radio = modal.querySelectorAll('#g_radio label');
    ok('пояснение к группе вариантов — у заголовка группы, а не у последнего варианта',
       /разрешение/.test(radio[0].getAttribute('title') || '') && !radio[2].getAttribute('title'),
       [radio[0].getAttribute('title'), radio[2].getAttribute('title')].join(' | '));

    ok('пояснение к действию — подсказкой над его кнопкой',
       /config\.js/.test(document.getElementById('h_gen').getAttribute('title') || '') &&
       !document.getElementById('h_check').getAttribute('title') &&
       !/Соберёт/.test(lbl('#g_buttons').textContent));

    const keep = lbl('#g_keep').textContent;
    ok('предупреждение остаётся на виду', /осторожно/.test(keep));
    ok('текст, который обновляет код, остаётся на месте', !!document.getElementById('h_status'));
    ok('текст со ссылкой остаётся — ссылку в подсказку не спрячешь', /Получить ключ/.test(keep));
    ok('от превращения можно отказаться явно', /Оставлено на виду/.test(keep));
    ok('вступление к разделу не трогается', /Вступление к разделу/.test(modal.textContent));

    // Дорисованное после открытия — тем же правилом.
    const late = document.createElement('div');
    late.className = 'form-group';
    late.innerHTML = '<label>Поздно</label><input id="h_late">' +
      '<div style="font-size:11px;color:var(--text-muted);">Появилось после открытия окна.</div>';
    modal.appendChild(late);
    await tick();
    ok('подсказки в дорисованном содержимом тоже превращаются',
       /после открытия/.test(late.querySelector('label').getAttribute('title') || '') &&
       !/после открытия/.test(late.textContent), late.innerHTML.slice(0, 120));

    // Растягивание.
    ok('окно формы растягивается', modal.classList.contains('modal-resizable'));
    document.querySelector('#modals .modal-actions .btn-secondary').click();

    const q = ui._confirm('Удалить?');
    await tick();
    ok('вопрос «да/нет» не растягивается — тянуть там нечего',
       !document.querySelector('#modals .modal').classList.contains('modal-resizable'));
    document.querySelector('#modals .modal-actions .btn-secondary').click();
    await q;

    // Форма, которую рисует инструмент: подсказка поля — при наведении.
    const pf = ui.showToolFormModal({ title: 'С подсказками', fields: [
      { name: 'city', label: 'Город', type: 'text', hint: 'Где <b>доставка</b>' },
      { name: 'kind', label: 'Тип', type: 'radio', hint: 'Как везти',
        options: [{ value: 'a', label: 'А' }, { value: 'b', label: 'Б' }] },
      { name: 'ok', label: 'Срочно', type: 'checkbox', hint: 'Дороже вдвое' },
    ] });
    await tick();
    const fm = document.querySelector('#modals .modal');
    const fl = fm.querySelectorAll('label');
    ok('подсказка поля формы инструмента — при наведении на подпись',
       fl[0].classList.contains('lbl-hint') && fl[0].getAttribute('title') === 'Где <b>доставка</b>',
       fl[0].getAttribute('title'));
    ok('и на самом поле', document.getElementById('tf_0').getAttribute('title') === 'Где <b>доставка</b>');
    ok('разметка из подсказки не исполняется', !fm.querySelector('b'));
    ok('у группы переключателей подсказка — у заголовка группы',
       /Как везти/.test(fm.querySelector('#tf_1 > label').getAttribute('title') || ''));
    ok('у флажка — у его подписи', /Дороже/.test(fm.querySelector('#tf_2').closest('label').getAttribute('title') || ''));
    ok('мелкого текста подсказок в форме нет', !/Где|Как везти|Дороже/.test(fm.textContent));
    ok('форма инструмента растягивается', fm.classList.contains('modal-resizable'));
    document.querySelector('#modals .modal-actions .btn-secondary').click();
    await pf;
  }

  // ══════════════════════════════════════════════
  console.log('\n── Проверка формы моделью ──');
  {
    // Модель подменена: важно не что она ответит, а что ей отправили и
    // как ответ показан и применён.
    const sentToModel = [];
    let reply = '';
    ui.agent.llm = {
      model: 'проверочная-модель',
      isConfigured: () => true,
      chat: async (messages) => { sentToModel.push(messages); return { content: reply, usage: { total_tokens: 321 } }; },
    };
    ui.agent.tools.loadTools = async () => [{ id: 'x1', name: 'slugify_text' }, { id: 'me', name: 'my_tool' }];

    // ── Редактор инструмента ──
    ui.showAddToolModal('me');
    for (let i = 0; i < 50 && !document.querySelector('#modals .review-btn'); i++) await tick(1);
    const btn = document.querySelector('#modals .review-btn');
    ok('у редактора объекта есть «Проверить с моделью»', !!btn && /Проверить с моделью/.test(btn.textContent));

    document.getElementById('t_name').value = 'my tool';
    document.getElementById('t_params').value = '{ "type": "object", "properties": {} }';
    document.getElementById('t_handler').value = 'return localStorage.getItem(params.q);';

    reply = '```json\n' + JSON.stringify({
      summary: 'Инструмент не заработает: имя и код с ошибками.',
      issues: [
        { field: 't_name', severity: 'error', message: 'В имени пробел', fix: 'my_tool' },
        { field: 't_handler', severity: 'error', message: 'localStorage недоступен в песочнице',
          fix: 'return { q: params.q };' },
        { field: 't_params', severity: 'warning', message: 'Нет описания параметра q',
          fix: { type: 'object', properties: { q: { type: 'string', description: 'запрос' } }, required: ['q'] } },
        { field: "t_name'], body, [x", severity: 'tip', message: 'Поле, которого нет', fix: 'зло' },
        { field: null, severity: 'tip', message: 'Добавьте пример вызова в описание' },
      ],
      help: ['Проверьте входные параметры в начале кода'],
    }) + '\n```';
    btn.click();
    for (let i = 0; i < 50 && !document.querySelector('#modals .review-issue'); i++) await tick(1);

    const req = sentToModel[0];
    ok('модели ушла форма', !!req && req.length === 2 && req[0].role === 'system');
    ok('с правилами именно этого вида объектов', /песочниц/.test(req[0].content) && /JSON Schema/.test(req[0].content));
    const payload = JSON.parse(req[1].content);
    ok('поля отправлены с подписями и значениями',
       payload.поля.some(f => f.id === 't_handler' && /localStorage/.test(f.value) && /Handler Code/.test(f.label)),
       JSON.stringify(payload.поля.map(f => f.id)));
    ok('и соседние объекты для контекста — без самого редактируемого',
       payload.контекст['другие инструменты (имена)'].includes('slugify_text') &&
       !payload.контекст['другие инструменты (имена)'].includes('my_tool'));

    const panel = document.querySelector('#modals .review-panel');
    ok('отчёт показан прямо в окне', !panel.hidden && /не заработает/.test(panel.textContent));
    ok('видно, какая модель проверяла и во что обошлось',
       /проверочная-модель/.test(panel.textContent) && /321 токенов/.test(panel.textContent));
    ok('замечания привязаны к полям по их подписям', /«Имя функции \(name\)»/.test(panel.textContent), panel.textContent.slice(0, 200));
    ok('советы вне полей тоже показаны', /пример вызова/.test(panel.textContent) && /входные параметры/.test(panel.textContent));

    // Исправление не применяется само.
    ok('исправление не применяется без спроса', document.getElementById('t_name').value === 'my tool');

    let inputFired = false;
    document.getElementById('t_name').addEventListener('input', () => { inputFired = true; });
    const applyBtns = panel.querySelectorAll('.review-apply');
    applyBtns[0].click();
    ok('«Применить» ставит исправленное значение в поле', document.getElementById('t_name').value === 'my_tool');
    ok('форма узнаёт об этом как о ручном вводе', inputFired);
    ok('кнопка отмечает, что применено', /Применено/.test(applyBtns[0].textContent) && applyBtns[0].disabled);

    applyBtns[2].click();
    ok('исправление-объект ставится в поле как JSON',
       JSON.parse(document.getElementById('t_params').value).required[0] === 'q');

    // id поля присылает модель — он не должен ломать поиск поля.
    const bogus = Array.from(panel.querySelectorAll('.review-issue'))
      .find(r => /Поле, которого нет/.test(r.textContent));
    const bogusBtn = bogus && bogus.querySelector('.review-apply');
    ok('поле с выдуманным id исправить не предлагается', !bogusBtn);

    // Разметка из ответа модели не исполняется.
    reply = JSON.stringify({ summary: '<img src=x onerror="window.__pwn=1">', issues: [
      { field: 't_desc', severity: 'tip', message: '<b>жирно</b>' }], help: ['<script>window.__pwn=2</script>'] });
    btn.click();
    for (let i = 0; i < 50 && !/жирно/.test(panel.textContent); i++) await tick(1);
    ok('разметка из ответа модели показывается текстом',
       !panel.querySelector('img, script') &&
       !Array.from(panel.querySelectorAll('b')).some(b => b.textContent === 'жирно') &&
       /<b>жирно<\/b>/.test(panel.textContent) && !window.__pwn);

    // Ответ не в условленном виде — всё равно полезен.
    reply = 'Просто текст без JSON: имя плохое.';
    btn.click();
    for (let i = 0; i < 50 && !/не в условленном виде/.test(panel.textContent); i++) await tick(1);
    ok('ответ не JSON-ом показан целиком', /не в условленном виде/.test(panel.textContent) && /имя плохое/.test(panel.textContent));

    document.querySelector('#modals .modal-actions .btn-secondary:not(.review-btn)').click();

    // ── Секреты модели не уходят ──
    ui.agent.models = {
      connections: [{ id: 'c9', name: 'P', apiUrl: 'https://api.example/v1', apiKey: 'sk-СЕКРЕТ-123',
                      customHeaderName: '', customHeaderValue: '', enabled: true, models: [] }],
      allModels: () => [], describe: () => null,
    };
    await ui.showProviderEditor('c9');
    for (let i = 0; i < 50 && !document.querySelector('#modals .review-btn'); i++) await tick(1);
    ok('у редактора провайдера тоже есть проверка', !!document.querySelector('#modals .review-btn'));
    sentToModel.length = 0;
    reply = JSON.stringify({ summary: 'ок', issues: [{ field: 'pe_key', severity: 'warning', message: 'ключ', fix: 'sk-НОВЫЙ' }], help: [] });
    document.querySelector('#modals .review-btn').click();
    for (let i = 0; i < 50 && !sentToModel.length; i++) await tick(1);
    for (let i = 0; i < 50 && !document.querySelector('#modals .review-issue'); i++) await tick(1);
    const wire = JSON.stringify(sentToModel);
    ok('значение ключа модели не отправлено', !/СЕКРЕТ/.test(wire), wire.slice(0, 300));
    ok('но сказано, что ключ задан', /секрет задан/.test(wire));
    ok('исправлять секрет не предлагается', !document.querySelector('#modals .review-apply'));
    document.querySelector('#modals .modal-actions .btn-secondary:not(.review-btn)').click();

    // ── Модель не настроена ──
    ui.agent.llm = { isConfigured: () => false };
    ui.showAddPromptModal();
    for (let i = 0; i < 50 && !document.querySelector('#modals .review-btn'); i++) await tick(1);
    document.querySelector('#modals .review-btn').click();
    await tick();
    ok('без модели — объяснение, а не молчание',
       /Модель не настроена/.test(document.querySelector('#modals .review-panel').textContent));
    document.querySelector('#modals .modal-actions .btn-secondary:not(.review-btn)').click();

    // У простого вопроса «да/нет» проверять нечего.
    const q = ui._confirm('Удалить?');
    await tick();
    ok('у вопроса «да/нет» кнопки проверки нет', !document.querySelector('#modals .review-btn'));
    document.querySelector('#modals .modal-actions .btn-secondary').click();
    await q;
  }

  // ══════════════════════════════════════════════
  console.log('\n── Подсветка кода в редакторе инструмента ──');
  {
    const hostile = 'const s = "</textarea><img src=x onerror=window.__pwn3=1>";\nreturn { s };';
    ui.agent.db.get = async (store, id) => (store === 'tools' && id === 'hl1')
      ? { id: 'hl1', name: 'hl_tool', description: 'd', parameters: { type: 'object', properties: { q: { type: 'string' } } },
          handlerCode: hostile, enabled: true }
      : null;
    ui.showAddToolModal('hl1');
    for (let i = 0; i < 50 && !document.querySelector('#modals .code-edit'); i++) await tick(1);

    const handler = document.getElementById('t_handler');
    const params = document.getElementById('t_params');
    ok('код инструмента в поле с подсветкой', !!handler.closest('.code-edit') && handler.dataset.codeLang === 'js');
    ok('схема параметров — с подсветкой JSON', !!params.closest('.code-edit') && params.dataset.codeLang === 'json');
    ok('поле осталось тем же элементом с тем же id', document.getElementById('t_handler') === handler);
    // Раньше код вставлялся в разметку без экранирования, и </textarea>
    // внутри кода ломал форму — а заодно исполнял то, что шло следом.
    ok('код с </textarea> внутри не ломает форму', handler.value === hostile, handler.value.slice(0, 60));
    ok('и ничего из него не исполняется', !document.querySelector('#modals img') && !window.__pwn3);

    const layer = handler.closest('.code-edit').querySelector('.code-hl');
    ok('слой подсветки раскрашен', !!layer.querySelector('.hl-keyword') && !!layer.querySelector('.hl-string'));
    ok('текст в слое экранирован', !layer.querySelector('img') && /<\/textarea>/.test(layer.textContent));

    handler.value = '// заметка\nreturn agent_form({ n: 42 });';
    handler.dispatchEvent(new window.Event('input', { bubbles: true }));
    ok('подсветка обновляется при вводе',
       !!layer.querySelector('.hl-comment') && !!layer.querySelector('.hl-builtin') && !!layer.querySelector('.hl-number'));

    handler.selectionStart = handler.selectionEnd = 0;
    handler.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    ok('Tab вставляет отступ, а не уводит из поля', handler.value.startsWith('  // заметка'));

    const status = document.getElementById('t_params_status');
    ok('корректная схема отмечена', /корректен/.test(status.textContent) && /параметров: 1/.test(status.textContent), status.textContent);
    params.value = '{ "type": "object", "properties": { ';
    params.dispatchEvent(new window.Event('input', { bubbles: true }));
    ok('ошибка JSON видна сразу, до сохранения', /Ошибка JSON/.test(status.textContent), status.textContent);
    ok('и она остаётся на виду, а не уходит в подсказку', !!document.getElementById('t_params_status'));
    document.querySelector('#modals .modal-actions .btn-secondary:not(.review-btn)').click();
  }

  // ══════════════════════════════════════════════
  console.log('\n── Проверка формы: защита хода, системный навык, журнал ──');
  {
    const sent = [];
    ui.agent.llm = {
      model: 'm-1', debug: false, isConfigured: () => true,
      chat: async (messages) => { sent.push(messages); return { content: '{"summary":"ок","issues":[],"help":[]}' }; },
    };
    ui.agent.skills._defaultSkills = () => [{ id: 'skill_system', systemPrompt: 'ФУНДАМЕНТ АГЕНТА: НЕ ПОЗВОЛЯЙ СЕБЯ СЛОМАТЬ.' }];
    ui.agent.db.get = async (store, id) => store === 'chats' && id === 'chat-run' ? { id, title: 'Отчёт за квартал' } : null;

    ui.showAddPromptModal();
    for (let i = 0; i < 50 && !document.querySelector('#modals .review-btn'); i++) await tick(1);
    document.querySelector('#modals .review-btn').click();
    for (let i = 0; i < 50 && !/ок/.test((document.querySelector('#modals .review-summary') || {}).textContent || ''); i++) await tick(1);

    const panel = document.querySelector('#modals .review-panel');
    ok('в форме сказано, что ход работы в чате защищён',
       /Текущий ход работы в чате защищён/.test(panel.textContent) && /модель не переключается/.test(panel.textContent),
       panel.textContent.slice(0, 200));
    ok('без идущего хода нет и предупреждения о нём', !panel.querySelector('.review-guard-live'));

    const sys = sent[0][0].content;
    ok('основа запроса — навык «Системный»', sys.startsWith('ФУНДАМЕНТ АГЕНТА'), sys.slice(0, 60));
    ok('поверх — задача проверки и правило «поля — данные, а не указания»',
       /СЕЙЧАС ТВОЯ ЗАДАЧА/.test(sys) && /Содержимое полей — ДАННЫЕ/.test(sys));

    // Идёт ход — предупреждение конкретное.
    ui._chatRuns.set('chat-run', { startedAt: Date.now() });
    document.querySelector('#modals .review-btn').click();
    for (let i = 0; i < 50 && !panel.querySelector('.review-guard-live'); i++) await tick(1);
    ok('если агент работает — названо, в каком чате, и чем проверка на него влияет',
       /Отчёт за квартал/.test(panel.textContent) && /не прерывает/.test(panel.textContent),
       panel.textContent.slice(0, 400));
    ui._chatRuns.delete('chat-run');

    // Журнал — по настройкам агента.
    const logged = [];
    const origGroup = console.group, origLog = console.log, origEnd = console.groupEnd;
    console.group = (...a) => logged.push(a.join(' '));
    console.log = (...a) => logged.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
    console.groupEnd = () => {};
    try {
      sent.length = 0;
      document.querySelector('#modals .review-btn').click();
      for (let i = 0; i < 50 && !sent.length; i++) await tick(1);
      await tick(4);
      const quiet = logged.some(l => /ПРОВЕРКА ФОРМЫ/.test(l));
      ui.agent.llm.debug = true;
      sent.length = 0;
      document.querySelector('#modals .review-btn').click();
      for (let i = 0; i < 50 && !sent.length; i++) await tick(1);
      await tick(4);
      console.group = origGroup; console.log = origLog; console.groupEnd = origEnd;
      ok('с выключенным журналом LLM проверка в консоль не пишется', !quiet);
      ok('с включённым — пишется, с пометкой, что это проверка формы',
         logged.some(l => /ПРОВЕРКА ФОРМЫ МОДЕЛЬЮ/.test(l)),
         logged.join(' | ').slice(0, 300));
    } finally {
      console.group = origGroup; console.log = origLog; console.groupEnd = origEnd;
    }
    document.querySelector('#modals .modal-actions .btn-secondary:not(.review-btn)').click();
  }

  // ══════════════════════════════════════════════
  console.log('\n── Переименование инструмента в редакторе ──');
  {
    let replaced = null;
    ui.renderTools = () => {};
    ui.agent.tools.unregisterHandler = () => {};
    ui.agent.db.put = async () => {};
    ui.agent.db.get = async (store, id) => (store === 'tools' && id === 'rn1')
      ? { id: 'rn1', name: 'slug_text', description: 'd',
          parameters: { type: 'object', properties: { text: { type: 'string' } } }, handlerCode: 'return 1;', enabled: true }
      : null;
    ui.agent.skills.toolReferenceImpact = async (before, after) => ({
      renamed: before.name !== after.name, oldName: before.name, newName: after.name,
      removedParams: ['text'], addedParams: ['input'],
      fixable: [{ skillId: 'sk_a', skillName: 'Писатель', count: 2 }],
      manual: [
        { skillId: 'sk_a', skillName: 'Писатель', kind: 'params', params: ['text'], replace: { from: 'text', to: 'input' },
          reason: 'В тексте навыка упоминаются параметры, которых больше нет: «text».', suggestion: 'Замените.' },
        { skillId: 'skill_system', skillName: 'Системный', kind: 'protected',
          reason: 'Навык защищён.', suggestion: 'Верните прежнее имя «slug_text».' },
      ],
    });
    ui.agent.skills.applyToolRename = async (impact) => impact.fixable.map(f => ({ ...f }));
    ui.agent.skills.replaceWordInSkill = async (id, from, to) => { replaced = [id, from, to]; return 1; };

    ui.showAddToolModal('rn1');
    for (let i = 0; i < 50 && !document.getElementById('t_name'); i++) await tick(1);
    document.getElementById('t_name').value = 'make_slug';
    document.getElementById('t_params').value = '{ "type": "object", "properties": { "input": { "type": "string" } } }';
    document.querySelector('#modals .modal-actions .btn-primary').click();
    for (let i = 0; i < 50 && !/Навыки, связанные/.test((document.querySelector('#modals h2') || {}).textContent || ''); i++) await tick(1);

    const rep = document.querySelector('#modals .modal');
    ok('после переименования показан отчёт о навыках', /Навыки, связанные с инструментом/.test(rep.querySelector('h2').textContent));
    ok('что исправлено автоматически — названо', /Исправлено автоматически/.test(rep.textContent) && /Писатель/.test(rep.textContent));
    ok('что исправить нельзя — с причиной и предложением',
       /Требует решения/.test(rep.textContent) && /Навык защищён/.test(rep.textContent) && /Верните прежнее имя/.test(rep.textContent));
    ok('у защищённого навыка нет кнопки «Открыть» — править его всё равно нельзя',
       Array.from(rep.querySelectorAll('.dep-manual')).find(r => /Системный/.test(r.textContent)).querySelector('.dep-open') === null);
    ok('кнопки окна названы по делу', /Готово/.test(rep.querySelector('.modal-actions .btn-primary').textContent));

    const rb = rep.querySelector('.dep-replace');
    ok('вероятная замена параметра предложена кнопкой', !!rb && /text/.test(rb.textContent) && /input/.test(rb.textContent));
    rb.click();
    for (let i = 0; i < 50 && !replaced; i++) await tick(1);
    ok('и выполняется только по нажатию', replaced && replaced.join() === 'sk_a,text,input');
    await tick();
    ok('результат замены виден', /Заменено/.test(rb.textContent) && rb.disabled);
    document.querySelector('#modals .modal-actions .btn-primary').click();
  }

  // ══════════════════════════════════════════════
  console.log('\n── Первый запуск: история релизов ──');
  {
    let marked = false;
    ui.agent.about = {
      releaseCount: () => 3,
      all: () => [
        { n: 1, title: 'Начало', items: ['Чаты'] },
        { n: 2, title: 'Инструменты', items: ['Песочница'] },
        { n: 3, title: 'Навыки', items: ['Проверка формы'] },
      ],
      unread: async () => [],
      markRead: async () => { marked = true; },
    };
    ui.updateReleaseBadge = async () => {};
    ui.showBackupImportModal = async () => 'восстановление';

    const title = () => (document.querySelector('#modals h2') || {}).textContent || '';
    const first = ui.offerFirstRunRestore();
    await tick();

    const hist = document.getElementById('first_run_history');
    ok('в окне первого запуска есть кнопка истории релизов',
       /Первый запуск/.test(title()) && !!hist && /История релизов/.test(hist.textContent) &&
       /всего релизов: 3/.test(hist.getAttribute('title') || ''),
       hist && hist.textContent);
    ok('кнопки выбора остались на местах',
       /Начать с нуля/.test(document.querySelector('#modals .modal-actions .btn-secondary').textContent) &&
       /Восстановить/.test(document.querySelector('#modals .modal-actions .btn-primary').textContent));

    hist.click();
    for (let i = 0; i < 50 && !/История доработок/.test(title()); i++) await tick(1);
    ok('по кнопке открывается история релизов', /История доработок/.test(title()));
    ok('в ней все релизы, от новых к старым',
       /Релиз 3/.test(document.querySelector('#modals').textContent) &&
       document.querySelector('#modals').textContent.indexOf('Релиз 3') < document.querySelector('#modals').textContent.indexOf('Релиз 1'));

    document.querySelector('#modals .modal-actions .btn-primary').click();
    for (let i = 0; i < 50 && !/Первый запуск/.test(title()); i++) await tick(1);
    ok('после «Понятно» возвращается окно первого запуска', /Первый запуск/.test(title()));
    ok('просмотр из первого запуска не отмечает релизы прочитанными', !marked);

    document.getElementById('first_run_history').click();
    for (let i = 0; i < 50 && !/История доработок/.test(title()); i++) await tick(1);
    pressEsc();
    for (let i = 0; i < 50 && !/Первый запуск/.test(title()); i++) await tick(1);
    ok('и после закрытия по Esc — тоже', /Первый запуск/.test(title()));

    document.querySelector('#modals .modal-actions .btn-secondary').click();
    ok('«Начать с нуля» по-прежнему завершает выбор', (await first) === false);

    const second = ui.offerFirstRunRestore();
    await tick();
    document.querySelector('#modals .modal-actions .btn-primary').click();
    ok('«Восстановить из файла» по-прежнему ведёт к восстановлению', (await second) === 'восстановление');
  }

  // ══════════════════════════════════════════════
  console.log('\n── Форма настройки поиска в интернете ──');
  {
    window.ToolsEngine = { WEB_SEARCH_PROVIDERS: {
      duckduckgo: { title: 'DuckDuckGo', needsKey: false, cors: false },
      searxng: { title: 'SearXNG (свой экземпляр)', needsKey: false, cors: null },
      brave: { title: 'Brave Search API', needsKey: true, cors: false },
      google: { title: 'Google Programmable Search', needsKey: true, cors: true },
      tavily: { title: 'Tavily Search API', needsKey: true, cors: null },
    } };
    let savedArgs = null, testArgs = null;
    const stored = { key: 'web_search', provider: 'brave', viaProxy: true, apiKey: 'enc:OLD-KEY', count: 5 };
    ui.agent.db.get = async (store, key) => (store === 'settings' && key === 'web_search') ? stored : null;
    ui.agent.tools = {
      _webSearchConfig: async () => ({ saved: true, provider: 'brave', viaProxy: true, searxngUrl: '', googleCx: '',
        count: 5, apiKey: 'OLD-KEY', proxyBaseUrl: 'http://localhost:3000' }),
      _webSearchSaveConfig: async (a) => { savedArgs = a; return { provider: a.provider, viaProxy: a.viaProxy }; },
      _webSearchForget: async () => true,
      _webSearch: async (params, override) => { testArgs = { params, override };
        return { count: 1, results: [{ title: '<b>Новость</b>', url: 'https://n.test' }] }; },
    };

    const done = ui.showWebSearchConfigModal();
    for (let i = 0; i < 50 && !document.getElementById('ws_provider'); i++) await tick(1);
    const $ = (id) => document.getElementById(id);
    const modal = document.querySelector('#modals .modal');

    ok('форма открылась с сохранённой службой', $('ws_provider').value === 'brave' && $('ws_proxy').checked);
    ok('сохранённый ключ в поле не показан', $('ws_key').value === '' && !modal.innerHTML.includes('OLD-KEY'));
    ok('а подсказано, что он сохранён', /Сохранён/.test($('ws_key').getAttribute('placeholder')));
    ok('для Brave видно поле ключа, но не cx и не адрес SearXNG',
       !$('ws_key_row').hidden && $('ws_cx_row').hidden && $('ws_searxng_row').hidden);
    ok('и сказано, где взять ключ', /api-dashboard\.search\.brave\.com/.test($('ws_provider_note').textContent));

    $('ws_provider').value = 'duckduckgo';
    $('ws_provider').dispatchEvent(new window.Event('change'));
    ok('у DuckDuckGo поля ключа нет', $('ws_key_row').hidden);
    $('ws_proxy').checked = false;
    $('ws_proxy').dispatchEvent(new window.Event('change'));
    ok('без прокси DuckDuckGo сразу предупреждает, что не заработает',
       !$('ws_proxy_warn').hidden && /включите прокси/.test($('ws_proxy_warn').textContent));
    ok('и это предупреждение не спрятано в подсказку', !!$('ws_proxy_warn'));

    $('ws_provider').value = 'google';
    $('ws_provider').dispatchEvent(new window.Event('change'));
    ok('у Google — поле cx', !$('ws_cx_row').hidden && !$('ws_key_row').hidden);
    $('ws_cx').value = 'CX-FORM';
    $('ws_test').click();
    for (let i = 0; i < 50 && !/Работает/.test($('ws_test_result').textContent); i++) await tick(1);
    ok('«Проверить поиск» ищет с тем, что введено в форме',
       testArgs && testArgs.override.provider === 'google' && testArgs.override.googleCx === 'CX-FORM',
       JSON.stringify(testArgs && testArgs.override));
    ok('с сохранённым ключом, если новый не введён', testArgs && testArgs.override.apiKey === 'OLD-KEY');
    ok('результат проверки показан, разметка из выдачи не исполняется',
       /Работает: найдено 1/.test($('ws_test_result').textContent) && !$('ws_test_result').querySelector('b'));
    ok('проверка ничего не сохранила', savedArgs === null);

    ui.agent.tools._webSearch = async () => ({ error: 'Google отказал в доступе (403)', hint: 'Проверь ключ' });
    $('ws_test').click();
    for (let i = 0; i < 50 && !/отказал/.test($('ws_test_result').textContent); i++) await tick(1);
    ok('ошибка проверки показана с подсказкой', /✗ Google отказал/.test($('ws_test_result').textContent) && /Проверь ключ/.test($('ws_test_result').textContent));

    document.querySelector('#modals .modal-actions .btn-primary').click();
    const res = await done;
    ok('сохранение передаёт выбранное', savedArgs && savedArgs.provider === 'google' && savedArgs.googleCx === 'CX-FORM' && savedArgs.viaProxy === false,
       JSON.stringify(savedArgs));
    ok('пустое поле ключа означает «не менять»', savedArgs && savedArgs.keepKey === true && savedArgs.apiKey === '');
    ok('форма вернула результат', res && res.provider === 'google');
  }

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('СБОЙ ТЕСТА:', e); process.exit(1); });
