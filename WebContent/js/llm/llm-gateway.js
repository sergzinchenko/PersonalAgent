// ============================================================
//  LLM GATEWAY — OpenAI-compatible API client
// ============================================================
class LLMGateway {
  constructor() {
    this.apiUrl = '';
    this.apiKey = '';
    this.model = '';
    this.maxTokens = 4096;
    this.temperature = 0.7;
    this.authType = 'bearer'; // 'bearer' | 'custom'
    this.customHeaderName = '';
    this.customHeaderValue = '';
    this.availableModels = [];
    // Подробное логирование запросов/ответов (включая содержимое сообщений
    // и tool-аргументов) в консоль. По умолчанию выключено: раньше это
    // писалось безусловно на каждый вызов, включая переписку пользователя
    // и параметры инструментов — утечка в консоль браузера/расширения.
    // Включить для отладки: agent.llm.debug = true (в DevTools console).
    this.debug = false;
  }

  configure({ apiUrl, apiKey, model, maxTokens, temperature, authType, customHeaderName, customHeaderValue }) {
    if (apiUrl !== undefined) this.apiUrl = apiUrl.replace(/\/+$/, '');
    if (apiKey !== undefined) this.apiKey = apiKey;
    if (model !== undefined) this.model = model;
    if (maxTokens !== undefined) this.maxTokens = maxTokens;
    if (temperature !== undefined) this.temperature = temperature;
    if (authType !== undefined) this.authType = authType;
    if (customHeaderName !== undefined) this.customHeaderName = customHeaderName;
    if (customHeaderValue !== undefined) this.customHeaderValue = customHeaderValue;
  }

