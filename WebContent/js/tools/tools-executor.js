// ============================================================
//  TOOLS EXECUTOR — исполнение инструмента и шлюз безопасности
// ============================================================
//
// Единственная точка, через которую проходит ЛЮБОЙ вызов инструмента,
// откуда бы он ни пришёл: от модели, из интерфейса, из другого
// инструмента. Поэтому проверки безопасности стоят здесь, а не в
// обработчиках — иначе новый инструмент легко забыть закрыть.

Object.assign(ToolsEngine.prototype, {

  // timeoutMs — ограничение на выполнение ОДНОГО вызова инструмента.
  // Нужно, потому что handlerCode пишет LLM: бесконечный цикл или зависший
  // fetch внутри него иначе повесил бы всю цепочку ответа навсегда.
  // ВАЖНО: JS не умеет прерывать уже запущенный синхронный код — таймаут
  // отпускает ожидание и возвращает ошибку, но сам handler, если он завис
  // в синхронном цикле, продолжит занимать поток. Это ограничение среды;
  // полноценное прерывание требует исполнения в Worker с terminate().
  async executeTool(toolName, args, { timeoutMs = 0, bypassSecurity = false } = {}) {
	    var parsedArgs;
	    try {
	      parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
	    } catch (e) {
	      parsedArgs = args;
	    }

	    // ── Политика безопасности ──
	    // Единая точка проверки: любой инструмент, откуда бы он ни вызывался,
	    // проходит здесь. bypassSecurity ставится только для вызовов, которые
	    // инициировал сам пользователь кнопкой интерфейса — переспрашивать
	    // о том, что человек только что нажал, бессмысленно.
	    if (this.security && !bypassSecurity) {
	      const tools0 = await this.loadTools();
	      const toolRec = tools0.find(t => t.name === toolName);
	      let verdict;
	      try {
	        verdict = await this.security.check(toolName, parsedArgs, toolRec);
	      } catch (e) {
	        verdict = { allow: true }; // сбой политики не должен ломать работу
	      }

	      if (verdict && verdict.allow === false) {
	        this.security.audit({ tool: toolName, decision: 'blocked', reason: verdict.reason });
	        return { error: 'Заблокировано политикой безопасности: ' + verdict.reason, blocked: true };
	      }

	      if (verdict && verdict.confirm) {
	        const approve = this.security.confirmFn;
	        if (typeof approve === 'function') {
	          const answer = await approve({
	            toolName,
	            category: verdict.category,
	            risks: verdict.risks || [],
	            args: parsedArgs,
	            host: verdict.host,
	          });
	          if (!answer || !answer.approved) {
	            this.security.audit({ tool: toolName, decision: 'denied', risks: verdict.risks });
	            return {
	              error: 'Операция отклонена пользователем',
	              denied: true,
	              hint: 'Пользователь не разрешил это действие. Не пытайся выполнить его обходным путём — ' +
	                    'спроси, что делать дальше.',
	            };
	          }
	          // «Больше не спрашивать про этот адрес» — только на сессию.
	          // MCP-хосты держим в отдельном списке: разрешение «звонить
	          // на этот MCP-сервер» и разрешение «сходить по этому адресу
	          // через http_fetch» — разные по смыслу решения.
	          if (answer.rememberHost && verdict.host) {
	            if (verdict.mcp) this.security.approvedMcpHosts.add(verdict.host);
	            else this.security.approvedHosts.add(verdict.host);
	          }
	          this.security.audit({ tool: toolName, decision: 'approved', risks: verdict.risks });
	        }
	      }
	      this.security._count(this.security.categoryOf(toolName, toolRec), toolName);
	    }

	    // ── Что не журналируется никогда ──
	    // Вызовы инструментов из папки «Системные» в консоль не попадают
	    // ни в каком виде: через них проходят память агента, ответы
	    // пользователя, тела артефактов и планы задач. Это не уровень
	    // подробности, который можно поднять, — см. core/log-guard.js.
	    const silent = LogGuard.isSystemTool(toolName);
	    if (this.debug && silent) LogGuard.notice();
	    const logCall = this.debug && !silent;

	    if (logCall) {
	    console.group('%c🔧 TOOL CALL', 'color:#f39c12;font-weight:bold;font-size:13px;');
	    console.log('%cTool:', 'color:#888;', toolName);
	    console.log('%cArguments:', 'color:#888;');
	    console.dir(parsedArgs);
	    console.log('%cTimestamp:', 'color:#888;', new Date().toISOString());
	    }
	    var t0 = performance.now();

	    var result;

	    // Обёртка гонки с таймаутом (см. комментарий к сигнатуре метода).
	    const withTimeout = (promise) => {
	      if (!timeoutMs || timeoutMs <= 0) return promise;
	      return Promise.race([
	        promise,
	        new Promise((resolve) => setTimeout(
	          () => resolve({ error: 'Timeout: инструмент не ответил за ' + timeoutMs + ' мс' }),
	          timeoutMs
	        )),
	      ]);
	    };

	    try {
	      const tools = await this.loadTools();
	      const tool = tools.find(function (t) { return t.name === toolName; });

	      if (!tool) {
	        result = { error: 'Tool "' + toolName + '" not found' };
	      } else if (!tool.enabled && !bypassSecurity) {
	        // Модель не получает описание выключенного инструмента в схеме
	        // (см. getEnabledToolsForAPI), но может всё равно попытаться его
	        // вызвать — по имени из истории диалога или по памяти о нём из
	        // предыдущего хода, когда он ещё был включён. Без этой проверки
	        // вызов бы тихо выполнился в обход тумблера на вкладке Tools.
	        result = { error: 'Инструмент "' + toolName + '" отключён и недоступен для вызова.' };
	      } else if (tool.handlerCode) {
	        // ← ИСТОЧНИК ИСТИНЫ: персистентный код редактируемого инструмента.
	        //   Компилируется заново на каждый вызов из актуальной записи в БД,
	        //   поэтому правки из UI применяются сразу, без перезагрузки страницы.
	        try {
	          const fn = new AsyncFunction('params', tool.handlerCode);
	          result = await withTimeout(Promise.resolve(fn(parsedArgs)));
	        } catch (e) {
	          result = { error: 'Execution error: ' + e.message };
	        }
	      } else {
	        // Нет собственного кода → нативный обработчик из реестра
	        // (встроенные инструменты и MCP).
	        const entry = this.registry.get(tool.id);
	        if (entry && entry.handler) {
	          try {
	            result = await withTimeout(Promise.resolve(entry.handler(parsedArgs)));
	          } catch (e) {
	            result = { error: e.message };
	          }
	        } else {
	          result = { error: 'No handler registered for tool "' + toolName + '"' };
	        }
	      }
	    } catch (e) {
	      result = { error: 'Tool engine error: ' + e.message };
	      // Ошибку самого движка (не хендлера) логируем всегда, без this.debug —
	      // это внутренний сбой, а не рутинный tool-вызов, полезно видеть сразу.
	      // Только имя и сообщение об ошибке: сам объект исключения у
	      // системного инструмента может нести его данные.
	      console.error('🔧 TOOL ENGINE ERROR:', toolName, silent ? e.message : e);
	    } finally {
	      var elapsed = (performance.now() - t0).toFixed(0);
	      if (logCall) {
	      if (result && result.error) {
	        console.log('%c❌ Error:', 'color:#e74c3c;');
	      } else {
	        console.log('%c✅ Result:', 'color:#00b894;');
	      }
	      console.dir(result);
	      console.log('%cElapsed:', 'color:#888;', elapsed + 'ms');
	      console.groupEnd();
	      }
	    }

	    return result;
	  },

});
