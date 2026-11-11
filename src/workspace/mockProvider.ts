import { generateMockContent } from './mockContent';
import type { ScanProgress, WorkspaceProvider } from './provider';
import type { Panel, Workspace } from './types';

/**
 * In-memory provider for the mock workspace. Generates deterministic file
 * contents on first read and keeps edits in memory so the editor pipeline can
 * be exercised without a real folder.
 */
export class MockProvider implements WorkspaceProvider {
  readonly name: string;
  private readonly workspace: Workspace;
  private readonly panelsByPath = new Map<string, Panel>();
  private readonly content = new Map<string, string>();

  constructor(workspace: Workspace) {
    this.workspace = workspace;
    this.name = workspace.rootPath;
    for (const panel of workspace.panels) {
      this.panelsByPath.set(panel.path, panel);
    }
  }

  async load(onProgress?: (progress: ScanProgress) => void): Promise<Workspace> {
    onProgress?.({
      phase: 'done',
      files: this.workspace.panels.length,
      folders: this.workspace.groups.length,
    });
    return this.workspace;
  }

  async readText(path: string): Promise<string | null> {
    const cached = this.content.get(path);
    if (cached !== undefined) return cached;

    const panel = this.panelsByPath.get(path);
    if (!panel) return null;

    const text = generateMockContent(panel);
    this.content.set(path, text);
    return text;
  }

  async writeText(path: string, content: string): Promise<void> {
    if (!this.panelsByPath.has(path)) throw new Error(`Unknown file: ${path}`);
    this.content.set(path, content);
  }
}
