import { ContentIndex, type IndexProgress, type SearchMatch } from '../search/contentIndex';
import { formatInt } from '../util/math';
import type { Panel } from '../workspace/types';

export interface SearchOptions {
  getPanels(): readonly Panel[];
  readText(path: string): Promise<string | null>;
  onPick(panel: Panel, line: number, column: number): void;
}

export interface SearchOverlay {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  /** Rebuilds the index after the workspace changes. */
  reset(): void;
}

const MAX_MATCHES = 200;

const TEMPLATE = `
  <div class="search-overlay" hidden>
    <div class="search-backdrop" data-s="backdrop"></div>
    <div class="search-card">
      <div class="search-head">
        <span class="search-glyph">⌕</span>
        <input class="search-input" data-s="input" id="search-input" name="search" type="text" spellcheck="false" autocomplete="off" aria-label="Search in files" placeholder="Search in files…" />
        <span class="search-progress" data-s="progress"></span>
      </div>
      <div class="search-results" data-s="results"></div>
      <div class="search-foot">
        <span class="search-summary" data-s="summary">Type at least 2 characters</span>
        <span class="search-hints">
          <kbd>↑</kbd><kbd>↓</kbd> navigate
          <kbd>↵</kbd> open
          <kbd>esc</kbd> close
        </span>
      </div>
    </div>
  </div>
`;

