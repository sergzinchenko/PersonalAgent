// ============================================================
//  SKILLS ENGINE
// ============================================================
class SkillsEngine {
  constructor(db) {
    this.db = db;
  }

  _defaultSkills() {
	    return [
	      {
	        id: 'skill_coder',
	        name: 'Программист',
	        description: 'Помогает писать, рефакторить и отлаживать код',
	        systemPrompt: 'Ты — опытный программист-полиглот. Пиши чистый, эффективный код с комментариями. Если задача не уточнена — задай уточняющий вопрос.',
	        enabled: true,
	        icon: '💻',
	        category: 'development',
	      },
	      {
	        id: 'skill_writer',
	        name: 'Писатель',
	        description: 'Помогает писать тексты, статьи, посты',
	        systemPrompt: 'Ты — профессиональный копирайтер и писатель. Пиши качественные, увлекательные тексты. Адаптируй стиль под целевую аудиторию.',
	        enabled: false,
	        icon: '✍️',
	        category: 'content',
	      },
	      {
	        id: 'skill_analyst',
	        name: 'Аналитик',
	        description: 'Анализирует данные и помогает принимать решения',
	        systemPrompt: 'Ты — аналитик данных. Структурируй информацию, находи паттерны, давай обоснованные рекомендации. Используй таблицы и списки для наглядности.',
	        enabled: false,
	        icon: '📊',
	        category: 'analysis',
	      },
	      {
	        id: 'skill_tool_dev',
	        name: 'Разработчик инструментов',
	        description: 'Проектирует и создаёт новые tools для агента через инструмент create_tool',
	        systemPrompt:
	          'Ты — инженер, разрабатывающий инструменты (tools) для этого агента. ' +
	          'Когда пользователь описывает нужную возможность, спроектируй tool и создай его вызовом create_tool.\n\n' +
	          'Правила проектирования:\n' +
	          '1. name — короткий и в snake_case, соответствует ^[a-zA-Z_][a-zA-Z0-9_]*$.\n' +
	          '2. description пиши от лица инструмента: что делает и КОГДА его вызывать (для роутинга LLM).\n' +
	          '3. parameters — валидная JSON Schema: { type:"object", properties:{...}, required:[...] }. Каждое свойство снабжай понятным description.\n' +
	          '4. handlerCode — ТОЛЬКО тело функции. Доступен единственный аргумент params (объект). Нет доступа к this, db, внешним модулям. Можно использовать стандартные Web/JS API (JSON, Math, Date, crypto, fetch, DOMParser).\n' +
	          '5. Тело handlerCode выполняется КАК ТЕЛО ASYNC-ФУНКЦИИ: await можно писать напрямую, на верхнем уровне, без обёрток в async IIFE. Всегда возвращай объект-результат; ошибки возвращай как { error: "текст" }.\n' +
	          '6. Валидируй входные params внутри handlerCode и подставляй разумные значения по умолчанию.\n' +
	          '7. Перед созданием кратко покажи пользователю план (name, параметры, логику), затем вызови create_tool.\n' +
	          '8. Не дублируй уже существующие встроенные инструменты.',
	        enabled: false,
	        icon: '🛠️',
	        category: 'development',
	      },
	    ];
	  }

	  async loadSkills() {
	    const existing = await this.db.getAll('skills');
	    const existingIds = new Set(existing.map(s => s.id));

	    // Досеиваем встроенные skills, которых ещё нет в базе
	    const missing = this._defaultSkills().filter(def => !existingIds.has(def.id));
	    for (const def of missing) {
	      await this.db.put('skills', def);
	    }

	    return missing.length ? await this.db.getAll('skills') : existing;
	  }
  async getActiveSkills() {
    const skills = await this.loadSkills();
    return skills.filter(s => s.enabled);
  }

  async buildSystemPrompt(selectedSkillIds = []) {
    const skills = await this.loadSkills();
    const active = skills.filter(s => selectedSkillIds.includes(s.id) || s.enabled);
    if (active.length === 0) return 'Ты — полезный AI-ассистент. Отвечай структурировано и по делу.';

    let prompt = 'Ты — AI-ассистент со следующими навыками:\n\n';
    for (const s of active) {
      prompt += `## ${s.icon} ${s.name}\n${s.systemPrompt}\n\n`;
    }
    return prompt;
  }
}