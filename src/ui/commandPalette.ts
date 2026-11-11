import { scoreTokens } from '../util/fuzzy';

export interface Command {
  id: string;
  title: string;
  /** Optional secondary text shown beside the title. */
  detail?: string;
  /** Display-only key hint, e.g. "ctrl+shift+f". */
  shortcut?: string;
  /** Commands can disappear or dim when their context is unavailable. */
  enabled?: () => boolean;
  run(): void | Promise<void>;
}

export interface CommandPaletteOptions {
  getCommands(): readonly Command[];
}

export interface CommandPalette {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

interface Entry {
  command: Command;
  enabled: boolean;
  score: number;
}

const TEMPLATE = `
  <div class="quick-open command-palette" hidden>
    <div class="quick-open-backdrop" data-c="backdrop"></div>
    <div class="quick-open-card">
      <input class="quick-open-input" data-c="input" id="command-input" name="command" type="text" spellcheck="false" autocomplete="off" aria-label="Command palette" placeholder="Run a command…" />
      <div class="quick-open-list" data-c="list"></div>
      <div class="quick-open-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
        <span><kbd>↵</kbd> run</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>
  </div>
`;

export function createCommandPalette(options: CommandPaletteOptions): CommandPalette {
  const container = document.createElement('div');
  container.innerHTML = TEMPLATE;
  document.body.appendChild(container);

  const root = container.querySelector<HTMLElement>('.command-palette');
  const backdrop = container.querySelector<HTMLElement>('[data-c="backdrop"]');
  const input = container.querySelector<HTMLInputElement>('[data-c="input"]');
  const list = container.querySelector<HTMLElement>('[data-c="list"]');

  if (!root || !backdrop || !input || !list) {
    throw new Error('Failed to create command palette');
  }

  let entries: Entry[] = [];
  let active = 0;
  let open = false;

  const close = (): void => {
    if (!open) return;
    open = false;
    root.hidden = true;
    input.value = '';
    entries = [];
    list.replaceChildren();
  };

  const render = (): void => {
    list.replaceChildren();

    entries.forEach((entry, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'command-row';
      if (!entry.enabled) row.classList.add('is-disabled');
      if (index === active && entry.enabled) row.classList.add('is-active');
      row.disabled = !entry.enabled;

      const title = document.createElement('span');
      title.className = 'command-title';
      title.textContent = entry.command.title;

      const detail = document.createElement('span');
      detail.className = 'command-detail';
      detail.textContent = entry.command.detail ?? '';

      const key = document.createElement('span');
      key.className = 'command-key';
      if (entry.command.shortcut) {
        const kbd = document.createElement('kbd');
        kbd.textContent = entry.command.shortcut;
        key.appendChild(kbd);
      }

      row.append(title, detail, key);
      if (entry.enabled) {
        row.addEventListener('click', () => run(entry.command));
      }
      list.appendChild(row);
    });

    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'quick-empty';
      empty.textContent = 'No matching commands';
      list.appendChild(empty);
    }

    list.querySelector('.command-row.is-active')?.scrollIntoView({ block: 'nearest' });
  };

  const refresh = (): void => {
    const query = input.value.trim();
    entries = options
      .getCommands()
      .map((command) => ({
        command,
        enabled: command.enabled ? command.enabled() : true,
        score: scoreTokens(`${command.title} ${command.detail ?? ''}`, query),
      }))
      .filter((entry) => entry.score >= 0);

    if (query) {
      entries.sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return b.score - a.score;
      });
    }

    active = entries.findIndex((entry) => entry.enabled);
    if (active < 0) active = 0;
    render();
  };

  const move = (delta: number): void => {
    if (entries.length === 0) return;
    let index = active;
    for (let step = 0; step < entries.length; step += 1) {
      index = (index + delta + entries.length) % entries.length;
      if (entries[index].enabled) {
        active = index;
        render();
        return;
      }
    }
  };

  const run = (command: Command): void => {
    close();
    void Promise.resolve(command.run()).catch((error) => {
      console.error(`Command failed: ${command.id}`, error);
    });
  };

  const runActive = (): void => {
    const entry = entries[active];
    if (entry?.enabled) run(entry.command);
  };

  input.addEventListener('input', refresh);

  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown') {
      move(1);
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowUp') {
      move(-1);
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter') {
      runActive();
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