export function createSearch(options: SearchOptions): SearchOverlay {
  const container = document.createElement('div');
  container.innerHTML = TEMPLATE;
  document.body.appendChild(container);

  const root = container.querySelector<HTMLElement>('.search-overlay');
  const backdrop = container.querySelector<HTMLElement>('[data-s="backdrop"]');
  const input = container.querySelector<HTMLInputElement>('[data-s="input"]');
  const results = container.querySelector<HTMLElement>('[data-s="results"]');
  const progressEl = container.querySelector<HTMLElement>('[data-s="progress"]');
  const summary = container.querySelector<HTMLElement>('[data-s="summary"]');

  if (!root || !backdrop || !input || !results || !progressEl || !summary) {
    throw new Error('Failed to create search overlay');
  }

  const index = new ContentIndex(options.readText);
  index.setPanels(options.getPanels());

  let open = false;
  let indexing = false;
  let debounceTimer: number | null = null;
  let searchToken = 0;
  let currentQuery = '';
  let rows: HTMLButtonElement[] = [];
  let currentMatches: SearchMatch[] = [];
  let active = 0;

  const updateProgress = (progress: IndexProgress): void => {
    if (!open) return;
    if (progress.done) {
      progressEl.textContent = progress.truncated
        ? `${formatInt(progress.indexed)} of ${formatInt(progress.total)} indexed`
        : '';
      progressEl.classList.toggle('is-warn', progress.truncated);
      return;
    }
    progressEl.classList.remove('is-warn');
    progressEl.textContent = `Indexing ${formatInt(progress.indexed)} / ${formatInt(progress.total)}`;
  };

  const setActive = (next: number): void => {
    if (rows.length === 0) return;
    const clamped = ((next % rows.length) + rows.length) % rows.length;
    rows[active]?.classList.remove('is-active');
    active = clamped;
    const row = rows[active];
    row.classList.add('is-active');
    row.scrollIntoView({ block: 'nearest' });
  };

  const renderHint = (query: string): void => {
    results.replaceChildren();
    rows = [];
    currentMatches = [];
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent =
      query.length > 0
        ? 'Type one more character to search.'
        : `Search across ${formatInt(options.getPanels().length)} files.`;
    results.appendChild(empty);
    summary.textContent =
      query.length > 0 ? 'Type at least 2 characters' : 'Type to search the workspace';
  };

  const renderMatches = (matches: SearchMatch[], query: string): void => {
    results.replaceChildren();
    rows = [];
    currentMatches = matches;

    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = `No matches for “${query}”`;
      results.appendChild(empty);
      const indexed = index.progress.indexed;
      summary.textContent = `0 results in ${formatInt(indexed)} ${indexed === 1 ? 'file' : 'files'}`;
      return;
    }

    const groups = new Map<string, SearchMatch[]>();
    for (const match of matches) {
      const list = groups.get(match.panel.path);
      if (list) list.push(match);
      else groups.set(match.panel.path, [match]);
    }

    for (const list of groups.values()) {
      const panel = list[0].panel;
      const header = document.createElement('div');
      header.className = 'search-file';

      const name = document.createElement('span');
      name.className = 'search-file-name';
      name.textContent = panel.name;

      const directory = document.createElement('span');
      directory.className = 'search-file-dir';
      const slash = panel.path.lastIndexOf('/');
      directory.textContent = slash > 0 ? panel.path.slice(0, slash) : '.';

      const count = document.createElement('span');
      count.className = 'search-file-count';
      count.textContent = String(list.length);

      header.append(name, directory, count);
      results.appendChild(header);

      for (const match of list) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'search-row';

        const lineNumber = document.createElement('span');
        lineNumber.className = 'search-line';
        lineNumber.textContent = String(match.line + 1);

        const preview = document.createElement('span');
        preview.className = 'search-preview';
        const start = Math.max(0, Math.min(match.lineText.length, match.column));
        const end = Math.min(match.lineText.length, start + match.length);
        preview.append(
          document.createTextNode(match.lineText.slice(0, start)),
          createMark(match.lineText.slice(start, end)),
          document.createTextNode(match.lineText.slice(end)),
        );

        row.append(lineNumber, preview);
        row.addEventListener('click', () => pick(match));
        results.appendChild(row);
        rows.push(row);
      }
    }

    active = 0;
    setActive(0);
    const fileCount = groups.size;
    const limitNote = matches.length >= MAX_MATCHES ? ' · limit reached' : '';
    const resultWord = matches.length === 1 ? 'result' : 'results';
    const fileWord = fileCount === 1 ? 'file' : 'files';
    summary.textContent = `${formatInt(matches.length)} ${resultWord} in ${formatInt(fileCount)} ${fileWord}${limitNote}`;
  };

  const ensureIndex = async (): Promise<void> => {
    if (index.isComplete) {
      updateProgress(index.progress);
      return;
    }
    if (indexing) return;

    indexing = true;
    updateProgress(index.progress);
    await index.ensure((progress) => {
      if (open) updateProgress(progress);
    });
    indexing = false;

    if (!open) return;
    updateProgress(index.progress);
    if (currentQuery.trim().length >= 2) void execute(currentQuery);
  };

  const execute = async (query: string): Promise<void> => {
    if (!open) return;
    const token = (searchToken += 1);
    currentQuery = query;
    const trimmed = query.trim();

    if (trimmed.length < 2) {
      renderHint(trimmed);
      return;
    }

    if (!index.isComplete) {
      summary.textContent = 'Indexing files…';
      void ensureIndex();
      return;
    }

    const matches = index.search(trimmed, MAX_MATCHES);
    if (token !== searchToken) return;
    renderMatches(matches, trimmed);
  };

  const scheduleSearch = (): void => {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    const query = input.value;
    if (query.trim().length < 2) {
      searchToken += 1;
      renderHint(query.trim());
      return;
    }
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void execute(query);
    }, 180);
  };

  const pick = (match: SearchMatch): void => {
    close();
    options.onPick(match.panel, match.line, match.column);
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    root.hidden = true;
    input.value = '';
    currentQuery = '';
    searchToken += 1;
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    rows = [];
    currentMatches = [];
    results.replaceChildren();
    progressEl.textContent = '';
    progressEl.classList.remove('is-warn');
  };

  input.addEventListener('input', scheduleSearch);

  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown') {
      if (rows.length > 0) setActive(active + 1);
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowUp') {
      if (rows.length > 0) setActive(active - 1);
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter') {
      const match = currentMatches[active];
      if (match) pick(match);
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      close();
      event.preventDefault();
    }
  });

  backdrop.addEventListener('click', close);

  return {
    open(): void {
      if (open) {
        input.focus();
        return;
      }
      open = true;
      root.hidden = false;
      input.value = '';
      currentQuery = '';
      searchToken += 1;
      renderHint('');
      progressEl.textContent = '';
      input.focus();
      void ensureIndex();
    },
    close,
    get isOpen(): boolean {
      return open;
    },
    reset(): void {
      index.setPanels(options.getPanels());
      searchToken += 1;
      currentQuery = '';
      if (open) {
        renderHint('');
        progressEl.textContent = '';
        void ensureIndex();
      }
    },
  };
}

function createMark(text: string): HTMLElement {
  const mark = document.createElement('mark');
  mark.textContent = text;
  return mark;
}
