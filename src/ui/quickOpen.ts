import type { Panel } from '../workspace/types';

export interface QuickOpenOptions {
  getPanels(): readonly Panel[];
  onPick(panel: Panel): void;
}

export interface QuickOpen {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

const MAX_RESULTS = 40;

const TEMPLATE = `
  <div class="quick-open" hidden>
    <div class="quick-open-backdrop" data-q="backdrop"></div>
    <div class="quick-open-card">
      <input class="quick-open-input" data-q="input" id="quick-open-input" name="quick-open" type="text" spellcheck="false" autocomplete="off" aria-label="Go to file" placeholder="Go to file…" />
      <div class="quick-open-list" data-q="list"></div>
      <div class="quick-open-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> open</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>
  </div>
`;

/** Subsequence score that rewards contiguous and word-boundary matches. */
function scoreSubsequence(path: string, needle: string): number {
  const haystack = path.toLowerCase();
  let hayIndex = 0;
  let needleIndex = 0;
  let score = 0;
  let lastMatch = -2;

  while (hayIndex < haystack.length && needleIndex < needle.length) {
    if (haystack[hayIndex] === needle[needleIndex]) {
      score += lastMatch === hayIndex - 1 ? 9 : 2;
      const previous = haystack[hayIndex - 1];
      if (
        hayIndex === 0 ||
        previous === '/' ||
        previous === '-' ||
        previous === '_' ||
        previous === '.'
      ) {
        score += 5;
      }
      lastMatch = hayIndex;
      needleIndex += 1;
    }
    hayIndex += 1;
  }

  if (needleIndex !== needle.length) return -1;
  return score - haystack.length * 0.01;
}

/** Every whitespace-separated token must match somewhere in the path. */
function scorePath(path: string, query: string): number {
  if (!query) return 0;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const token of tokens) {
    const score = scoreSubsequence(path, token);
    if (score < 0) return -1;
    total += score;
  }
  return total / tokens.length;
}

export function createQuickOpen(options: QuickOpenOptions): QuickOpen {
  const container = document.createElement('div');
  container.innerHTML = TEMPLATE;
  document.body.appendChild(container);

  const root = container.querySelector<HTMLElement>('.quick-open');
  const backdrop = container.querySelector<HTMLElement>('[data-q="backdrop"]');
  const input = container.querySelector<HTMLInputElement>('[data-q="input"]');
  const list = container.querySelector<HTMLElement>('[data-q="list"]');

  if (!root || !backdrop || !input || !list) {
    throw new Error('Failed to create quick open');
  }

  let results: Panel[] = [];
  let active = 0;
  let open = false;

  const close = (): void => {
    if (!open) return;
    open = false;
    root.hidden = true;
    input.value = '';
    results = [];
    list.replaceChildren();
  };

  const pick = (panel: Panel): void => {
    close();
    options.onPick(panel);
  };

  const render = (): void => {
    list.replaceChildren();
    results.forEach((panel, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = index === active ? 'quick-row is-active' : 'quick-row';

      const name = document.createElement('span');
      name.className = 'quick-name';
      name.textContent = panel.name;

      const directory = document.createElement('span');
      directory.className = 'quick-dir';
      const slash = panel.path.lastIndexOf('/');
      directory.textContent = slash > 0 ? panel.path.slice(0, slash) : '.';

      row.append(name, directory);
      row.addEventListener('click', () => pick(panel));
      list.appendChild(row);
    });

    if (results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'quick-empty';
      empty.textContent = 'No matching files';
      list.appendChild(empty);
    }

    list.querySelector('.quick-row.is-active')?.scrollIntoView({ block: 'nearest' });
  };

  const refresh = (): void => {
    const query = input.value.trim();
    results = options
      .getPanels()
      .map((panel) => ({ panel, score: scorePath(panel.path, query) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.panel.path.length !== b.panel.path.length) {
          return a.panel.path.length - b.panel.path.length;
        }
        return a.panel.path.localeCompare(b.panel.path);
      })
      .slice(0, MAX_RESULTS)
      .map((item) => item.panel);

    active = 0;
    render();
  };

  input.addEventListener('input', refresh);

  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown') {
      if (results.length > 0) active = (active + 1) % results.length;
      render();
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowUp') {
      if (results.length > 0) active = (active - 1 + results.length) % results.length;
      render();
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter') {
      const panel = results[active];
      if (panel) pick(panel);
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
      open = true;
      root.hidden = false;
      input.value = '';
      refresh();
      input.focus();
    },
    close,
    get isOpen(): boolean {
      return open;
    },
  };
}
