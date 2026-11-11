import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import {
  lintGutter,
  setDiagnostics as setLintDiagnostics,
  type Diagnostic as LintDiagnostic,
} from '@codemirror/lint';
import { searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import type { Camera } from '../scene/camera';
import type { Diagnostic } from '../tokens/tokenTypes';
import type { FileStat } from '../workspace/provider';
import type { Language, Panel } from '../workspace/types';
import type { DraftPersistence, PersistedDraft } from './draftStore';

export interface EditorCallbacks {
  readText(path: string): Promise<string | null>;
  writeText(path: string, content: string): Promise<void>;
  /** undefined means the provider cannot report file stats. */
  stat?(path: string): Promise<FileStat | null | undefined>;
  /** Latest tree-sitter diagnostics for a path, if they have been parsed. */
  getDiagnostics?(path: string): readonly Diagnostic[] | null;
  /** Called after edits settle so the canvas can re-render live tokens. */
  onDocSettled?(panel: Panel, text: string): void;
  onDirtyChange(panel: Panel, dirty: boolean): void;
  onContentReplaced?(panel: Panel, text: string): void;
}

export interface EditorFocus {
  /** Zero-based line index. */
  line: number;
  /** Zero-based column index. */
  column: number;
}

interface Draft extends PersistedDraft {}

const EDITOR_CLOSE_WIDTH = 560;
const EDITOR_OFFSCREEN_MARGIN = 96;

function sameStat(a: FileStat | null, b: FileStat | null): boolean {
  if (!a || !b) return a === b;
  return a.mtime === b.mtime && a.size === b.size;
}

const EDITOR_THEME = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: '#d7e0ee',
      backgroundColor: '#0a0e15',
      fontSize: '12.5px',
    },
    '.cm-scroller': {
      fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
      lineHeight: '1.55',
    },
    '.cm-content': {
      caretColor: '#7db4ff',
      padding: '8px 0',
    },
    '.cm-line': {
      padding: '0 12px',
    },
    '.cm-gutters': {
      backgroundColor: '#080b11',
      color: '#43506a',
      border: 'none',
      paddingRight: '4px',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'rgba(110, 168, 254, 0.08)',
      color: '#8ea6c8',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(255, 255, 255, 0.035)',
    },
    '.cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(70, 120, 200, 0.38) !important',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#7db4ff',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-matchingBracket': {
      backgroundColor: 'rgba(110, 168, 254, 0.2)',
      outline: '1px solid rgba(110, 168, 254, 0.4)',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'rgba(110, 168, 254, 0.16)',
      border: 'none',
      color: '#9ec1ff',
    },
    '.cm-tooltip': {
      backgroundColor: '#0d1420',
      border: '1px solid rgba(120, 145, 180, 0.25)',
    },
  },
  { dark: true },
);

function languageExtension(language: Language): Extension {
  switch (language) {
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'js':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'css':
      return css();
    case 'json':
      return json();
    case 'md':
      return markdown();
    case 'rust':
      return rust();
    case 'html':
      return html();
    case 'other':
      return [];
  }
}

const SHELL_TEMPLATE = `
  <div class="editor-header">
    <span class="editor-dirty" data-e="dirty"></span>
    <span class="editor-name" data-e="name"></span>
    <span class="editor-meta" data-e="meta"></span>
    <span class="editor-status" data-e="status"></span>
    <button class="editor-close" type="button" data-e="close" title="Close editor (Esc)">×</button>
  </div>
  <div class="editor-host" data-e="host"></div>
`;

/**
 * Mounts a native CodeMirror instance over a panel once it reaches the edit
 * LOD. The overlay tracks the panel's screen rect every frame; zooming out past
 * the edit threshold collapses it back into the canvas.
 */
export class EditorOverlay {
  private readonly callbacks: EditorCallbacks;
  private readonly shell: HTMLDivElement;
  private readonly nameEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly dirtyEl: HTMLElement;
  private readonly host: HTMLElement;

  private view: EditorView | null = null;
  private panel: Panel | null = null;
  private savedText = '';
  private savedStat: FileStat | null = null;
  private dirty = false;
  private loading = false;
  private pendingDoc: string | null = null;
  private pendingFocus: EditorFocus | null = null;
  private openToken = 0;
  private revision = 0;
  private conflict = false;
  private missing = false;
  private overwriteArmed = false;
  private polling = false;
  private settleTimer: number | null = null;
  private suppressSettle = false;
  private readonly drafts = new Map<string, Draft>();
  private draftPersistence: DraftPersistence | null = null;
  private draftLoad: Promise<void> | null = null;

