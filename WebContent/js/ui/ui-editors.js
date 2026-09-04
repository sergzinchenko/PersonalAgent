// ============================================================
//  UI EDITORS — окна создания и правки Tools / Skills / Prompts
// ============================================================
//
// Формы редактирования сущностей и импорт инструментов с MCP-сервера.

Object.assign(UI.prototype, {


  showAddToolModal(editId = null) {
    const isEdit = !!editId;
    const title = isEdit ? 'Редактировать Tool' : 'Добавить Tool';

    const loadAndShow = async () => {
      const tool = isEdit ? await this.agent.db.get('tools', editId) : null;

      this._showModal(title, `
        <div class="form-group">
          <label>Имя функции (name)</label>
          <input id="t_name" value="${tool ? this._escHtml(tool.name) : ''}" placeholder="my_custom_tool">
        </div>
        <div class="form-group">
          <label>Описание</label>
          <textarea id="t_desc" rows="2">${tool ? this._escHtml(tool.description) : ''}</textarea>
        </div>
        <div class="form-group">
          <label>Parameters (JSON Schema)</label>
          <textarea id="t_params" rows="6">${tool ? JSON.stringify(tool.parameters, null, 2) : '{\n  "type": "object",\n  "properties": {},\n  "required": []\n}'}</textarea>
        </div>
        <div class="form-group">
          <label>Handler Code (JavaScript, получает params)</label>
          <textarea id="t_handler" rows="5">${tool?.handlerCode || '// return { result: params.input };\n'}</textarea>
        </div>
      `, async () => {
        const id = isEdit ? editId : 'custom_' + uid();
        let params;
        try { params = JSON.parse(document.getElementById('t_params').value); }
        catch { params = { type: 'object', properties: {}, required: [] }; }

        // Новый tool не должен попасть внутрь чужого MCP-сервера — та же
        // граница, что охраняется при перетаскивании в _bindSidebarTree:
        // поддерево сервера содержит только его собственные инструменты.
        // Если сейчас выбрана папка внутри сервера, создаём в корне раздела.
        const targetParentId = isEdit
          ? (tool?.parentId ?? null)
          : ((await this._mcpScopeOf('tools', this.folderSelection.tools)) ? null : (this.folderSelection.tools || null));

        const toolObj = {
          id,
          name: document.getElementById('t_name').value.trim(),
          description: document.getElementById('t_desc').value.trim(),
          parameters: params,
          handlerCode: document.getElementById('t_handler').value,
          enabled: tool?.enabled ?? true,
          builtin: false,
          parentId: targetParentId,
        };
        await this.agent.db.put('tools', toolObj);
        this.agent.tools.unregisterHandler(id);   // ← сбрасываем stale-handler из registry       
        this.renderTools();
      });
    };
    loadAndShow();
  },


  // Подключение нового сервера: вся логика (проверка адреса, импорт
  // tools/list, создание папки-контейнера) — в ToolsEngine.connectMcpServer,
  // здесь только форма и реакция на результат.
  showAddMCPServerModal() {
    this._showModal('Подключить MCP-сервер', `
      <p style="color:var(--text-secondary);font-size:13px;margin-bottom:16px;">
        MCP (Model Context Protocol) сервер выставляет tools через HTTP.
        Инструменты сервера появятся отдельной группой в дереве раздела Tools.
      </p>
      <div class="form-group">
        <label>Название</label>
        <input id="mcp_name" placeholder="Например: Локальный MCP">
      </div>
      <div class="form-group">
        <label>MCP Server URL</label>
        <input id="mcp_url" placeholder="http://localhost:3000/mcp">
      </div>
      <div class="form-group">
        <label>Auth Token (опционально)</label>
        <input id="mcp_token" type="password" placeholder="Bearer token">
      </div>
    `, async () => {
      const name = document.getElementById('mcp_name').value.trim();
      const url = document.getElementById('mcp_url').value.trim();
      const token = document.getElementById('mcp_token').value.trim();
      if (!url) return;

      const res = await this.agent.tools.connectMcpServer({ name, url, token });
      if (res.error) {
        await this._confirm(res.error, { title: 'Не удалось подключить сервер' });
        return this.showAddMCPServerModal();
      }

      this.folderSelection.tools = res.folder.id;
      await this.refreshSidebar();
      this.renderTools();
    });
  },

  // Правка сервера: название и токен. URL показан, но недоступен для
  // изменения — см. пояснение у ToolsEngine.updateMcpServer.
  async showEditMCPServerModal(serverId) {
    const server = await this.agent.db.get('mcp_servers', serverId);
    if (!server) return;

    this._showModal('✏ ' + this._escHtml(server.name), `
      <div class="form-group">
        <label>Название</label>
        <input id="mcps_name" value="${this._escHtml(server.name)}">
      </div>
      <div class="form-group">
        <label>MCP Server URL</label>
        <input value="${this._escHtml(server.url)}" disabled style="opacity:.6;">
      </div>
      <div class="form-group">
        <label>Auth Token</label>
        <input id="mcps_token" type="password" placeholder="Оставьте пустым, чтобы не менять">
      </div>
    `, async () => {
      const name = document.getElementById('mcps_name').value.trim();
      const token = document.getElementById('mcps_token').value.trim();
      await this.agent.tools.updateMcpServer(serverId, { name, token });
      await this.refreshSidebar();
      this.renderTools();
    });
  },


  // Та же связь, что в редакторе навыка, но с другой стороны: к каким
  // навыкам относится ЭТОТ инструмент. Отдельным окном, а не полем в
  // редакторе инструмента, потому что редактор открывается только у
  // собственных инструментов — а привязывать нужно и встроенные, и
  // пришедшие с MCP-сервера.
  async showToolSkillsModal(toolId) {
    const tool = await this.agent.db.get('tools', toolId);
    if (!tool) return;

    const skills = (await this.agent.skills.loadSkills())
      .slice().sort((a, b) => a.name.localeCompare(b.name));
    const boundIds = new Set(skills.filter(s => this.agent.skills.toolIdsOf(s).includes(toolId)).map(s => s.id));

    // Системный навык показываем, но снять галочку нельзя: его состав —
    // часть описания механизмов агента. Живая, но бездействующая галочка
    // была бы хуже отсутствия — она обещает то, чего не происходит.
    const rows = skills.map(s => `
      <label class="skill-tool-row${boundIds.has(s.id) ? ' bound' : ''}" data-filter-name="${this._escHtml(s.name.toLowerCase())}"
             ${s.locked ? 'title="Системный навык — его состав не меняется"' : ''}>
        <input type="checkbox" data-skill-of-tool="${s.id}" ${boundIds.has(s.id) ? 'checked' : ''} ${s.locked ? 'disabled' : ''}>
        <span class="skill-tool-name">${s.locked ? '🔒 ' : ''}${this._escHtml(s.icon)} ${this._escHtml(s.name)}</span>
        <span class="skill-tool-state${s.enabled ? ' on' : ''}">${s.enabled ? 'включён' : 'выключен'}</span>
      </label>`).join('');

    this._showModal(`🧩 Навыки инструмента «${this._escHtml(tool.name)}»`, `
      <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:10px;">
        Отметьте навыки, которые пользуются этим инструментом. Один инструмент
        может участвовать в нескольких навыках.
        Отметка ничего не включает: ${tool.locked
          ? 'этот инструмент системный и включён всегда'
          : `инструмент сейчас <b>${tool.enabled ? 'включён' : 'выключен'}</b>, и это решает только его собственный тумблер`}.
      </div>
      ${skills.length ? `
        <input id="ts_filter" placeholder="Фильтр по названию навыка" style="margin-bottom:6px;">
        <div class="skill-tools-picker" id="ts_list">${rows}</div>`
        : '<div style="font-size:12px;color:var(--text-muted);">Навыков пока нет.</div>'}
    `, async () => {
      const chosen = [...document.querySelectorAll('[data-skill-of-tool]')]
        .filter(cb => cb.checked).map(cb => cb.dataset.skillOfTool);
      await this.agent.skills.setToolSkills(toolId, chosen);
      this.renderTools();
      this.renderSkills();
      this.updateChatToolbar();
    });

    setTimeout(() => {
      const list = document.getElementById('ts_list');
      list?.addEventListener('change', (e) => {
        if (!e.target.matches('[data-skill-of-tool]')) return;
        e.target.closest('.skill-tool-row')?.classList.toggle('bound', e.target.checked);
      });
      document.getElementById('ts_filter')?.addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        list?.querySelectorAll('.skill-tool-row').forEach(row => {
          row.hidden = !!q && !row.dataset.filterName.includes(q);
        });
      });
    }, 50);
  },


  // ── Генератор файлов локального прокси ──
  // Прокси — отдельный Node-процесс, и до сих пор его нужно было добыть
  // самому. Здесь его комплект собирается по заполненной форме: config.js
  // с подставленными значениями, сам proxy.js и скрипты запуска.
  //
  // proxy.js НЕ хранится копией внутри приложения, а забирается с того же
  // адреса, откуда открыта страница (в dist он тоже кладётся сборкой).
  // Вторая копия исходника рано или поздно разошлась бы с оригиналом, и
  // пользователь получал бы прокси, отличающийся от того, что в репозитории.
  showProxySetupModal() {
    const cfg = this.proxy || {};
    let port = 3000;
    try { port = parseInt(new URL(cfg.baseUrl).port, 10) || 3000; } catch (_) { port = 3000; }

    const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];

    this._showModal('📦 Файлы локального прокси', `
      <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px;">
        Соберём комплект для запуска прокси: <code>config.js</code> с вашими значениями,
        <code>proxy.js</code> и скрипты запуска. Сохранить их нужно в одну папку —
        браузер спросит, в какую.
      </div>

      <div class="settings-grid">
        <div class="form-group">
          <label>Порт</label>
          <input id="pg_port" type="number" min="1" max="65535" value="${port}">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            На нём прокси слушает запросы от этой страницы.
          </div>
        </div>
        <div class="form-group">
          <label>Максимальный размер запроса, МБ</label>
          <input id="pg_body_mb" type="number" min="1" max="512" value="10">
        </div>
      </div>

      <div class="form-group">
        <label>Разрешённые хосты (белый список)</label>
        <input id="pg_allowlist" placeholder="intranet.corp.local, api.example.com — пусто = без ограничений">
        <div style="font-size:11px;color:var(--warning);margin-top:2px;line-height:1.5;">
          Пустой список означает, что прокси сходит куда угодно — включая внутреннюю сеть —
          по просьбе любой страницы, знающей его порт. Для постоянной работы список лучше заполнить.
        </div>
      </div>

      <div class="form-group">
        <label>Разрешённые методы</label>
        <div style="display:flex;flex-wrap:wrap;gap:10px;">
          ${METHODS.map(m => `
            <label style="display:flex;align-items:center;gap:5px;font-weight:400;font-size:12px;">
              <input type="checkbox" data-pg-method="${m}" style="width:auto;" checked> ${m}
            </label>`).join('')}
        </div>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:6px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:4px;">TLS-сертификаты</div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:10px;">
          У внутренних серверов сертификат обычно выпущен корпоративным центром,
          которого нет в списке доверенных, — без настройки такой запрос падает с 502.
          Варианты ниже идут от правильного к крайнему; берите первый, который применим.
        </div>
        <div class="form-group">
          <label>Путь к CA-файлу (PEM) — рекомендуется</label>
          <input id="pg_ca" placeholder="ca.pem или C:\\corp\\ca.pem — пусто = не использовать">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            Проверка при этом ОСТАЁТСЯ включённой: прокси просто узнаёт про ваш
            удостоверяющий центр. Подменённый сертификат по-прежнему будет отвергнут.
          </div>
        </div>
        <div class="form-group">
          <label>Не проверять сертификат у хостов</label>
          <input id="pg_tls_hosts" placeholder="intranet.corp.local — пусто = проверять у всех">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            Компромисс, когда до CA-файла не добраться. <code>corp.local</code> покрывает и поддомены.
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;">
          <input type="checkbox" id="pg_tls_insecure" style="width:auto;"> Не проверять сертификаты вообще нигде
        </label>
        <div style="font-size:11px;color:var(--danger);margin:2px 0 8px 22px;line-height:1.5;">
          Крайний случай. Снимает защиту от подмены сервера на ВСЕХ адресах, включая внешние:
          перехватчик трафика станет неотличим от настоящего сервера. Только на время разбирательства.
        </div>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:6px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:4px;">SSO (доменная аутентификация)</div>
        <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:10px;">
          Включается не здесь, а в каждом запросе отдельно (<code>sso: true</code>). Эти значения
          лишь задают, как прокси будет вызывать <code>curl</code>, когда его об этом попросят.
        </div>
        <div class="form-group">
          <label>Путь к curl</label>
          <input id="pg_curl" value="curl.exe" placeholder="curl.exe или полный путь">
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">
            На Windows curl с поддержкой SSPI идёт в комплекте системы. На других ОС — <code>curl</code>.
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;">
          <input type="checkbox" id="pg_ntlm" style="width:auto;" checked> Разрешить NTLM
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-top:4px;">
          <input type="checkbox" id="pg_negotiate" style="width:auto;" checked> Разрешить Negotiate (Kerberos)
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-top:4px;">
          <input type="checkbox" id="pg_insecure" style="width:auto;"> Принимать самоподписанные сертификаты (-k)
        </label>
        <div style="font-size:11px;color:var(--warning);margin:2px 0 8px 22px;line-height:1.5;">
          Отключает проверку сертификата целиком — только для внутренних серверов, где это неизбежно.
        </div>
        <div class="settings-grid">
          <div class="form-group">
            <label>Таймаут curl, сек</label>
            <input id="pg_sso_timeout" type="number" min="1" max="600" value="60">
          </div>
          <div class="form-group">
            <label>Предел ответа в SSO-режиме, МБ</label>
            <input id="pg_sso_mb" type="number" min="1" max="512" value="20">
          </div>
        </div>
      </div>

      <label class="check-row" style="margin-top:8px;">
        <input type="checkbox" id="pg_set_url" checked> Прописать адрес прокси в настройках агента
      </label>
      <div id="pg_result" style="font-size:12px;margin-top:10px;line-height:1.6;"></div>
    `, async () => {
      const num = (id, def) => { const v = parseInt(document.getElementById(id)?.value, 10); return v > 0 ? v : def; };
      const methods = [...document.querySelectorAll('[data-pg-method]')]
        .filter(cb => cb.checked).map(cb => cb.dataset.pgMethod);
      const allowlist = (document.getElementById('pg_allowlist')?.value || '')
        .split(/[\s,;]+/).map(h => h.trim()).filter(Boolean);

      const opts = {
        port: num('pg_port', 3000),
        caFile: (document.getElementById('pg_ca')?.value || '').trim(),
        tlsInsecureHosts: (document.getElementById('pg_tls_hosts')?.value || '')
          .split(/[\s,;]+/).map(h => h.trim()).filter(Boolean),
        tlsInsecure: !!document.getElementById('pg_tls_insecure')?.checked,
        methods: methods.length ? methods : ['GET'],
        allowlist,
        bodyMb: num('pg_body_mb', 10),
        curlBin: (document.getElementById('pg_curl')?.value || 'curl.exe').trim() || 'curl.exe',
        useNtlm: !!document.getElementById('pg_ntlm')?.checked,
        useNegotiate: !!document.getElementById('pg_negotiate')?.checked,
        insecure: !!document.getElementById('pg_insecure')?.checked,
        ssoTimeout: num('pg_sso_timeout', 60),
        ssoMb: num('pg_sso_mb', 20),
      };

      const files = [
        { name: 'config.js', text: this._buildProxyConfigJs(opts) },
        { name: 'start-proxy.bat', text: this._buildProxyLauncher('bat') },
        { name: 'start-proxy.sh', text: this._buildProxyLauncher('sh') },
      ];

      // proxy.js берём с адреса, откуда открыто приложение. Если его там
      // нет (страницу открыли из папки без proxy/), честно говорим об этом
      // и отдаём остальное: config.js без proxy.js бесполезен не полностью —
      // его можно положить рядом с уже имеющимся прокси.
      let proxyJsError = null;
      try {
        const r = await fetch('proxy/proxy.js', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        files.unshift({ name: 'proxy.js', text: await r.text() });
      } catch (e) {
        proxyJsError = e.message;
      }

      const saved = await this._saveGeneratedFiles(files);
      if (document.getElementById('pg_set_url')?.checked) {
        this.proxy = { ...this.proxy, baseUrl: 'http://localhost:' + opts.port };
        await this.agent.db.put('settings', { key: 'proxy', ...this.proxy });
      }

      const list = files.map(f => f.name).join(', ');
      await this._confirm(
        (saved.ok
          ? `Сохранено в выбранную папку: ${list}.`
          : saved.downloaded
            ? `Папку выбрать не удалось (${saved.reason}), файлы скачаны по одному: ${list}.`
            : `Не удалось сохранить файлы: ${saved.reason}`) +
        (proxyJsError
          ? `\n\nproxy.js получить не удалось (${proxyJsError}) — возьмите его из папки proxy/ репозитория.`
          : '') +
        (saved.ok || saved.downloaded
          ? '\n\nЗапуск: start-proxy.bat (Windows) или sh start-proxy.sh. Нужен установленный Node.js.'
          : ''),
        { title: 'Файлы прокси' });
    }, null, { wide: true });
  },


  // config.js собирается с комментариями, а не голыми значениями: файл
  // правят руками после генерации, и без пояснений «allowlist: []» через
  // месяц выглядит как «тут ничего не нужно».
  _buildProxyConfigJs(o) {
    const q = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    return `// Конфигурация локального прокси. Сгенерирована из ⚙ Настройки → Безопасность.
// Правьте значения и перезапускайте proxy.js — переменные окружения не нужны.
module.exports = {
  // Порт, на котором прокси слушает входящие запросы из браузера.
  port: ${o.port},

  // Разрешённые HTTP-методы. GET/HEAD тела не имеют, остальные поддерживаются полностью.
  allowedMethods: [${o.methods.map(q).join(', ')}],

  // Белый список хостов, куда прокси разрешено ходить (защита от SSRF —
  // без него любая страница, знающая порт прокси, может ходить куда угодно
  // от имени вашей локальной машины). Пустой массив = ограничений нет.
  allowlist: [${o.allowlist.map(q).join(', ')}],

  // Максимальный размер тела входящего запроса от браузера, в байтах.
  maxRequestBodyBytes: ${o.bodyMb} * 1024 * 1024, // ${o.bodyMb} MB

  // Сколько байт тела запроса/ответа печатать в консоль при логировании
  // (клиенту пересылается всё целиком, лимит только для лога).
  maxLogBytes: 4096,

  // Отключить цветной (ANSI) вывод — удобно, если логи пишутся в файл.
  noColor: false,

  // ---- TLS: доверие к сертификатам целевых серверов ----
  // Варианты от правильного к крайнему — берите первый, который применим.
  tls: {
    // 1. ЛУЧШИЙ ВАРИАНТ: PEM с сертификатом вашего удостоверяющего центра.
    //    Проверка ОСТАЁТСЯ включённой, просто Node узнаёт про ваш CA.
    //    Путь абсолютный или относительно папки с proxy.js.
    caFile: ${q(o.caFile || '')},

    // 2. КОМПРОМИСС: не проверять сертификат только у этих хостов.
    //    'corp.local' покрывает и 'intranet.corp.local'.
    insecureHosts: [${(o.tlsInsecureHosts || []).map(q).join(', ')}],

    // 3. КРАЙНИЙ СЛУЧАЙ: не проверять ни у кого. Отключает защиту от
    //    подмены сервера на ВСЕХ адресах, включая внешние.
    insecure: ${!!o.tlsInsecure},
  },

  // ---- SSO: аутентификация к целевому серверу через curl (NTLM/Negotiate) ----
  // Включается на конкретный запрос заголовком X-Use-Sso: 1 или ?sso=1 —
  // остальные запросы всегда идут обычным путём через http/https.
  sso: {
    // Путь к исполняемому файлу curl.
    curlBin: ${q(o.curlBin)},

    // Механизмы аутентификации, разрешённые curl. На Windows с пустыми
    // user:pass это даёт SSO текущего пользователя через SSPI, без пароля.
    useNtlm: ${o.useNtlm},
    useNegotiate: ${o.useNegotiate},

    // -k у curl — принимать самоподписанные сертификаты.
    insecure: ${o.insecure},

    // Таймаут одного запроса curl, в секундах.
    timeoutSec: ${o.ssoTimeout},

    // Предел ответа в SSO-режиме: здесь ответ буферизуется в памяти целиком.
    maxResponseBytes: ${o.ssoMb} * 1024 * 1024, // ${o.ssoMb} MB
  },
};
`;
  },


  _buildProxyLauncher(kind) {
    if (kind === 'bat') {
      return [
        '@echo off',
        'rem Запуск локального прокси. Файл должен лежать рядом с proxy.js и config.js.',
        'cd /d "%~dp0"',
        'where node >nul 2>nul || (echo Node.js не найден в PATH. Установите его: https://nodejs.org && pause && exit /b 1)',
        'node proxy.js',
        'rem Окно не закрывается сразу — иначе причину падения не прочитать.',
        'pause',
        '',
      ].join('\r\n');
    }
    return [
      '#!/bin/sh',
      '# Запуск локального прокси. Файл должен лежать рядом с proxy.js и config.js.',
      'cd "$(dirname "$0")" || exit 1',
      'command -v node >/dev/null 2>&1 || { echo "Node.js не найден в PATH: https://nodejs.org"; exit 1; }',
      'exec node proxy.js',
      '',
    ].join('\n');
  },


  // Сохранение пачки файлов в выбранную пользователем папку. Fallback —
  // обычное скачивание по одному: File System Access есть не везде, и
  // остаться совсем без файлов из-за этого пользователь не должен.
  async _saveGeneratedFiles(files) {
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
        for (const f of files) {
          const handle = await dir.getFileHandle(f.name, { create: true });
          const w = await handle.createWritable();
          await w.write(f.text);
          await w.close();
        }
        return { ok: true };
      } catch (e) {
        // Отмена выбора папки — не ошибка и не повод скачивать файлы,
        // которых пользователь мог и не захотеть.
        if (e && e.name === 'AbortError') return { ok: false, downloaded: false, reason: 'выбор папки отменён' };
        for (const f of files) this.agent.tools._downloadFile(f.text, f.name, 'text/plain');
        return { ok: false, downloaded: true, reason: e.message };
      }
    }
    for (const f of files) this.agent.tools._downloadFile(f.text, f.name, 'text/plain');
    return { ok: false, downloaded: true, reason: 'браузер не поддерживает выбор папки' };
  },


  // Системный навык — только просмотр. Отдельное окно, а не форма с
  // заблокированными полями: disabled-поля выглядят как «сломалось»,
  // а здесь нужно объяснить, ПОЧЕМУ его не правят.
  async showSystemSkillModal(skill) {
    const tools = await this.agent.skills.toolsOfSkill(skill);
    this._showModal(`🔒 ${this._escHtml(skill.icon)} ${this._escHtml(skill.name)}`, `
      <div style="font-size:12px;color:var(--text-secondary);line-height:1.6;margin-bottom:12px;">
        Системный навык описывает устройство самого агента — память, подтверждение
        операций, судьбу выключенных инструментов, подрезку истории. Он участвует
        в <b>каждом</b> запросе, идёт <b>перед</b> остальными навыками, и его правила
        имеют приоритет над ними. Поэтому его нельзя выключить, удалить или изменить:
        правка тихо поменяла бы основания, на которые опирается всё остальное поведение.
      </div>
      <div class="form-group">
        <label>Описание</label>
        <div style="font-size:13px;color:var(--text-primary);">${this._escHtml(skill.description)}</div>
      </div>
      <div class="form-group">
        <label>Инструменты навыка (тоже неотключаемые)</label>
        <div class="skill-tools">
          ${tools.map(t => `<span class="skill-tool-chip">${this._escHtml(t.name)}</span>`).join('') ||
            '<span style="font-size:12px;color:var(--text-muted);">нет</span>'}
        </div>
      </div>
      <div class="form-group">
        <label>System Prompt</label>
        <div class="tool-params" style="white-space:pre-wrap;max-height:40vh;overflow:auto;">${this._escHtml(skill.systemPrompt)}</div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);line-height:1.5;">
        Нужно другое поведение — не меняйте системный навык, а добавьте свой:
        его указания применяются поверх, но не отменяют системные.
      </div>
    `, null, null, { wide: true });
  },


  showAddSkillModal(editId = null) {
    const loadAndShow = async () => {
      const skill = editId ? await this.agent.db.get('skills', editId) : null;
      // Системный навык не редактируется: он описывает устройство самого
      // агента и участвует в каждом запросе. Правка его текста тихо меняла
      // бы правила, на которые опирается всё остальное, — включая то, как
      // агент объясняет отказы политики и судьбу выключенных инструментов.
      // Показываем как есть, только на чтение.
      if (skill?.locked) return this.showSystemSkillModal(skill);

      const title = skill ? 'Редактировать Skill' : 'Новый Skill';

      // Привязка к инструментам. Отмеченные не включаются и не выключаются —
      // это связь «чем пользуется навык», а доступность по-прежнему решает
      // собственный тумблер инструмента (см. комментарий в SkillsEngine).
      const allTools = (await this.agent.tools.loadTools())
        .slice().sort((a, b) => a.name.localeCompare(b.name));
      const boundIds = new Set(this.agent.skills.toolIdsOf(skill));

      const toolRows = allTools.map(t => `
        <label class="skill-tool-row${boundIds.has(t.id) ? ' bound' : ''}" data-filter-name="${this._escHtml(t.name.toLowerCase())}">
          <input type="checkbox" data-skill-tool="${t.id}" ${boundIds.has(t.id) ? 'checked' : ''}>
          <span class="skill-tool-name">${t.mcpServerId ? '🧩 ' : ''}${this._escHtml(t.name)}</span>
          <span class="skill-tool-state${t.enabled ? ' on' : ''}">${t.enabled ? 'включён' : 'выключен'}</span>
        </label>`).join('');

      this._showModal(title, `
        <div class="form-group">
          <label>Иконка</label>
          <input id="sk_icon" value="${skill?.icon || '🤖'}" maxlength="4" style="width:60px">
        </div>
        <div class="form-group">
          <label>Название</label>
          <input id="sk_name" value="${skill ? this._escHtml(skill.name) : ''}" placeholder="Мой навык">
        </div>
        <div class="form-group">
          <label>Описание</label>
          <input id="sk_desc" value="${skill ? this._escHtml(skill.description) : ''}" placeholder="Краткое описание">
        </div>
        <div class="form-group">
          <label>Категория</label>
          <select id="sk_cat">
            <option value="development" ${skill?.category === 'development' ? 'selected' : ''}>Development</option>
            <option value="content" ${skill?.category === 'content' ? 'selected' : ''}>Content</option>
            <option value="analysis" ${skill?.category === 'analysis' ? 'selected' : ''}>Analysis</option>
            <option value="custom" ${skill?.category === 'custom' ? 'selected' : ''}>Custom</option>
          </select>
        </div>
        <div class="form-group">
          <label>System Prompt</label>
          <textarea id="sk_prompt" rows="6">${skill ? this._escHtml(skill.systemPrompt) : ''}</textarea>
        </div>
        <div class="form-group">
          <label>Инструменты навыка <span id="sk_tools_count" style="color:var(--text-muted);font-weight:400;"></span></label>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;line-height:1.5;">
            Отметьте, чем пользуется этот навык. Один инструмент может быть привязан
            к нескольким навыкам. Отметка НЕ включает инструмент: доступность
            по-прежнему решает его собственный тумблер на вкладке Tools —
            привязанный, но выключенный будет назван модели как недоступный.
          </div>
          ${allTools.length ? `
            <input id="sk_tools_filter" placeholder="Фильтр по имени инструмента" style="margin-bottom:6px;">
            <div class="skill-tools-picker" id="sk_tools_list">${toolRows}</div>`
            : '<div style="font-size:12px;color:var(--text-muted);">Инструментов пока нет.</div>'}
        </div>
      `, async () => {
        const toolIds = [...document.querySelectorAll('[data-skill-tool]')]
          .filter(cb => cb.checked).map(cb => cb.dataset.skillTool);
        const obj = {
          id: editId || 'skill_' + uid(),
          icon: document.getElementById('sk_icon').value || '🤖',
          name: document.getElementById('sk_name').value.trim(),
          description: document.getElementById('sk_desc').value.trim(),
          category: document.getElementById('sk_cat').value,
          systemPrompt: document.getElementById('sk_prompt').value.trim(),
          enabled: skill?.enabled ?? false,
          toolIds,
          parentId: editId ? (skill?.parentId ?? null) : (this.folderSelection.skills || null),
        };
        await this.agent.db.put('skills', obj);
        this.renderSkills();
        this.updateChatToolbar();
      });

      // Фильтр и счётчик отмеченного. Инструментов бывает много (одни
      // только встроенные — четвёртый десяток), без поиска список
      // превращается в прокрутку вслепую.
      setTimeout(() => {
        const list = document.getElementById('sk_tools_list');
        const counter = document.getElementById('sk_tools_count');
        const syncCount = () => {
          if (!counter) return;
          const n = document.querySelectorAll('[data-skill-tool]:checked').length;
          counter.textContent = n ? `— отмечено ${n}` : '— ничего не отмечено';
        };
        syncCount();
        list?.addEventListener('change', (e) => {
          if (!e.target.matches('[data-skill-tool]')) return;
          e.target.closest('.skill-tool-row')?.classList.toggle('bound', e.target.checked);
          syncCount();
        });
        document.getElementById('sk_tools_filter')?.addEventListener('input', (e) => {
          const q = e.target.value.trim().toLowerCase();
          list?.querySelectorAll('.skill-tool-row').forEach(row => {
            row.hidden = !!q && !row.dataset.filterName.includes(q);
          });
        });
      }, 50);
    };
    loadAndShow();
  },


  showAddPromptModal(editId = null) {
    const loadAndShow = async () => {
      const prompt = editId ? await this.agent.db.get('prompts', editId) : null;
      const title = prompt ? 'Редактировать промпт' : 'Новый промпт';

      this._showModal(title, `
        <div class="form-group">
          <label>Название</label>
          <input id="pr_title" value="${prompt ? this._escHtml(prompt.title) : ''}" placeholder="Название промпта">
        </div>
        <div class="form-group">
          <label>Категория</label>
          <select id="pr_cat">
            <option value="development" ${prompt?.category === 'development' ? 'selected' : ''}>Development</option>
            <option value="content" ${prompt?.category === 'content' ? 'selected' : ''}>Content</option>
            <option value="analysis" ${prompt?.category === 'analysis' ? 'selected' : ''}>Analysis</option>
            <option value="learning" ${prompt?.category === 'learning' ? 'selected' : ''}>Learning</option>
            <option value="custom" ${prompt?.category === 'custom' ? 'selected' : ''}>Custom</option>
          </select>
        </div>
        <div class="form-group">
          <label>Теги (через запятую)</label>
          <input id="pr_tags" value="${prompt?.tags?.join(', ') || ''}" placeholder="тег1, тег2">
        </div>
        <div class="form-group">
          <label>Контент (используйте {{variable}} для переменных)</label>
          <textarea id="pr_content" rows="8">${prompt ? this._escHtml(prompt.content) : ''}</textarea>
        </div>
      `, async () => {
        const content = document.getElementById('pr_content').value;
        const variables = [...new Set((content.match(/\{\{(\w+)\}\}/g) || []).map(v => v.replace(/\{\{|\}\}/g, '')))];
        const obj = {
          id: editId || 'p_' + uid(),
          title: document.getElementById('pr_title').value.trim(),
          category: document.getElementById('pr_cat').value,
          tags: document.getElementById('pr_tags').value.split(',').map(s => s.trim()).filter(Boolean),
          content,
          variables,
          createdAt: prompt?.createdAt || Date.now(),
          parentId: editId ? (prompt?.parentId ?? null) : (this.folderSelection.prompts || null),
        };
        await this.agent.db.put('prompts', obj);
        this.renderPrompts();
        this.refreshSidebar();
      });
    };
    loadAndShow();
  }

  ,

  // ── Добавление файлов как ссылок ──
  // Через File System Access API получаем дескрипторы, которые переживают
  // перезагрузку. Если API недоступен (Firefox, Safari), откатываемся на
  // <input type="file"> и честно помечаем, что ссылка временная.
  async addFiles() {
    const parentId = this.folderSelection.files || null;

    if (FilesEngine.isSupported()) {
      let handles;
      try {
        handles = await window.showOpenFilePicker({ multiple: true });
      } catch (e) {
        return; // пользователь закрыл диалог — это не ошибка
      }
      let added = 0;
      for (const handle of handles) {
        const file = await handle.getFile();
        await this.agent.files.register({ handle, file, parentId });
        added++;
      }
      if (added) this.renderFiles();
      return;
    }

    // Запасной режим
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', async () => {
      for (const file of Array.from(input.files || [])) {
        await this.agent.files.register({ handle: null, file, parentId });
      }
      this.renderFiles();
      const c = document.getElementById('files-container');
      c?.insertAdjacentHTML('afterbegin',
        '<div class="message system" style="margin:12px;">ℹ️ Браузер не поддерживает постоянные ссылки на файлы ' +
        '(нужен Chrome или Edge). Файлы доступны до перезагрузки страницы, после неё их нужно выбрать заново.</div>');
    });
    input.click();
  },

  // Повторный выбор файла: дескриптор мог устареть (файл перемещён,
  // переименован) либо его не было вовсе (запасной режим).
  async relinkFile(id) {
    const record = await this.agent.files.get(id);
    if (!record) return;

    if (FilesEngine.isSupported()) {
      let handles;
      try {
        handles = await window.showOpenFilePicker({ multiple: false });
      } catch (e) { return; }
      const handle = handles[0];
      const file = await handle.getFile();
      record.handle = handle;
      record.name = file.name;
      record.size = file.size;
      record.mime = file.type || '';
      record.lastModified = file.lastModified;
      record.needsRelink = false;
      await this.agent.db.put('files', record);
      this.renderFiles();
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      record.name = file.name;
      record.size = file.size;
      record.mime = file.type || '';
      record.lastModified = file.lastModified;
      await this.agent.db.put('files', record);
      this.agent.files._transient.set(id, file);
      this.renderFiles();
    });
    input.click();
  },

  // Просмотр содержимого. Кнопка — это жест пользователя, поэтому именно
  // отсюда корректно запрашивать разрешение на чтение.
  async showFilePreview(id) {
    const record = await this.agent.files.get(id);
    if (!record) return;

    if (record.handle) {
      const perm = await this.agent.files.ensurePermission(record, { request: true });
      if (perm !== 'granted') {
        this._showModal('📎 ' + this._escHtml(record.name), `
          <p style="color:var(--text-secondary);font-size:13px;">
            Браузер не дал разрешение на чтение файла. Это штатное поведение после
            перезапуска браузера — нажмите «Просмотр» ещё раз и разрешите доступ,
            либо выберите файл заново кнопкой «Перевыбрать».
          </p>`, null);
        return;
      }
    }

    const res = await this.agent.files.read(id, { maxBytes: 200 * 1024 });
    if (res.error) {
      this._showModal('📎 ' + this._escHtml(record.name),
        `<p style="color:var(--danger);font-size:13px;">${this._escHtml(res.error)}</p>` +
        (res.needsRelink ? '<p style="font-size:12px;color:var(--text-muted);">Нажмите «Перевыбрать», чтобы указать файл заново.</p>' : ''),
        null);
      return;
    }

    const isImage = (res.mime || '').startsWith('image/');
    const body = isImage
      ? '<p style="color:var(--text-secondary);font-size:13px;">Двоичный файл — предпросмотр текста недоступен.</p>'
      : `<pre class="tool-pre" style="max-height:50vh;">${this._escHtml(res.text || '')}</pre>`;

    this._showModal('📎 ' + this._escHtml(record.name), `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
        ${res.size} байт${res.mime ? ' · ' + this._escHtml(res.mime) : ''}
        ${res.truncated ? ' · показано начало файла' : ''}
      </div>
      ${body}
      <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
        Содержимое читается с диска при каждом обращении и нигде не сохраняется.
      </div>`, null, null, { wide: true });
  }

});
