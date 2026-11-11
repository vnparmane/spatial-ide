export type Language =
  | 'ts'
  | 'tsx'
  | 'js'
  | 'jsx'
  | 'css'
  | 'json'
  | 'md'
  | 'rust'
  | 'html'
  | 'other';

export type GitStatus = 'clean' | 'modified' | 'added' | 'deleted';

export interface Panel {
  /** Stable index into Workspace.panels. */
  id: number;
  /** Stable identity derived from the workspace-relative path. */
  docId: string;
  path: string;
  name: string;
  language: Language;
  /** World-space geometry. */
  x: number;
  y: number;
  w: number;
  h: number;
  groupId: number;
  lines: number;
  git: GitStatus;
  dirty: boolean;
}

export interface Group {
  id: number;
  name: string;
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  panelIds: number[];
  /** Muted accent used for the group frame and its panels. */
  color: [number, number, number];
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Workspace {
  rootPath: string;
  panels: Panel[];
  groups: Group[];
  bounds: Bounds;
}

export const LANGUAGE_LABEL: Record<Language, string> = {
  ts: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  jsx: 'JSX',
  css: 'CSS',
  json: 'JSON',
  md: 'Markdown',
  rust: 'Rust',
  html: 'HTML',
  other: 'Text',
};

export const LANGUAGE_COLOR: Record<Language, [number, number, number]> = {
  ts: [48, 104, 176],
  tsx: [36, 148, 166],
  js: [198, 168, 56],
  jsx: [198, 142, 44],
  css: [148, 88, 196],
  json: [122, 132, 148],
  md: [154, 158, 170],
  rust: [200, 112, 58],
  html: [214, 96, 66],
  other: [104, 112, 126],
};
