// Тесты реестра провайдеров и моделей.
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? ' → ' + e : '')); } };

class FakeDB {
  constructor() { this.stores = { settings: new Map(), llm_connections: new Map(), tools: new Map(), chats: new Map(), files: new Map() }; }
  async get(s, k) { return this.stores[s].get(k); }
  async getAll(s) { return Array.from(this.stores[s].values()); }
  async put(s, o) { this.stores[s].set(o.key ?? o.id, o); }
  async delete(s, k) { this.stores[s].delete(k); }
  async putAll(s, o) { for (const x of o) await this.put(s, x); return o.length; }
}

const sandbox = {
  console, setTimeout, clearTimeout, Date, Math, JSON, Promise, URL, TypeError, Error,
  Map, Set, Array, Object, String, Number, Boolean, RegExp, parseInt, parseFloat, isNaN,
  SecretsVault: { encrypt: async (_d, v) => v || '', decrypt: async (_d, v) => v || '' },
  fetch: async () => { throw new TypeError('сеть недоступна в тесте'); },
  performance: { now: () => Date.now() },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const load = (f, ...n) => vm.runInContext(
  fs.readFileSync('/home/claude/app/' + f, 'utf8') +
  (n.length ? '\n' + n.map(x => `globalThis.${x} = ${x};`).join('\n') : ''), sandbox, { filename: f });

load('llm/llm-registry.js', 'LLMRegistry');
const { LLMRegistry } = sandbox;

const mkGateway = () => ({ configure(c) { Object.assign(this, c); } });

(async () => {
  console.log('\n── Догадки при добавлении модели ──');
  ok('o3 распознан как рассуждающая', LLMRegistry.guessTier('o3-mini') === 'reasoning');
  ok('haiku распознан как простая', LLMRegistry.guessTier('claude-3-haiku') === 'light');
  ok('opus распознан как сильная', LLMRegistry.guessTier('claude-3-opus') === 'advanced');
  ok('неизвестное имя → обычная', LLMRegistry.guessTier('нечто-своё') === 'balanced');
  ok('окно для gpt-4o подставлено', LLMRegistry.guessContextWindow('gpt-4o-mini') === 128000);
  ok('окно для claude подставлено', LLMRegistry.guessContextWindow('claude-3-5-sonnet') === 200000);
  ok('неизвестной модели окно не выдумывается', LLMRegistry.guessContextWindow('своя-сборка') === 0);

  console.log('\n── Два уровня: провайдер и модели ──');
  {
    const db = new FakeDB(); const gw = mkGateway();
    const reg = new LLMRegistry(db, gw);
    await reg.init();

    const p1 = await reg.saveConnection({ name: 'OpenAI', apiUrl: 'https://api.openai.com/v1/', apiKey: 'sk-1' });
    ok('хвостовой слэш в адресе убран', p1.apiUrl === 'https://api.openai.com/v1');

    const m1 = await reg.saveModel(p1.id, { name: 'gpt-4o', tier: 'advanced', contextWindow: 128000 });
    const m2 = await reg.saveModel(p1.id, { name: 'gpt-4o-mini', tier: 'light', contextWindow: 128000 });
    await reg.load();
    ok('модели вложены в провайдера', reg.connections[0].models.length === 2);

    const p2 = await reg.saveConnection({ name: 'Локальный', apiUrl: 'http://localhost:11434/v1', apiKey: '' });
    await reg.saveModel(p2.id, { name: 'qwen2.5:14b', tier: 'balanced' });
    await reg.load();
    ok('второй провайдер добавлен', reg.connections.length === 2);
    ok('плоский список собирает все модели', reg.allModels().length === 3);
    ok('в плоском списке указан провайдер',
      reg.allModels().every(m => !!m.connName), JSON.stringify(reg.allModels().map(m => m.connName)));

    const ref = reg.refOf(p1.id, m1.id);
    ok('ссылка разрешается в провайдера и модель',
      reg.resolve(ref).conn.name === 'OpenAI' && reg.resolve(ref).model.name === 'gpt-4o');
    ok('битая ссылка не разрешается', reg.resolve('нет::такого') === null);

    reg.applyRef(ref);
    ok('шлюз получил адрес провайдера', gw.apiUrl === 'https://api.openai.com/v1');
    ok('шлюз получил модель', gw.model === 'gpt-4o');
    ok('шлюз получил ключ провайдера', gw.apiKey === 'sk-1');

    const ref2 = reg.refOf(p2.id, reg.connections.find(c => c.id === p2.id).models[0].id);
    reg.applyRef(ref2);
    ok('смена модели меняет и провайдера', gw.apiUrl === 'http://localhost:11434/v1' && gw.model === 'qwen2.5:14b');

    // Правка провайдера не должна терять вложенные модели.
    await reg.saveConnection({ id: p1.id, name: 'OpenAI (осн.)', apiUrl: p1.apiUrl, apiKey: 'sk-1' });
    await reg.load();
    ok('правка провайдера не стирает его модели',
      reg.connections.find(c => c.id === p1.id).models.length === 2);

    const d = reg.describe(ref);
    ok('describe отдаёт человекочитаемое', d.tierLabel === 'Сильная' && d.provider === 'OpenAI (осн.)');
    ok('describe не отдаёт ключ', !JSON.stringify(d).includes('sk-1'), JSON.stringify(d));
  }

  console.log('\n── Модель по умолчанию ──');
  {
    const db = new FakeDB(); const reg = new LLMRegistry(db, mkGateway());
    await reg.init();
    const p = await reg.saveConnection({ name: 'P', apiUrl: 'https://a.test/v1', apiKey: 'k' });
    const a = await reg.saveModel(p.id, { name: 'model-a' });
    const b = await reg.saveModel(p.id, { name: 'model-b' });
    await reg.load();

    await reg.setDefault(reg.refOf(p.id, a.id));
    ok('умолчание сохранено', reg.defaultRef === reg.refOf(p.id, a.id));

    await reg.removeModel(p.id, a.id);
    ok('после удаления умолчание перешло на оставшуюся', reg.defaultRef === reg.refOf(p.id, b.id));

    await reg.removeModel(p.id, b.id);
    ok('без моделей умолчание пустое', reg.defaultRef === null);

    // Переживает перезагрузку.
    const c = await reg.saveModel(p.id, { name: 'model-c' });
    await reg.setDefault(reg.refOf(p.id, c.id));
    const reg2 = new LLMRegistry(db, mkGateway());
    await reg2.init();
    ok('умолчание переживает перезагрузку', reg2.defaultRef === reg.refOf(p.id, c.id));
  }

  console.log('\n── Удаление провайдера ──');
  {
    const db = new FakeDB(); const reg = new LLMRegistry(db, mkGateway());
    await reg.init();
    const p1 = await reg.saveConnection({ name: 'A', apiUrl: 'https://a.test/v1', apiKey: 'k' });
    const m1 = await reg.saveModel(p1.id, { name: 'm1' });
    const p2 = await reg.saveConnection({ name: 'B', apiUrl: 'https://b.test/v1', apiKey: 'k' });
    await reg.saveModel(p2.id, { name: 'm2' });
    await reg.load();
    await reg.setDefault(reg.refOf(p1.id, m1.id));

    await reg.removeConnection(p1.id);
    ok('провайдер удалён вместе с моделями', reg.allModels().length === 1);
    ok('умолчание перешло к уцелевшей модели',
      !!reg.resolve(reg.defaultRef) && reg.describe().model === 'm2', reg.defaultRef);
  }

  console.log('\n── Перенос старых настроек ──');
  {
    const db = new FakeDB();
    await db.put('settings', { key: 'llm', apiUrl: 'https://old.test/v1', apiKey: 'old-key',
                               model: 'm-old', maxTokens: 8192, temperature: 0.3, authType: 'bearer' });
    const gw = mkGateway();
    const reg = new LLMRegistry(db, gw);
    await reg.init();

    ok('создан один провайдер', reg.connections.length === 1);
    ok('создана одна модель', reg.allModels().length === 1);
    const d = reg.describe();
    ok('имя модели перенесено', d.model === 'm-old');
    ok('max_tokens перенесён', d.maxTokens === 8192);
    ok('температура перенесена', d.temperature === 0.3);
    ok('перенесённая модель стала умолчанием', reg.defaultRef === d.ref);
    ok('ключ перенесён в провайдера', gw.apiKey === 'old-key');

    // Повторный запуск не должен создавать дубль.
    const reg2 = new LLMRegistry(db, mkGateway());
    await reg2.init();
    ok('повторный запуск не дублирует перенос', reg2.connections.length === 1);
  }

  console.log('\n── Обращение к провайдеру ──');
  {
    const db = new FakeDB(); const reg = new LLMRegistry(db, mkGateway());
    await reg.init();
    const p = await reg.saveConnection({ name: 'P', apiUrl: 'https://a.test/v1', apiKey: 'sk-x' });
    await reg.load();

    // Провайдер отдаёт список моделей.
    sandbox.fetch = async (url, opts) => {
      sandbox._lastUrl = url; sandbox._lastHeaders = opts.headers;
      return { ok: true, json: async () => ({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'a-model' }] }) };
    };
    const res = await reg.fetchAvailable(p.id);
    ok('список моделей получен', res.models.length === 2, JSON.stringify(res));
    ok('дубли убраны и список отсортирован', res.models.join(',') === 'a-model,b-model');
    ok('запрос ушёл на /models', sandbox._lastUrl === 'https://a.test/v1/models');
    ok('ключ ушёл в заголовке', sandbox._lastHeaders['Authorization'] === 'Bearer sk-x');

    // Свой заголовок вместо Bearer.
    await reg.saveConnection({ id: p.id, name: 'P', apiUrl: 'https://a.test/v1',
                               authType: 'custom', customHeaderName: 'X-Key', customHeaderValue: 'sec' });
    await reg.load();
    await reg.fetchAvailable(p.id);
    ok('нестандартный заголовок применён', sandbox._lastHeaders['X-Key'] === 'sec');
    ok('Bearer при этом не отправлен', !sandbox._lastHeaders['Authorization']);

    sandbox.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
    const bad = await reg.fetchAvailable(p.id);
    ok('ошибка провайдера возвращается с кодом', /401/.test(bad.error), bad.error);

    sandbox.fetch = async () => { throw new TypeError('Failed to fetch'); };
    const net = await reg.fetchAvailable(p.id);
    ok('сетевая ошибка объясняет и про CORS', /CORS/.test(net.error), net.error);

    const t = await reg.testConnection(p.id);
    ok('проверка провайдера возвращает ошибку', t.ok === false && !!t.error);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`Пройдено: ${pass}, провалено: ${fail}`);
  console.log('='.repeat(46));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('СБОЙ:', e); process.exit(1); });
