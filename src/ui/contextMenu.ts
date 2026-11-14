export interface ContextMenuAction {
  label: string;
  /** Display-only key hint, e.g. "F2". */
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  run(): void | Promise<void>;
}

export interface ContextMenuSeparator {
  separator: true;
}

export type ContextMenuEntry = ContextMenuAction | ContextMenuSeparator;

export interface ContextMenu {
  open(entries: readonly ContextMenuEntry[], x: number, y: number): void;
  close(): void;
  readonly isOpen: boolean;
}

function isSeparator(entry: ContextMenuEntry): entry is ContextMenuSeparator {
  return 'separator' in entry;
}

/**
 * Small floating menu used for panel actions. It is modal for keyboard
 * shortcuts while open, but clicking outside closes it and lets the click
 * continue to the canvas.
 */
export function createContextMenu(): ContextMenu {
  const root = document.createElement('div');
  root.className = 'context-menu';
  root.hidden = true;
  root.tabIndex = -1;
  root.setAttribute('role', 'menu');
  root.setAttribute('aria-label', 'Panel actions');
  document.body.appendChild(root);

  let entries: readonly ContextMenuEntry[] = [];
  let activeIndex = -1;
  let open = false;

  const enabledIndices = (): number[] => {
    const indices: number[] = [];
    entries.forEach((entry, index) => {
      if (!isSeparator(entry) && !entry.disabled) indices.push(index);
    });
    return indices;
  };

  const setActive = (index: number): void => {
    activeIndex = index;
    for (const button of root.querySelectorAll<HTMLButtonElement>('.context-item')) {
      const buttonIndex = Number(button.dataset.entry);
      button.classList.toggle('is-active', buttonIndex === activeIndex);
    }
    root
      .querySelector<HTMLButtonElement>('.context-item.is-active')
      ?.scrollIntoView({ block: 'nearest' });
  };

  const move = (delta: number): void => {
    const indices = enabledIndices();
    if (indices.length === 0) return;
    const current = indices.indexOf(activeIndex);
    const next =
      current < 0
        ? delta > 0
          ? 0
          : indices.length - 1
        : (current + delta + indices.length) % indices.length;
    setActive(indices[next]);
  };

  const run = (entry: ContextMenuAction): void => {
    if (entry.disabled) return;
    close();
    void Promise.resolve(entry.run()).catch((error) => {
      console.error(`Context action failed: ${entry.label}`, error);
    });
  };

  const runActive = (): void => {
    const entry = entries[activeIndex];
    if (entry && !isSeparator(entry)) run(entry);
  };

  const render = (): void => {
    const fragment = document.createDocumentFragment();

    entries.forEach((entry, index) => {
      if (isSeparator(entry)) {
        const separator = document.createElement('div');
        separator.className = 'context-separator';
        separator.setAttribute('role', 'separator');
        fragment.appendChild(separator);
        return;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'context-item';
      button.dataset.entry = String(index);
      button.disabled = Boolean(entry.disabled);
      button.setAttribute('role', 'menuitem');
      if (entry.danger) button.classList.add('is-danger');

      const label = document.createElement('span');
      label.className = 'context-label';
      label.textContent = entry.label;
      button.appendChild(label);

      if (entry.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'context-shortcut';
        shortcut.textContent = entry.shortcut;
        button.appendChild(shortcut);
      }

      button.addEventListener('mouseenter', () => {
        if (!entry.disabled) setActive(index);
      });
      button.addEventListener('click', () => run(entry));
      fragment.appendChild(button);
    });

    root.replaceChildren(fragment);
  };

  const position = (x: number, y: number): void => {
    root.style.left = '0px';
    root.style.top = '0px';
    root.hidden = false;
    const rect = root.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (!(event.target instanceof Node) || !root.contains(event.target)) close();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!open) return;
    // Keep shortcuts from reaching the canvas, HUD, and global handlers.
    event.stopPropagation();

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close();
        break;
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActive(enabledIndices()[0] ?? -1);
        break;
      case 'End': {
        event.preventDefault();
        const indices = enabledIndices();
        setActive(indices[indices.length - 1] ?? -1);
        break;
      }
      case 'Enter':
      case ' ':
        event.preventDefault();
        runActive();
        break;
      case 'Tab':
        event.preventDefault();
        close();
        break;
      default:
        break;
    }
  };

  const onDismiss = (): void => close();
  const onWheel = (): void => close();

  function close(): void {
    if (!open) return;
    open = false;
    root.hidden = true;
    root.replaceChildren();
    entries = [];
    activeIndex = -1;
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('wheel', onWheel, true);
    window.removeEventListener('blur', onDismiss);
    window.removeEventListener('resize', onDismiss);
  }

  return {
    open(nextEntries: readonly ContextMenuEntry[], x: number, y: number): void {
      close();
      entries = nextEntries;
      activeIndex = -1;
      open = true;
      render();
      position(x, y);
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('wheel', onWheel, true);
      window.addEventListener('blur', onDismiss);
      window.addEventListener('resize', onDismiss);
      const first = enabledIndices()[0] ?? -1;
      setActive(first);
      root.focus({ preventScroll: true });
    },
    close,
    get isOpen(): boolean {
      return open;
    },
  };
}
