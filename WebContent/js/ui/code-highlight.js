// ============================================================
//  Подсветка кода в полях редактора: JSON и JavaScript
// ============================================================
//
// Код инструмента и его схема параметров редактируются в обычном
// <textarea>: в нём не видно ни незакрытой строки, ни комментария,
// съевшего половину кода, ни ключа JSON без кавычек. Полноценный
// редактор (CodeMirror, Monaco) — это сотни килобайт и загрузка из сети,
// а приложение работает и без неё.
//
// Поэтому подсветка сделана слоем ПОД полем ввода: <pre> с раскрашенным
// текстом лежит точно под прозрачным текстом <textarea>, а сам ввод,
// выделение, отмена, копирование остаются родными — браузерными. Слой
// перерисовывается на каждый ввод и прокручивается вместе с полем.
//
// Разбор намеренно простой — лексический, без построения дерева: он
// раскрашивает, а не проверяет. Ошибиться он может только в цвете (например,
// в редком случае регулярного выражения после скобки), но никогда — в
// тексте: всё выводится экранированным.
// ============================================================

const CodeHighlight = {

  _esc(t) {
    return String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  },

  _span(cls, text) {
    return `<span class="hl-${cls}">${CodeHighlight._esc(text)}</span>`;
  },

  JS_KEYWORDS: new Set(('break case catch class const continue debugger default delete do else export ' +
    'extends finally for function if import in instanceof let new of return super switch this throw ' +
    'try typeof var void while with yield async await').split(' ')),
  JS_LITERALS: new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']),
  // То, что приложение даёт коду инструмента: подсвечено отдельно, чтобы
  // было видно, где код обращается к возможностям песочницы.
  JS_SANDBOX: new Set(['params', 'agent_form', 'agent_dialog', 'agent_download', 'fetch', 'console',
    'JSON', 'Math', 'Date', 'crypto', 'DOMParser', 'document', 'Promise']),

  // ── JavaScript ──
  js(src) {
    const s = String(src ?? '');
    let out = '';
    let i = 0;
    // Может ли здесь начаться регулярное выражение: после оператора,
    // открывающей скобки, запятой, начала текста или ключевого слова.
    let regexOk = true;

    while (i < s.length) {
      const ch = s[i];
      const next = s[i + 1];

      // Комментарии
      if (ch === '/' && next === '/') {
        const end = s.indexOf('\n', i);
        const stop = end < 0 ? s.length : end;
        out += CodeHighlight._span('comment', s.slice(i, stop));
        i = stop;
        continue;
      }
      if (ch === '/' && next === '*') {
        const end = s.indexOf('*/', i + 2);
        const stop = end < 0 ? s.length : end + 2;
        out += CodeHighlight._span('comment', s.slice(i, stop));
        i = stop;
        continue;
      }

      // Строки, включая шаблонные
      if (ch === '"' || ch === "'" || ch === '`') {
        let j = i + 1;
        while (j < s.length) {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === ch) { j++; break; }
          if (s[j] === '\n' && ch !== '`') break;   // незакрытая строка — до конца строки
          j++;
        }
        out += CodeHighlight._span('string', s.slice(i, j));
        i = j;
        regexOk = false;
        continue;
      }

      // Регулярное выражение
      if (ch === '/' && regexOk) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < s.length && s[j] !== '\n') {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === '[') inClass = true;
          else if (s[j] === ']') inClass = false;
          else if (s[j] === '/' && !inClass) { closed = true; j++; break; }
          j++;
        }
        if (closed) {
          while (j < s.length && /[a-z]/i.test(s[j])) j++;
          out += CodeHighlight._span('regex', s.slice(i, j));
          i = j;
          regexOk = false;
          continue;
        }
      }

      // Числа
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(next || ''))) {
        const m = /^(0[xob][0-9a-f_]+|[0-9_]*\.?[0-9_]+(e[+-]?[0-9]+)?n?)/i.exec(s.slice(i));
        const tok = m ? m[0] : ch;
        out += CodeHighlight._span('number', tok);
        i += tok.length;
        regexOk = false;
        continue;
      }

      // Имена
      if (/[A-Za-z_$]/.test(ch)) {
        const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(s.slice(i));
        const word = m[0];
        const after = s.slice(i + word.length).match(/^\s*(.)/);
        let cls = null;
        if (CodeHighlight.JS_KEYWORDS.has(word)) cls = 'keyword';
        else if (CodeHighlight.JS_LITERALS.has(word)) cls = 'literal';
        else if (CodeHighlight.JS_SANDBOX.has(word)) cls = 'builtin';
        else if (after && after[1] === '(') cls = 'function';
        else if (s[i - 1] === '.') cls = 'property';
        out += cls ? CodeHighlight._span(cls, word) : CodeHighlight._esc(word);
        i += word.length;
        // После return/typeof и т. п. может идти регулярное выражение.
        regexOk = CodeHighlight.JS_KEYWORDS.has(word) && word !== 'this' && word !== 'super';
        continue;
      }

      // Пробелы и знаки
      if (!/\s/.test(ch)) regexOk = !/[)\]}]/.test(ch);
      out += CodeHighlight._esc(ch);
      i++;
    }
    return out;
  },

  // ── JSON ──
  // Ключ отличается от строкового значения тем, что за ним идёт двоеточие.
  json(src) {
    const s = String(src ?? '');
    let out = '';
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') {
        let j = i + 1;
        while (j < s.length) {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === '"') { j++; break; }
          if (s[j] === '\n') break;
          j++;
        }
        const isKey = /^\s*:/.test(s.slice(j));
        out += CodeHighlight._span(isKey ? 'key' : 'string', s.slice(i, j));
        i = j;
        continue;
      }
      if (/[-0-9]/.test(ch)) {
        const m = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(s.slice(i));
        if (m) { out += CodeHighlight._span('number', m[0]); i += m[0].length; continue; }
      }
      const lit = /^(true|false|null)\b/.exec(s.slice(i));
      if (lit) { out += CodeHighlight._span('literal', lit[0]); i += lit[0].length; continue; }
      if (/[{}\[\]:,]/.test(ch)) { out += CodeHighlight._span('punct', ch); i++; continue; }
      out += CodeHighlight._esc(ch);
      i++;
    }
    return out;
  },

  render(src, lang) {
    return lang === 'json' ? CodeHighlight.json(src) : CodeHighlight.js(src);
  },

  // ── Подключить подсветку к полю ──
  // Поле оборачивается контейнером; сам <textarea> остаётся тем же
  // элементом — с тем же id, значением и обработчиками: код формы,
  // читающий его по id, ничего не замечает.
  attach(textarea, lang) {
    if (!textarea || textarea.dataset.codeLang) return null;
    const doc = textarea.ownerDocument;
    textarea.dataset.codeLang = lang;
    textarea.setAttribute('spellcheck', 'false');
    textarea.setAttribute('autocomplete', 'off');
    textarea.classList.add('code-input');

    const wrap = doc.createElement('div');
    wrap.className = 'code-edit';
    const pre = doc.createElement('pre');
    pre.className = 'code-hl';
    pre.setAttribute('aria-hidden', 'true');
    const code = doc.createElement('code');
    pre.appendChild(code);

    textarea.parentNode.insertBefore(wrap, textarea);
    wrap.appendChild(pre);
    wrap.appendChild(textarea);

    const paint = () => {
      // Завершающий перевод строки <pre> не показывает — без пробела в
      // конце слой на последней пустой строке «проседал» на строку выше.
      code.innerHTML = CodeHighlight.render(textarea.value, lang) + '\n ';
      pre.scrollTop = textarea.scrollTop;
      pre.scrollLeft = textarea.scrollLeft;
    };
    const sync = () => { pre.scrollTop = textarea.scrollTop; pre.scrollLeft = textarea.scrollLeft; };

    textarea.addEventListener('input', paint);
    textarea.addEventListener('scroll', sync);

    // Tab вставляет отступ, а не уводит фокус из редактора кода. Shift+Tab
    // по-прежнему уводит — выйти из поля с клавиатуры можно всегда.
    textarea.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = textarea;
      textarea.value = value.slice(0, a) + '  ' + value.slice(b);
      textarea.selectionStart = textarea.selectionEnd = a + 2;
      paint();
    });

    paint();
    return { wrap, pre, paint };
  },
};

if (typeof window !== 'undefined') window.CodeHighlight = CodeHighlight;
