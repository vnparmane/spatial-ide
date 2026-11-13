export interface DirectoryWatcher {
  /** False when the browser has no observer or observation failed. */
  readonly active: boolean;
  dispose(): void;
}

const DEBOUNCE_MS = 250;

/**
 * Watches a real folder for external changes using the FileSystemObserver API.
 * The callback is debounced because bulk operations (git checkout, builds)
 * produce many records at once. Returns null when the API is unavailable so
 * the caller can fall back to metadata polling.
 */
export function watchDirectory(
  directory: FileSystemDirectoryHandle,
  onChange: () => void,
): DirectoryWatcher | null {
  const Observer = window.FileSystemObserver;
  if (!Observer) return null;

  let active = true;
  let disposed = false;
  let timer: number | null = null;

  const observer = new Observer((records) => {
    if (disposed || records.length === 0) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      if (!disposed) onChange();
    }, DEBOUNCE_MS);
  });

  void observer.observe(directory, { recursive: true }).catch((error) => {
    console.warn('Could not observe folder changes; using polling instead', error);
    active = false;
    observer.disconnect();
  });

  return {
    get active(): boolean {
      return active;
    },
    dispose(): void {
      disposed = true;
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      observer.disconnect();
    },
  };
}
