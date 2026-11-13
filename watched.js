import { readFile, writeFile, rename } from 'node:fs/promises';

// Keep discoveries per Jellyfin user, with separate identities for films and series.
export async function openWatchedStore(file) {
  let data = {};
  try {
    data = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let pending = Promise.resolve();
  return {
    has(userId, kind, id) {
      return data[userId]?.includes(`${kind}:${id}`) || false;
    },
    set(userId, kind, id, watched) {
      const save = pending.then(async () => {
        const keys = new Set(data[userId] || []);
        const key = `${kind}:${id}`;
        if (watched) keys.add(key);
        else keys.delete(key);
        const next = { ...data, [userId]: [...keys] };
        const temporary = file instanceof URL ? new URL(`${file.href}.tmp`) : `${file}.tmp`;
        await writeFile(temporary, JSON.stringify(next));
        await rename(temporary, file);
        data = next;
      });
      pending = save.catch(() => {});
      return save;
    },
  };
}
