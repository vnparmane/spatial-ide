const DB_NAME = 'spatial-ide';
const DB_VERSION = 1;
const STORE_NAME = 'directory-handles';
const HANDLE_KEY = 'workspace';

interface PermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface PermissionCapableHandle extends FileSystemDirectoryHandle {
  queryPermission(descriptor?: PermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: PermissionDescriptor): Promise<PermissionState>;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'));
  });
}

export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to store folder handle'));
      tx.onabort = () => reject(tx.error ?? new Error('Folder handle transaction aborted'));
    });
    db.close();
  } catch (error) {
    console.warn('Could not persist folder handle', error);
  }
}

export async function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDatabase();
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(HANDLE_KEY);
      request.onsuccess = () =>
        resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('Failed to read folder handle'));
    });
    db.close();
    return handle;
  } catch (error) {
    console.warn('Could not load folder handle', error);
    return null;
  }
}

export async function clearDirectoryHandle(): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to clear folder handle'));
    });
    db.close();
  } catch (error) {
    console.warn('Could not clear folder handle', error);
  }
}

/** Current read/write permission without prompting. */
export async function directoryPermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  try {
    return await (handle as PermissionCapableHandle).queryPermission({ mode: 'readwrite' });
  } catch {
    return 'prompt';
  }
}

/** Requests permission; must be called from a user gesture. */
export async function requestDirectoryPermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  try {
    const capable = handle as PermissionCapableHandle;
    if ((await capable.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await capable.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}