  _buildAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.authType === 'custom' && this.customHeaderName) {
      headers[this.customHeaderName] = this.customHeaderValue;
    } else if (this.apiKey) {
      headers['Authorization'] = 'Bearer ' + this.apiKey;
    }
    return headers;
  }

  isConfigured() {
    const hasAuth = this.authType === 'custom'
      ? !!(this.customHeaderName && this.customHeaderValue)
      : !!this.apiKey;
    return !!(this.apiUrl && hasAuth && this.model);
  }

  async chat(messages, { tools = null, stream = false, onChunk = null, signal = null } = {}) {
    const body = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const endpoint = this.apiUrl + '/chat/completions';
    const headers = this._buildAuthHeaders();

    if (this.debug) {
    // --- LOG REQUEST ---
    const logHeaders = Object.assign({}, headers);
    for (var hk in logHeaders) {
      if (hk.toLowerCase() === 'authorization' || hk.toLowerCase().includes('key') || hk.toLowerCase().includes('secret') || hk.toLowerCase().includes('token')) {
        var val = logHeaders[hk];
        if (val && val.length > 12) {
          logHeaders[hk] = val.substring(0, 8) + '***' + val.substring(val.length - 4);
        }
      }
    }
    console.group('%c🔼 LLM REQUEST', 'color:#6c5ce7;font-weight:bold;font-size:13px;');
    console.log('%cEndpoint:', 'color:#888;', endpoint);
    console.log('%cMethod:', 'color:#888;', 'POST');
    console.log('%cHeaders:', 'color:#888;', logHeaders);
    console.log('%cBody:', 'color:#888;');
    // Системный промпт и описания системных инструментов в консоль не
    // уходят никогда — см. core/log-guard.js.
    LogGuard.notice();
    console.dir(JSON.parse(JSON.stringify(LogGuard.redactBody(body))));
    console.log('%cMessages count:', 'color:#888;', messages.length);
    if (tools) console.log('%cTools count:', 'color:#888;', tools.length);
    console.log('%cStream:', 'color:#888;', stream);
    console.log('%cTimestamp:', 'color:#888;', new Date().toISOString());
    console.groupEnd();
    }

    var requestTimestamp = performance.now();

    if (stream && onChunk) {
      body.stream = true;
      // Просим провайдера прислать usage финальным чанком — иначе при
      // stream:true счётчик токенов недоступен. Провайдеры, не знающие
      // это поле, обычно его игнорируют; тогда usage останется null и
      // UI просто не покажет цифры за этот запрос.
      body.stream_options = { include_usage: true };
      if (this.debug) {
      console.log('%c🔼 LLM REQUEST body.stream set to true', 'color:#6c5ce7;');
      }

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: signal,
      });

      var elapsed = (performance.now() - requestTimestamp).toFixed(0);

      if (!resp.ok) {
        const err = await resp.text();
        if (this.debug) {
        console.group('%c🔽❌ LLM RESPONSE (STREAM ERROR)', 'color:#e74c3c;font-weight:bold;font-size:13px;');
        console.log('%cStatus:', 'color:#888;', resp.status, resp.statusText);
        console.log('%cResponse Headers:', 'color:#888;');
        resp.headers.forEach(function(v, k) { console.log('  ' + k + ': ' + v); });
        console.log('%cError Body:', 'color:#e74c3c;', err);
        console.log('%cElapsed:', 'color:#888;', elapsed + 'ms');
        console.groupEnd();
        }
        {
          const e = new Error('API Error ' + resp.status + ': ' + err);
          e.status = resp.status;   // используется при разборе ошибки в UI
          throw e;
        }
      }

      if (this.debug) {
      console.group('%c🔽 LLM RESPONSE (STREAM START)', 'color:#00b894;font-weight:bold;font-size:13px;');
      console.log('%cStatus:', 'color:#888;', resp.status, resp.statusText);
      console.log('%cResponse Headers:', 'color:#888;');
      resp.headers.forEach(function(v, k) { console.log('  ' + k + ': ' + v); });
      console.log('%cTime to first byte:', 'color:#888;', elapsed + 'ms');
      console.groupEnd();
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      let toolCalls = [];
      let streamUsage = null;
      // finish_reason приходит в одном из последних чанков. Без него
      // обрыв ответа по max_tokens ('length') невозможно отличить от
      // нормального завершения — ответ просто выглядел неполным.
      let streamFinishReason = null;
      var chunkCount = 0;
      var rawChunks = [];

      try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        var decodedChunk = decoder.decode(value, { stream: true });
        buffer += decodedChunk;
        rawChunks.push(decodedChunk);
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;
          try {
            const json = JSON.parse(trimmed.slice(6));
            chunkCount++;
            // usage приходит отдельным финальным чанком (choices пустой)
            if (json.usage) streamUsage = json.usage;
            const fr = json.choices?.[0]?.finish_reason;
            if (fr) streamFinishReason = fr;
            const delta = json.choices?.[0]?.delta;
            if (delta?.content) {
              fullContent += delta.content;
              onChunk(delta.content);
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
                }
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
          } catch (e) { /* skip */ }
        }
      }

      } finally {
        // При прерывании (кнопка «⏹» или таймаут) выход из цикла идёт
        // через исключение, и поток оставался заблокированным читателем:
        // соединение висело до сборки мусора. Освобождаем явно.
        try { reader.releaseLock(); } catch (_) {}
        try { await resp.body.cancel(); } catch (_) {}
      }

      var totalElapsed = (performance.now() - requestTimestamp).toFixed(0);
      var result = {
        content: fullContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : null,
        usage: streamUsage,
        finish_reason: streamFinishReason,
      };

      if (this.debug) {
      console.group('%c🔽 LLM RESPONSE (STREAM COMPLETE)', 'color:#00b894;font-weight:bold;font-size:13px;');
      console.log('%cTotal chunks:', 'color:#888;', chunkCount);
      console.log('%cTotal elapsed:', 'color:#888;', totalElapsed + 'ms');
      console.log('%cContent length:', 'color:#888;', fullContent.length + ' chars');
      console.log('%cContent preview:', 'color:#888;', fullContent.substring(0, 300) + (fullContent.length > 300 ? '...' : ''));
      if (result.tool_calls) {
        console.log('%cTool Calls:', 'color:#f39c12;');
        console.dir(LogGuard.redactToolCalls(result.tool_calls));
      }
      console.log('%cFull assembled response:', 'color:#888;');
      console.dir({ ...result, tool_calls: result.tool_calls ? LogGuard.redactToolCalls(result.tool_calls) : null });
      console.groupEnd();
      }

      return result;
    }

    // ===== Non-streaming =====
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: signal,
    });

    var elapsed2 = (performance.now() - requestTimestamp).toFixed(0);

    if (!resp.ok) {
      const err = await resp.text();
      if (this.debug) {
      console.group('%c🔽❌ LLM RESPONSE (ERROR)', 'color:#e74c3c;font-weight:bold;font-size:13px;');
      console.log('%cStatus:', 'color:#888;', resp.status, resp.statusText);
      console.log('%cResponse Headers:', 'color:#888;');
      resp.headers.forEach(function(v, k) { console.log('  ' + k + ': ' + v); });
      console.log('%cError Body:', 'color:#e74c3c;', err);
      console.log('%cElapsed:', 'color:#888;', elapsed2 + 'ms');
      console.groupEnd();
      }
      {
        const e = new Error('API Error ' + resp.status + ': ' + err);
        e.status = resp.status;   // используется при разборе ошибки в UI
        throw e;
      }
    }

    const data = await resp.json();
    const choice = data.choices[0];
    var result2 = {
      content: choice.message.content || '',
      tool_calls: choice.message.tool_calls || null,
      usage: data.usage || null,
      finish_reason: choice.finish_reason || null,
    };

    if (this.debug) {
    console.group('%c🔽 LLM RESPONSE (COMPLETE)', 'color:#00b894;font-weight:bold;font-size:13px;');
    console.log('%cStatus:', 'color:#888;', resp.status, resp.statusText);
    console.log('%cResponse Headers:', 'color:#888;');
    resp.headers.forEach(function(v, k) { console.log('  ' + k + ': ' + v); });
    console.log('%cElapsed:', 'color:#888;', elapsed2 + 'ms');
    console.log('%cFull API Response:', 'color:#888;');
    console.dir(LogGuard.redactApiResponse(data));
    console.log('%cUsage:', 'color:#888;', data.usage || 'N/A');
    console.log('%cFinish reason:', 'color:#888;', choice.finish_reason);
    console.log('%cContent length:', 'color:#888;', result2.content.length + ' chars');
    console.log('%cContent:', 'color:#888;', result2.content.substring(0, 500) + (result2.content.length > 500 ? '...' : ''));
    if (result2.tool_calls) {
      console.log('%cTool Calls:', 'color:#f39c12;font-weight:bold;');
      console.dir(LogGuard.redactToolCalls(result2.tool_calls));
    }
    console.groupEnd();
    }

    return result2;
  }

  async fetchModels(apiUrl, authHeaders) {
    const url = (apiUrl || this.apiUrl).replace(/\/+$/, '');
    const headers = authHeaders || this._buildAuthHeaders();
    const endpoint = url + '/models';

    if (this.debug) {
    console.group('%c🔼 MODELS REQUEST', 'color:#6c5ce7;font-weight:bold;');
    console.log('%cEndpoint:', 'color:#888;', endpoint);
    console.log('%cMethod:', 'color:#888;', 'GET');
    console.groupEnd();
    }

    var t0 = performance.now();
    const resp = await fetch(endpoint, { headers });
    var elapsed = (performance.now() - t0).toFixed(0);

    if (!resp.ok) {
      if (this.debug) {
      console.group('%c🔽❌ MODELS RESPONSE (ERROR)', 'color:#e74c3c;font-weight:bold;');
      console.log('%cStatus:', 'color:#888;', resp.status);
      console.log('%cElapsed:', 'color:#888;', elapsed + 'ms');
      console.groupEnd();
      }
      throw new Error('Failed to fetch models: ' + resp.status);
    }

    const data = await resp.json();
    let models = [];

    if (Array.isArray(data.data)) {
      models = data.data.map(function(m) { return m.id; });
    } else if (Array.isArray(data)) {
      models = data.map(function(m) { return typeof m === 'string' ? m : m.id; });
    }

    models.sort();
    this.availableModels = models;

    if (this.debug) {
    console.group('%c🔽 MODELS RESPONSE', 'color:#00b894;font-weight:bold;');
    console.log('%cStatus:', 'color:#888;', resp.status);
    console.log('%cElapsed:', 'color:#888;', elapsed + 'ms');
    console.log('%cModels found:', 'color:#888;', models.length);
    console.log('%cFull response:', 'color:#888;');
    console.dir(data);
    console.log('%cModel list:', 'color:#888;', models);
    console.groupEnd();
    }

    return models;
  }

  async testConnection(apiUrl, authHeaders) {
    try {
      const url = (apiUrl || this.apiUrl).replace(/\/+$/, '');
      const headers = authHeaders || this._buildAuthHeaders();
      const resp = await fetch(url + '/models', { headers });
      return resp.ok;
    } catch {
      return false;
    }
  }
}