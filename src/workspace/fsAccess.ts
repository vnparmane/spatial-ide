import { layoutWorkspace } from '../scene/layout';
import { groupColor } from '../util/color';
import { clamp } from '../util/math';
import {
  applyGitStatus,
  gitStatusForContent,
  readGitIndex,
  type GitIndexEntry,
} from './gitStatus';
import type { ScanProgress, WorkspaceProvider } from './provider';
import type { GitStatus, Group, Language, Panel, Workspace } from './types';

const MAX_FILES = 5000;
const MAX_FILE_SIZE = 2 * 1024 * 1024;

const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'Pods',
  'DerivedData',
]);

const TEXT_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'css',
  'scss',
  'sass',
  'less',
  'json',
  'jsonc',
  'md',
  'mdx',
  'txt',
  'rs',
  'py',
  'go',
  'java',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'kt',
  'kts',
  'html',
  'htm',
  'xml',
  'svg',
  'vue',
  'svelte',
  'astro',
  'toml',
  'yaml',
  'yml',
  'ini',
  'cfg',
  'conf',
  'sql',
  'graphql',
  'gql',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'dockerfile',
  'makefile',
  'gitignore',
  'env',
  'editorconfig',
  'prettierrc',
  'eslintrc',
]);

const EXTENSION_LANGUAGE: Record<string, Language> = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  json: 'json',
  jsonc: 'json',
  md: 'md',
  mdx: 'md',
  rs: 'rust',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  astro: 'html',
  svg: 'html',
  xml: 'html',
};

const BASE_NAMES = new Set([
  'dockerfile',
  'makefile',
  'license',
  'readme',
  'changelog',
  'contributing',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.prettierrc',
  '.eslintrc',
  '.env',
]);

interface ScannedFile {
  path: string;
  name: string;
  directory: string;
  size: number;
  mtime: number;
  language: Language;
  handle: FileSystemFileHandle;
}

function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot <= 0 || dot === lower.length - 1) return lower;
  return lower.slice(dot + 1);
}

function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === '.ds_store') return false;
  if (BASE_NAMES.has(lower)) return true;
  return TEXT_EXTENSIONS.has(extensionOf(name));
}

function languageForFile(name: string): Language {
  return EXTENSION_LANGUAGE[extensionOf(name)] ?? 'other';
}

function estimatedPanelSize(size: number): { width: number; height: number; lines: number } {
  const lines = Math.max(12, Math.round(size / 34));
  const width = clamp(150 + Math.sqrt(lines) * 8.5, 170, 400);
  const height = clamp(width * 0.62, 120, 250);
  return { width: Math.round(width), height: Math.round(height), lines };
}

async function scanFiles(
  root: FileSystemDirectoryHandle,
  onProgress?: (progress: ScanProgress) => void,
): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  const stack: Array<{ handle: FileSystemDirectoryHandle; path: string }> = [
    { handle: root, path: '' },
  ];
  let folders = 0;
  let lastReport = 0;

  while (stack.length > 0 && files.length < MAX_FILES) {
    const current = stack.pop();
    if (!current) break;
    folders += 1;

    for await (const [name, entry] of current.handle.entries()) {
      if (files.length >= MAX_FILES) break;

      if (entry.kind === 'directory') {
        if (IGNORED_DIRS.has(name) || name.startsWith('.')) continue;
        stack.push({
          handle: entry as FileSystemDirectoryHandle,
          path: current.path ? `${current.path}/${name}` : name,
        });
        continue;
      }

      if (!isTextFile(name)) continue;

      try {
        const handle = entry as FileSystemFileHandle;
        const file = await handle.getFile();
        if (file.size > MAX_FILE_SIZE) continue;
        files.push({
          path: current.path ? `${current.path}/${name}` : name,
          name,
          directory: current.path || '.',
          size: file.size,
          mtime: file.lastModified,
          language: languageForFile(name),
          handle,
        });
      } catch (error) {
        console.warn(`Skipping unreadable file: ${name}`, error);
      }

      if (files.length - lastReport >= 50) {
        lastReport = files.length;
        onProgress?.({ phase: 'scanning', files: files.length, folders });
      }
    }

    onProgress?.({ phase: 'scanning', files: files.length, folders });
  }

  return files;
}

