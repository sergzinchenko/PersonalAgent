// ============================================================
//  ТЕСТ: непротиворечивость ограничений и окно контекста
// ============================================================
//
// Две проверки, у которых общая суть: приложение должно САМО замечать
// то, что иначе выясняется по симптомам.
//
//   1. LimitsAdvisor — сочетания настроек, при которых ограничение не
//      работает так, как написано в его же подписи: таймаут вызова
//      больше бюджета хода, потолок вызовов ниже потолка шагов, порог
//      артефакта выше предела ответа. Каждое из них выглядит как
//      «настроено», а ведёт себя как «сломано».
//
//   2. Окно контекста — три способа узнать его, не спрашивая человека:
//      из списка моделей провайдера, из текста его отказа и по факту
//      прошедшего запроса. Здесь же — правило, по которому автоматика
//      не спорит с значением, введённым руками.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e !== undefined ? ' → ' + e : '')); } };

const ROOT = path.join(__dirname, '..', '..');

const sandbox = {
  console, JSON, Math, Number, parseInt, parseFloat, String, Object, Array, Map, Set,
  RegExp, Date, Promise, Error, TypeError, isNaN, Boolean, fetch: async () => ({ ok: false }),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const load = (f, ...names) => vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'js', f), 'utf8') +
  (names.length ? '\n' + names.map(n => `globalThis.${n} = ${n};`).join('\n') : ''),
  sandbox, { filename: f });

console.log('\n── Загрузка модулей ──');
try {
  load('core/limits-advisor.js', 'LimitsAdvisor');
  load('llm/llm-registry.js', 'LLMRegistry');
  ok('модули загрузились', true);
} catch (e) {
  ok('модули загрузились', false, e.message);
  process.exit(1);
}

const { LimitsAdvisor, LLMRegistry } = sandbox;

// Значения по умолчанию из ui-core.js: с ними приложение и поставляется,
// поэтому именно они обязаны быть согласованы между собой.
const DEFAULTS = {
  maxToolSteps: 25,
  maxTurnSeconds: 180,
  toolTimeoutSeconds: 30,
  maxToolCallsPerTurn: 50,
  maxToolResponseChars: 20000,
  artifactThresholdChars: 2000,
  subtaskMaxSteps: 10,
  contextCompaction: true,
};

const has = (findings, part) => findings.some(f => f.title.includes(part));

