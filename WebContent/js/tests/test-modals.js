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
    'js/ui/ui-core.js',
    'js/ui/ui-navigation.js',
    'js/ui/ui-chat.js',
    'js/ui/ui-subtask.js',
    'js/ui/ui-compaction.js',
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

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('СБОЙ ТЕСТА:', e); process.exit(1); });