/** Order-independent metadata fingerprint used to detect external changes. */
function signatureOf(files: readonly ScannedFile[]): string {
  let hash = 0x811c9dc5;
  for (const file of files) {
    for (let i = 0; i < file.path.length; i += 1) {
      hash ^= file.path.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= file.size;
    hash = Math.imul(hash, 0x01000193);
    hash ^= file.mtime >>> 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${files.length}:${hash >>> 0}`;
}

export class FsAccessProvider implements WorkspaceProvider {
  readonly name: string;
  private readonly root: FileSystemDirectoryHandle;
  private readonly handles = new Map<string, FileSystemFileHandle>();
  private gitIndex: Map<string, GitIndexEntry> | null = null;
  private hasGit = false;
  private loadedSignature = '';

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
    this.name = root.name;
  }

  get directory(): FileSystemDirectoryHandle {
    return this.root;
  }

  static async pick(): Promise<FsAccessProvider | null> {
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('This browser cannot open folders. Use Chrome or Edge on Windows.');
    }
    const handle = await window.showDirectoryPicker({
      id: 'spatial-ide',
      mode: 'readwrite',
    });
    return new FsAccessProvider(handle);
  }

  async load(onProgress?: (progress: ScanProgress) => void): Promise<Workspace> {
    onProgress?.({ phase: 'scanning', files: 0, folders: 0 });
    const [scanned, index] = await Promise.all([
      scanFiles(this.root, onProgress),
      readGitIndex(this.root),
    ]);
    if (scanned.length === 0) {
      throw new Error('No supported text files were found in this folder.');
    }

    this.gitIndex = index;
    this.hasGit = index !== null;

    scanned.sort((a, b) => a.path.localeCompare(b.path));
    this.loadedSignature = signatureOf(scanned);

    const groupsByPath = new Map<string, Group>();
    const panels: Panel[] = [];
    const groupList: Group[] = [];

    const getGroup = (directory: string): Group => {
      const existing = groupsByPath.get(directory);
      if (existing) return existing;
      const name = directory === '.' ? this.root.name : (directory.split('/').pop() ?? directory);
      const group: Group = {
        id: groupList.length,
        name,
        path: directory,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        panelIds: [],
        color: groupColor(directory),
      };
      groupsByPath.set(directory, group);
      groupList.push(group);
      return group;
    };

    for (const file of scanned) {
      const group = getGroup(file.directory);
      const size = estimatedPanelSize(file.size);
      const panel: Panel = {
        id: panels.length,
        docId: file.path,
        path: file.path,
        name: file.name,
        language: file.language,
        x: 0,
        y: 0,
        w: size.width,
        h: size.height,
        groupId: group.id,
        lines: size.lines,
        git: 'clean',
        dirty: false,
      };
      panels.push(panel);
      group.panelIds.push(panel.id);
      this.handles.set(file.path, file.handle);
    }

    if (index) {
      const meta = new Map(
        scanned.map((file) => [file.path, { size: file.size, mtime: file.mtime }]),
      );
      applyGitStatus(panels, meta, index);
    }

    onProgress?.({ phase: 'layout', files: panels.length, folders: groupList.length });
    const bounds = layoutWorkspace(panels, groupList);

    return {
      rootPath: this.root.name,
      panels,
      groups: groupList,
      bounds,
    };
  }

  /**
   * Walks metadata only (no file contents) to detect files added, removed, or
   * changed since the last load. Used for quiet sync when the window regains
   * focus.
   */
  async changedSinceLoad(): Promise<boolean> {
    if (!this.loadedSignature) return true;
    const files = await scanFiles(this.root);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return signatureOf(files) !== this.loadedSignature;
  }

  async stat(path: string): Promise<{ mtime: number; size: number } | null> {
    const handle = this.handles.get(path);
    if (!handle) return null;
    try {
      const file = await handle.getFile();
      return { mtime: file.lastModified, size: file.size };
    } catch {
      return null;
    }
  }

  /**
   * Exact git status for an in-memory buffer. Re-reads the index so external
   * commits are reflected; null means git status is unavailable.
   */
  async gitStatus(path: string, content: string): Promise<GitStatus | null> {
    if (!this.hasGit) return null;
    const index = (await readGitIndex(this.root)) ?? this.gitIndex;
    if (!index) return null;
    this.gitIndex = index;
    return gitStatusForContent(index, path, content);
  }

  async readText(path: string): Promise<string | null> {
    const handle = this.handles.get(path);
    if (!handle) return null;
    const file = await handle.getFile();
    return file.text();
  }

  async writeText(path: string, content: string): Promise<void> {
    const handle = this.handles.get(path);
    if (!handle) throw new Error(`Unknown file: ${path}`);
    const writable = await handle.createWritable();
    try {
      await writable.write(content);
    } finally {
      await writable.close();
    }
  }

  async createFile(path: string, content = ''): Promise<void> {
    const { directory, name } = await this.resolveParent(path, true);
    await this.ensureMissing(directory, name, path);

    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(content);
    } finally {
      await writable.close();
    }
    this.handles.set(path, handle);
  }

  async deleteFile(path: string): Promise<void> {
    const { directory, name } = await this.resolveParent(path, false);
    await directory.removeEntry(name);
    this.handles.delete(path);
  }

  async renameFile(from: string, to: string): Promise<void> {
    if (from === to) return;
    const { directory: sourceDirectory, name: sourceName } = await this.resolveParent(
      from,
      false,
    );
    const source = await sourceDirectory.getFileHandle(sourceName);
    const content = await (await source.getFile()).text();
    await this.createFile(to, content);
    await sourceDirectory.removeEntry(sourceName);
    this.handles.delete(from);
  }

  private async resolveParent(
    path: string,
    create: boolean,
  ): Promise<{ directory: FileSystemDirectoryHandle; name: string }> {
    const segments = path.split('/').filter(Boolean);
    const name = segments.pop();
    if (!name) throw new Error('Invalid file path.');

    let directory = this.root;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create });
    }
    return { directory, name };
  }

  private async ensureMissing(
    directory: FileSystemDirectoryHandle,
    name: string,
    path: string,
  ): Promise<void> {
    try {
      await directory.getFileHandle(name);
      throw new Error(`File already exists: ${path}`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return;
      throw error;
    }
  }
}
