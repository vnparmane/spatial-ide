import type { Language } from '../workspace/types';

export type TokenKind =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'type'
  | 'property'
  | 'identifier'
  | 'plain';

export interface TokenRun {
  /** Zero-based line index. */
  line: number;
  /** Start column in the line. */
  start: number;
  /** End column in the line. */
  end: number;
  kind: TokenKind;
}

export interface Diagnostic {
  /** Zero-based line index. */
  line: number;
  /** Start column in the line. */
  start: number;
  /** End column in the line. */
  end: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface TokenizeRequest {
  type: 'tokenize';
  id: number;
  path: string;
  language: Language;
  text: string;
}

export interface TokenizeResponse {
  type: 'tokens';
  id: number;
  path: string;
  runs: TokenRun[];
  diagnostics?: Diagnostic[];
  error?: string;
}

/** Languages with a prebuilt tree-sitter WASM grammar in the bundle. */
export const TOKEN_LANGUAGES: ReadonlySet<Language> = new Set<Language>([
  'ts',
  'tsx',
  'js',
  'jsx',
  'css',
  'json',
  'rust',
  'html',
]);
