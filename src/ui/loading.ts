export interface LoadingOverlay {
  show(title: string, detail: string): void;
  setDetail(detail: string): void;
  hide(): void;
  fail(message: string): void;
  readonly isOpen: boolean;
}

const TEMPLATE = `
  <div class="loading" hidden>
    <div class="loading-card" data-l="card">
      <div class="loading-spinner" data-l="spinner"></div>
      <div class="loading-title" data-l="title">Opening workspace</div>
      <div class="loading-detail" data-l="detail">Scanning files…</div>
      <button class="loading-close" type="button" data-l="close" hidden>Dismiss</button>
    </div>
  </div>
`;

export function createLoadingOverlay(): LoadingOverlay {
  document.body.insertAdjacentHTML('beforeend', TEMPLATE);

  const root = document.querySelector<HTMLElement>('.loading');
  const card = document.querySelector<HTMLElement>('[data-l="card"]');
  const spinner = document.querySelector<HTMLElement>('[data-l="spinner"]');
  const title = document.querySelector<HTMLElement>('[data-l="title"]');
  const detail = document.querySelector<HTMLElement>('[data-l="detail"]');
  const close = document.querySelector<HTMLButtonElement>('[data-l="close"]');

  if (!root || !card || !spinner || !title || !detail || !close) {
    throw new Error('Failed to create loading overlay');
  }

  const hide = (): void => {
    root.hidden = true;
  };

  close.addEventListener('click', hide);

  return {
    show(nextTitle: string, nextDetail: string): void {
      root.hidden = false;
      card.classList.remove('is-error');
      spinner.hidden = false;
      close.hidden = true;
      title.textContent = nextTitle;
      detail.textContent = nextDetail;
    },

    setDetail(nextDetail: string): void {
      detail.textContent = nextDetail;
    },

    hide,

    fail(message: string): void {
      root.hidden = false;
      card.classList.add('is-error');
      spinner.hidden = true;
      close.hidden = false;
      title.textContent = 'Could not open folder';
      detail.textContent = message;
    },

    get isOpen(): boolean {
      return !root.hidden;
    },
  };
}
