import type { Language, Panel } from '../workspace/types';
import {
  TOKEN_LANGUAGES,
  type Diagnostic,
  type TokenRun,
  type TokenizeRequest,
  type TokenizeResponse,
} from './tokenTypes';

type ReadText = (path: string) => Promise<string | null>;

/**
 * Main-thread front end for the tree-sitter worker. Token runs are cached per
 * path and requested lazily when a panel first reaches the inspect LOD.
 * Diagnostics ride along with every parse and are cached per path.
 */
export class TokenStore {
  private readonly readText: ReadText;
  private readonly worker: Worker | null;
  private readonly cache = new Map<string, TokenRun[]>();
  private readonly diagnosticCache = new Map<string, Diagnostic[]>();
  private readonly semanticCache = new Map<string, Diagnostic[]>();
  private readonly diagnosticListeners = new Set<
    (path: string, diagnostics: readonly Diagnostic[]) => void
  >();
  private readonly pending = new Set<string>();
  private readonly requestPaths = new Map<number, string>();
  private readonly latest = new Map<string, number>();
  private nextId = 1;
  private generation = 0;

  constructor(readText: ReadText) {
    this.readText = readText;

    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./tokenWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<TokenizeResponse>) => this.handle(event.data);
      worker.onerror = (event) => {
        console.warn('Token worker error:', event.message);
      };
    } catch (error) {
      console.warn('Token worker unavailable:', error);
    }
    this.worker = worker;
  }

  get(path: string): TokenRun[] | null {
    return this.cache.get(path) ?? null;
  }

  getDiagnostics(path: string): readonly Diagnostic[] | null {
    if (!this.diagnosticCache.has(path) && !this.semanticCache.has(path)) return null;
    return this.mergedDiagnostics(path);
  }

  /** Merges language-service diagnostics with the latest tree-sitter parse. */
  setSemantic(path: string, diagnostics: readonly Diagnostic[]): void {
    if (diagnostics.length === 0) this.semanticCache.delete(path);
    else this.semanticCache.set(path, [...diagnostics]);
    this.notify(path);
  }

  /** Subscribes to diagnostic updates; returns an unsubscribe function. */
  onDiagnostics(
    listener: (path: string, diagnostics: readonly Diagnostic[]) => void,
  ): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  request(panel: Panel): void {
    if (!this.worker || !TOKEN_LANGUAGES.has(panel.language)) return;
    if (this.cache.has(panel.path) || this.pending.has(panel.path)) return;

    this.pending.add(panel.path);
    const generation = this.generation;
    void this.readText(panel.path)
      .then((text) => {
        if (generation !== this.generation) return;
        if (text === null) {
          this.pending.delete(panel.path);
          return;
        }
        this.send(panel.path, panel.language, text);
      })
      .catch((error) => {
        console.warn(`Token read failed for ${panel.path}`, error);
        this.pending.delete(panel.path);
      });
  }

  /** Re-tokenizes a document after an edit, save, or external reload. */
  set(path: string, language: Language, text: string): void {
    if (!this.worker || !TOKEN_LANGUAGES.has(language)) return;
    this.send(path, language, text);
  }

  reset(): void {
    this.generation += 1;
    this.cache.clear();
    this.diagnosticCache.clear();
    this.semanticCache.clear();
    this.pending.clear();
    this.requestPaths.clear();
    this.latest.clear();
  }

  dispose(): void {
    this.worker?.terminate();
  }

  private send(path: string, language: Language, text: string): void {
    if (!this.worker) return;
    const id = this.nextId;
    this.nextId += 1;
    this.requestPaths.set(id, path);
    this.latest.set(path, id);
    this.pending.add(path);

    const request: TokenizeRequest = {
      type: 'tokenize',
      id,
      path,
      language,
      text,
    };
    this.worker.postMessage(request);
  }

  private handle(response: TokenizeResponse): void {
    const path = this.requestPaths.get(response.id);
    if (!path) return;
    this.requestPaths.delete(response.id);
    if (this.latest.get(path) !== response.id) return;

    this.pending.delete(path);
    if (response.error) {
      console.warn(`Tokenize failed for ${path}: ${response.error}`);
      this.cache.set(path, []);
      this.diagnosticCache.set(path, []);
      this.notify(path);
      return;
    }

    this.cache.set(path, response.runs);
    this.diagnosticCache.set(path, response.diagnostics ?? []);
    this.notify(path);
  }

  private mergedDiagnostics(path: string): Diagnostic[] {
    return [
      ...(this.diagnosticCache.get(path) ?? []),
      ...(this.semanticCache.get(path) ?? []),
    ];
  }

  private notify(path: string): void {
    const diagnostics = this.mergedDiagnostics(path);
    for (const listener of this.diagnosticListeners) {
      listener(path, diagnostics);
    }
  }
}
