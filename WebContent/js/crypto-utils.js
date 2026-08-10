// ============================================================
//  SECRETS VAULT — шифрование секретов (API-ключи, MCP-токены)
//  перед сохранением в IndexedDB, через Web Crypto API (AES-GCM).
// ============================================================
//
// ЧЕСТНО О МОДЕЛИ УГРОЗ И ЕЁ ГРАНИЦАХ:
// Это клиентское приложение без бэкенда. Секреты, которыми оно
// пользуется само (чтобы сформировать заголовок Authorization), в
// принципе не могут быть скрыты от кода, выполняющегося в этой же
// вкладке — то есть от XSS. Любой JS на странице может вызвать
// SecretsVault.decrypt() точно так же, как это делает сам агент.
//
// Что эта защита ДЕЙСТВИТЕЛЬНО даёт:
//  - секреты не лежат plaintext-строкой в самой IndexedDB — просмотр
//    базы через DevTools, браузерное расширение или файл бэкапа
//    профиля не раскрывает их напрямую;
//  - ключ шифрования хранится как non-extractable CryptoKey — его
//    нельзя экспортировать в сырые байты даже кодом на странице,
//    только использовать через subtle.encrypt/decrypt.
//
// Чего эта защита НЕ даёт:
//  - защиты от XSS в этом же origin (см. выше — поэтому исправление
//    XSS в markdown.js остаётся важнее этого шага);
//  - защиты, если у атакующего уже есть произвольный доступ к тому же
//    origin (IndexedDB одного источника открыта для всего JS на нём).
//
// Для защиты секретов от кода в собственной вкладке нужен сервер,
// который сам делает вызовы к LLM/MCP API, а фронтенду отдаёт только
// результат — секреты тогда вообще не попадают в браузер.

const SecretsVault = (() => {
  let keyPromise = null;

  // Ключ генерируется один раз и хранится в IndexedDB как сам объект
  // CryptoKey (non-extractable) — это стандартно поддерживается
  // структурным клонированием IndexedDB и не требует хранить сырые
  // байты ключа нигде в БД.
  async function _getKey(db) {
    if (keyPromise) return keyPromise;
    keyPromise = (async () => {
      const rec = await db.get('settings', '__vault_key');
      if (rec && rec.cryptoKey) return rec.cryptoKey;

      const cryptoKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false, // non-extractable — нельзя экспортировать в сырые байты
        ['encrypt', 'decrypt']
      );
      await db.put('settings', { key: '__vault_key', cryptoKey });
      return cryptoKey;
    })();
    return keyPromise;
  }

  // Возвращает null для пустого/отсутствующего значения (не шифруем "ничего"),
  // иначе { __enc:true, iv:[...], data:[...] } — сериализуемый в IndexedDB объект.
  async function encrypt(db, plainText) {
    if (!plainText) return null;
    try {
      const key = await _getKey(db);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoded = new TextEncoder().encode(String(plainText));
      const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
      return { __enc: true, iv: Array.from(iv), data: Array.from(new Uint8Array(cipher)) };
    } catch (e) {
      console.error('SecretsVault.encrypt: не удалось зашифровать секрет', e);
      return null;
    }
  }

  // Принимает как новый формат ({__enc:true,...}), так и старые обычные
  // строки (значения, сохранённые ДО внедрения шифрования) — для плавной
  // миграции без потери уже введённых пользователем ключей. Такие
  // значения будут перезашифрованы при следующем сохранении настроек.
  async function decrypt(db, value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (!value.__enc) return '';
    try {
      const key = await _getKey(db);
      const iv = new Uint8Array(value.iv);
      const data = new Uint8Array(value.data);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
      return new TextDecoder().decode(plain);
    } catch (e) {
      console.error('SecretsVault.decrypt: не удалось расшифровать секрет', e);
      return '';
    }
  }

  return { encrypt, decrypt };
})();