  constructor(callbacks: EditorCallbacks) {
    this.callbacks = callbacks;

    const shell = document.createElement('div');
    shell.className = 'editor-shell';
    shell.hidden = true;
    shell.innerHTML = SHELL_TEMPLATE;
    document.body.appendChild(shell);
    this.shell = shell;

    const nameEl = shell.querySelector<HTMLElement>('[data-e="name"]');
    const metaEl = shell.querySelector<HTMLElement>('[data-e="meta"]');
    const statusEl = shell.querySelector<HTMLElement>('[data-e="status"]');
    const dirtyEl = shell.querySelector<HTMLElement>('[data-e="dirty"]');
    const host = shell.querySelector<HTMLElement>('[data-e="host"]');
    const closeEl = shell.querySelector<HTMLButtonElement>('[data-e="close"]');

    if (!nameEl || !metaEl || !statusEl || !dirtyEl || !host || !closeEl) {
      throw new Error('Failed to create editor overlay');
    }

    this.nameEl = nameEl;
    this.metaEl = metaEl;
    this.statusEl = statusEl;
    this.dirtyEl = dirtyEl;
    this.host = host;

    closeEl.addEventListener('click', () => this.close());
  }

  get isOpen(): boolean {
    return this.panel !== null;
  }

  get openPanel(): Panel | null {
    return this.panel;
  }

  /** Switches draft storage; call after reset when the workspace changes. */
  setDraftPersistence(persistence: DraftPersistence | null): void {
    this.draftPersistence = persistence;
    this.draftLoad = null;
    this.drafts.clear();
  }

  /** Forces pending draft writes for page-hide and workspace switches. */
  flushDrafts(): void {
    void this.draftPersistence?.flush();
  }

  async open(panel: Panel, camera: Camera, focus?: EditorFocus): Promise<void> {
    if (this.panel?.id === panel.id && this.view) {
      this.focusAt(this.view, focus);
      this.view.focus();
      return;
    }

    this.stashDraft();
    this.destroyView();

    const token = (this.openToken += 1);
    this.panel = panel;
    this.savedText = '';
    this.savedStat = null;
    this.dirty = false;
    this.loading = true;
    this.pendingDoc = null;
    this.pendingFocus = focus ?? null;
    this.conflict = false;
    this.missing = false;
    this.overwriteArmed = false;
    this.statusEl.textContent = 'Loading…';
    this.nameEl.textContent = panel.name;
    this.metaEl.textContent = panel.path;
    this.updateDirtyIndicator();
    this.shell.hidden = true;
    this.host.innerHTML = '<div class="editor-loading">Loading file…</div>';

    const draftsPromise = this.ensureDraftsLoaded();
    let stored: string | null = null;
    try {
      stored = await this.callbacks.readText(panel.path);
    } catch (error) {
      console.error(error);
      if (token === this.openToken && this.panel === panel) {
        this.loading = false;
        this.statusEl.textContent = 'Read failed';
        this.panel = null;
      }
      return;
    }

    await draftsPromise;
    if (token !== this.openToken || this.panel !== panel) return;

    const diskStat = await this.readStat(panel.path);
    if (token !== this.openToken || this.panel !== panel) return;

    this.loading = false;
    const draft = this.drafts.get(panel.path);
    this.savedText = draft ? draft.baseText : (stored ?? '');
    this.savedStat = draft ? draft.baseStat : (diskStat ?? null);
    this.missing = diskStat === null;
    this.conflict = Boolean(
      draft && diskStat !== undefined && !sameStat(draft.baseStat, diskStat ?? null),
    );

    const doc = draft ? draft.text : this.savedText;
    this.dirty = doc !== this.savedText;
    panel.dirty = this.dirty;
    this.callbacks.onDirtyChange(panel, this.dirty);

    // Wait for the camera flight to bring the panel up to the edit LOD before
    // mounting, otherwise the first frame would see a tiny panel and close.
    if (panel.w * camera.zoom >= EDITOR_CLOSE_WIDTH) {
      this.mountView(panel, doc, camera);
    } else {
      this.pendingDoc = doc;
      this.statusEl.textContent = 'Zooming in…';
    }
  }

