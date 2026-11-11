import type { GitStatus, Workspace } from './types';

export interface ScanProgress {
  phase: 'scanning' | 'layout' | 'done';
  files: number;
  folders: number;
}

export interface FileStat {
  /** Milliseconds since epoch, from the File lastModified field. */
  mtime: number;
  size: number;
}

export interface WorkspaceProvider {
  readonly name: string;
  load(onProgress?: (progress: ScanProgress) => void): Promise<Workspace>;
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  /** Optional change detection; null means the file is missing. */
  stat?(path: string): Promise<FileStat | null>;
  /** Optional exact git status for a buffer; null when git is unavailable. */
  gitStatus?(path: string, content: string): Promise<GitStatus | null>;
  /** Optional file mutation APIs for real folders. */
  createFile?(path: string, content?: string): Promise<void>;
  deleteFile?(path: string): Promise<void>;
  renameFile?(from: string, to: string): Promise<void>;
}