(async () => {
  console.log('\n── Значения по умолчанию ──');
  const base = LimitsAdvisor.analyze(DEFAULTS, null);
  ok('на значениях по умолчанию замечаний нет', base.length === 0,
     base.map(f => f.title).join(' | '));
  ok('и вердикт — «в порядке»', LimitsAdvisor.verdict(base) === 'ok');

  console.log('\n── Время ──');
  const slowTool = LimitsAdvisor.analyze({ ...DEFAULTS, toolTimeoutSeconds: 300 }, null);
  ok('таймаут вызова больше бюджета хода — ошибка',
     has(slowTool, 'больше бюджета') && LimitsAdvisor.verdict(slowTool) === 'error');
  const fix = slowTool.find(f => f.title.includes('больше бюджета')).fix;
  ok('и предложено значение, которое в бюджет укладывается',
     fix.field === 'toolTimeoutSeconds' && fix.value < DEFAULTS.maxTurnSeconds, JSON.stringify(fix));
  ok('половина бюджета — уже предупреждение, но не ошибка',
     LimitsAdvisor.verdict(LimitsAdvisor.analyze({ ...DEFAULTS, toolTimeoutSeconds: 120 }, null)) === 'warn');

  console.log('\n── Шаги и вызовы ──');
  const fewCalls = LimitsAdvisor.analyze({ ...DEFAULTS, maxToolCallsPerTurn: 5 }, null);
  ok('потолок вызовов ниже потолка шагов — ошибка', has(fewCalls, 'Потолок вызовов'));
  ok('рекомендация поднимает именно вызовы',
     fewCalls.find(f => f.title.includes('Потолок вызовов')).fix.field === 'maxToolCallsPerTurn');

  const noBrakes = LimitsAdvisor.analyze(
    { ...DEFAULTS, maxToolSteps: 0, maxTurnSeconds: 0, maxToolCallsPerTurn: 0 }, null);
  ok('снятые разом три ограничения — ошибка', has(noBrakes, 'нечем остановить'));

  console.log('\n── Подзадача ──');
  const bigSub = LimitsAdvisor.analyze({ ...DEFAULTS, subtaskMaxSteps: 25 }, null);
  ok('подзадаче нельзя разрешать столько же шагов, сколько ходу',
     has(bigSub, 'подзадач') || has(bigSub, 'Подзадаче'), bigSub.map(f => f.title).join(' | '));

  console.log('\n── Артефакты ──');
  const noArtifacts = LimitsAdvisor.analyze({ ...DEFAULTS, artifactThresholdChars: 20000 }, null);
  ok('порог артефакта не ниже предела ответа — артефакты не заведутся',
     has(noArtifacts, 'Артефакты не заведутся'));
  ok('и это ошибка, а не совет', LimitsAdvisor.verdict(noArtifacts) === 'error');
  ok('выключенные артефакты — предупреждение',
     has(LimitsAdvisor.analyze({ ...DEFAULTS, artifactThresholdChars: 0 }, null), 'целиком'));

  console.log('\n── Связь с моделью ──');
  const small = { contextWindow: 8192, maxTokens: 4096 };
  const withSmall = LimitsAdvisor.analyze(DEFAULTS, small);
  ok('ответ инструмента в четверть окна — предупреждение',
     has(withSmall, 'четверть окна'), withSmall.map(f => f.title).join(' | '));
  // Ровно половина — ещё не повод предупреждать: приложение и так
  // резервирует под ответ не больше 30% окна. А вот больше половины —
  // уже повод: провайдер может отказать на prompt + max_tokens > окна.
  ok('ровно половина окна под ответ — не замечание',
     !has(withSmall, 'половины окна'), withSmall.map(f => f.title).join(' | '));
  ok('больше половины — предупреждение',
     has(LimitsAdvisor.analyze(DEFAULTS, { contextWindow: 8192, maxTokens: 6000 }), 'половины окна'));

  const impossible = LimitsAdvisor.analyze(DEFAULTS, { contextWindow: 4096, maxTokens: 4096 });
  ok('max_tokens не меньше окна — ошибка', has(impossible, 'не меньше окна'));
  ok('исправлять надо карточку модели, и это сказано',
     impossible.find(f => f.title.includes('не меньше окна')).fix.field === 'model.maxTokens');

  const unknown = LimitsAdvisor.analyze(DEFAULTS, { contextWindow: 0, maxTokens: 4096 });
  ok('неизвестное окно — предупреждение', has(unknown, 'неизвестно'));

  console.log('\n── Рекомендации применимы разом ──');
  const broken = {
    ...DEFAULTS, toolTimeoutSeconds: 300, maxToolCallsPerTurn: 5, artifactThresholdChars: 20000,
  };
  const patch = LimitsAdvisor.recommend(broken, null);
  ok('рекомендация собрана по всем замечаниям', Object.keys(patch).length >= 3, JSON.stringify(patch));
  ok('в неё не попадают поля карточки модели',
     Object.keys(LimitsAdvisor.recommend(DEFAULTS, { contextWindow: 4096, maxTokens: 4096 }))
       .every(k => !k.startsWith('model.')));
  const after = LimitsAdvisor.analyze({ ...broken, ...patch }, null);
  ok('после применения замечаний не остаётся', after.length === 0,
     after.map(f => f.title).join(' | '));

  // ══════════════════════════════════════════════
  console.log('\n── Окно контекста: из списка моделей ──');
  ok('vLLM: max_model_len',
     LLMRegistry.contextFromModelEntry({ id: 'x', max_model_len: 32768 }) === 32768);
  ok('OpenRouter: context_length',
     LLMRegistry.contextFromModelEntry({ id: 'x', context_length: 128000 }) === 128000);
  ok('вложенные поля тоже читаются',
     LLMRegistry.contextFromModelEntry({ id: 'x', meta: { n_ctx: 8192 } }) === 8192);
  ok('мелочь за окно не принимаем',
     LLMRegistry.contextFromModelEntry({ id: 'x', max_tokens: 512 }) === 0);
  ok('обычная карточка OpenAI ничего не даёт',
     LLMRegistry.contextFromModelEntry({ id: 'gpt-4o', object: 'model', created: 1715367049 }) === 0);

  console.log('\n── Окно контекста: из текста отказа ──');
  // Апостроф в «model's» собираем кодом символа: экранирование внутри
  // строки в строке — верный способ сломать сам тест, а не проверку.
  const q = String.fromCharCode(39);
  const openaiError = 'API Error 400: {"error":{"message":"This model' + q +
    's maximum context length is 8192 tokens, however you requested 9000"}}';
  ok('формулировка OpenAI разбирается', LLMRegistry.contextFromError(openaiError) === 8192);
  ok('локальные сборки тоже', LLMRegistry.contextFromError('max_seq_len 32768 exceeded') === 32768);
  ok('посторонняя ошибка не даёт ложного срабатывания',
     LLMRegistry.contextFromError('API Error 500: internal error, request id 4096') === 0);

  console.log('\n── Окно контекста: уточнение по работе ──');

  // Мини-реестр: нужны только resolve/saveModel/applyRef.
  const makeReg = (model) => {
    const reg = Object.create(LLMRegistry.prototype);
    reg.connections = [{ id: 'c1', name: 'p', apiUrl: 'http://x', models: [model] }];
    reg.currentRef = 'c1:m1';
    reg.defaultRef = 'c1:m1';
    reg.saved = [];
    reg.resolve = () => ({ ref: 'c1:m1', conn: reg.connections[0], model: reg.connections[0].models[0] });
    reg.saveModel = async (connId, m) => { reg.connections[0].models[0] = m; reg.saved.push(m); return m; };
    reg.applyRef = () => true;
    return reg;
  };

  let reg = makeReg({ id: 'm1', name: 'local', contextWindow: 8000, contextWindowSource: 'guess' });
  let res = await reg.learnContextWindow('c1:m1', 12000, 'observed');
  ok('прошедший запрос больше заявленного окна — окно поднимается', res.changed === true, JSON.stringify(res));
  ok('с небольшим запасом и круглым числом', res.to >= 12000 && res.to % 1000 === 0, String(res.to));

  reg = makeReg({ id: 'm1', name: 'local', contextWindow: 128000, contextWindowSource: 'manual' });
  res = await reg.learnContextWindow('c1:m1', 12000, 'observed');
  ok('меньшее наблюдение окно не понижает', res.changed === false);

  reg = makeReg({ id: 'm1', name: 'local', contextWindow: 128000, contextWindowSource: 'manual' });
  res = await reg.learnContextWindow('c1:m1', 32768, 'provider');
  ok('данные провайдера не спорят с введённым вручную', res.changed === false);

  reg = makeReg({ id: 'm1', name: 'local', contextWindow: 128000, contextWindowSource: 'manual' });
  res = await reg.learnContextWindow('c1:m1', 8192, 'error');
  ok('но отказ провайдера главнее: он означает «ваше значение неверно»',
     res.changed === true && res.to === 8192, JSON.stringify(res));
  ok('и источник значения записан', reg.saved[0].contextWindowSource === 'error');

  reg = makeReg({ id: 'm1', name: 'local', contextWindow: 0 });
  res = await reg.learnContextWindow('c1:m1', 32768, 'provider');
  ok('пустое окно заполняется любым источником', res.changed === true && res.to === 32768);

  reg = makeReg({ id: 'm1', name: 'local', contextWindow: 8000 });
  ok('мусорные значения игнорируются',
     (await reg.learnContextWindow('c1:m1', 12, 'observed')).changed === false);

  // ══════════════════════════════════════════════
  console.log('\n── Проба модели живым запросом ──');

  // Проба честно пишет каждый свой шаг в консоль — это её работа. Но в
  // выводе набора этот журнал только шум: глушим его на время раздела
  // и включаем там, где он сам предмет проверки.
  const realConsole = sandbox.console;
  const silent = { group() {}, groupEnd() {}, log() {}, dir() {}, error() {} };
  sandbox.console = silent;

  // Мини-реестр с подменённым fetch: проба — это два запроса, и важно,
  // ЧТО именно она из них вытаскивает.
  const makeProbe = (responder) => {
    const reg = Object.create(LLMRegistry.prototype);
    reg.connections = [{ id: 'c1', name: 'P', apiUrl: 'http://x/v1', apiKey: 'k' }];
    reg._headers = () => ({ 'Content-Type': 'application/json' });
    const sent = [];
    sandbox.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      const r = responder(body, sent.length);
      return {
        ok: r.ok !== false,
        status: r.status || 200,
        text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {})),
      };
    };
    return { reg, sent };
  };

  // Провайдер отказывает и сам называет предел — самый точный источник.
  const { reg: r1, sent: sent1 } = makeProbe((body, n) => n === 1
    ? { ok: false, status: 400, body: '{"error":{"message":"This model maximum context length is 8192 tokens"}}' }
    : { body: { choices: [{ message: { content: 'ok' } }] } });
  let probed = await r1.probeModel('c1', 'local-model');
  ok('предел контекста берётся из отказа провайдера', probed.contextWindow === 8192, JSON.stringify(probed));
  ok('и помечен как названный им самим', probed.contextSource === 'error');
  ok('первый запрос — с заведомо невозможным пределом ответа',
     sent1[0].max_tokens >= 1000000, String(sent1[0].max_tokens));
  ok('запрос крошечный: одно сообщение', sent1[0].messages.length === 1);

  // Провайдер предел молча урезает: узнаём другое — что модель отвечает.
  const { reg: r2, sent: sent2 } = makeProbe((body, n) => n === 1
    ? { body: { model: 'local-model-q4', usage: { prompt_tokens: 12 },
                choices: [{ message: { content: 'готово' }, finish_reason: 'stop' }] } }
    : { body: { choices: [{ message: { content: 'ok' } }] } });
  probed = await r2.probeModel('c1', 'local-model');
  ok('без отказа окно не выдумывается', !probed.contextWindow, JSON.stringify(probed.contextWindow));
  ok('но сказано, что модель отвечает', probed.findings.some(f => /отвеча/.test(f)), probed.findings.join(' | '));
  ok('замечено расхождение идентификатора',
     probed.resolvedModel === 'local-model-q4' &&
     probed.findings.some(f => f.includes('local-model-q4')), probed.findings.join(' | '));
  ok('оценка токенизатора посчитана', !!probed.tokensPerChar);
  ok('и честно сказано, что окно придётся задать вручную',
     probed.findings.some(f => /вручную/.test(f)), probed.findings.join(' | '));

  // Второй запрос — про инструменты, и он с ними.
  ok('вторым запросом проверяются инструменты',
     Array.isArray(sent2[1].tools) && sent2[1].tools.length === 1, JSON.stringify(sent2[1].tools));

  // Модель без поддержки инструментов: для этого приложения это важнее
  // всего остального.
  const { reg: r3 } = makeProbe((body, n) => n === 1
    ? { body: { choices: [{ message: { content: 'ok' } }] } }
    : { ok: false, status: 400, body: '{"error":{"message":"tools are not supported by this model"}}' });
  probed = await r3.probeModel('c1', 'plain-model');
  ok('отсутствие поддержки инструментов замечено', probed.tools === false);
  ok('и названо прямо, с последствием',
     probed.findings.some(f => /НЕ ПОДДЕРЖИВАЮТСЯ/.test(f) && /разговаривать/.test(f)),
     probed.findings.join(' | '));

  // ── Два случая из жизни, на которых проба спотыкалась ──

  // 1. Провайдер отвергает не запрос, а конкретно max_tokens, и называет
  //    свой потолок. Окно меньше него быть не может.
  const realError1 = '{"error":{"message":"Invalid max_tokens value, the valid range of max_tokens is [1, 393216]",' +
    '"type":"invalid_request_error","param":null,"code":"invalid_request_error"}}';
  const { reg: r5, sent: sent5 } = makeProbe((body, n) => {
    if (n === 1) return { ok: false, status: 400, body: realError1 };
    return { body: { model: 'glm', choices: [{ message: { content: 'готово' } }] } };
  });
  probed = await r5.probeModel('c1', 'glm');
  ok('потолок max_tokens разобран из отказа', probed.maxTokensCeiling === 393216, JSON.stringify(probed.maxTokensCeiling));
  ok('и принят как нижняя граница окна', probed.contextWindow === 393216 && probed.contextSource === 'ceiling',
     probed.contextSource);
  ok('сказано, почему это именно «не меньше»',
     probed.findings.some(f => /не меньше/.test(f)), probed.findings.join(' | '));
  ok('отказ по max_tokens не считается отказом модели: её спросили ещё раз',
     sent5.length >= 2 && sent5[1].max_tokens <= 64, JSON.stringify(sent5.map(x => x.max_tokens)));
  ok('и поддержку инструментов всё равно проверили',
     sent5.some(x => Array.isArray(x.tools)), JSON.stringify(sent5.length));

  // 2. Сервер принимает любой max_tokens, но отвечает от имени другой
  //    модели — а в перечне она есть именно под этим именем.
  const { reg: r6 } = makeProbe((body, n) => {
    if (n === 1) return { body: { model: 'z-ai/glm-5.2', usage: { prompt_tokens: 26 },
                                  choices: [{ message: { content: 'готово' } }] } };
    return { body: { choices: [{ message: { content: 'ok' } }] } };
  });
  // Перечень моделей отдаётся тем же поддельным fetch: подменяем его
  // так, чтобы запрос к /models вернул карточку с окном.
  const baseFetch = sandbox.fetch;
  sandbox.fetch = async (url, init) => {
    if (String(url).endsWith('/models')) {
      // fetchAvailable читает перечень через json(), а не text().
      const body = { data: [{ id: 'z-ai/glm-5.2', context_length: 200000 }] };
      return { ok: true, status: 200,
        json: async () => body, text: async () => JSON.stringify(body) };
    }
    return baseFetch(url, init);
  };
  probed = await r6.probeModel('c1', 'glm-5.2');
  ok('окно нашлось в перечне под настоящим именем модели',
     probed.contextWindow === 200000 && probed.contextSource === 'provider', JSON.stringify(probed.contextWindow));
  ok('и сказано, под каким именно',
     probed.findings.some(f => /z-ai\/glm-5\.2/.test(f)), probed.findings.join(' | '));
  ok('жалобы «задайте вручную» при этом нет',
     !probed.findings.some(f => /вручную/.test(f)), probed.findings.join(' | '));

  // 3. Отказ шлюза, где предел провайдера стоит РЯДОМ с числом, которое
  //    запросили мы. Небрежный разбор возьмёт наше — и окно окажется
  //    вымышленным.
  const realError3 = JSON.stringify({ status: 'error', error: { message: JSON.stringify({
    errors: [{ message: 'AiError: AiError: ' + JSON.stringify({
      object: 'error',
      message: 'max_completion_tokens is too large: 1179628.This model supports at most 65536 completion tokens',
    }) }],
  }) } });
  ok('в отказе берётся предел провайдера, а не запрошенное нами число',
     LLMRegistry.maxTokensFromError(realError3) === 65536,
     String(LLMRegistry.maxTokensFromError(realError3)));

  const { reg: r7 } = makeProbe((body, n) => (n === 1
    ? { ok: false, status: 400, body: realError3 }
    : { body: { model: 'gpt-5-mini', choices: [{ message: { content: 'ok' } }] } }));
  sandbox.fetch = (() => {
    const base = sandbox.fetch;
    return base;
  })();
  probed = await r7.probeModel('c1', 'мой-алиас');
  ok('такой отказ тоже даёт нижнюю границу окна',
     probed.contextWindow === 65536 && probed.contextSource === 'ceiling', JSON.stringify(probed.contextWindow));

  // 4. Имя, которым назвался сервер, идёт и в справочник известных имён:
  //    алиас в нём может не значиться, а полное имя — вполне.
  const { reg: r8 } = makeProbe((body, n) => (n === 1
    ? { body: { model: 'openai/gpt-4o', choices: [{ message: { content: 'ok' } }] } }
    : { body: { choices: [{ message: { content: 'ok' } }] } }));
  sandbox.fetch = (() => {
    const inner = sandbox.fetch;
    return async (url, init) => {
      // Перечень моделей провайдер не отдаёт — остаётся справочник имён.
      if (String(url).endsWith('/models')) return { ok: false, status: 404, text: async () => 'no' };
      return inner(url, init);
    };
  })();
  probed = await r8.probeModel('c1', 'моя-модель');
  ok('окно взято из справочника по имени, которым ответил сервер',
     probed.contextWindow === 128000 && probed.contextSource === 'guess', JSON.stringify(probed.contextWindow));
  ok('и сказано, что значение приблизительное',
     probed.findings.some(f => /приблизительное/.test(f)), probed.findings.join(' | '));

  console.log('\n── Проба пишется в журнал ──');
  // Диагностику видно в консоли целиком: именно в ответе провайдера
  // лежит то, ради чего проба и делается. Но ключ туда попасть не должен.
  const logged = [];
  sandbox.console = {
    group: (...a) => logged.push(a.join(' ')),
    groupEnd: () => {},
    log: (...a) => logged.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
    dir: () => {}, error: () => {},
  };
  const { reg: r9 } = makeProbe(() => ({ body: { choices: [{ message: { content: 'ok' } }] } }));
  r9.connections[0].apiKey = 'sk-ОЧЕНЬ-СЕКРЕТНЫЙ-КЛЮЧ-1234';
  r9._headers = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer sk-ОЧЕНЬ-СЕКРЕТНЫЙ-КЛЮЧ-1234' });
  await r9.probeModel('c1', 'модель');
  sandbox.console = silent;
  const journal = logged.join('\n');
  ok('каждый шаг пробы записан', /ПРОБА МОДЕЛИ/.test(journal), journal.slice(0, 120));
  ok('шаги названы', /предел контекста/.test(journal) && /поддержка инструментов/.test(journal));
  ok('ответ провайдера виден целиком', /Response/.test(journal));
  ok('ключ в журнал не попал', !/ОЧЕНЬ-СЕКРЕТНЫЙ/.test(journal), journal.slice(0, 200));
  ok('но видно, что он был', /\*\*\*/.test(journal));

  // Сеть недоступна — проба обязана сказать это, а не молчать.
  const { reg: r4 } = makeProbe(() => { throw new TypeError('failed to fetch'); });
  sandbox.fetch = async () => { throw new TypeError('failed to fetch'); };
  probed = await r4.probeModel('c1', 'any');
  ok('недоступный сервер объяснён, а не проглочен', !!probed.error && /CORS|недоступ/.test(probed.error), JSON.stringify(probed));

  sandbox.console = realConsole;

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('СБОЙ ТЕСТА:', e); process.exit(1); });