  private mountView(panel: Panel, doc: string, camera: Camera): void {
    this.host.replaceChildren();
    const state = EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        bracketMatching(),
        lintGutter(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle),
        EditorState.tabSize.of(2),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              void this.save();
              return true;
            },
          },
          {
            key: 'Escape',
            run: () => {
              this.close();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),
        languageExtension(panel.language),
        EDITOR_THEME,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (this.panel !== panel || this.view !== update.view) return;

          const value = update.state.doc.toString();
          const dirty = value !== this.savedText;
          this.revision += 1;
          this.overwriteArmed = false;
          if (dirty) {
            this.drafts.set(panel.path, {
              text: value,
              baseText: this.savedText,
              baseStat: this.savedStat,
            });
          } else {
            this.drafts.delete(panel.path);
          }
          this.persistDraft(panel.path);

          if (dirty !== this.dirty) {
            this.dirty = dirty;
            panel.dirty = dirty;
            this.callbacks.onDirtyChange(panel, dirty);
            this.refreshStatus();
            this.updateDirtyIndicator();
          }

          if (!this.suppressSettle) this.scheduleDocSettled(panel, value);
        }),
      ],
    });

    this.view = new EditorView({ state, parent: this.host });
    this.shell.hidden = false;
    panel.lines = this.view.state.doc.lines;
    this.applyDiagnostics(panel.path, this.callbacks.getDiagnostics?.(panel.path) ?? []);
    if (this.dirty) this.callbacks.onDocSettled?.(panel, doc);
    this.refreshStatus();
    this.updateMeta();
    this.updateDirtyIndicator();
    this.updatePosition(camera);
    this.applyPendingFocus(this.view);
    this.view.focus();
  }

  private applyPendingFocus(view: EditorView): void {
    const focus = this.pendingFocus;
    if (!focus) return;
    this.pendingFocus = null;
    this.focusAt(view, focus);
  }

  private focusAt(view: EditorView, focus?: EditorFocus): void {
    if (!focus) return;
    const doc = view.state.doc;
    const lineNumber = Math.min(doc.lines, Math.max(1, Math.floor(focus.line) + 1));
    const line = doc.line(lineNumber);
    const column = Math.max(0, Math.min(line.length, Math.floor(focus.column)));
    view.dispatch({ selection: { anchor: line.from + column }, scrollIntoView: true });
  }

  /** Applies the latest tree-sitter diagnostics for the open document. */
  setDiagnostics(path: string, diagnostics: readonly Diagnostic[]): void {
    if (this.panel?.path !== path || !this.view) return;
    this.applyDiagnostics(path, diagnostics);
  }

  /** Drops a persisted draft, e.g. after the file is deleted or renamed. */
  discardDraft(path: string): void {
    this.drafts.delete(path);
    this.draftPersistence?.remove(path);
  }

  private applyDiagnostics(path: string, diagnostics: readonly Diagnostic[]): void {
    const view = this.view;
    if (!view || this.panel?.path !== path) return;

    const doc = view.state.doc;
    const mapped: LintDiagnostic[] = [];
    for (const diagnostic of diagnostics) {
      const lineNumber = Math.min(doc.lines, Math.max(1, diagnostic.line + 1));
      const line = doc.line(lineNumber);
      const from = line.from + Math.min(line.length, Math.max(0, diagnostic.start));
      const to =
        line.from + Math.min(line.length, Math.max(diagnostic.start + 1, diagnostic.end));
      mapped.push({
        from,
        to: Math.max(from, to),
        severity: diagnostic.severity,
        message: diagnostic.message,
        source: 'tree-sitter',
      });
    }
    view.dispatch(setLintDiagnostics(view.state, mapped));
  }

  close(): void {
    if (!this.panel) return;
    this.stashDraft();
    this.persistDraft(this.panel.path);
    if (this.dirty && this.view) {
      this.callbacks.onDocSettled?.(this.panel, this.view.state.doc.toString());
    }
    this.flushDrafts();
    this.clearSettleTimer();
    this.openToken += 1;
    this.loading = false;
    this.pendingDoc = null;
    this.pendingFocus = null;
    this.conflict = false;
    this.missing = false;
    this.overwriteArmed = false;
    this.savedStat = null;
    this.destroyView();
    this.shell.hidden = true;
    this.panel = null;
  }

  /** Drops drafts too, used when the workspace itself changes. */
  reset(): void {
    this.flushDrafts();
    this.drafts.clear();
    this.clearSettleTimer();
    this.openToken += 1;
    this.loading = false;
    this.pendingDoc = null;
    this.pendingFocus = null;
    this.conflict = false;
    this.missing = false;
    this.overwriteArmed = false;
    this.savedStat = null;
    this.destroyView();
    this.shell.hidden = true;
    this.panel = null;
  }

  async save(): Promise<void> {
    const panel = this.panel;
    const view = this.view;
    if (!panel || !view) return;

    if (this.conflict && !this.overwriteArmed) {
      this.overwriteArmed = true;
      this.statusEl.textContent = this.missing
        ? 'Deleted on disk — Ctrl+S again to recreate'
        : 'Changed on disk — Ctrl+S again to overwrite';
      return;
    }

    this.clearSettleTimer();
    const content = view.state.doc.toString();
    this.statusEl.textContent = 'Saving…';
    try {
      await this.callbacks.writeText(panel.path, content);
      if (this.panel !== panel || this.view !== view) return;
      this.savedText = content;
      this.savedStat = (await this.readStat(panel.path)) ?? this.savedStat;
      if (this.panel !== panel || this.view !== view) return;

      this.revision += 1;
      this.drafts.delete(panel.path);
      this.draftPersistence?.remove(panel.path);
      panel.dirty = false;
      panel.lines = view.state.doc.lines;
      this.dirty = false;
      this.conflict = false;
      this.missing = false;
      this.overwriteArmed = false;
      this.callbacks.onDirtyChange(panel, false);
      this.statusEl.textContent = 'Saved';
      this.updateMeta();
      this.updateDirtyIndicator();
    } catch (error) {
      console.error(error);
      this.statusEl.textContent = 'Save failed';
    }
  }

  /**
   * Polls the backing file. Clean buffers reload automatically; dirty buffers
   * keep the draft and require a second Ctrl+S to overwrite the disk version.
   */
  async pollExternal(): Promise<void> {
    if (!this.callbacks.stat || this.polling || this.loading) return;
    const panel = this.panel;
    const view = this.view;
    if (!panel || !view) return;

    this.polling = true;
    try {
      const stat = await this.readStat(panel.path);
      if (this.panel !== panel || this.view !== view) return;
      if (stat === undefined) return;

      if (stat === null) {
        if (!this.missing) {
          this.missing = true;
          this.conflict = true;
          this.overwriteArmed = false;
          this.refreshStatus();
        }
        return;
      }

      if (this.missing) {
        this.missing = false;
        if (sameStat(this.savedStat, stat)) {
          this.conflict = false;
          this.refreshStatus();
          return;
        }
      }

      if (sameStat(this.savedStat, stat)) return;

      if (this.dirty) {
        if (!this.conflict) {
          this.conflict = true;
          this.overwriteArmed = false;
          this.refreshStatus();
        }
        return;
      }

      const revision = this.revision;
      const text = await this.callbacks.readText(panel.path);
      if (
        this.panel !== panel ||
        this.view !== view ||
        this.revision !== revision ||
        this.dirty
      ) {
        return;
      }
      if (text === null) {
        this.missing = true;
        this.conflict = true;
        this.refreshStatus();
        return;
      }

      this.applyExternalText(panel, view, text);
      this.savedStat = stat;
      this.conflict = false;
      this.missing = false;
      this.overwriteArmed = false;
      this.statusEl.textContent = 'Reloaded from disk';
      this.callbacks.onContentReplaced?.(panel, text);
    } catch (error) {
      console.warn(`Could not check ${panel.path} for changes`, error);
    } finally {
      this.polling = false;
    }
  }

  /** Called every frame; keeps the DOM overlay glued to the panel. */
  update(camera: Camera): void {
    const panel = this.panel;
    if (!panel) return;
    if (this.loading) return;

    const screenW = panel.w * camera.zoom;
    if (this.pendingDoc !== null) {
      if (screenW >= EDITOR_CLOSE_WIDTH && !camera.isAnimating()) {
        const doc = this.pendingDoc;
        this.pendingDoc = null;
        this.mountView(panel, doc, camera);
      } else if (!camera.isAnimating() && panel.w * camera.tzoom < EDITOR_CLOSE_WIDTH) {
        // The user zoomed back out before the edit flight finished.
        this.close();
      }
      return;
    }

    if (screenW < EDITOR_CLOSE_WIDTH) {
      this.close();
      return;
    }

    const [sx, sy] = camera.worldToScreen(panel.x, panel.y);
    const screenH = panel.h * camera.zoom;
    if (
      sx + screenW < -EDITOR_OFFSCREEN_MARGIN ||
      sy + screenH < -EDITOR_OFFSCREEN_MARGIN ||
      sx > camera.vw + EDITOR_OFFSCREEN_MARGIN ||
      sy > camera.vh + EDITOR_OFFSCREEN_MARGIN
    ) {
      this.close();
      return;
    }

    this.updatePosition(camera);
  }

  private updatePosition(camera: Camera): void {
    const panel = this.panel;
    if (!panel) return;
    const [sx, sy] = camera.worldToScreen(panel.x, panel.y);
    this.shell.style.left = `${sx.toFixed(2)}px`;
    this.shell.style.top = `${sy.toFixed(2)}px`;
    this.shell.style.width = `${Math.max(1, panel.w * camera.zoom).toFixed(2)}px`;
    this.shell.style.height = `${Math.max(1, panel.h * camera.zoom).toFixed(2)}px`;
  }

  private updateMeta(): void {
    const panel = this.panel;
    if (!panel) return;
    this.metaEl.textContent = `${panel.path} · ${panel.lines.toLocaleString('en-US')} lines`;
  }

  private updateDirtyIndicator(): void {
    this.dirtyEl.classList.toggle('is-dirty', this.dirty);
  }

  private refreshStatus(): void {
    this.statusEl.textContent = this.conflict
      ? this.missing
        ? 'Deleted on disk'
        : 'Changed on disk'
      : this.dirty
        ? 'Unsaved'
        : 'Saved';
  }

  private scheduleDocSettled(panel: Panel, text: string): void {
    if (!this.callbacks.onDocSettled) return;
    this.clearSettleTimer();
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      if (this.panel !== panel || !this.view) return;
      this.callbacks.onDocSettled?.(panel, text);
    }, 350);
  }

  private persistDraft(path: string): void {
    const persistence = this.draftPersistence;
    if (!persistence) return;
    const draft = this.drafts.get(path);
    if (draft) persistence.save(path, draft);
    else persistence.remove(path);
  }

  private ensureDraftsLoaded(): Promise<void> {
    const persistence = this.draftPersistence;
    if (!persistence) return Promise.resolve();
    if (this.draftLoad) return this.draftLoad;

    this.draftLoad = persistence
      .load()
      .then((persisted) => {
        if (this.draftPersistence !== persistence) return;
        for (const [path, draft] of persisted) {
          if (!this.drafts.has(path)) this.drafts.set(path, draft);
        }
      })
      .catch((error) => {
        console.warn('Could not load drafts', error);
      });
    return this.draftLoad;
  }

  private clearSettleTimer(): void {
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private async readStat(path: string): Promise<FileStat | null | undefined> {
    if (!this.callbacks.stat) return undefined;
    try {
      return await this.callbacks.stat(path);
    } catch {
      return undefined;
    }
  }

  /** Replaces a clean buffer with the latest disk text. */
  private applyExternalText(panel: Panel, view: EditorView, text: string): void {
    this.savedText = text;
    this.revision += 1;
    const current = view.state.doc.toString();
    if (current !== text) {
      this.suppressSettle = true;
      try {
        view.dispatch({ changes: { from: 0, to: current.length, insert: text } });
      } finally {
        this.suppressSettle = false;
      }
    }
    panel.dirty = false;
    panel.lines = view.state.doc.lines;
    this.dirty = false;
    this.drafts.delete(panel.path);
    this.draftPersistence?.remove(panel.path);
    this.callbacks.onDirtyChange(panel, false);
    this.updateMeta();
    this.updateDirtyIndicator();
  }

  private stashDraft(): void {
    if (this.view && this.panel && this.dirty) {
      this.drafts.set(this.panel.path, {
        text: this.view.state.doc.toString(),
        baseText: this.savedText,
        baseStat: this.savedStat,
      });
    }
  }

  private destroyView(): void {
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    this.host.replaceChildren();
  }
}
