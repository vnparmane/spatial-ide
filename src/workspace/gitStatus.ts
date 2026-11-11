import type { GitStatus, Panel } from './types';

export interface GitIndexEntry {
  path: string;
  /** Index mtime in seconds since epoch; 0 means git marked it racy. */
  mtime: number;
  size: number;
  oid: Uint8Array;
}

interface FileMeta {
  size: number;
  mtime: number;
}

const encoder = new TextEncoder();

/** Reads `.git/index` from the workspace root, if it is a normal git checkout. */
export async function readGitIndex(
  root: FileSystemDirectoryHandle,
): Promise<Map<string, GitIndexEntry> | null> {
  try {
    const gitDir = await root.getDirectoryHandle('.git');
    const indexHandle = await gitDir.getFileHandle('index');
    const buffer = await (await indexHandle.getFile()).arrayBuffer();
    return parseGitIndex(buffer);
  } catch {
    return null;
  }
}

/**
 * Parses git index versions 2 and 3. Version 4 uses path compression and is
 * treated as unsupported; the workspace still loads, just without git colors.
 */
function parseGitIndex(buffer: ArrayBuffer): Map<string, GitIndexEntry> | null {
  if (buffer.byteLength < 12) return null;
  const view = new DataView(buffer);
  if (
    view.getUint8(0) !== 0x44 || // D
    view.getUint8(1) !== 0x49 || // I
    view.getUint8(2) !== 0x52 || // R
    view.getUint8(3) !== 0x43 // C
  ) {
    return null;
  }

  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) return null;

  const count = view.getUint32(8);
  const decoder = new TextDecoder();
  const entries = new Map<string, GitIndexEntry>();
  let offset = 12;

  for (let i = 0; i < count; i += 1) {
    if (offset + 62 > buffer.byteLength) break;

    const mtime = view.getUint32(offset + 8);
    const size = view.getUint32(offset + 36);
    const oid = new Uint8Array(buffer.slice(offset + 40, offset + 60));
    const flags = view.getUint16(offset + 60);

    let pathStart = offset + 62;
    if (version === 3 && (flags & 0x4000) !== 0) {
      if (pathStart + 2 > buffer.byteLength) break;
      pathStart += 2;
    }

    let pathEnd = pathStart;
    while (pathEnd < buffer.byteLength && view.getUint8(pathEnd) !== 0) {
      pathEnd += 1;
    }
    if (pathEnd >= buffer.byteLength) break;

    const path = decoder.decode(new Uint8Array(buffer, pathStart, pathEnd - pathStart));
    if (path) {
      entries.set(path, { path, mtime, size, oid });
    }

    const entryLength = pathEnd - offset + 1;
    offset += Math.ceil(entryLength / 8) * 8;
  }

  return entries;
}

/**
 * Approximate working-tree status from index stat data. Files absent from the
 * index are treated as added/untracked.
 */
export function applyGitStatus(
  panels: readonly Panel[],
  files: ReadonlyMap<string, FileMeta>,
  index: Map<string, GitIndexEntry>,
): void {
  for (const panel of panels) {
    const entry = index.get(panel.path);
    if (!entry) {
      panel.git = 'added';
      continue;
    }

    const file = files.get(panel.path);
    if (!file) {
      panel.git = 'deleted';
      continue;
    }

    const mtimeSeconds = Math.floor(file.mtime / 1000);
    const statMatches =
      entry.size === file.size && (entry.mtime === 0 || entry.mtime === mtimeSeconds);
    panel.git = statMatches ? 'clean' : 'modified';
  }
}

/** Exact status for a saved buffer, using the git blob SHA-1 in the index. */
export async function gitStatusForContent(
  index: Map<string, GitIndexEntry>,
  path: string,
  content: string,
): Promise<GitStatus> {
  const entry = index.get(path);
  if (!entry) return 'added';

  try {
    const oid = await gitBlobOid(content);
    return sameBytes(oid, entry.oid) ? 'clean' : 'modified';
  } catch {
    return 'modified';
  }
}

async function gitBlobOid(content: string): Promise<Uint8Array> {
  const body = encoder.encode(content);
  const header = encoder.encode(`blob ${body.length}\0`);
  const blob = new Uint8Array(header.length + body.length);
  blob.set(header, 0);
  blob.set(body, header.length);
  const digest = await crypto.subtle.digest('SHA-1', blob);
  return new Uint8Array(digest);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
