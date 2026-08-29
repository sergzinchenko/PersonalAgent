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

  // Блоки кода вынимаем из текста ДО остальных преобразований и
  // возвращаем в самом конце. Иначе к их содержимому применялись бы
  // правила разметки: `*` внутри кода превращался в <em>, `#` в начале
  // строки — в заголовок, а финальная замена \n → <br> добавляла лишние
  // переносы поверх тех, что <pre> и так сохраняет (строки двоились).
  var codeBlocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (m, lang, code) {
    const label = lang ? '<span class="code-lang">' + lang + '</span>' : '';
    // Текст для копирования обработчик берёт напрямую из <code>
    // через textContent — ни экранировать повторно, ни хранить копию
    // в data-атрибуте не требуется.
    codeBlocks.push(
      '<div class="code-block">' +
        '<div class="code-bar">' + label +
          '<button class="code-copy-btn" type="button" title="Копировать код">⧉ Копировать</button>' +
        '</div>' +
        '<pre><code class="lang-' + lang + '">' + code + '</code></pre>' +
      '</div>'
    );
    return '\u0000CODEBLOCK' + (codeBlocks.length - 1) + '\u0000';
  });
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

  // Возвращаем блоки кода на место — уже после всех текстовых правил.
  html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, function (m, i) {
    return codeBlocks[Number(i)];
  });
  return html;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}