import type { AudioMeta } from '../types.ts';

const DB_NAME = 'sarpay_studio_audio_db';
const DB_VERSION = 1;
const STORE_NAME = 'audio_clips';

export interface StoredAudioRecord {
  id: string;
  blob: Blob;
  meta: AudioMeta;
  savedAt: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openAudioDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this browser.'));
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error ?? new Error('Failed to open local audio database.'));
      };
    });
  }

  return dbPromise;
}

export async function saveAudioClip(id: string, blob: Blob, meta: AudioMeta): Promise<void> {
  try {
    const db = await openAudioDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record: StoredAudioRecord = {
        id,
        blob,
        meta,
        savedAt: new Date().toISOString(),
      };
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to save audio clip locally.'));
    });
  } catch (err) {
    console.warn('Could not persist audio clip to IndexedDB:', err);
  }
}

export async function getAudioClip(id: string): Promise<StoredAudioRecord | null> {
  try {
    const db = await openAudioDb();
    return await new Promise<StoredAudioRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve((req.result as StoredAudioRecord | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('Failed to read audio clip.'));
    });
  } catch (err) {
    console.warn('Could not read audio clip from IndexedDB:', err);
    return null;
  }
}

export async function deleteAudioClip(id: string): Promise<void> {
  try {
    const db = await openAudioDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to delete audio clip.'));
    });
  } catch (err) {
    console.warn('Could not delete audio clip from IndexedDB:', err);
  }
}

export async function deleteAudioClips(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const db = await openAudioDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const id of ids) {
        store.delete(id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to delete audio clips.'));
    });
  } catch (err) {
    console.warn('Could not delete audio clips from IndexedDB:', err);
  }
}
