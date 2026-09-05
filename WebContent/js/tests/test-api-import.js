// ============================================================
//  ТЕСТ: комплекты «навык + инструменты» из описаний API
// ============================================================
//
// Проверяется не «разобрался ли JSON», а обещания, ради которых всё
// затевалось:
//   • из описания получается РАБОЧИЙ набор: инструмент знает метод, адрес,
//     параметры и тело, и вызов действительно уходит куда надо;
//   • набор лежит в своей папке, к нему есть навык, и всё выключено;
//   • секрет вводится один раз, хранится зашифрованным, подставляется при
//     вызове и не появляется ни в аргументах, ни в результате, ни в списке;
//   • большое описание берётся частями, и об остатке говорится прямо;
//   • после импорта есть план тестирования.
//
// Нужен jsdom: WSDL разбирается через DOMParser, а форма секрета — окно.
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

class FakeDB {
  constructor() {
    this.stores = { settings: new Map(), tools: new Map(), skills: new Map(), folders: new Map(),
      prompts: new Map(), chats: new Map(), messages: new Map(), files: new Map(),
      mcp_servers: new Map(), security_log: new Map(), api_bundles: new Map(),
      artifacts: new Map(), tasks: new Map() };
  }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(o.key ?? o.id, o); }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, o) { for (const x of o) await this.put(s, x); return o.length; }
  async deleteAll(s, keys) { for (const k of keys) await this.delete(s, k); return keys.length; }
  async getAllByIndex(s, i, v) { return (await this.getAll(s)).filter(r => r[i] === v); }
}

// ── Образцы описаний ──
const OPENAPI3 = JSON.stringify({
  openapi: '3.0.1',
  info: { title: 'Питомцы', version: '1.2', description: 'Учёт питомцев' },
  servers: [{ url: 'https://api.pets.example/v1' }],
  components: {
    securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Pet-Key' } },
    schemas: { Pet: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } } },
  },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets', summary: 'Список питомцев', tags: ['pets'],
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' }, description: 'Сколько вернуть' }],
        responses: { 200: { content: { 'application/json': { example: [{ id: 1, name: 'Барсик' }] } } } },
      },
      post: {
        operationId: 'createPet', summary: 'Завести питомца', tags: ['pets'],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        responses: { 201: { description: 'создан' } },
      },
    },
    '/pets/{petId}': {
      get: {
        operationId: 'getPet', summary: 'Питомец по номеру', tags: ['pets'],
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'ок' } },
      },
      delete: { operationId: 'deletePet', summary: 'Удалить', tags: ['admin'],
        parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 204: { description: 'удалён' } } },
    },
  },
});

const SWAGGER2 = JSON.stringify({
  swagger: '2.0', info: { title: 'Старый сервис', version: '1' },
  host: 'legacy.example', basePath: '/api', schemes: ['https'],
  securityDefinitions: { t: { type: 'basic' } },
  paths: {
    '/orders': {
      post: {
        operationId: 'makeOrder', summary: 'Создать заказ',
        parameters: [{ name: 'body', in: 'body', required: true, schema: { type: 'object', properties: { sum: { type: 'number' } } } }],
        responses: { 200: { description: 'ok' } },
      },
    },
  },
});

