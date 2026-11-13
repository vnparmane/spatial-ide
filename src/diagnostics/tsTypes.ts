export interface SemanticDiagnostic {
  /** Zero-based line index. */
  line: number;
  /** Start column in the line. */
  start: number;
  /** End column in the line. */
  end: number;
  severity: 'error' | 'warning';
  message: string;
  /** TypeScript diagnostic code, useful for filtering and debugging. */
  code: number;
}

export interface SemanticFile {
  path: string;
  text: string;
}

export interface DiagnoseRequest {
  type: 'diagnose';
  id: number;
  path: string;
  text: string;
  /** Local dependency files used to resolve relative imports. */
  files: SemanticFile[];
}

export interface DiagnoseResponse {
  type: 'diagnostics';
  id: number;
  path: string;
  diagnostics: SemanticDiagnostic[];
  error?: string;
}
