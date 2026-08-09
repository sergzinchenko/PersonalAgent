// ================================================================
//  FOLDERS ENGINE — произвольная иерархия для tools/skills/prompts
// ================================================================
class FoldersEngine {
  constructor(db) {
    this.db = db;
  }

  // Все папки конкретного раздела: 'tools' | 'skills' | 'prompts'
  async all(type) {
    const all = await this.db.getAll('folders');
    return all.filter(f => f.type === type);
  }

  async create(type, name, parentId = null) {
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
    f.name = String(name || '').trim() || f.name;
    await this.db.put('folders', f);
  }

  // Перемещение папки с защитой от циклов (нельзя вложить папку в саму себя/потомка)
  async move(id, newParentId) {
    newParentId = newParentId || null;
    if (id === newParentId) return;
    const folder = await this.db.get('folders', id);
    if (!folder) return;

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
    const parentId = folder.parentId || null;

    const subs = (await this.db.getAll('folders')).filter(f => f.parentId === id);
    for (const s of subs) { s.parentId = parentId; await this.db.put('folders', s); }

    const items = (await this.db.getAll(itemStore)).filter(it => (it.parentId || null) === id);
    for (const it of items) { it.parentId = parentId; await this.db.put(itemStore, it); }

    await this.db.delete('folders', id);
  }
}