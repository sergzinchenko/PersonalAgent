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
      const ids = (data.data || data.models || [])
        .map(m => (typeof m === 'string' ? m : m.id || m.name))
        .filter(Boolean);
      return { models: Array.from(new Set(ids)).sort() };
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

  // Подсказка окна контекста по имени модели. Провайдеры этот предел в
  // API не сообщают, поэтому при добавлении модели поле подставляется
  // из таблицы, а пользователь при необходимости правит.
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
