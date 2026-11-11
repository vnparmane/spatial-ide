import type { FileStat } from '../workspace/provider';

export interface PersistedDraft {
  text: string;
  /** Disk text the draft was based on, for accurate dirty/conflict checks. */
  baseText: string;
  baseStat: FileStat | null;
}

export interface DraftPersistence {
  load(): Promise<Map<string, PersistedDraft>>;
  save(path: string, draft: PersistedDraft): void;
  remove(path: string): void;
  /** Writes any debounced changes immediately. */
  flush(): Promise<void>;
}

interface DraftRecord extends PersistedDraft {
  path: string;
  updatedAt: number;
}

const DB_NAME = 'spatial-ide-drafts';
const DB_VERSION = 1;
const STORE_NAME = 'drafts';
const WRITE_DELAY_MS = 300;

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
    request.onerror = () => reject(request.error ?? new Error('Draft storage unavailable'));
  });
}

function keyFor(workspace: string, path: string): string {
  return `${workspace}\u0000${path}`;
}

/**
 * Unsaved editor buffers keyed by workspace root and file path. Writes are
 * debounced while typing and flushed when the editor closes or the page hides.
 */
export class DraftStore implements DraftPersistence {
  private readonly workspace: string;
  private readonly pending = new Map<string, PersistedDraft | null>();
  private timer: number | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  async load(): Promise<Map<string, PersistedDraft>> {
    const drafts = new Map<string, PersistedDraft>();
    try {
      await this.flush();
      const db = await openDatabase();
      const prefix = `${this.workspace}\u0000`;
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);

      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).openCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          const record = cursor.value as DraftRecord;
          if (record.path && typeof record.text === 'string') {
            drafts.set(record.path, {
              text: record.text,
              baseText: record.baseText ?? '',
              baseStat: record.baseStat ?? null,
            });
          }
          cursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error('Failed to read drafts'));
        tx.onerror = () => reject(tx.error ?? new Error('Draft read transaction failed'));
      });
      db.close();
    } catch (error) {
      console.warn('Could not load drafts', error);
    }
    return drafts;
  }

  save(path: string, draft: PersistedDraft): void {
    this.pending.set(path, draft);
    this.schedule();
  }

  remove(path: string): void {
    this.pending.set(path, null);
    this.schedule();
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return this.writing;

    const entries = [...this.pending];
    this.pending.clear();
    this.writing = this.writing
      .then(() => this.writeEntries(entries))
      .catch((error) => {
        console.warn('Could not persist drafts', error);
      });
    return this.writing;
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, WRITE_DELAY_MS);
  }

  private async writeEntries(entries: Array<[string, PersistedDraft | null]>): Promise<void> {
    const db = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const [path, draft] of entries) {
          const key = keyFor(this.workspace, path);
          if (draft) {
            const record: DraftRecord = {
              path,
              text: draft.text,
              baseText: draft.baseText,
              baseStat: draft.baseStat,
              updatedAt: Date.now(),
            };
            store.put(record, key);
          } else {
            store.delete(key);
          }
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Draft write transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('Draft write transaction aborted'));
      });
    } finally {
      db.close();
    }
  }
}
