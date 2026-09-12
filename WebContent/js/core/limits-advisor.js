// ============================================================
//  LIMITS ADVISOR — проверка ограничений на непротиворечивость
// ============================================================
//
// ЗАЧЕМ. Ограничений в настройках девять, и каждое по отдельности
// понятно. Вместе они образуют систему, где значения ЗАВИСЯТ друг от
// друга, и эта зависимость нигде не написана: таймаут одного вызова
// больше бюджета всего хода означает, что бюджет не сработает ни разу;
// потолок вызовов меньше потолка шагов означает, что до второго никогда
// не дойдёт; порог артефакта выше предела ответа инструмента означает,
// что артефакты не заведутся вовсе. Каждое из этих сочетаний выглядит
// как «настроено», а ведёт себя как «сломано» — и разбираться в этом
// пользователю приходилось по симптомам.
//
// ЧТО ЗДЕСЬ. Чистая функция: на входе ограничения и (если известна)
// модель, на выходе — список замечаний. У каждого есть уровень, причина
// человеческим языком и, где это осмысленно, КОНКРЕТНОЕ рекомендуемое
// значение — чтобы совет можно было применить кнопкой, а не переводить
// с языка советов на язык полей.
//
// ГРАНИЦА. Здесь нет ни DOM, ни базы, ни сети: только арифметика и
// правила. Поэтому это ядро (js/core), а не часть настроек, и поэтому
// же правила проверяются тестами без всякого интерфейса.
class LimitsAdvisor {