const POSTMAN = JSON.stringify({
  info: { name: 'CRM', _postman_id: 'x', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [{ key: 'baseUrl', value: 'https://crm.example' }],
  auth: { type: 'bearer' },
  item: [
    {
      name: 'Клиенты',
      item: [
        {
          name: 'Список клиентов',
          request: {
            method: 'GET',
            url: { raw: '{{baseUrl}}/clients?active=true', query: [{ key: 'active', value: 'true', description: 'Только активные' }] },
            header: [{ key: 'X-Trace', value: '1' }],
          },
          response: [{ name: 'успех', code: 200, body: '[{"id":1}]' }],
        },
        {
          name: 'Клиент по id',
          request: { method: 'GET', url: { raw: '{{baseUrl}}/clients/:clientId' } },
        },
      ],
    },
  ],
});

const WSDL = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             targetNamespace="http://bank.example/ws">
  <portType name="AccountPort">
    <operation name="GetBalance">
      <documentation>Остаток по счёту</documentation>
      <input message="tns:GetBalanceRequest"/>
      <output message="tns:GetBalanceResponse"/>
    </operation>
    <operation name="Transfer">
      <input message="tns:TransferRequest"/>
    </operation>
  </portType>
  <binding name="AccountBinding" type="tns:AccountPort">
    <operation name="GetBalance"><soap:operation soapAction="urn:GetBalance"/></operation>
    <operation name="Transfer"><soap:operation soapAction="urn:Transfer"/></operation>
  </binding>
  <service name="AccountService">
    <port name="AccountPort" binding="tns:AccountBinding">
      <soap:address location="https://bank.example/ws/account"/>
    </port>
  </service>
</definitions>`;

const HAR = JSON.stringify({
  log: {
    entries: [
      { request: { method: 'GET', url: 'https://app.example/api/users?page=1',
          queryString: [{ name: 'page', value: '1' }],
          headers: [{ name: 'Authorization', value: 'Bearer СЕКРЕТ-ИЗ-ЗАПИСИ' }, { name: 'X-Client', value: 'web' }] },
        response: { status: 200, content: { text: '{"users":[]}' } } },
      { request: { method: 'GET', url: 'https://app.example/api/users?page=2', queryString: [], headers: [] },
        response: { status: 200, content: { text: '{}' } } },
      { request: { method: 'GET', url: 'https://app.example/static/app.js', queryString: [], headers: [] },
        response: { status: 200, content: { text: '' } } },
      { request: { method: 'POST', url: 'https://app.example/api/login', queryString: [], headers: [],
          postData: { mimeType: 'application/json', text: '{"login":"x"}' } },
        response: { status: 200, content: { text: '{"token":"y"}' } } },
    ],
  },
});

const INSOMNIA = JSON.stringify({
  _type: 'export', __export_format: 4,
  resources: [
    { _id: 'fld1', _type: 'request_group', name: 'Отчёты' },
    { _id: 'req1', _type: 'request', parentId: 'fld1', name: 'Отчёт за день',
      method: 'GET', url: 'https://rep.example/daily', parameters: [{ name: 'date', value: '2024-01-01' }],
      headers: [{ name: 'X-Org', value: '7' }] },
  ],
});

const GRAPHQL = JSON.stringify({
  data: {
    __schema: {
      queryType: { name: 'Query' }, mutationType: { name: 'Mutation' },
      types: [
        { name: 'Query', fields: [{ name: 'user', description: 'Пользователь',
            args: [{ name: 'id', type: { kind: 'NON_NULL', ofType: { name: 'ID' } } }], type: { name: 'User' } }] },
        { name: 'Mutation', fields: [{ name: 'createUser', args: [], type: { name: 'User' } }] },
      ],
    },
  },
});

(async () => {
  const rawHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const html = rawHtml.replace(/<script src="[^"]+"><\/script>\s*/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const { window } = dom;
  const document = window.document;
  window.performance = window.performance || { now: () => Date.now() };
  // Шифрование подменяем узнаваемой обёрткой: так видно, что в базу легло
  // не то же самое, что ввёл человек, и что при вызове идёт расшифровка.
  window.SecretsVault = {
    encrypt: async (_d, v) => (v ? 'ENC(' + v + ')' : ''),
    decrypt: async (_d, v) => (typeof v === 'string' && v.startsWith('ENC(') ? v.slice(4, -1) : (v || '')),
  };

  const files = [
    'js/core/markdown.js', 'js/core/log-guard.js', 'js/core/tool-sandbox.js',
    'js/core/binary-formats.js',
    'js/engines/folders-engine.js', 'js/engines/security-engine.js', 'js/engines/skills-engine.js',
    'js/engines/api-import-engine.js',
    'js/tools/tools-engine.js', 'js/tools/tools-registry.js', 'js/tools/tools-executor.js',
    'js/tools/tools-builtin.js', 'js/tools/tools-defs.js', 'js/tools/tools-mcp.js',
    'js/tools/tools-api-import.js',
    'js/ui/ui-core.js', 'js/ui/ui-about.js', 'js/ui/ui-navigation.js', 'js/ui/ui-chat.js',
    'js/ui/ui-subtask.js', 'js/ui/ui-compaction.js', 'js/ui/ui-resume.js', 'js/ui/ui-metrics.js',
    'js/ui/ui-settings.js', 'js/ui/ui-connections.js', 'js/ui/ui-editors.js', 'js/ui/ui-transfer.js',
  ];
  window.eval(files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n') +
    '\nwindow.__X = { ApiImportEngine, FoldersEngine, SkillsEngine, ToolsEngine, SecurityEngine, UI };\n');
  const X = window.__X;

  const db = new FakeDB();
  const folders = new X.FoldersEngine(db);
  await folders.ensureSeeded();
  const eng = new X.ApiImportEngine(db);

  // ══════════════════════════════════════════════
  console.log('\n── Определение формата ──');
  ok('OpenAPI 3 распознан', X.ApiImportEngine.detect(OPENAPI3) === 'openapi');
  ok('Swagger 2.0 распознан', X.ApiImportEngine.detect(SWAGGER2) === 'openapi');
  ok('Postman распознан', X.ApiImportEngine.detect(POSTMAN) === 'postman');
  ok('WSDL распознан', X.ApiImportEngine.detect(WSDL) === 'wsdl');
  ok('HAR распознан', X.ApiImportEngine.detect(HAR) === 'har');
  ok('Insomnia распознан', X.ApiImportEngine.detect(INSOMNIA) === 'insomnia');
  ok('GraphQL распознан', X.ApiImportEngine.detect(GRAPHQL) === 'graphql');
  ok('YAML отличается от «не понял»', X.ApiImportEngine.detect('openapi: 3.0.0\ninfo:\n  title: x') === 'openapi-yaml');
  ok('мусор не распознаётся', X.ApiImportEngine.detect('просто текст') === null);

  const yamlOut = eng.parse('openapi: 3.0.0\npaths: {}');
  ok('про YAML сказано отдельно и по делу', /YAML/.test(yamlOut.error) && /JSON/.test(yamlOut.hint));
  ok('неизвестный формат перечисляет поддерживаемые', /Postman/.test(eng.parse('просто текст').hint || ''));

  console.log('\n── OpenAPI 3 ──');
  const oas = eng.parse(OPENAPI3);
  ok('базовый адрес взят из servers', oas.baseUrl === 'https://api.pets.example/v1');
  ok('название взято из info', oas.name === 'Питомцы');
  ok('найдены все операции', oas.endpoints.length === 4, String(oas.endpoints.length));
  const listPets = oas.endpoints.find(e => e.opId === 'listPets');
  ok('метод и путь разобраны', listPets.method === 'GET' && listPets.path === '/pets');
  ok('query-параметр найден', listPets.params.some(p => p.name === 'limit' && p.in === 'query'));
  ok('пример ответа сохранён', /Барсик/.test(JSON.stringify(listPets.examples)));
  const getPet = oas.endpoints.find(e => e.opId === 'getPet');
  ok('обязательный параметр пути найден',
     getPet.params.some(p => p.name === 'petId' && p.in === 'path' && p.required));
  const createPet = oas.endpoints.find(e => e.opId === 'createPet');
  ok('тело запроса разобрано', !!createPet.body && createPet.body.contentType === 'application/json');
  ok('$ref в схеме тела развёрнут в пример', /name/.test(JSON.stringify(createPet.body.sample)));
  ok('способ авторизации распознан',
     oas.authHint.type === 'header' && oas.authHint.name === 'X-Pet-Key');

  console.log('\n── Swagger 2.0 ──');
  const sw = eng.parse(SWAGGER2);
  ok('адрес собран из host/basePath/schemes', sw.baseUrl === 'https://legacy.example/api');
  ok('body-параметр стал телом запроса', !!sw.endpoints[0].body);
  ok('basic-авторизация распознана', sw.authHint.type === 'basic');

  console.log('\n── Коллекция Postman ──');
  const pm = eng.parse(POSTMAN);
  ok('базовый адрес взят из переменных коллекции', pm.baseUrl === 'https://crm.example');
  ok('вложенные папки обойдены', pm.endpoints.length === 2);
  ok('{{baseUrl}} подставлен в адрес', pm.endpoints[0].url === 'https://crm.example/clients');
  ok('строка запроса отрезана от адреса', !pm.endpoints[0].url.includes('?'));
  ok('query-параметр перенесён', pm.endpoints[0].params.some(p => p.in === 'query' && p.name === 'active'));
  ok('заголовок перенесён', pm.endpoints[0].params.some(p => p.in === 'header' && p.name === 'X-Trace'));
  ok('пример ответа сохранён',
     (pm.endpoints[0].examples[0] || {}).response === '[{"id":1}]',
     JSON.stringify(pm.endpoints[0].examples));
  ok('параметр :clientId распознан как путь',
     pm.endpoints[1].params.some(p => p.name === 'clientId' && p.in === 'path'));
  ok('bearer из auth коллекции распознан', pm.authHint.type === 'bearer');

  console.log('\n── WSDL ──');
  const ws = eng.parse(WSDL);
  ok('адрес сервиса найден', ws.baseUrl === 'https://bank.example/ws/account');
  ok('имя сервиса найдено', ws.name === 'AccountService');
  ok('операции найдены', ws.endpoints.length === 2 && ws.endpoints[0].name === 'GetBalance');
  ok('все операции идут POST', ws.endpoints.every(e => e.method === 'POST'));
  ok('soapAction подхвачен', ws.endpoints[0].soap.action === 'urn:GetBalance');
  ok('документация операции попала в описание', /Остаток по счёту/.test(ws.endpoints[0].description));
  ok('в теле подсказан шаблон операции', /<GetBalance/.test(ws.endpoints[0].body.sample));

  console.log('\n── HAR ──');
  const har = eng.parse(HAR);
  ok('повторы схлопнуты', har.endpoints.length === 2, String(har.endpoints.length));
  ok('статика отброшена', !har.endpoints.some(e => /app\.js/.test(e.url)));
  ok('записанный ответ стал примером', /users/.test(JSON.stringify(har.endpoints[0].examples)));
  ok('тело POST перенесено', !!har.endpoints.find(e => e.method === 'POST').body);
  ok('Authorization из записи НЕ перенесён — это чужая сессия',
     !JSON.stringify(har).includes('СЕКРЕТ-ИЗ-ЗАПИСИ') || !har.endpoints.some(e =>
       e.params.some(p => /authorization/i.test(p.name))));
  ok('обычный заголовок перенесён', har.endpoints[0].params.some(p => p.name === 'X-Client'));

  console.log('\n── Insomnia и GraphQL ──');
  const ins = eng.parse(INSOMNIA);
  ok('запрос Insomnia разобран', ins.endpoints.length === 1 && ins.endpoints[0].url === 'https://rep.example/daily');
  ok('папка попала в имя', /Отчёты/.test(ins.endpoints[0].name));

  const gql = eng.parse(GRAPHQL, { baseUrl: 'https://gql.example/graphql' });
  ok('GraphQL даёт один инструмент, а не по одному на поле', gql.endpoints.length === 1);
  ok('операции схемы перечислены в описании',
     /query user\(id: ID!\)/.test(gql.endpoints[0].description) && /mutation createUser/.test(gql.endpoints[0].description));

  // ══════════════════════════════════════════════
  console.log('\n── Имена инструментов ──');
  const taken = new Set();
  const n1 = X.ApiImportEngine.toolName('pets', { opId: 'listPets' }, taken);
  ok('имя приводится к snake_case', n1 === 'pets_listpets', n1);
  const n2 = X.ApiImportEngine.toolName('pets', { opId: 'listPets' }, taken);
  ok('повтор получает свой суффикс', n2 !== n1 && /_2$/.test(n2), n2);
  const n3 = X.ApiImportEngine.toolName('', { name: 'Список клиентов' }, taken);
  ok('кириллица транслитерируется', /^[a-z_0-9]+$/.test(n3), n3);
  const n4 = X.ApiImportEngine.toolName('', { name: '123 старт' }, taken);
  ok('имя не начинается с цифры', /^[a-zA-Z_]/.test(n4), n4);
  const n5 = X.ApiImportEngine.toolName('x'.repeat(40), { name: 'y'.repeat(60) }, taken);
  ok('длина ограничена 64 символами', n5.length <= 64, String(n5.length));
  ok('все имена проходят проверку API моделей',
     [n1, n2, n3, n4, n5].every(n => /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(n)));

  // ══════════════════════════════════════════════
  console.log('\n── Сборка комплекта ──');
  const tools = new X.ToolsEngine(db);
  tools.folders = folders;
  tools.apiImport = eng;
  tools.security = new X.SecurityEngine();
  tools.security.db = db;
  tools.security.mode = 'off';
  tools.ui = { refreshSidebar() {}, renderTools() {}, renderSkills() {}, renderPrompts() {}, updateChatToolbar() {} };
  await tools.loadTools();

  const dry = await tools.executeTool('api_import', { source: OPENAPI3, dryRun: true });
  ok('разведка не создаёт ничего', dry.dryRun === true && (await db.getAll('api_bundles')).length === 0);
  ok('разведка называет формат и число операций',
     dry.format === 'openapi' && dry.operationsFound === 4);
  ok('разведка перечисляет операции', dry.operations.length === 4 && dry.operations[0].method);

  const imp = await tools.executeTool('api_import', { source: OPENAPI3, name: 'Питомцы' });
  ok('импорт создал набор', imp.ok === true && imp.toolsCreated.length === 4, JSON.stringify(imp.error || ''));
  ok('инструменты созданы выключенными',
     (await db.getAll('tools')).filter(t => t.apiCall).every(t => t.enabled === false));
  ok('у инструмента есть описание вызова, а не код',
     (await db.getAll('tools')).filter(t => t.apiCall).every(t => !t.handlerCode && t.apiCall.method));
  const bundleFolder = (await db.getAll('folders')).find(f => f.name.includes('Питомцы'));
  ok('заведена отдельная папка набора', !!bundleFolder && bundleFolder.type === 'tools');
  ok('все инструменты набора лежат в ней',
     (await db.getAll('tools')).filter(t => t.apiCall).every(t => t.parentId === bundleFolder.id));
  const bundleSkill = (await db.getAll('skills')).find(s => s.name === 'Питомцы');
  ok('создан навык набора', !!bundleSkill && bundleSkill.enabled === false);
  ok('навык связан со всеми инструментами набора', bundleSkill.toolIds.length === 4);
  ok('в навыке есть правила работы с сервисом', /Авторизацию подставляет приложение/.test(bundleSkill.systemPrompt));
  ok('в навыке перечислены операции', /pitomcy_listpets|listpets/i.test(bundleSkill.systemPrompt));
  ok('импорт вернул план тестирования', Array.isArray(imp.testPlan) && imp.testPlan.length >= 3);
  ok('план начинается с чтения', /чтени/i.test(imp.testPlan[0]));
  ok('план отдельно упоминает изменяющие операции', imp.testPlan.some(s => /тестовом контуре|откатить/i.test(s)));
  ok('сказано, что нужен секрет', imp.needsAuth === true);
  ok('описание инструмента содержит примеры из источника',
     (await db.getAll('tools')).some(t => t.apiCall && /Барсик/.test(t.description)));

  console.log('\n── Импорт частями ──');
  const db2 = new FakeDB();
  const folders2 = new X.FoldersEngine(db2);
  await folders2.ensureSeeded();
  const eng2 = new X.ApiImportEngine(db2);
  const tools2 = new X.ToolsEngine(db2);
  tools2.folders = folders2; tools2.apiImport = eng2; tools2.security = null;
  tools2.ui = tools.ui;
  await tools2.loadTools();

  const part1 = await tools2.executeTool('api_import', { source: OPENAPI3, name: 'Питомцы', limit: 2 });
  ok('взята только первая часть', part1.toolsCreated.length === 2);
  ok('сказано, сколько осталось', part1.remaining === 2);
  ok('в подсказке названо, как продолжить', /offset=2/.test(part1.note));
  const part2 = await tools2.executeTool('api_import', { source: OPENAPI3, name: 'Питомцы', limit: 2, offset: 2 });
  ok('вторая часть дозагружена в тот же набор', part2.bundleId === part1.bundleId);
  ok('папка не задвоилась',
     (await db2.getAll('folders')).filter(f => f.name.includes('Питомцы')).length === 1);
  ok('в наборе стало четыре инструмента', (await db2.getAll('tools')).filter(t => t.apiCall).length === 4);
  ok('навык знает обо всех', (await db2.get('skills', part2.skillId || (await eng2.get('Питомцы')).skillId)).toolIds.length === 4);

  const filtered = await tools2.executeTool('api_import', { source: OPENAPI3, name: 'Только админ', only: 'admin' });
  ok('фильтр по разделу работает', filtered.toolsCreated.length === 1 && filtered.operationsMatchingFilter === 1);
  const nothing = await tools2.executeTool('api_import', { source: OPENAPI3, name: 'X', only: 'нет-такого' });
  ok('пустой фильтр объяснён', !!nothing.error);

  // ══════════════════════════════════════════════
  console.log('\n── Секрет ──');
  const bundle = await eng.get('Питомцы');
  const saved = await eng.saveAuth(bundle.id, { type: 'header', name: 'X-Pet-Key', secret: 'ТАЙНА-123' });
  ok('секрет сохранён', saved.ok === true && saved.hasSecret === true);
  const stored = await db.get('api_bundles', bundle.id);
  ok('в базе он зашифрован, а не как есть',
     stored.auth.secret !== 'ТАЙНА-123' && stored.auth.secret.startsWith('ENC('));
  const listed = await tools.executeTool('api_bundle_list', {});
  ok('список наборов не отдаёт секрет', !JSON.stringify(listed).includes('ТАЙНА-123'));
  ok('но говорит, что он задан', listed.bundles[0].hasSecret === true);
  ok('и сколько инструментов включено', listed.bundles[0].enabledTools === 0 && listed.bundles[0].tools === 4);

  await eng.saveAuth(bundle.id, { type: 'header', name: 'X-Pet-Key', secret: '' });
  ok('пустой ввод не стирает сохранённый секрет',
     (await db.get('api_bundles', bundle.id)).auth.secret.startsWith('ENC('));

  // Шифрование может быть недоступно (страница открыта не в защищённом
  // контексте). Сохранять секрет открытым текстом нельзя, а отчитаться
  // об успехе — тем более: пользователь будет уверен, что доступ настроен.
  const realEncrypt = window.SecretsVault.encrypt;
  window.SecretsVault.encrypt = async () => null;
  const failed = await eng.saveAuth(bundle.id, { type: 'header', name: 'X-Pet-Key', secret: 'ДРУГОЙ' });
  window.SecretsVault.encrypt = realEncrypt;
  ok('при отказе шифрования сохранения не происходит', !!failed.error);
  ok('и сказано, почему и что делать', /защищённого контекста|https/.test(failed.hint || ''));
  ok('прежний секрет при этом цел',
     (await db.get('api_bundles', bundle.id)).auth.secret === 'ENC(ТАЙНА-123)');

  console.log('\n── Выполнение импортированного вызова ──');
  const calls = [];
  window.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true, status: 200, statusText: 'OK',
      text: async () => '{"id":7,"name":"Барсик"}',
      headers: { forEach: (fn) => fn('application/json', 'Content-Type') },
    };
  };

  const allTools = await db.getAll('tools');
  const getPetTool = allTools.find(t => t.apiCall && t.apiCall.path === '/pets/{petId}' && t.apiCall.method === 'GET');
  const listTool = allTools.find(t => t.apiCall && t.apiCall.path === '/pets' && t.apiCall.method === 'GET');
  const createTool = allTools.find(t => t.apiCall && t.apiCall.method === 'POST');
  for (const t of [getPetTool, listTool, createTool]) { t.enabled = true; await db.put('tools', t); }

  const r1 = await tools.executeTool(getPetTool.name, { petId: 7 });
  ok('вызов ушёл по собранному адресу', calls[0].url === 'https://api.pets.example/v1/pets/7', calls[0].url);
  ok('ответ разобран как JSON', r1.data && r1.data.name === 'Барсик');
  ok('в результате есть статус и метод', r1.status === 200 && r1.method === 'GET');
  ok('секрет подставлен в заголовок', calls[0].init.headers['X-Pet-Key'] === 'ТАЙНА-123');
  ok('но в результат он не попал', !JSON.stringify(r1).includes('ТАЙНА-123'));

  const r2 = await tools.executeTool(listTool.name, { limit: 5 });
  ok('query-параметр подставлен', calls[1].url.includes('limit=5'));
  ok('пустые параметры не подставляются', !(await tools.executeTool(listTool.name, {})) .error && !calls[2].url.includes('limit='));

  const r3 = await tools.executeTool(getPetTool.name, {});
  ok('без обязательного параметра пути вызов не уходит', /обязательные параметры пути/i.test(r3.error || ''));

  const r4 = await tools.executeTool(createTool.name, { body: '{"name":"Мурка"}' });
  const lastCall = calls[calls.length - 1];
  ok('тело отправлено', lastCall.init.body === '{"name":"Мурка"}');
  ok('заголовок Content-Type проставлен', lastCall.init.headers['Content-Type'] === 'application/json');
  const r5 = await tools.executeTool(createTool.name, {});
  ok('без тела вызов не уходит', /тело запроса/i.test(r5.error || ''));

  console.log('\n── Ошибки сервиса ──');
  window.fetch = async () => ({ ok: false, status: 401, statusText: 'Unauthorized',
    text: async () => '{"error":"bad token"}', headers: { forEach: () => {} } });
  const r401 = await tools.executeTool(listTool.name, {});
  ok('401 объяснён как проблема доступа', /нет доступа/.test(r401.error || ''));
  ok('и подсказано, чем перенастроить', /api_bundle_configure/.test(r401.hint || ''));

  window.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const rNet = await tools.executeTool(listTool.name, {});
  ok('сетевая ошибка не роняет вызов', /не выполнен/.test(rNet.error || ''));

  console.log('\n── SOAP ──');
  const dbS = new FakeDB();
  const foldersS = new X.FoldersEngine(dbS);
  await foldersS.ensureSeeded();
  const engS = new X.ApiImportEngine(dbS);
  const toolsS = new X.ToolsEngine(dbS);
  toolsS.folders = foldersS; toolsS.apiImport = engS; toolsS.security = null; toolsS.ui = tools.ui;
  await toolsS.loadTools();
  await toolsS.executeTool('api_import', { source: WSDL, name: 'Банк' });
  const soapTool = (await dbS.getAll('tools')).find(t => t.apiCall && t.apiCall.soap);
  soapTool.enabled = true; await dbS.put('tools', soapTool);

  const soapCalls = [];
  window.fetch = async (url, init) => {
    soapCalls.push({ url: String(url), init });
    return { ok: true, status: 200, statusText: 'OK', text: async () => '<ok/>', headers: { forEach: () => {} } };
  };
  await toolsS.executeTool(soapTool.name, { body: '<GetBalance><acc>1</acc></GetBalance>' });
  ok('тело обёрнуто в SOAP-конверт', /<soap:Envelope[\s\S]*<soap:Body><GetBalance>/.test(soapCalls[0].init.body));
  ok('SOAPAction проставлен', soapCalls[0].init.headers.SOAPAction === '"urn:GetBalance"');
  await toolsS.executeTool(soapTool.name, { body: '<soap:Envelope xmlns:soap="x"><soap:Body/></soap:Envelope>' });
  ok('готовый конверт не оборачивается второй раз',
     (soapCalls[1].init.body.match(/<soap:Envelope/g) || []).length === 1);

  // ══════════════════════════════════════════════
  console.log('\n── Безопасность ──');
  const sec = new X.SecurityEngine();
  ok('импортированный вызов относится к сетевым',
     sec.categoryOf(getPetTool.name, getPetTool) === 'network');
  ok('импорт API — операция самомодификации', sec.categoryOf('api_import') === 'execute');
  sec.mode = 'off';
  sec.noteExternal('http_fetch', null);
  const q = await sec.check('api_import', { url: 'https://x' }, null);
  ok('после внешних данных импорт API требует подтверждения', q.quarantine === true);
  ok('чтение списка наборов подтверждения не требует', sec.categoryOf('api_bundle_list') === 'read');

  const noBundle = await tools.executeTool('api_bundle_configure', { bundle: 'нет-такого' });
  ok('несуществующий набор объяснён и перечислены имеющиеся',
     !!noBundle.error && Array.isArray(noBundle.available));

  console.log('\n── Форма секрета ──');
  const agent = {
    db, folders, tools, apiImport: eng,
    skills: new X.SkillsEngine(db),
    llm: { isConfigured: () => false, model: 'm' },
    models: { allModels: () => [], describe: () => null },
    files: { all: async () => [] }, tasks: { active: async () => null },
    about: { name: 'Ада', label: 'Ада', releaseCount: () => 1, unread: async () => [], latest: () => null },
  };
  const ui = new X.UI(agent);
  ui.refreshSidebar = async () => {}; ui.updateChatToolbar = async () => {}; ui.renderTools = () => {};
  tools.ui = ui;

  const p = ui.showApiAuthModal(bundle.id);
  await tick(20);
  ok('окно открылось', !!document.querySelector('.modal-overlay'));
  ok('поле секрета скрыто от посторонних глаз',
     document.getElementById('api_secret').type === 'password');
  ok('сказано, что секрет не увидит агент',
     /агенту он не передаётся/i.test(document.querySelector('.modal').textContent));
  document.getElementById('api_auth_type').value = 'bearer';
  document.getElementById('api_auth_type').dispatchEvent(new window.Event('change'));
  ok('для bearer имя заголовка не спрашивается', document.getElementById('api_name_row').hidden === true);
  document.getElementById('api_secret').value = 'НОВЫЙ-ТОКЕН';
  document.getElementById('api_base').value = 'https://api.pets.example/v2';
  document.querySelector('.modal-actions .btn-primary').click();
  const formRes = await p;
  ok('форма вернула тип авторизации и факт секрета',
     formRes.authType === 'bearer' && formRes.hasSecret === true);
  const afterForm = await db.get('api_bundles', bundle.id);
  ok('новый секрет зашифрован', afterForm.auth.secret === 'ENC(НОВЫЙ-ТОКЕН)');
  ok('базовый адрес обновлён', afterForm.baseUrl === 'https://api.pets.example/v2');

  window.fetch = async (url, init) => { calls.push({ url: String(url), init }); return {
    ok: true, status: 200, statusText: 'OK', text: async () => '{}', headers: { forEach: () => {} } }; };
  await tools.executeTool(listTool.name, {});
  const bearerCall = calls[calls.length - 1];
  ok('bearer подставляется при вызове', bearerCall.init.headers.Authorization === 'Bearer НОВЫЙ-ТОКЕН');
  ok('и адрес взят обновлённый', bearerCall.url.startsWith('https://api.pets.example/v2'));

  console.log('\n── Удаление набора ──');
  const before = (await db.getAll('tools')).filter(t => t.apiCall).length;
  const removed = await eng.remove(bundle.id);
  ok('инструменты набора удалены', removed.removedTools === before);
  ok('навык набора удалён', !(await db.get('skills', bundleSkill.id)));
  ok('папка набора удалена', !(await db.get('folders', bundleFolder.id)));
  ok('запись набора удалена', !(await db.get('api_bundles', bundle.id)));

  console.log('\n==============================================');
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('==============================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
