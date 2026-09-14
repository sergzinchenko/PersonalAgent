// ============================================================
//  LLM REGISTRY — провайдеры и их модели
// ============================================================
//
// Два уровня:
//   провайдер (подключение) — адрес, ключ, способ авторизации;
//   модель                  — имя, класс сложности, окно контекста,
//                             max_tokens, температура.
//
// Модели вложены в запись провайдера, а не лежат отдельным хранилищем:
// модель не существует без провайдера, читаются они всегда вместе, и
// вложенность избавляет от каскадного удаления и рассинхронизации.
//
// Ссылка на модель — строка «идентификатор_провайдера::идентификатор_модели».
// Такую ссылку можно положить в запись чата и в настройки, не заводя
// вторичных индексов.
//
// ЧЕГО ЗДЕСЬ НЕТ. Автоматического переключения между моделями. Оно было
// в предыдущей версии и убрано намеренно: подмена модели посреди работы
// меняет качество и стиль ответа, а причину этого пользователю не видно.
// Переключение теперь только явное — из панели чата или из настроек.

class LLMRegistry {

  // Класс сложности. Нужен, чтобы при выборе модели в чате было видно,
  // за чем к ней идти, — имена вроде «qwen2.5-72b-instruct» сами по себе
  // ни о чём не говорят.
  static TIERS = {
    light:     { label: 'Простая',      icon: '🟢', hint: 'Быстро и дёшево: короткие ответы, черновики, форматирование' },
    balanced:  { label: 'Обычная',      icon: '🔵', hint: 'Повседневная работа: большинство задач' },
    advanced:  { label: 'Сильная',      icon: '🟣', hint: 'Сложные задачи: длинный код, разбор больших текстов' },
    reasoning: { label: 'Рассуждающая', icon: '🧠', hint: 'Долго думает перед ответом: задачи с многошаговым выводом' },
  };

  constructor(db, gateway) {
    this.db = db;
    this.gateway = gateway;

    this.connections = [];   // провайдеры с вложенными моделями
    this.defaultRef = null;  // модель по умолчанию для новых чатов
    this.currentRef = null;  // что сейчас применено к шлюзу
  }

  // ── Загрузка и перенос старых настроек ──

  async init() {
    await this.load();

    const saved = await this.db.get('settings', 'llm_registry');
    if (saved && saved.defaultRef) this.defaultRef = saved.defaultRef;

    if (!this.connections.length) await this._migrateLegacy();

    // Если сохранённая модель по умолчанию исчезла (провайдер удалён,
    // модель убрана из списка) — берём первую доступную, иначе интерфейс
    // показывал бы выбранной несуществующую модель.
    if (!this.resolve(this.defaultRef)) {
      const first = this.allModels()[0];
      this.defaultRef = first ? first.ref : null;
    }
    if (this.defaultRef) this.applyRef(this.defaultRef);

    return this.connections;
  }

  // Перенос из двух предыдущих форматов: набора подключений без моделей
  // и ещё более раннего одиночного settings/llm. Настройки, введённые
  // руками, теряться не должны.
  async _migrateLegacy() {
    const legacy = await this.db.get('settings', 'llm');
    if (!legacy || !legacy.apiUrl) return;

    const conn = await this.saveConnection({
      name: 'Основное подключение',
      apiUrl: legacy.apiUrl,
      apiKey: await SecretsVault.decrypt(this.db, legacy.apiKey),
      authType: legacy.authType,
      customHeaderName: legacy.customHeaderName,
      customHeaderValue: await SecretsVault.decrypt(this.db, legacy.customHeaderValue),
    });

    if (legacy.model) {
      const m = await this.saveModel(conn.id, {
        name: legacy.model,
        tier: 'balanced',
        contextWindow: 0,
        maxTokens: legacy.maxTokens ?? 4096,
        temperature: legacy.temperature ?? 0.7,
      });
      this.defaultRef = this.refOf(conn.id, m.id);
      await this.persist();
    }
  }

