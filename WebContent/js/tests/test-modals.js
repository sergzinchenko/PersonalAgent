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
    'js/ui/ui-editors.js',
    'js/ui/ui-transfer.js',
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
    ok('о подсказке видно, что она есть', labels.every(l => !!l.querySelector('span')));
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

    document.querySelector('#modals .btn-secondary')?.click();
  }

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('СБОЙ ТЕСТА:', e); process.exit(1); });