  // level: 'error'   — сочетание, при котором что-то заведомо не работает;
  //        'warn'    — работает, но предсказуемо плохо;
  //        'info'    — не ошибка, но стоит знать.
  // fix:   { field, value } — поле настроек и рекомендуемое значение.
  static analyze(limits = {}, model = null) {
    const out = [];
    const L = {
      maxToolSteps: LimitsAdvisor._num(limits.maxToolSteps),
      maxTurnSeconds: LimitsAdvisor._num(limits.maxTurnSeconds),
      toolTimeoutSeconds: LimitsAdvisor._num(limits.toolTimeoutSeconds),
      maxToolCallsPerTurn: LimitsAdvisor._num(limits.maxToolCallsPerTurn),
      maxToolResponseChars: LimitsAdvisor._num(limits.maxToolResponseChars),
      artifactThresholdChars: LimitsAdvisor._num(limits.artifactThresholdChars),
      subtaskMaxSteps: LimitsAdvisor._num(limits.subtaskMaxSteps),
      contextCompaction: limits.contextCompaction !== false,
    };
    const ctx = model ? LimitsAdvisor._num(model.contextWindow) : 0;
    const maxTokens = model ? LimitsAdvisor._num(model.maxTokens) : 0;

    // ── Время ──
    if (L.toolTimeoutSeconds > 0 && L.maxTurnSeconds > 0 &&
        L.toolTimeoutSeconds > L.maxTurnSeconds) {
      out.push({
        level: 'error',
        title: 'Таймаут вызова больше бюджета всего ответа',
        why: `Один зависший инструмент ждут ${L.toolTimeoutSeconds} с, а на весь ответ отведено ` +
             `${L.maxTurnSeconds} с. Бюджет хода оборвёт работу раньше, чем сработает таймаут, ` +
             'и вызов так и не вернёт понятной ошибки — ответ просто прервётся.',
        fix: { field: 'toolTimeoutSeconds', value: Math.max(5, Math.floor(L.maxTurnSeconds / 3)) },
      });
    } else if (L.toolTimeoutSeconds > 0 && L.maxTurnSeconds > 0 &&
               L.toolTimeoutSeconds > L.maxTurnSeconds / 2) {
      out.push({
        level: 'warn',
        title: 'Одного зависшего вызова хватит, чтобы съесть ход',
        why: `Таймаут вызова (${L.toolTimeoutSeconds} с) — больше половины бюджета ответа ` +
             `(${L.maxTurnSeconds} с). Два таких вызова подряд, и на работу времени не осталось.`,
        fix: { field: 'toolTimeoutSeconds', value: Math.max(5, Math.floor(L.maxTurnSeconds / 3)) },
      });
    }

    // ── Шаги и вызовы ──
    // Шаг — это одно обращение к модели, вызовов в нём может быть
    // несколько. Значит, потолок вызовов не может быть меньше потолка
    // шагов: до последних шагов дело не дойдёт никогда.
    if (L.maxToolSteps > 0 && L.maxToolCallsPerTurn > 0 &&
        L.maxToolCallsPerTurn < L.maxToolSteps) {
      out.push({
        level: 'error',
        title: 'Потолок вызовов ниже потолка шагов',
        why: `За ${L.maxToolSteps} шагов будет как минимум столько же вызовов, а разрешено ` +
             `${L.maxToolCallsPerTurn}. Работа всегда будет обрываться по вызовам, а настройка ` +
             'шагов не сработает ни разу.',
        fix: { field: 'maxToolCallsPerTurn', value: Math.max(L.maxToolSteps * 2, 10) },
      });
    }

    if (L.maxToolSteps === 0 && L.maxTurnSeconds === 0 && L.maxToolCallsPerTurn === 0) {
      out.push({
        level: 'error',
        title: 'Зациклившуюся работу нечем остановить',
        why: 'Сняты сразу все три ограничения хода: шаги, время и вызовы. Модель, ушедшая ' +
             'в цикл «вызвал — не получилось — вызвал снова», будет работать, пока её не ' +
             'остановят вручную, и потратит столько запросов к провайдеру, сколько успеет.',
        fix: { field: 'maxToolSteps', value: 25 },
      });
    }

    // ── Подзадача ──
    // Подзадача — часть хода. Если её потолок не меньше общего, одна
    // такая часть занимает весь ход, и смысл разделения пропадает.
    if (L.subtaskMaxSteps > 0 && L.maxToolSteps > 0 && L.subtaskMaxSteps >= L.maxToolSteps) {
      out.push({
        level: 'warn',
        title: 'Подзадаче разрешено столько же шагов, сколько всему ходу',
        why: `Подзадача — часть работы (${L.subtaskMaxSteps} шагов), а на весь ход отведено ` +
             `${L.maxToolSteps}. Одна подзадача может занять ход целиком, и на остальное ` +
             'ничего не останется.',
        fix: { field: 'subtaskMaxSteps', value: Math.max(3, Math.floor(L.maxToolSteps / 2)) },
      });
    }

    // ── Ответы инструментов и артефакты ──
    // Ответ сначала обрезается по пределу, и только потом решается,
    // выносить ли его в артефакт. Порог выше предела означает, что до
    // выноса дело не доходит никогда.
    if (L.artifactThresholdChars > 0 && L.maxToolResponseChars > 0 &&
        L.artifactThresholdChars >= L.maxToolResponseChars) {
      out.push({
        level: 'error',
        title: 'Артефакты не заведутся',
        why: `Ответ инструмента обрезается на ${L.maxToolResponseChars} символах, а выносится ` +
             `в артефакт начиная с ${L.artifactThresholdChars}. Порог недостижим: крупные ответы ` +
             'будут просто обрезаться, а не сохраняться целиком.',
        fix: { field: 'artifactThresholdChars', value: Math.max(500, Math.floor(L.maxToolResponseChars / 4)) },
      });
    }

    if (L.artifactThresholdChars === 0) {
      out.push({
        level: 'warn',
        title: 'Крупные ответы идут в переписку целиком',
        why: 'Вынос в артефакт выключен. Один большой ответ инструмента останется в контексте ' +
             'до конца чата и будет уезжать в КАЖДЫЙ следующий запрос.',
        fix: { field: 'artifactThresholdChars', value: 2000 },
      });
    }

    // ── Связь с окном контекста модели ──
    if (ctx > 0) {
      // Символы в токены — грубо, 1 токен ≈ 4 символа для латиницы и
      // ≈ 2 для кириллицы. Берём осторожную оценку в 3.
      const respTokens = Math.round(L.maxToolResponseChars / 3);
      if (L.maxToolResponseChars > 0 && respTokens > ctx * 0.25) {
        out.push({
          level: 'warn',
          title: 'Один ответ инструмента может занять четверть окна',
          why: `${L.maxToolResponseChars} символов — это примерно ${respTokens} токенов при окне ` +
               `${ctx}. Пары таких ответов хватит, чтобы вытеснить из контекста разговор.`,
          fix: { field: 'maxToolResponseChars', value: Math.max(2000, Math.round(ctx * 0.15 * 3 / 500) * 500) },
        });
      }

      if (maxTokens > 0 && maxTokens >= ctx) {
        out.push({
          level: 'error',
          title: 'max_tokens не меньше окна контекста',
          why: `Модели разрешено ответить на ${maxTokens} токенов при окне ${ctx}. Окно — это ` +
               'ВЕСЬ запрос вместе с ответом, поэтому на историю не остаётся ничего, а многие ' +
               'провайдеры отвечают на такой запрос ошибкой.',
          fix: { field: 'model.maxTokens', value: Math.max(512, Math.floor(ctx / 4)) },
        });
      } else if (maxTokens > 0 && maxTokens > ctx * 0.5) {
        out.push({
          level: 'warn',
          title: 'Под ответ зарезервировано больше половины окна',
          why: `max_tokens = ${maxTokens} при окне ${ctx}. Столько же места вычитается из бюджета ` +
               'истории при подрезке — переписка начнёт обрезаться заметно раньше, чем могла бы.',
          fix: { field: 'model.maxTokens', value: Math.max(512, Math.floor(ctx / 4)) },
        });
      }
    } else if (model) {
      out.push({
        level: 'warn',
        title: 'Окно контекста модели неизвестно',
        why: 'Пока оно не задано, подрезать историю не по чему: в запрос уходит вся переписка, ' +
             'и при переполнении провайдер отвечает ошибкой вместо ответа. Индикатор заполнения ' +
             'тоже не работает.',
        fix: { field: 'model.contextWindow', value: 0, action: 'detect' },
      });
    }

    if (!L.contextCompaction) {
      out.push({
        level: 'info',
        title: 'Начало переписки теряется без резюме',
        why: 'Сворачивание выключено: вытесненная часть разговора просто перестаёт передаваться ' +
             'модели. На длинной задаче это выглядит как забывчивость агента.',
        fix: { field: 'contextCompaction', value: true },
      });
    }

    return out;
  }

  // Рекомендованный набор целиком — то, что применяет кнопка «исправить».
  // Собирается из тех же замечаний: второго набора правил, способного
  // разойтись с первым, здесь быть не должно.
  static recommend(limits, model) {
    const patch = {};
    for (const f of LimitsAdvisor.analyze(limits, model)) {
      if (!f.fix || f.fix.action === 'detect') continue;
      if (String(f.fix.field).startsWith('model.')) continue;   // это поле карточки модели
      patch[f.fix.field] = f.fix.value;
    }
    return patch;
  }

  // Положительное целое или 0. Статический метод, а не функция файла:
  // в продакшен-сборке все файлы склеиваются в один, и имя вроде num
  // рано или поздно столкнулось бы с чужим.
  static _num(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Насколько всё в порядке — одной строкой для заголовка раздела.
  static verdict(findings) {
    if (findings.some(f => f.level === 'error')) return 'error';
    if (findings.some(f => f.level === 'warn')) return 'warn';
    return 'ok';
  }
}
