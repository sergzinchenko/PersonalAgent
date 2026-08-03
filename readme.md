## Структура проекта

WebContent/
|-- index.html
\-- css/
|   \-- styles.css
\-- js/
    \-- db.js
    \-- llm-gateway.js
    \-- tools-engine.js
    \-- skills-engine.js
    \-- prompts-library.js
    \-- markdown.js
    \-- ui.js
    \-- agent.js
    \-- app.js
    
Итоговая структура и зависимости
Файл	Содержимое	Зависит от
index.html	Разметка + подключение CSS и JS	все файлы
css/styles.css	Все стили	—
js/db.js	AgentDB	—
js/llm-gateway.js	LLMGateway	—
js/tools-engine.js	ToolsEngine	AgentDB
js/skills-engine.js	SkillsEngine	AgentDB
js/prompts-library.js	PromptsLibrary	AgentDB
js/markdown.js	renderMarkdown(), uid()	—
js/ui.js	UI	все классы выше
js/agent.js	AIAgent	все классы выше
js/app.js	bootstrap new AIAgent().init()	AIAgent    