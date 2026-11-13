interface FileSystemDirectoryHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  keys(): AsyncIterableIterator<string>;
  values(): AsyncIterableIterator<FileSystemHandle>;
}

type FileSystemChangeType =
  | 'appeared'
  | 'disappeared'
  | 'modified'
  | 'moved'
  | 'unknown'
  | 'errored';

interface FileSystemChangeRecord {
  readonly changedHandle: FileSystemHandle;
  readonly relativePathComponents: readonly string[];
  readonly type: FileSystemChangeType;
}

interface FileSystemObserver {
  observe(target: FileSystemHandle, options?: { recursive?: boolean }): Promise<void>;
  disconnect(): void;
}

interface FileSystemObserverConstructor {
  new (
    callback: (
      records: readonly FileSystemChangeRecord[],
      observer: FileSystemObserver,
    ) => void,
  ): FileSystemObserver;
}

interface Window {
  showDirectoryPicker(options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: FileSystemHandle | string;
  }): Promise<FileSystemDirectoryHandle>;
  FileSystemObserver?: FileSystemObserverConstructor;
}