  async load() {
    let rows = [];
    try { rows = await this.db.getAll('llm_connections'); }
    catch (_) { rows = []; }

    const out = [];
    for (const r of rows) {
      out.push({
        ...r,
        apiKey: await SecretsVault.decrypt(this.db, r.apiKey),
        customHeaderValue: await SecretsVault.decrypt(this.db, r.customHeaderValue),
        models: Array.isArray(r.models) ? r.models : [],
      });
    }
    out.sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || String(a.name).localeCompare(String(b.name)));
    this.connections = out;
    return out;
  }

  async persist() {
    await this.db.put('settings', { key: 'llm_registry', defaultRef: this.defaultRef });
  }

  // ── Ссылки на модели ──

  refOf(connId, modelId) { return connId + '::' + modelId; }

  resolve(ref) {
    if (!ref) return null;
    const [connId, modelId] = String(ref).split('::');
    const conn = this.connections.find(c => c.id === connId);
    if (!conn) return null;
    const model = (conn.models || []).find(m => m.id === modelId);
    if (!model) return null;
    return { conn, model, ref };
  }

  // Плоский список всех моделей — для выпадающих списков и выбора в чате.
  allModels({ enabledOnly = true } = {}) {
    const out = [];
    for (const c of this.connections) {
      if (enabledOnly && c.enabled === false) continue;
      for (const m of (c.models || [])) {
        out.push({
          ref: this.refOf(c.id, m.id),
          connId: c.id, connName: c.name,
          ...m,
          tierInfo: LLMRegistry.TIERS[m.tier] || LLMRegistry.TIERS.balanced,
        });
      }
    }
    return out;
  }

  // ── Провайдеры ──

  async saveConnection(conn) {
    const id = conn.id || ('conn_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    const existing = this.connections.find(c => c.id === id);

    const record = {
      id,
      name: String(conn.name || 'Без названия').slice(0, 80),
      apiUrl: String(conn.apiUrl || '').replace(/\/+$/, ''),
      authType: conn.authType || 'bearer',
      customHeaderName: conn.customHeaderName || '',
      enabled: conn.enabled !== false,
      order: conn.order ?? this.connections.length,
      // Модели правятся своими методами; здесь их только сохраняем,
      // чтобы правка провайдера не стирала вложенный список.
      models: conn.models || (existing ? existing.models : []),
      createdAt: conn.createdAt || (existing ? existing.createdAt : Date.now()),
    };

    await this.db.put('llm_connections', {
      ...record,
      apiKey: await SecretsVault.encrypt(this.db, conn.apiKey || ''),
      customHeaderValue: await SecretsVault.encrypt(this.db, conn.customHeaderValue || ''),
    });
    await this.load();
    return this.connections.find(c => c.id === id);
  }

  async removeConnection(id) {
    await this.db.delete('llm_connections', id);
    await this.load();
    // Модель по умолчанию могла жить у удалённого провайдера.
    if (!this.resolve(this.defaultRef)) {
      const first = this.allModels()[0];
      this.defaultRef = first ? first.ref : null;
      await this.persist();
      if (this.defaultRef) this.applyRef(this.defaultRef);
    }
    return true;
  }

  // ── Модели ──

  async saveModel(connId, model) {
    const conn = this.connections.find(c => c.id === connId);
    if (!conn) return null;

    const id = model.id || ('m_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
    const record = {
      id,
      name: String(model.name || '').trim(),          // строка модели для API
      label: String(model.label || '').trim(),        // как называть в интерфейсе
      tier: LLMRegistry.TIERS[model.tier] ? model.tier : 'balanced',
      contextWindow: parseInt(model.contextWindow) || 0,
      // Откуда взялось окно: manual (ввёл человек), provider, error,
      // observed. Нужен, чтобы автоопределение не спорило с тем, что
      // пользователь задал руками (см. learnContextWindow).
      contextWindowSource: model.contextWindowSource || 'manual',
      maxTokens: parseInt(model.maxTokens) || 4096,
      temperature: model.temperature ?? 0.7,
      notes: String(model.notes || '').slice(0, 300),
    };

    const models = (conn.models || []).slice();
    const idx = models.findIndex(m => m.id === id);
    if (idx >= 0) models[idx] = record; else models.push(record);

    await this.saveConnection({ ...conn, models });
    return record;
  }

  async removeModel(connId, modelId) {
    const conn = this.connections.find(c => c.id === connId);
    if (!conn) return false;
    await this.saveConnection({ ...conn, models: (conn.models || []).filter(m => m.id !== modelId) });

    if (this.defaultRef === this.refOf(connId, modelId)) {
      const first = this.allModels()[0];
      this.defaultRef = first ? first.ref : null;
      await this.persist();
      if (this.defaultRef) this.applyRef(this.defaultRef);
    }
    return true;
  }

  // ── Применение к шлюзу ──

  applyRef(ref) {
    const r = this.resolve(ref);
    if (!r) return false;
    this.currentRef = ref;
    this.gateway.configure({
      apiUrl: r.conn.apiUrl,
      apiKey: r.conn.apiKey,
      authType: r.conn.authType,
      customHeaderName: r.conn.customHeaderName,
      customHeaderValue: r.conn.customHeaderValue,
      model: r.model.name,
      maxTokens: r.model.maxTokens,
      temperature: r.model.temperature,
    });
    return true;
  }

  async setDefault(ref) {
    if (!this.resolve(ref)) return { error: 'Модель не найдена' };
    this.defaultRef = ref;
    await this.persist();
    this.applyRef(ref);
    return { ok: true };
  }

  // Что сейчас применено — с уже разобранными полями, чтобы вызывающему
  // коду не приходилось лезть внутрь структуры.
  describe(ref) {
    const r = this.resolve(ref || this.currentRef || this.defaultRef);
    if (!r) return null;
    const tier = LLMRegistry.TIERS[r.model.tier] || LLMRegistry.TIERS.balanced;
    return {
      ref: r.ref,
      provider: r.conn.name,
      providerId: r.conn.id,
      model: r.model.name,
      label: r.model.label || r.model.name,
      tier: r.model.tier,
      tierLabel: tier.label,
      tierIcon: tier.icon,
      contextWindow: r.model.contextWindow,
      contextWindowSource: r.model.contextWindowSource || 'manual',
      maxTokens: r.model.maxTokens,
      temperature: r.model.temperature,
      notes: r.model.notes,
    };
  }

  // ── Обращения к провайдеру ──

  _headers(conn) {
    const h = { 'Content-Type': 'application/json' };
    if (conn.authType === 'custom' && conn.customHeaderName) h[conn.customHeaderName] = conn.customHeaderValue;
    else if (conn.apiKey) h['Authorization'] = 'Bearer ' + conn.apiKey;
    return h;
  }

  // Список моделей, доступных у провайдера. Из него пользователь выбирает,
  // что добавить в свой рабочий набор: у крупных провайдеров в выдаче
  // сотни строк, включая эмбеддинги и озвучку, — тащить их все в интерфейс
  // чата бессмысленно.
  async fetchAvailable(connId) {
    const conn = this.connections.find(c => c.id === connId);
    if (!conn) return { error: 'Провайдер не найден' };
    if (!conn.apiUrl) return { error: 'Не задан адрес API' };

    try {
      const resp = await fetch(conn.apiUrl + '/models', { headers: this._headers(conn) });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        return { error: 'Провайдер ответил ' + resp.status + (body ? ': ' + body.slice(0, 200) : '') };
      }
      const data = await resp.json();
      const raw = (data.data || data.models || []);
      const ids = raw.map(m => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
      // ── Окно контекста, если провайдер его сообщает ──
      // OpenAI не сообщает, а вот всё, что разворачивают у себя (vLLM,
      // llama.cpp, LM Studio, Ollama, шлюзы вроде OpenRouter), кладёт
      // предел прямо в карточку модели — просто под разными именами.
      // Пользоваться этим дешевле, чем угадывать по имени модели.
      const meta = {};
      for (const m of raw) {
        if (!m || typeof m === 'string') continue;
        const id = m.id || m.name;
        if (!id) continue;
        const ctx = LLMRegistry.contextFromModelEntry(m);
        if (ctx) meta[id] = { contextWindow: ctx };
      }
      return { models: Array.from(new Set(ids)).sort(), meta };
    } catch (e) {
      // Браузер отдаёт одинаковый TypeError и на недоступный сервер,
      // и на запрет CORS — без подсказки причину ищут не там.
      if (e instanceof TypeError) {
        return { error: 'Не удалось связаться с ' + conn.apiUrl + '. Сервер недоступен либо не разрешает запросы с этой страницы (CORS).' };
      }
      return { error: e.message };
    }
  }

  async testConnection(connId) {
    const conn = this.connections.find(c => c.id === connId);
    if (!conn) return { ok: false, error: 'Провайдер не найден' };
    const t0 = Date.now();
    const res = await this.fetchAvailable(connId);
    if (res.error) return { ok: false, name: conn.name, error: res.error };
    return { ok: true, name: conn.name, latencyMs: Date.now() - t0, modelCount: res.models.length };
  }

  // ── Окно контекста из карточки модели в /models ──
  // Имена полей у всех разные, поэтому просто перебираем известные.
  // Берём максимум: некоторые сборки отдают и общий предел, и предел
  // одного запроса, и первый — то, что нам нужно.
  static contextFromModelEntry(entry) {
    const keys = ['context_length', 'max_context_length', 'max_model_len', 'context_window',
                  'n_ctx', 'max_input_tokens', 'max_tokens'];
    const nested = [entry, entry.meta, entry.capabilities, entry.limits, entry.model_info,
                    entry.top_provider, entry.architecture].filter(o => o && typeof o === 'object');
    let best = 0;
    for (const obj of nested) {
      for (const k of keys) {
        const v = parseInt(obj[k], 10);
        // Отсекаем очевидную ерунду: окно меньше тысячи токенов — это
        // почти наверняка не окно, а предел ответа или чужое поле.
        if (Number.isFinite(v) && v >= 1000 && v > best) best = v;
      }
    }
    return best;
  }

  // ── Окно контекста из ответа об ошибке ──
  // Самый точный источник из всех: провайдер отказал и сам назвал предел.
  // Ловим и английские формулировки OpenAI-совместимых серверов, и то,
  // что пишут локальные сборки.
  static contextFromError(text) {
    const t = String(text || '');
    const patterns = [
      /maximum context length is (\d{3,})/i,
      /context length of (\d{3,})/i,
      /context window of (\d{3,})/i,
      /max(?:imum)?[ _-]?(?:context|seq(?:uence)?)[ _-]?(?:length|len)[^\d]{0,20}(\d{3,})/i,
      /model'?s max(?:imum)? (?:context )?(?:length|tokens?)[^\d]{0,20}(\d{3,})/i,
      /n_ctx[^\d]{0,10}(\d{3,})/i,
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n >= 1000) return n;
      }
    }
    return 0;
  }

  // ── Проба модели живым запросом ──
  //
  // ЗАЧЕМ. Перечень моделей отдаёт пределы далеко не у всех провайдеров, а
  // таблица догадок по имени врёт там, где одно и то же имя запускают с
  // разным окном (локальные сборки). Между тем сама модель отвечает на
  // эти вопросы точно — надо только спросить.
  //
  // КАК. Два крошечных запроса, оба по явному нажатию пользователя:
  //
  //   1. Запрос с заведомо невозможным max_tokens. OpenAI-совместимые
  //      серверы отвечают отказом, в котором САМИ называют предел:
  //      «This model's maximum context length is 8192 tokens…». Это
  //      самый точный источник из существующих. Если сервер предел
  //      молча урезает и отвечает нормально — узнаём другое: модель
  //      отзывается, какой идентификатор она сообщает о себе и сколько
  //      токенов вышло из нашей пробной строки (грубая оценка
  //      токенизатора для кириллицы).
  //   2. Запрос с одним пустым инструментом — поддерживает ли модель
  //      вызов инструментов вообще. Для этого приложения вопрос не
  //      праздный: без инструментов агент здесь почти бесполезен, а
  //      выясняется это обычно в середине первой же задачи.
  //
  // ЦЕНА. Несколько токенов и пара секунд. Поэтому проба не делается
  // сама — только по кнопке.
  async probeModel(connId, modelName) {
    const conn = this.connections.find(c => c.id === connId);
    if (!conn) return { error: 'Провайдер не найден' };
    if (!conn.apiUrl) return { error: 'Не задан адрес API' };
    const model = String(modelName || '').trim();
    if (!model) return { error: 'Не указан идентификатор модели' };

    const out = { model, findings: [] };
    const endpoint = conn.apiUrl + '/chat/completions';
    const headers = this._headers(conn);
    // Строка с кириллицей: по её usage видно, во сколько токенов
    // обходится русский текст у этой модели.
    const probeText = 'Проверка связи. Ответь одним словом: готово.';

    // ── Журнал пробы ──
    // Проба — диагностика, и её ответ нужен человеку целиком: именно в
    // нём провайдер называет пределы, а разбор ниже вытаскивает оттуда
    // не всё и не всегда. Пишем в консоль всегда (проба делается только
    // по кнопке, фона от неё нет), но по тем же правилам, что и обычные
    // запросы: ключ в заголовках маскируется, тело проходит через
    // LogGuard — системные промпты и вызовы системных инструментов в
    // консоль не попадают ни при каких настройках (см. core/log-guard.js).
    const logProbe = (label, body, resp) => {
      try {
        const safeHeaders = {};
        for (const k of Object.keys(headers)) {
          const low = k.toLowerCase();
          const v = String(headers[k] || '');
          safeHeaders[k] = (low === 'authorization' || low.includes('key') ||
                            low.includes('secret') || low.includes('token'))
            ? (v.length > 12 ? v.slice(0, 8) + '***' + v.slice(-4) : '***')
            : v;
        }
        console.group('%c🔬 ПРОБА МОДЕЛИ · ' + label, 'color:#0984e3;font-weight:bold;');
        console.log('%cEndpoint:', 'color:#888;', endpoint);
        console.log('%cHeaders:', 'color:#888;', safeHeaders);
        if (typeof LogGuard !== 'undefined') LogGuard.notice();
        console.log('%cBody:', 'color:#888;',
          typeof LogGuard !== 'undefined' ? LogGuard.redactBody(body) : body);
        if (resp && resp.networkError) {
          console.log('%cСеть:', 'color:#e74c3c;', resp.networkError);
        } else if (resp) {
          console.log('%cStatus:', 'color:#888;', resp.status, resp.ok ? 'OK' : 'ОТКАЗ');
          console.log('%cElapsed:', 'color:#888;', resp.ms + ' мс');
          // Ответ печатаем целиком: в отказе провайдера и лежит то, ради
          // чего проба затевалась. Системных данных в пробе нет — тело
          // запроса составлено здесь же и состоит из одной фразы.
          console.log('%cResponse:', 'color:#888;', resp.text);
        }
        console.groupEnd();
      } catch (_) { /* журнал не должен ломать пробу */ }
    };

    const ask = async (label, body) => {
      const t0 = Date.now();
      const full = { model, ...body };
      try {
        const resp = await fetch(endpoint, {
          method: 'POST', headers, body: JSON.stringify(full),
        });
        const text = await resp.text();
        let data = null;
        try { data = JSON.parse(text); } catch (_) { data = null; }
        const out = { ok: resp.ok, status: resp.status, text, data, ms: Date.now() - t0 };
        logProbe(label, full, out);
        return out;
      } catch (e) {
        const out = { networkError: e instanceof TypeError
          ? 'Не удалось связаться с ' + conn.apiUrl + '. Сервер недоступен либо не разрешает запросы с этой страницы (CORS).'
          : (e && e.message) || String(e) };
        logProbe(label, full, out);
        return out;
      }
    };

    // ── 1. Предел контекста ──
    const probe = await ask('предел контекста', {
      messages: [{ role: 'user', content: probeText }],
      max_tokens: 1000000000,
      temperature: 0,
      stream: false,
    });
    if (probe.networkError) return { error: probe.networkError };

    out.latencyMs = probe.ms;
    let answer = probe;
    if (!probe.ok) {
      const declared = LLMRegistry.contextFromError(probe.text);
      const ceiling = LLMRegistry.maxTokensFromError(probe.text);
      if (declared) {
        out.contextWindow = declared;
        out.contextSource = 'error';
        out.findings.push(`Окно контекста: ${declared} токенов — назвал сам провайдер в ответе на запрос.`);
      } else if (ceiling) {
        // Провайдер отверг не запрос, а конкретно наш max_tokens, и назвал
        // свой потолок. Больше окна он быть не может — значит, окно не
        // меньше этого числа.
        out.maxTokensCeiling = ceiling;
        out.contextWindow = ceiling;
        out.contextSource = 'ceiling';
        out.findings.push(`Предел ответа (max_tokens) у этой модели — ${ceiling} токенов; провайдер назвал его сам. ` +
          `Окно контекста не меньше этого: сгенерировать больше, чем в него помещается, нельзя.`);
      } else {
        out.findings.push(`Провайдер ответил ${probe.status}: ` +
          String(probe.text || '').replace(/\s+/g, ' ').slice(0, 200));
        out.failed = true;
      }

      // Отказ по max_tokens — не отказ модели: она просто не приняла
      // заведомо невозможное число. Спрашиваем ещё раз, по-человечески,
      // чтобы узнать остальное: отвечает ли она и как себя называет.
      if (!out.failed) {
        answer = await ask('обычный запрос', {
          messages: [{ role: 'user', content: probeText }],
          max_tokens: Math.min(64, ceiling || 64),
          temperature: 0,
          stream: false,
        });
        if (answer.networkError) answer = { ok: false, text: answer.networkError };
      }
    }

    if (answer.ok) {
      const usage = answer.data && answer.data.usage;
      const answered = answer.data && answer.data.choices && answer.data.choices[0];
      out.findings.push('Модель отвечает' + (answer.ms ? ` (${(answer.ms / 1000).toFixed(1).replace('.', ',')} с)` : '') + '.');
      // Идентификатор из ответа ловит опечатки и подмены: «gpt-4o» у
      // шлюза может оказаться совсем другой моделью. Он же нужен, чтобы
      // поискать модель в перечне провайдера под её настоящим именем.
      if (answer.data && answer.data.model && answer.data.model !== model) {
        out.resolvedModel = answer.data.model;
        out.findings.push(`Сервер отвечает от имени «${answer.data.model}» — идентификатор отличается от указанного.`);
      }
      if (usage && usage.prompt_tokens) {
        out.tokensPerChar = usage.prompt_tokens / probeText.length;
        out.findings.push(`Пробная строка из ${probeText.length} символов кириллицы заняла ` +
          `${usage.prompt_tokens} токенов (≈${(probeText.length / usage.prompt_tokens).toFixed(1).replace('.', ',')} символа на токен).`);
      }
      if (answered && answered.finish_reason === 'length') {
        out.findings.push('Ответ оборван по длине: провайдер молча урезал запрошенный предел ответа.');
      }
    }

    // ── Перечень моделей под НАСТОЯЩИМ именем ──
    // Если окно ещё не известно, а сервер назвал другое имя модели —
    // стоит поискать в перечне по нему: у шлюзов там обычно всё есть,
    // просто ключ другой («z-ai/glm-5.2» против введённого «glm-5.2»).
    if (!out.contextWindow && out.resolvedModel) {
      const list = await this.fetchAvailable(connId);
      const meta = !list.error && LLMRegistry.findMeta(list.meta, out.resolvedModel);
      if (meta && meta.contextWindow) {
        out.contextWindow = meta.contextWindow;
        out.contextSource = 'provider';
        out.findings.push(`Окно контекста: ${meta.contextWindow} токенов — нашлось в перечне моделей ` +
          `под именем «${out.resolvedModel}».`);
      }
    }

    // ── Справочник имён — по НАСТОЯЩЕМУ имени модели ──
    // Таблица догадок по имени (guessContextWindow) знает «glm», «gpt-4o»
    // и прочие семейства. Введённый человеком алиас в ней может не
    // значиться, а полное имя от сервера — вполне: «z-ai/glm-5.2»
    // говорит о семействе больше, чем «моя-модель».
    if (!out.contextWindow && out.resolvedModel) {
      const guessed = LLMRegistry.guessContextWindow(out.resolvedModel);
      if (guessed) {
        out.contextWindow = guessed;
        out.contextSource = 'guess';
        out.findings.push(`Окно контекста: ${guessed} токенов — по справочнику известных моделей, ` +
          `для имени «${out.resolvedModel}», которым назвался сервер. Значение приблизительное, проверьте.`);
      }
    }

    if (!out.contextWindow && !out.failed) {
      out.findings.push('Предел контекста провайдер не назвал: запрос с заведомо завышенным пределом ответа он принял, ' +
        'ни в перечне моделей, ни в справочнике имён его тоже нет. Задайте окно вручную — оно уточнится ' +
        'само по первому же рабочему запросу.');
    }

    // ── 2. Поддержка инструментов ──
    // Спрашиваем только если модель вообще отвечает: у неотвечающей это
    // выяснять нечего.
    if (!out.failed) {
      const withTools = await ask('поддержка инструментов', {
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
        temperature: 0,
        stream: false,
        tools: [{
          type: 'function',
          function: { name: 'ping', description: 'проверка', parameters: { type: 'object', properties: {} } },
        }],
        tool_choice: 'auto',
      });
      if (withTools.networkError) {
        out.tools = null;
      } else if (withTools.ok) {
        out.tools = true;
        out.findings.push('Вызов инструментов поддерживается.');
      } else {
        out.tools = false;
        out.findings.push('ИНСТРУМЕНТЫ НЕ ПОДДЕРЖИВАЮТСЯ: ' +
          String(withTools.text || '').replace(/\s+/g, ' ').slice(0, 160) +
          ' Без них агент сможет только разговаривать.');
      }
    }

    return out;
  }

  // ── Предел max_tokens из отказа провайдера ──
  // Отдельно от окна контекста, потому что это РАЗНЫЕ величины: max_tokens
  // ограничивает ответ, окно — весь запрос вместе с ответом. Но связь
  // между ними жёсткая и в нужную нам сторону: сгенерировать больше, чем
  // помещается в окно, нельзя, поэтому потолок max_tokens — это гарантия
  // «окно НЕ МЕНЬШЕ этого». Для настройки, где 0 означает «неизвестно»,
  // такая нижняя граница несравнимо лучше пустоты: подрезка начинает
  // работать, а ошибётся она в безопасную сторону — и сама исправится по
  // первому же отказу с точной цифрой.
  static maxTokensFromError(text) {
    const t = String(text || '');
    // ВАЖНО: ловим предел ПРОВАЙДЕРА, а не то число, что запросили мы.
    // В отказах они стоят рядом («max_completion_tokens is too large:
    // 1179628. This model supports at most 65536…»), и небрежный образец
    // с радостью возьмёт первое — то есть наше собственное.
    const patterns = [
      // «This model supports at most 65536 completion tokens»
      /supports? at most[^\d]{0,20}(\d+)/i,
      // «the valid range of max_tokens is [1, 393216]»
      /max_(?:completion_)?tokens[^[\]]{0,40}\[\s*\d+\s*,\s*(\d+)\s*\]/i,
      /max_(?:completion_)?tokens must be (?:less than or equal to|at most|<=?)\s*(\d+)/i,
      /max(?:imum)?[ _-]?(?:value|allowed)?[ _-]?(?:of |for )?max_(?:completion_)?tokens[^\d]{0,20}(?!too large)(\d+)/i,
      /max_(?:completion_)?tokens[^\d]{0,20}(?:cannot|can't|must not) exceed[^\d]{0,10}(\d+)/i,
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n >= 256) return n;
      }
    }
    return 0;
  }

  // ── Поиск модели в перечне провайдера ──
  // Имя, которое ввёл человек, и имя, которым модель зовётся у провайдера,
  // совпадают не всегда: у шлюзов принято «z-ai/glm-5.2», а вводят
  // «glm-5.2». Точное совпадение при этом не находит ничего, хотя данные
  // в перечне есть. Поэтому ищем по убыванию строгости и никогда — по
  // частичному вхождению: «gpt-4» не должен подхватить «gpt-4o-mini».
  static findMeta(meta, name) {
    if (!meta || !name) return null;
    if (meta[name]) return meta[name];
    const want = String(name).toLowerCase();
    const keys = Object.keys(meta);
    let k = keys.find(x => x.toLowerCase() === want);
    if (k) return meta[k];
    // «glm-5.2» ↔ «z-ai/glm-5.2»: сравниваем часть после последней косой.
    const tail = (x) => x.toLowerCase().split('/').pop();
    k = keys.find(x => tail(x) === want || x.toLowerCase() === tail(want));
    if (k) return meta[k];
    k = keys.find(x => tail(x) === tail(want));
    return k ? meta[k] : null;
  }

  // ── Уточнение окна по факту работы ──
  // source:
  //   'provider' — сказал сам провайдер в /models;
  //   'error'    — назвал в тексте отказа (самое надёжное, ставим как есть);
  //   'observed' — столько токенов запрос УЖЕ прошёл, значит окно не меньше.
  //
  // Правило простое и намеренно осторожное: заданное человеком вручную
  // не перетираем ничем, кроме ответа об отказе, — он единственный
  // означает «ваше значение неверно», а не «может быть больше».
  async learnContextWindow(ref, value, source = 'observed') {
    const r = this.resolve(ref || this.currentRef || this.defaultRef);
    const n = parseInt(value, 10);
    if (!r || !Number.isFinite(n) || n < 1000) return { changed: false };

    const cur = parseInt(r.model.contextWindow, 10) || 0;
    const curSource = r.model.contextWindowSource || (cur ? 'manual' : 'unknown');

    let next = 0;
    if (source === 'error') {
      // Провайдер прямо назвал предел — он главнее всего, включая
      // введённое руками: с неверным значением чат просто не работает.
      next = n;
    } else if (!cur) {
      next = n;
    } else if (source === 'observed' && n > cur) {
      // Запрос на n токенов ПРОШЁЛ, а в настройках окно меньше — значит,
      // настройки занижены, и подрезка режет историю зря. Поднимаем до
      // фактически достигнутого с небольшим запасом.
      next = Math.ceil((n * 1.05) / 1000) * 1000;
    } else if (source === 'provider' && curSource !== 'manual' && n !== cur) {
      next = n;
    }

    if (!next || next === cur) return { changed: false, contextWindow: cur };

    await this.saveModel(r.conn.id, {
      ...r.model,
      contextWindow: next,
      contextWindowSource: source,
    });
    // Шлюз держит копию параметров применённой модели — обновляем, иначе
    // изменение подхватится только после переключения модели.
    if ((this.currentRef || this.defaultRef) === r.ref) this.applyRef(r.ref);
    return { changed: true, from: cur, to: next, source };
  }

  // Подсказка окна контекста по имени модели. Многие провайдеры этот
  // предел в API не сообщают, поэтому при добавлении модели поле
  // подставляется из таблицы, а пользователь при необходимости правит.
  static guessContextWindow(modelName) {
    const m = String(modelName || '').toLowerCase();
    const table = [
      [/gpt-4\.1|gpt-4o|o1|o3|o4/, 128000],
      [/gpt-4-turbo/, 128000],
      [/gpt-4/, 8192],
      [/gpt-3\.5/, 16385],
      [/claude/, 200000],
      [/gemini.*1\.5|gemini.*2/, 1000000],
      [/gemini/, 32768],
      [/llama-?3\.[12]|llama-?4/, 128000],
      [/llama/, 8192],
      [/mixtral|mistral-large/, 32768],
      [/mistral/, 32768],
      [/qwen2?\.5|qwen3/, 128000],
      [/deepseek/, 64000],
      [/command-r/, 128000],
      [/yi-/, 200000],
      [/phi-3/, 128000],
    ];
    for (const [re, limit] of table) if (re.test(m)) return limit;
    return 0;
  }

  // Класс сложности по имени — тоже лишь предположение для подстановки.
  static guessTier(modelName) {
    const m = String(modelName || '').toLowerCase();
    if (/o1|o3|o4|reason|think|r1|qwq/.test(m)) return 'reasoning';
    if (/mini|small|haiku|flash|lite|1b|3b|7b|8b/.test(m)) return 'light';
    if (/opus|large|70b|72b|405b|gpt-4|sonnet|pro/.test(m)) return 'advanced';
    return 'balanced';
  }
}
