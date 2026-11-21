// Kleine IndexedDB-Hülle: Audiodateien, Aufnahmen und Ereignis-Log bleiben lokal im Browser.
const DB_NAME = 'hypna';
const DB_VERSION = 1;
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
