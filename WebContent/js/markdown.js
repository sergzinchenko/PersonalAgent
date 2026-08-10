// ============================================================
//  MARKDOWN RENDERER (lightweight) + UTILITIES
// ============================================================
// Экранирует спецсимволы HTML. Вызывается ПЕРВЫМ шагом в renderMarkdown —
// результат этой функции вставляется через innerHTML (ui.js), поэтому
// содержимое ответа LLM (потенциально враждебное — prompt injection,
// скомпрометированный/сторонний API-эндпоинт) не должно исполняться как HTML.
function _escapeHtmlForMarkdown(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(text) {
  if (!text) return '';
  // ВАЖНО: сначала экранируем весь входной текст как HTML, и только потом
  // применяем markdown-трансформации к уже безопасной строке. Раньше здесь
  // не было экранирования вообще, и ответ ассистента (roль assistant) шёл
  // прямиком в innerHTML — это давало прямой XSS через содержимое ответа LLM.
  var html = _escapeHtmlForMarkdown(text);
  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');
  // Inline code
  var inlineCodeRe = new RegExp('[`]([^`]+)[`]', 'g');
  html = html.replace(inlineCodeRe, '<code>$1</code>');
  // Bold (before italic)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  // Links — экранирование выше уже нейтрализовало < > " ' &, но опасные
  // схемы вроде javascript:/data:/vbscript: не содержат этих символов,
  // поэтому проверяем их отдельно.
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, label, url) {
    if (/^\s*(javascript|data|vbscript):/i.test(url)) return label;
    return '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';
  });
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}