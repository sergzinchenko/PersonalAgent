// ============================================================
//  BOOTSTRAP
// ============================================================
const agent = new AIAgent();

// Раньше ошибка инициализации уходила только в консоль: пользователь видел
// пустой интерфейс без единого объяснения. Самый вероятный случай —
// неудачная миграция схемы IndexedDB (версия поднималась несколько раз) или
// недоступное хранилище: в приватном окне и при отключённых данных сайтов
// IndexedDB может не работать вовсе.
function showBootError(err) {
  const message = (err && err.message) || String(err);
  const isStorage = /indexeddb|database|quota|version|store/i.test(message);
  const esc = (t) => String(t).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  document.body.insertAdjacentHTML('beforeend', `
    <div class="boot-error">
      <div class="boot-error-card">
        <h2>Не удалось запустить приложение</h2>
        <p class="boot-error-msg">${esc(message)}</p>
        ${isStorage ? `
        <p class="boot-error-hint">
          Похоже, проблема с локальным хранилищем. Обычные причины: приватное окно,
          отключённые в браузере данные сайтов, переполненный диск или база,
          оставшаяся от несовместимой версии приложения.
        </p>
        <p class="boot-error-hint">
          Кнопка ниже удалит локальную базу и создаст её заново.
          <strong>Все чаты, инструменты, навыки и промпты будут потеряны</strong> —
          используйте её, только если запустить приложение иначе не удаётся.
        </p>
        <button id="boot-reset-db" class="boot-error-btn danger">Удалить базу и перезапустить</button>` : ''}
        <button id="boot-reload" class="boot-error-btn">Перезагрузить страницу</button>
        <p class="boot-error-hint">Подробности ошибки — в консоли браузера (F12).</p>
      </div>
    </div>`);

  document.getElementById('boot-reload')?.addEventListener('click', () => location.reload());
  document.getElementById('boot-reset-db')?.addEventListener('click', () => {
    if (!confirm('Удалить локальную базу? Все данные приложения будут потеряны безвозвратно.')) return;
    const req = indexedDB.deleteDatabase('ai_agent_db');
    req.onsuccess = () => location.reload();
    req.onerror = () => alert('Не удалось удалить базу. Закройте другие вкладки с приложением и попробуйте снова.');
    // Если база открыта в другой вкладке, удаление блокируется.
    req.onblocked = () => alert('База используется другой вкладкой — закройте её и повторите.');
  });
}

agent.init().catch(err => {
  console.error('Agent init failed:', err);
  showBootError(err);
});
