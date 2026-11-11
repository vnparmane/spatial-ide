import type { Panel } from '../workspace/types';

export interface SearchMatch {
  panel: Panel;
  /** Zero-based line index. */
  line: number;
  /** Zero-based column of the match within the line. */
  column: number;
  /** Match length in characters. */
  length: number;
  /** Line text, clipped around the match when it is very long. */
  lineText: string;
}

export interface IndexProgress {
  indexed: number;
  total: number;
  skipped: number;
  done: boolean;
  truncated: boolean;
}

interface IndexedFile {
  panel: Panel;
  text: string;
  lower: string;
  lineStarts: number[];
}

/** Files larger than this are skipped; global search is a navigation aid. */
const MAX_FILE_CHARS = 512 * 1024;
/** Keeps the in-memory index bounded on very large workspaces. */
const MAX_TOTAL_CHARS = 24 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 320;
const MAX_MATCHES_PER_FILE = 8;
const CONCURRENCY = 8;

function lineStartsFor(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineAt(starts: number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Lazy full-text index for the workspace. Files are read once on first search
 * and matched in memory afterwards. Reads are bounded by concurrency and total
 * size so a huge folder cannot lock up the tab.
 */
export class ContentIndex {
  private readonly readText: (path: string) => Promise<string | null>;
  private files = new Map<string, IndexedFile>();
  private queue: Panel[] = [];
  private nextIndex = 0;
  private active = 0;
  private generation = 0;
  private total = 0;
  private skipped = 0;
  private chars = 0;
  private truncated = false;
  private started = false;
  private done = false;
  private waiters: Array<() => void> = [];
  private progressListener: ((progress: IndexProgress) => void) | null = null;

  constructor(readText: (path: string) => Promise<string | null>) {
    this.readText = readText;
  }

  get isComplete(): boolean {
    return this.done;
  }

  get progress(): IndexProgress {
    return {
      indexed: this.files.size,
      total: this.total,
      skipped: this.skipped,
      done: this.done,
      truncated: this.truncated,
    };
  }

  /** Replaces the indexed panel set; in-flight reads from the old set are ignored. */
  setPanels(panels: readonly Panel[]): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();

    this.generation += 1;
    this.files.clear();
    this.queue = [...panels];
    this.nextIndex = 0;
    this.active = 0;
    this.total = panels.length;
    this.skipped = 0;
    this.chars = 0;
    this.truncated = false;
    this.started = false;
    this.done = false;
    this.progressListener = null;
  }

  /** Builds the index, reporting progress until every panel has been read. */
  ensure(onProgress?: (progress: IndexProgress) => void): Promise<void> {
    if (onProgress) this.progressListener = onProgress;
    if (this.done) {
      onProgress?.(this.progress);
      return Promise.resolve();
    }

    const promise = new Promise<void>((resolve) => this.waiters.push(resolve));
    if (!this.started) {
      this.started = true;
      this.pump();
    }
    return promise;
  }

  /** Case-insensitive literal search over the indexed files. */
  search(query: string, limit = 200): SearchMatch[] {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];

    const matches: SearchMatch[] = [];
    for (const panel of this.queue) {
      const file = this.files.get(panel.path);
      if (!file) continue;

      let from = 0;
      let perFile = 0;
      while (perFile < MAX_MATCHES_PER_FILE && matches.length < limit) {
        const index = file.lower.indexOf(needle, from);
        if (index < 0) break;

        const line = lineAt(file.lineStarts, index);
        const lineStart = file.lineStarts[line];
        const lineEnd =
          line + 1 < file.lineStarts.length
            ? file.lineStarts[line + 1] - 1
            : file.text.length;
        let lineText = file.text.slice(lineStart, lineEnd).replace(/\r$/, '');
        let column = index - lineStart;

        if (lineText.length > MAX_PREVIEW_CHARS) {
          const sliceStart = Math.max(
            0,
            Math.min(column - 80, lineText.length - MAX_PREVIEW_CHARS),
          );
          lineText = lineText.slice(sliceStart, sliceStart + MAX_PREVIEW_CHARS);
          column -= sliceStart;
        }

        matches.push({
          panel,
          line,
          column,
          length: needle.length,
          lineText,
        });
        perFile += 1;
        from = index + Math.max(1, needle.length);
      }

      if (matches.length >= limit) break;
    }
    return matches;
  }

  private pump(): void {
    const generation = this.generation;
    if (this.truncated) this.nextIndex = this.queue.length;

    while (this.active < CONCURRENCY && this.nextIndex < this.queue.length) {
      const panel = this.queue[this.nextIndex];
      this.nextIndex += 1;
      this.active += 1;

      void this.readText(panel.path)
        .then((text) => {
          if (generation !== this.generation) return;
          if (this.truncated || text === null) {
            this.skipped += 1;
            return;
          }
          if (
            text.length > MAX_FILE_CHARS ||
            this.chars + text.length > MAX_TOTAL_CHARS
          ) {
            this.skipped += 1;
            if (this.chars + text.length > MAX_TOTAL_CHARS) {
              this.truncated = true;
              this.nextIndex = this.queue.length;
            }
            return;
          }

          this.chars += text.length;
          this.files.set(panel.path, {
            panel,
            text,
            lower: text.toLowerCase(),
            lineStarts: lineStartsFor(text),
          });
        })
        .catch(() => {
          if (generation === this.generation) this.skipped += 1;
        })
        .finally(() => {
          if (generation !== this.generation) return;
          this.active -= 1;
          this.notify();
          this.pump();
        });
    }

    if (this.active === 0 && this.nextIndex >= this.queue.length) this.finish();
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.skipped = Math.max(this.skipped, this.total - this.files.size);
    this.notify();

    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  private notify(): void {
    this.progressListener?.(this.progress);
  }
}
