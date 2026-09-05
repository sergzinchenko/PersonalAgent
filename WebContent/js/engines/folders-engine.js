// ================================================================
//  FOLDERS ENGINE — произвольная иерархия для tools/skills/prompts
// ================================================================
//
// ── Системные папки ──
// Часть папок заводит не пользователь, а само приложение: в них лежит то,
// на чём агент держится, — системные инструменты и навыки, управляющие его
// ядром. Такая папка помечена флагом `system`, и это не украшение:
//   • её нельзя переименовать, переместить и удалить;
//   • в неё нельзя ничего положить, и из неё нельзя ничего забрать.
// Иначе «системная папка» была бы просто названием: достаточно было бы
// перетащить навык наружу, чтобы снять с него все ограничения, — а
// ограничения на то и ограничения, чтобы их нельзя было обойти мышью.
//
// Запрет живёт ЗДЕСЬ, в единственной точке изменения папок, а не в
// интерфейсе: до этих же операций дотягиваются инструменты агента
// (create_folder, move_folder, delete_folder, move_item), и проверка,
// написанная только в UI, их бы не касалась.
class FoldersEngine {
  constructor(db) {
    this.db = db;
  }

  // Папки, которые приложение заводит само. Идентификаторы фиксированные:
  // по ним и код, и загрузчики встроенных инструментов/навыков находят
  // папку, не угадывая её по названию (название пользователь увидит, но
  // менять его нельзя — см. ensureSeeded).
  static SEEDED = [
    {
      id: 'folder_tools_system', type: 'tools', name: 'Системные', system: true,
      note: 'Инструменты, на которых держатся базовые механизмы агента. Выключить и переместить нельзя.',
    },
    {
      id: 'folder_skills_system', type: 'skills', name: 'Системные', system: true,
      note: 'Навыки, управляющие ядром агента: правила самомодификации и безопасности. Менять их небезопасно.',
    },
    {
      id: 'folder_skills_service', type: 'skills', name: 'Сервисные',
      note: 'Навыки, управляющие содержимым агента: порядок, объяснения, перенос и создание объектов.',
    },
    {
      id: 'folder_skills_applied', type: 'skills', name: 'Прикладные',
      note: 'Навыки для работы над задачами пользователя.',
    },
  ];

  static systemFolderId(type) {
    const f = FoldersEngine.SEEDED.find(x => x.type === type && x.system);
    return f ? f.id : null;
  }

  static isSeededId(id) {
    return FoldersEngine.SEEDED.some(f => f.id === id);
  }

  // Досеивание при запуске. Имя и флаг system выправляются на КАЖДОМ
  // запуске: запись могли завести в старой версии или испортить прямой
  // правкой базы, а от флага зависят запреты ниже.
  async ensureSeeded() {
    const all = await this.db.getAll('folders');
    const byId = new Map(all.map(f => [f.id, f]));
    let changed = 0;
    for (const def of FoldersEngine.SEEDED) {
      const cur = byId.get(def.id);
      if (!cur) {
        await this.db.put('folders', { ...def, parentId: null, createdAt: Date.now() });
        changed++;
        continue;
      }
      // Сеяные папки живут в корне своего раздела: вложенная системная
      // папка ездила бы вместе с чужой родительской, а перемещать её нельзя.
      const stale = cur.name !== def.name || !!cur.system !== !!def.system ||
        cur.note !== def.note || (cur.parentId || null) !== null;
      if (!stale) continue;
      await this.db.put('folders', { ...cur, ...def, parentId: null });
      changed++;
    }
    return changed;
  }

  async isSystem(id) {
    if (!id) return false;
    if (FoldersEngine.SEEDED.some(f => f.id === id && f.system)) return true;
    const f = await this.db.get('folders', id);
    return !!(f && f.system);
  }

  // Все папки конкретного раздела: 'tools' | 'skills' | 'prompts'
  async all(type) {
    const all = await this.db.getAll('folders');
    return all.filter(f => f.type === type);
  }

  async create(type, name, parentId = null) {
    // Подпапка внутри системной папки — это способ положить туда своё
    // содержимое в обход запрета, поэтому её тоже нельзя завести.
    if (await this.isSystem(parentId)) {
      return { error: 'Внутри системной папки нельзя создавать подпапки.' };
    }
    const folder = {
      id: 'folder_' + uid(),
      type,
      name: String(name || 'Новая папка').trim(),
      parentId: parentId || null,
      createdAt: Date.now(),
    };
    await this.db.put('folders', folder);
    return folder;
  }

  async rename(id, name) {
    const f = await this.db.get('folders', id);
    if (!f) return;
    if (f.system) return { error: 'Системную папку нельзя переименовать.' };
    f.name = String(name || '').trim() || f.name;
    await this.db.put('folders', f);
    return f;
  }

  // Перемещение папки с защитой от циклов (нельзя вложить папку в саму себя/потомка)
  async move(id, newParentId) {
    newParentId = newParentId || null;
    if (id === newParentId) return;
    const folder = await this.db.get('folders', id);
    if (!folder) return;
    if (folder.system) return { error: 'Системную папку нельзя переместить.' };
    if (await this.isSystem(newParentId)) {
      return { error: 'В системную папку нельзя ничего перемещать.' };
    }

    const all = await this.db.getAll('folders');
    let p = newParentId;
    while (p) {
      if (p === id) return; // попытка создать цикл — игнорируем
      const pf = all.find(f => f.id === p);
      p = pf ? pf.parentId : null;
    }

    folder.parentId = newParentId;
    await this.db.put('folders', folder);
  }

  // Удаление папки: содержимое (подпапки и элементы) поднимается на уровень выше
  async remove(id, itemStore) {
    const folder = await this.db.get('folders', id);
    if (!folder) return;
    if (folder.system) return { error: 'Системную папку нельзя удалить.' };
    const parentId = folder.parentId || null;

    const subs = (await this.db.getAll('folders')).filter(f => f.parentId === id);
    // Одной транзакцией вместо записи по одному элементу.
    subs.forEach(x => { x.parentId = parentId; });
    if (subs.length) await this.db.putAll('folders', subs);

    const items = (await this.db.getAll(itemStore)).filter(it => (it.parentId || null) === id);
    items.forEach(it => { it.parentId = parentId; });
    if (items.length) await this.db.putAll(itemStore, items);

    await this.db.delete('folders', id);
  }
}
