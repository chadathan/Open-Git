import * as vscode from 'vscode';
import * as nodePath from 'path';
import * as fs from 'fs';
import { GraphViewProvider, GitGraphContentProvider } from './graphPanel';
import { getLineBlame } from './gitService';

export function activate(context: vscode.ExtensionContext) {
  const allPaths = getAllRepoPaths();
  const activePath = getActiveRepoPath(allPaths);
  const provider = new GraphViewProvider(context.extensionUri, activePath, allPaths);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GraphViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Subscribe to Git API events so repos picked up after our extension activates
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (gitExt?.isActive) {
    const api = gitExt.exports.getAPI(1);
    const onRepoChange = () => {
      const paths = getAllRepoPaths();
      provider.setRepoPaths(paths);
      // If current path is not a real git repo (e.g. still the workspace-folder fallback),
      // switch to the best match for the active editor
      if (!paths.includes(provider.currentRepoPath)) {
        provider.setRepoPath(getActiveRepoPath(paths));
      } else {
        // Just refresh tabs without switching
        provider.setRepoPaths(paths);
      }
    };
    context.subscriptions.push(api.onDidOpenRepository(onRepoChange));
    context.subscriptions.push(api.onDidCloseRepository(onRepoChange));
  }

  // Auto-switch repo when active editor changes to a file in a different repo
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      const paths = getAllRepoPaths();
      const active = getActiveRepoPath(paths);
      if (active && active !== provider.currentRepoPath) {
        provider.setRepoPaths(paths);
        provider.setRepoPath(active);
      }
    })
  );

  // Re-scan repos when workspace folders change
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const paths = getAllRepoPaths();
      provider.setRepoPaths(paths);
    })
  );

  const cmd = vscode.commands.registerCommand('git-graph.showGraph', async () => {
    const paths = getAllRepoPaths();
    if (paths.length === 0) {
      vscode.window.showErrorMessage('Git Graph: No Git repository found in workspace.');
      return;
    }
    provider.setRepoPaths(paths);
    provider.setRepoPath(getActiveRepoPath(paths));
    vscode.commands.executeCommand('git-graph.panelView.focus');
  });

  context.subscriptions.push(cmd);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('git-graph', new GitGraphContentProvider())
  );

  const blame = new BlameController(getAllRepoPaths);
  context.subscriptions.push({ dispose: () => blame.dispose() });
}

function getAllRepoPaths(): string[] {
  // 1. VS Code Git API (most accurate)
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (gitExt?.isActive) {
    const api = gitExt.exports.getAPI(1);
    if (api.repositories.length > 0) {
      return api.repositories.map((r: any) => r.rootUri.fsPath as string);
    }
  }
  // 2. Filesystem scan: workspace folders + their immediate subdirectories
  const results: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const fp = folder.uri.fsPath;
    if (fs.existsSync(nodePath.join(fp, '.git'))) {
      results.push(fp);
      continue;
    }
    try {
      for (const entry of fs.readdirSync(fp, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const sub = nodePath.join(fp, entry.name);
          if (fs.existsSync(nodePath.join(sub, '.git'))) {
            results.push(sub);
          }
        }
      }
    } catch {}
  }
  return results;
}

function getActiveRepoPath(allPaths: string[]): string {
  if (allPaths.length === 0) { return ''; }
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activeFile) {
    const match = allPaths
      .filter(p => activeFile.startsWith(p + nodePath.sep) || activeFile === p)
      .sort((a, b) => b.length - a.length)[0];
    if (match) { return match; }
  }
  return allPaths[0];
}

export function deactivate() {}


class BlameController {
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly getRepoPaths: () => string[]) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: false,
      after: {
        contentText: '',
        color: new vscode.ThemeColor('editorGhostText.foreground'),
        fontStyle: 'italic',
        margin: '0 0 0 3em',
      },
    });
    this.disposables.push(this.decorationType);

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
    this.statusBar.show();
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(e => this.schedule(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(e => { if (e) { this.schedule(e); } }),
      vscode.workspace.onDidChangeTextDocument(e => {
        const editor = vscode.window.activeTextEditor;
        if (editor && e.document === editor.document) { this.clearDec(); }
      }),
    );
    if (vscode.window.activeTextEditor) { this.schedule(vscode.window.activeTextEditor); }
  }

  private clearDec() {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decorationType, []);
    }
  }

  private schedule(editor: vscode.TextEditor) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.update(editor), 150);
  }

  private updateSeq = 0;

  private async update(editor: vscode.TextEditor) {
    const seq = ++this.updateSeq;
    const doc = editor.document;
    this.statusBar.text = '';

    if (doc.isUntitled || doc.uri.scheme !== 'file') { this.clearDec(); return; }

    const filePath = doc.uri.fsPath;
    const repoPath = this.getRepoPaths()
      .filter(p => filePath.startsWith(p + '/') || filePath.startsWith(p + nodePath.sep))
      .sort((a, b) => b.length - a.length)[0];
    if (!repoPath) { this.clearDec(); return; }

    const line = editor.selection.active.line;
    const blame = await getLineBlame(repoPath, filePath, line + 1);

    // discard if a newer update started while we were awaiting
    if (seq !== this.updateSeq) { return; }
    if (editor !== vscode.window.activeTextEditor) { return; }
    if (!blame) { this.clearDec(); return; }

    const text = blame.isUncommitted
      ? 'Uncommitted changes'
      : `${blame.author}, ${timeAgo(blame.date)} · ${blame.summary}`;

    this.statusBar.text = `$(git-commit) ${text}`;

    this.clearDec();

    console.log('[OpenGit] target editor:', editor.document.uri.fsPath, 'viewColumn:', editor.viewColumn);
    const targetLine = editor.selection.active.line;
    const lineText = editor.document.lineAt(targetLine);
    const range = new vscode.Range(targetLine, lineText.text.length, targetLine, lineText.text.length);
    console.log('[OpenGit] setDecorations line:', targetLine, 'range:', range.start.character, '-', range.end.character);
    editor.setDecorations(this.decorationType, [{
      range: range,
      renderOptions: {
        after: {
          contentText: ` • ${text}`,
        },
      },
    }]);
    this.statusBar.text += ` [L${targetLine + 1}]`;
  }

  dispose() {
    clearTimeout(this.timer);
    this.clearDec();
    this.statusBar.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}

function timeAgo(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60)               { return 'just now'; }
  if (s < 3600)             { return `${Math.floor(s / 60)}m ago`; }
  if (s < 86400)            { return `${Math.floor(s / 3600)}h ago`; }
  if (s < 86400 * 30)       { return `${Math.floor(s / 86400)}d ago`; }
  if (s < 86400 * 365)      { return `${Math.floor(s / (86400 * 30))}mo ago`; }
  return `${Math.floor(s / (86400 * 365))}y ago`;
}
