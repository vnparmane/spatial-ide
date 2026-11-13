import ts from 'typescript';
import type { DiagnoseRequest, DiagnoseResponse, SemanticDiagnostic } from './tsTypes';

/**
 * Bundles the TypeScript standard library into the worker. All `lib.*.d.ts`
 * files are included so `/// <reference lib="…" />` chains resolve offline.
 */
const libModules = import.meta.glob('../../node_modules/typescript/lib/lib.*.d.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const VIRTUAL_ROOT = '/workspace';
const LIB_DIR = '/lib';

const libFiles = new Map<string, string>();
for (const [key, text] of Object.entries(libModules)) {
  const name = key.slice(key.lastIndexOf('/') + 1);
  libFiles.set(`${LIB_DIR}/${name}`, text);
}

/** Diagnostics that only mean "this project's dependencies are not bundled". */
const IGNORED_CODES = new Set([
  2307, // Cannot find module
  2688, // Cannot find type definition file
  2580, // Cannot find name 'require'
  2581, // Cannot find name 'process'
  2591, // Cannot find name 'module'
  2792, // Cannot find module (did you mean to set moduleResolution?)
  7016, // Could not find a declaration file
  7026, // JSX element implicitly has type 'any' (no React types)
]);

const MAX_DIAGNOSTICS = 60;

const fileMap = new Map<string, string>();
const versions = new Map<string, number>();
let service: ts.LanguageService | null = null;
let versionCounter = 1;

function toVirtual(path: string): string {
  const clean = path.replace(/^\.?\//, '');
  return `${VIRTUAL_ROOT}/${clean}`;
}

function normalizePath(path: string): string {
  const segments = path.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return `/${out.join('/')}`;
}

function libText(fileName: string): string | undefined {
  return libFiles.get(fileName);
}

function resolveModule(
  moduleName: string,
  containingFile: string,
): ts.ResolvedModule | undefined {
  if (!moduleName.startsWith('.')) return undefined;

  const directory = containingFile.slice(0, containingFile.lastIndexOf('/'));
  const base = normalizePath(`${directory}/${moduleName}`);
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json'];
  const candidates = [base];
  for (const extension of extensions) candidates.push(`${base}${extension}`);
  for (const extension of extensions) candidates.push(`${base}/index${extension}`);

  for (const candidate of candidates) {
    if (fileMap.has(candidate)) {
      return {
        resolvedFileName: candidate,
        isExternalLibraryImport: false,
      };
    }
  }
  return undefined;
}

function createService(): ts.LanguageService {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    checkJs: false,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    forceConsistentCasingInFileNames: true,
    types: [],
  };

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...fileMap.keys()],
    getScriptVersion: (fileName) => String(versions.get(fileName) ?? 0),
    getScriptSnapshot: (fileName) => {
      const text = fileMap.get(fileName) ?? libText(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getCompilationSettings: () => options,
    getDefaultLibFileName: () => `${LIB_DIR}/lib.es2022.d.ts`,
    fileExists: (fileName) => fileMap.has(fileName) || libText(fileName) !== undefined,
    readFile: (fileName) => fileMap.get(fileName) ?? libText(fileName),
    readDirectory: () => [],
    directoryExists: (directory) =>
      directory === VIRTUAL_ROOT ||
      directory.startsWith(`${VIRTUAL_ROOT}/`) ||
      directory === LIB_DIR ||
      directory.startsWith(`${LIB_DIR}/`),
    getDirectories: () => [],
    resolveModuleNames: (moduleNames, containingFile) =>
      moduleNames.map((moduleName) => resolveModule(moduleName, containingFile)),
  };

  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

function updateFiles(request: DiagnoseRequest): string {
  const rootPath = toVirtual(request.path);
  const next = new Map<string, string>();
  next.set(rootPath, request.text);
  for (const file of request.files) {
    next.set(toVirtual(file.path), file.text);
  }

  for (const [path, text] of next) {
    if (fileMap.get(path) !== text) {
      versions.set(path, versionCounter);
      versionCounter += 1;
    }
  }
  for (const path of fileMap.keys()) {
    if (!next.has(path)) versions.delete(path);
  }

  fileMap.clear();
  for (const [path, text] of next) fileMap.set(path, text);
  return rootPath;
}

function diagnose(request: DiagnoseRequest): SemanticDiagnostic[] {
  const rootPath = updateFiles(request);
  service ??= createService();

  const source = service.getProgram()?.getSourceFile(rootPath);
  if (!source) throw new Error(`TypeScript could not load ${request.path}`);

  const lineStarts = source.getLineStarts();
  const diagnostics: SemanticDiagnostic[] = [];
  for (const diagnostic of service.getSemanticDiagnostics(rootPath)) {
    if (diagnostics.length >= MAX_DIAGNOSTICS) break;
    if (diagnostic.category === ts.DiagnosticCategory.Suggestion) continue;
    if (diagnostic.category === ts.DiagnosticCategory.Message) continue;
    if (diagnostic.code !== undefined && IGNORED_CODES.has(diagnostic.code)) continue;
    if (diagnostic.start === undefined || diagnostic.length === undefined) continue;

    const start = ts.getLineAndCharacterOfPosition(source, diagnostic.start);
    const end = ts.getLineAndCharacterOfPosition(source, diagnostic.start + diagnostic.length);
    const lineStart = lineStarts[start.line] ?? 0;
    const lineEnd =
      start.line + 1 < lineStarts.length ? lineStarts[start.line + 1] - 1 : source.text.length;
    const endColumn = end.line === start.line ? end.character : lineEnd - lineStart;

    diagnostics.push({
      line: start.line,
      start: start.character,
      end: Math.max(start.character + 1, endColumn),
      severity:
        diagnostic.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error',
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      code: diagnostic.code,
    });
  }
  return diagnostics;
}

self.onmessage = (event: MessageEvent<DiagnoseRequest>) => {
  const request = event.data;
  if (request.type !== 'diagnose') return;

  try {
    const diagnostics = diagnose(request);
    const response: DiagnoseResponse = {
      type: 'diagnostics',
      id: request.id,
      path: request.path,
      diagnostics,
    };
    self.postMessage(response);
  } catch (error) {
    const response: DiagnoseResponse = {
      type: 'diagnostics',
      id: request.id,
      path: request.path,
      diagnostics: [],
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};
