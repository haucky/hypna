// IndexedDB: Nachfragen-Audios, Aufnahme-Abschnitte (Absturzsicherung), fertige Aufnahmen, Log.
// Alles bleibt lokal im Browser.
const DB_NAME = 'hypna';
const DB_VERSION = 2;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
        if (!d.objectStoreNames.contains('recordings'))
          d.createObjectStore('recordings', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('events'))
          d.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('chunks')) {
          const s = d.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
          s.createIndex('session', 'session');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const putFile = (key, value) => run('files', 'readwrite', (s) => s.put(value, key));
export const getFile = (key) => run('files', 'readonly', (s) => s.get(key));
export const deleteFile = (key) => run('files', 'readwrite', (s) => s.delete(key));

export const addRecording = (rec) => run('recordings', 'readwrite', (s) => s.add(rec));
export const listRecordings = () => run('recordings', 'readonly', (s) => s.getAll());
export const deleteRecording = (id) => run('recordings', 'readwrite', (s) => s.delete(id));

export const addEvent = (ev) => run('events', 'readwrite', (s) => s.add(ev));
export const listEvents = () => run('events', 'readonly', (s) => s.getAll());
export const clearEvents = () => run('events', 'readwrite', (s) => s.clear());

export const addChunk = (c) => run('chunks', 'readwrite', (s) => s.add(c));
export const listChunks = (session) =>
  run('chunks', 'readonly', (s) => s.index('session').getAll(session));
// Alle Sessions, von denen noch unverarbeitete Abschnitte da sind (ohne die Audiodaten zu laden)
export async function listAllChunkSessions() {
  const d = await open();
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = d.transaction('chunks', 'readonly');
    const req = tx.objectStore('chunks').index('session').openKeyCursor(null, 'nextunique');
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        out.push(c.key);
        c.continue();
      }
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}
export async function deleteChunks(session) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('chunks', 'readwrite');
    const idx = tx.objectStore('chunks').index('session');
    const req = idx.openCursor(IDBKeyRange.only(session));
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        c.delete();
        c.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
