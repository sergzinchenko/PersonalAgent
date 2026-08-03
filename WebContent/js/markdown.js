// ============================================================
//  MARKDOWN RENDERER (lightweight) + UTILITIES
// ============================================================
function renderMarkdown(text) {
  if (!text) return '';
  // Code blocks
  var html = text.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');
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
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Line breaks
  html = html.replace(/\n/g, '<br>');
  return html;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}