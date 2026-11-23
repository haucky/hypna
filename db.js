// IndexedDB: Nachfragen-Audios, Stimmprobe, Aufnahme-Abschnitte (Absturzsicherung),
// fertige Aufnahmen, Log. Alles bleibt lokal im Browser.
//
// Android-Chrome schließt Datenbankverbindungen, wenn die App im Hintergrund war
// oder eingefroren wurde. Deshalb wird die Verbindung bei Bedarf neu geöffnet.
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
      req.onsuccess = () => {
        const d = req.result;
        // Vom Browser geschlossen: beim nächsten Zugriff neu verbinden
        d.onclose = () => { if (dbPromise && dbPromise._db === d) dbPromise = null; };
        d.onversionchange = () => {
          d.close();
          if (dbPromise && dbPromise._db === d) dbPromise = null;
        };
        dbPromise._db = d;
        resolve(d);
      };
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
      req.onblocked = () => console.warn('[hypna] Datenbank blockiert – ist die App in einem anderen Tab offen?');
    });
  }
  return dbPromise;
}

// Transaktion öffnen; ist die Verbindung inzwischen zu, einmal neu verbinden.
async function transaction(stores, mode) {
  for (let attempt = 0; ; attempt++) {
    const d = await open();
    try {
      return d.transaction(stores, mode);
    } catch (e) {
      if (attempt === 0 && e && e.name === 'InvalidStateError') {
        dbPromise = null;
        continue;
      }
      throw e;
    }
  }
}

async function run(store, mode, fn) {
  const tx = await transaction(store, mode);
  return new Promise((resolve, reject) => {
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
  const tx = await transaction('chunks', 'readonly');
  return new Promise((resolve, reject) => {
    const out = [];
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
  const tx = await transaction('chunks', 'readwrite');
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('chunks').index('session').openCursor(IDBKeyRange.only(session));
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

// Nur für Tests: Verbindung schließen, ohne es dem Modul zu sagen (wie Android es tut)
export async function _simulateBrowserClose() {
  const d = await open();
  d.close();
}
