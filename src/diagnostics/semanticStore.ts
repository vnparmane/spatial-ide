import type { Diagnostic } from '../tokens/tokenTypes';
import type { Language } from '../workspace/types';
import type { DiagnoseRequest, DiagnoseResponse, SemanticFile } from './tsTypes';

const TS_LANGUAGES: ReadonlySet<Language> = new Set<Language>(['ts', 'tsx', 'js', 'jsx']);
const DEBOUNCE_MS = 400;
const MAX_DEPENDENCIES = 60;
const MAX_DEPENDENCY_CHARS = 1024 * 1024;

const IMPORT_PATTERN =
  /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;

const RESOLVE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.json',
];

function normalizePath(path: string): string {
  const segments = path.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

function importSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (specifier && specifier.startsWith('.')) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveCandidates(fromPath: string, specifier: string): string[] {
  const directory = fromPath.slice(0, fromPath.lastIndexOf('/') + 1);
  const base = normalizePath(`${directory}${specifier}`);
  const candidates = [base];
  for (const extension of RESOLVE_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of RESOLVE_EXTENSIONS) candidates.push(`${base}/index${extension}`);
  return candidates;
}

/**
 * Main-thread front end for the TypeScript language-service worker. Only the
 * open document is checked; relative imports are read so cross-file types
 * resolve, but bare package imports are left to the bundler and suppressed.
 */
export class SemanticStore {
  private readonly readText: (path: string) => Promise<string | null>;
  private worker: Worker | null = null;
  private readonly cache = new Map<string, Diagnostic[]>();
  private readonly timers = new Map<string, number>();
  private readonly requestPaths = new Map<number, string>();
  private readonly latest = new Map<string, number>();
  private readonly listeners = new Set<
    (path: string, diagnostics: readonly Diagnostic[]) => void
  >();
  private nextId = 1;
  private generation = 0;

  constructor(readText: (path: string) => Promise<string | null>) {
    this.readText = readText;
  }

  get(path: string): readonly Diagnostic[] | null {
    return this.cache.get(path) ?? null;
  }

  onDiagnostics(
    listener: (path: string, diagnostics: readonly Diagnostic[]) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Schedules a semantic check; rapid edits collapse into one request. */
  update(path: string, language: Language, text: string): void {
    if (!TS_LANGUAGES.has(language)) return;
    const timer = this.timers.get(path);
    if (timer !== undefined) window.clearTimeout(timer);

    this.timers.set(
      path,
      window.setTimeout(() => {
        this.timers.delete(path);
        void this.run(path, text);
      }, DEBOUNCE_MS),
    );
  }

  clear(path: string): void {
    const timer = this.timers.get(path);
    if (timer !== undefined) window.clearTimeout(timer);
    this.timers.delete(path);
    this.cache.delete(path);
    this.latest.delete(path);
    this.notify(path, []);
  }

  reset(): void {
    this.generation += 1;
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
    this.cache.clear();
    this.requestPaths.clear();
    this.latest.clear();
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(new URL('./tsWorker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = (event: MessageEvent<DiagnoseResponse>) => this.handle(event.data);
      worker.onerror = (event) => {
        console.warn('TypeScript worker error:', event.message);
      };
      this.worker = worker;
      return worker;
    } catch (error) {
      console.warn('TypeScript worker unavailable:', error);
      return null;
    }
  }

  private async run(path: string, text: string): Promise<void> {
    const generation = this.generation;
    const files = await this.collectDependencies(path, text);
    if (generation !== this.generation) return;

    const worker = this.ensureWorker();
    if (!worker) return;

    const id = this.nextId;
    this.nextId += 1;
    this.requestPaths.set(id, path);
    this.latest.set(path, id);

    const request: DiagnoseRequest = {
      type: 'diagnose',
      id,
      path,
      text,
      files,
    };
    worker.postMessage(request);
  }

  private async collectDependencies(
    rootPath: string,
    rootText: string,
  ): Promise<SemanticFile[]> {
    const seen = new Set<string>([rootPath]);
    const files: SemanticFile[] = [];
    const queue: Array<{ path: string; text: string }> = [{ path: rootPath, text: rootText }];
    let chars = 0;

    while (queue.length > 0 && files.length < MAX_DEPENDENCIES) {
      const current = queue.shift();
      if (!current) break;

      for (const specifier of importSpecifiers(current.text)) {
        if (files.length >= MAX_DEPENDENCIES) break;
        for (const candidate of resolveCandidates(current.path, specifier)) {
          if (seen.has(candidate)) break;

          let text: string | null = null;
          try {
            text = await this.readText(candidate);
          } catch {
            text = null;
          }
          if (text === null) continue;
          if (chars + text.length > MAX_DEPENDENCY_CHARS) return files;

          seen.add(candidate);
          chars += text.length;
          files.push({ path: candidate, text });
          queue.push({ path: candidate, text });
          break;
        }
      }
    }

    return files;
  }

  private handle(response: DiagnoseResponse): void {
    const path = this.requestPaths.get(response.id);
    if (!path) return;
    this.requestPaths.delete(response.id);
    if (this.latest.get(path) !== response.id) return;

    if (response.error) {
      console.warn(`Semantic check failed for ${path}: ${response.error}`);
      this.cache.set(path, []);
      this.notify(path, []);
      return;
    }

    const diagnostics: Diagnostic[] = response.diagnostics.map((diagnostic) => ({
      line: diagnostic.line,
      start: diagnostic.start,
      end: diagnostic.end,
      severity: diagnostic.severity,
      message: diagnostic.message,
    }));
    this.cache.set(path, diagnostics);
    this.notify(path, diagnostics);
  }

  private notify(path: string, diagnostics: readonly Diagnostic[]): void {
    for (const listener of this.listeners) {
      listener(path, diagnostics);
    }
  }
}
