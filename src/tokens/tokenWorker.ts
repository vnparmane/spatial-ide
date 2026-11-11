import { Language, Parser, type Node as SyntaxNode } from 'web-tree-sitter';
import coreWasmUrl from 'web-tree-sitter/tree-sitter.wasm?url';
import cssWasmUrl from 'tree-sitter-wasms/out/tree-sitter-css.wasm?url';
import htmlWasmUrl from 'tree-sitter-wasms/out/tree-sitter-html.wasm?url';
import javascriptWasmUrl from 'tree-sitter-wasms/out/tree-sitter-javascript.wasm?url';
import jsonWasmUrl from 'tree-sitter-wasms/out/tree-sitter-json.wasm?url';
import rustWasmUrl from 'tree-sitter-wasms/out/tree-sitter-rust.wasm?url';
import tsxWasmUrl from 'tree-sitter-wasms/out/tree-sitter-tsx.wasm?url';
import typescriptWasmUrl from 'tree-sitter-wasms/out/tree-sitter-typescript.wasm?url';
import type { Language as WorkspaceLanguage } from '../workspace/types';
import type {
  Diagnostic,
  TokenizeRequest,
  TokenizeResponse,
  TokenKind,
  TokenRun,
} from './tokenTypes';

const GRAMMAR_URLS: Partial<Record<WorkspaceLanguage, string>> = {
  ts: typescriptWasmUrl,
  tsx: tsxWasmUrl,
  js: javascriptWasmUrl,
  jsx: javascriptWasmUrl,
  css: cssWasmUrl,
  json: jsonWasmUrl,
  rust: rustWasmUrl,
  html: htmlWasmUrl,
};

// L2 panels only ever show the first few dozen lines, so parsing the whole file
// would waste time and memory for large documents.
const MAX_TOKEN_LINE = 180;
const MAX_TOKEN_RUNS = 6000;
const MAX_DIAGNOSTICS = 200;
const MAX_DIAGNOSTIC_NODES = 250_000;

const KEYWORDS = new Set([
  'import',
  'export',
  'from',
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'class',
  'extends',
  'implements',
  'interface',
  'type',
  'enum',
  'new',
  'await',
  'async',
  'public',
  'private',
  'protected',
  'readonly',
  'static',
  'this',
  'super',
  'throw',
  'try',
  'catch',
  'finally',
  'switch',
  'case',
  'break',
  'continue',
  'default',
  'typeof',
  'instanceof',
  'in',
  'of',
  'as',
  'satisfies',
  'declare',
  'namespace',
  'abstract',
  'override',
  'get',
  'set',
  'void',
  'yield',
  'delete',
  'with',
  'debugger',
  'true',
  'false',
  'null',
  'undefined',
  'use',
  'pub',
  'struct',
  'impl',
  'fn',
  'mut',
  'match',
  'mod',
  'crate',
  'where',
  'trait',
  'dyn',
  'ref',
  'loop',
  'move',
  'unsafe',
  'extern',
  'self',
  'Self',
]);

function classify(type: string): TokenKind | null {
  if (type.includes('comment')) return 'comment';
  if (type.includes('string') || type === 'char_literal' || type === 'quoted_attribute_value') {
    return 'string';
  }
  if (
    type === 'number' ||
    type === 'integer' ||
    type === 'float' ||
    type === 'number_literal' ||
    type.endsWith('_integer')
  ) {
    return 'number';
  }
  if (type.endsWith('_literal')) {
    return type.includes('string') || type.includes('char') ? 'string' : 'number';
  }
  if (KEYWORDS.has(type)) return 'keyword';
  if (
    type === 'type_identifier' ||
    type === 'predefined_type' ||
    type === 'primitive_type' ||
    type === 'builtin_type' ||
    type === 'tag_name' ||
    type === 'class_name' ||
    type === 'id_name' ||
    type === 'nesting_selector'
  ) {
    return 'type';
  }
  if (
    type === 'property_identifier' ||
    type === 'field_identifier' ||
    type === 'shorthand_property_identifier' ||
    type === 'property_name' ||
    type === 'function_name' ||
    type === 'attribute_name'
  ) {
    return 'property';
  }
  if (
    type === 'identifier' ||
    type === 'variable_name' ||
    type === 'constant' ||
    type === 'text'
  ) {
    return 'identifier';
  }
  if (
    type === 'plain_value' ||
    type === 'color_value' ||
    type === 'integer_value' ||
    type === 'float_value' ||
    type === 'unit'
  ) {
    return 'number';
  }
  if (type === 'doctype') return 'comment';
  return null;
}

