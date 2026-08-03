// ============================================================
//  PROMPTS LIBRARY
// ============================================================
class PromptsLibrary {
  constructor(db) {
    this.db = db;
  }

  _defaultPrompts() {
	    return [
	      {
	        id: 'p1', title: 'Рефакторинг кода', category: 'development',
	        content: 'Проведи рефакторинг следующего кода. Улучши читаемость, производительность и следование лучшим практикам. Объясни каждое изменение.\n\n```\n{{code}}\n```',
	        tags: ['код', 'рефакторинг'], variables: ['code'], createdAt: Date.now(),
	      },
	      {
	        id: 'p2', title: 'Объяснение концепции', category: 'learning',
	        content: 'Объясни концепцию "{{concept}}" простым языком. Используй аналогии из реальной жизни. Приведи 3 практических примера. Целевая аудитория: {{audience}}.',
	        tags: ['обучение', 'объяснение'], variables: ['concept', 'audience'], createdAt: Date.now(),
	      },
	      {
	        id: 'p3', title: 'Анализ текста', category: 'analysis',
	        content: 'Проведи глубокий анализ следующего текста:\n1. Основные тезисы\n2. Сильные и слабые стороны аргументации\n3. Скрытые предпосылки\n4. Общая оценка\n\nТекст:\n{{text}}',
	        tags: ['анализ', 'критическое мышление'], variables: ['text'], createdAt: Date.now(),
	      },
	      {
	        id: 'p4', title: 'Пост для соцсетей', category: 'content',
	        content: 'Напиши вовлекающий пост для {{platform}} на тему "{{topic}}". Тон: {{tone}}. Добавь призыв к действию и 3-5 хештегов.',
	        tags: ['SMM', 'контент'], variables: ['platform', 'topic', 'tone'], createdAt: Date.now(),
	      },
	      {
	        id: 'p5', title: 'SQL запрос', category: 'development',
	        content: 'Напиши SQL запрос для следующей задачи: {{task}}.\nСтруктура таблиц:\n{{schema}}\nОбъясни логику запроса.',
	        tags: ['SQL', 'база данных'], variables: ['task', 'schema'], createdAt: Date.now(),
	      },
	      {
	        id: 'p_create_tool', title: 'Создать новый инструмент', category: 'development',
	        content:
	          'Создай новый инструмент (tool) для агента.\n\n' +
	          'Назначение: {{purpose}}\n' +
	          'Входные данные: {{inputs}}\n' +
	          'Ожидаемый результат: {{output}}\n\n' +
	          'Требования:\n' +
	          '- имя в snake_case;\n' +
	          '- parameters оформи как JSON Schema (type: object) с описанием каждого поля;\n' +
	          '- handlerCode — тело JS-функции, получающей объект params, без внешних зависимостей (доступен только params и стандартные Web/JS API), результат — объект, ошибки как { error };\n' +
	          '- сначала покажи план и черновик handlerCode, затем зарегистрируй инструмент вызовом create_tool.',
	        tags: ['tools', 'разработка', 'LLM'],
	        variables: ['purpose', 'inputs', 'output'], createdAt: Date.now(),
	      },
	    ];
	  }

	  async loadPrompts() {
	    const existing = await this.db.getAll('prompts');
	    const existingIds = new Set(existing.map(p => p.id));

	    // Досеиваем встроенные prompts, которых ещё нет в базе
	    const missing = this._defaultPrompts().filter(def => !existingIds.has(def.id));
	    for (const def of missing) {
	      await this.db.put('prompts', def);
	    }

	    return missing.length ? await this.db.getAll('prompts') : existing;
	  }
	  /*
  async loadPrompts() {
    const prompts = await this.db.getAll('prompts');
    if (prompts.length === 0) {
      const defaults = [
        {
          id: 'p1', title: 'Рефакторинг кода', category: 'development',
          content: 'Проведи рефакторинг следующего кода. Улучши читаемость, производительность и следование лучшим практикам. Объясни каждое изменение.\n\n```\n{{code}}\n```',
          tags: ['код', 'рефакторинг'], variables: ['code'], createdAt: Date.now(),
        },
        {
          id: 'p2', title: 'Объяснение концепции', category: 'learning',
          content: 'Объясни концепцию "{{concept}}" простым языком. Используй аналогии из реальной жизни. Приведи 3 практических примера. Целевая аудитория: {{audience}}.',
          tags: ['обучение', 'объяснение'], variables: ['concept', 'audience'], createdAt: Date.now(),
        },
        {
          id: 'p3', title: 'Анализ текста', category: 'analysis',
          content: 'Проведи глубокий анализ следующего текста:\n1. Основные тезисы\n2. Сильные и слабые стороны аргументации\n3. Скрытые предпосылки\n4. Общая оценка\n\nТекст:\n{{text}}',
          tags: ['анализ', 'критическое мышление'], variables: ['text'], createdAt: Date.now(),
        },
        {
          id: 'p4', title: 'Пост для соцсетей', category: 'content',
          content: 'Напиши вовлекающий пост для {{platform}} на тему "{{topic}}". Тон: {{tone}}. Добавь призыв к действию и 3-5 хештегов.',
          tags: ['SMM', 'контент'], variables: ['platform', 'topic', 'tone'], createdAt: Date.now(),
        },
        {
          id: 'p5', title: 'SQL запрос', category: 'development',
          content: 'Напиши SQL запрос для следующей задачи: {{task}}.\nСтруктура таблиц:\n{{schema}}\nОбъясни логику запроса.',
          tags: ['SQL', 'база данных'], variables: ['task', 'schema'], createdAt: Date.now(),
        },
        {
            id: 'p_create_tool', title: 'Создать новый инструмент', category: 'development',
            content:
              'Создай новый инструмент (tool) для агента.\n\n' +
              'Назначение: {{purpose}}\n' +
              'Входные данные: {{inputs}}\n' +
              'Ожидаемый результат: {{output}}\n\n' +
              'Требования:\n' +
              '- имя в snake_case;\n' +
              '- parameters оформи как JSON Schema (type: object) с описанием каждого поля;\n' +
              '- handlerCode — тело JS-функции, получающей объект params, без внешних зависимостей ' +
              '(доступен только params и стандартные Web/JS API), результат — объект, ошибки как { error };\n' +
              '- сначала покажи план и черновик handlerCode, затем зарегистрируй инструмент вызовом create_tool.',
            tags: ['tools', 'разработка', 'LLM'],
            variables: ['purpose', 'inputs', 'output'], createdAt: Date.now(),
          },
      ];
      for (const p of defaults) await this.db.put('prompts', p);
      return defaults;
    }
    return prompts;
  }
  */

  async getCategories() {
    const prompts = await this.loadPrompts();
    const cats = new Set(prompts.map(p => p.category));
    return ['all', ...cats];
  }
}