function collectRuns(root: SyntaxNode): TokenRun[] {
  const runs: TokenRun[] = [];
  let done = false;

  const visit = (node: SyntaxNode): void => {
    if (done) return;
    if (node.startPosition.row > MAX_TOKEN_LINE || runs.length >= MAX_TOKEN_RUNS) {
      done = true;
      return;
    }

    if (node.childCount === 0) {
      const kind = classify(node.type);
      if (!kind) return;
      const start = node.startPosition.column;
      const end = node.endPosition.column;
      if (end > start) {
        runs.push({ line: node.startPosition.row, start, end, kind });
      }
      return;
    }

    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (child) visit(child);
    }
  };

  visit(root);
  return runs;
}

function snippet(text: string, start: number, end: number): string {
  const raw = text
    .slice(start, Math.min(end, start + 48))
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  return ` near "${raw.length > 40 ? `${raw.slice(0, 40)}…` : raw}"`;
}

/**
 * Collects tree-sitter ERROR and missing nodes. Nested errors inside an outer
 * ERROR are skipped to keep the list readable; the outer node is enough.
 */
function collectDiagnostics(root: SyntaxNode, text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let visited = 0;

  const visit = (node: SyntaxNode, insideError: boolean): void => {
    if (diagnostics.length >= MAX_DIAGNOSTICS || visited >= MAX_DIAGNOSTIC_NODES) return;
    visited += 1;

    const isError = node.isError;
    if ((isError || node.isMissing) && !insideError) {
      const startRow = node.startPosition.row;
      const startColumn = node.startPosition.column;
      let endColumn: number;

      if (isError && node.endPosition.row > startRow) {
        // Underline to the end of the first line for multi-line errors.
        const newline = text.indexOf('\n', node.startIndex);
        endColumn =
          newline === -1
            ? text.length - node.startIndex + startColumn
            : newline - node.startIndex + startColumn;
      } else {
        endColumn = Math.max(startColumn + 1, node.endPosition.column);
      }

      diagnostics.push({
        line: startRow,
        start: startColumn,
        end: endColumn,
        severity: 'error',
        message: isError
          ? `Unexpected syntax${snippet(text, node.startIndex, node.endIndex)}`
          : `Missing ${node.type}`,
      });
    }

    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      if (child) visit(child, insideError || isError);
    }
  };

  visit(root, false);
  return diagnostics;
}

let initPromise: Promise<void> | null = null;
const languages = new Map<WorkspaceLanguage, Promise<Language>>();

function init(): Promise<void> {
  initPromise ??= Parser.init({ locateFile: () => coreWasmUrl });
  return initPromise;
}

function loadLanguage(language: WorkspaceLanguage): Promise<Language> {
  let pending = languages.get(language);
  if (!pending) {
    const url = GRAMMAR_URLS[language];
    if (!url) return Promise.reject(new Error(`No tree-sitter grammar for ${language}`));
    pending = init().then(() => Language.load(url));
    languages.set(language, pending);
  }
  return pending;
}

const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<TokenizeRequest>) => void) | null;
  postMessage: (message: TokenizeResponse) => void;
};

workerScope.onmessage = (event: MessageEvent<TokenizeRequest>): void => {
  const request = event.data;
  if (request.type !== 'tokenize') return;

  void (async () => {
    try {
      const language = await loadLanguage(request.language);
      const parser = new Parser();
      try {
        parser.setLanguage(language);
        const tree = parser.parse(request.text);
        if (!tree) throw new Error('Parser returned no tree');
        try {
          const diagnostics = collectDiagnostics(tree.rootNode, request.text);
          const runs = collectRuns(tree.rootNode);
          workerScope.postMessage({
            type: 'tokens',
            id: request.id,
            path: request.path,
            runs,
            diagnostics,
          });
        } finally {
          tree.delete();
        }
      } finally {
        parser.delete();
      }
    } catch (error) {
      workerScope.postMessage({
        type: 'tokens',
        id: request.id,
        path: request.path,
        runs: [],
        diagnostics: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
