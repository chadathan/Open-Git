import * as vscode from 'vscode';
import * as nodePath from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getGitLog, GitGraphData, getCommitFiles } from './gitService';

const execFileAsync = promisify(execFile);

export class GitGraphContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const p = JSON.parse(decodeURIComponent(uri.query));
    if (p.ref === 'empty') { return ''; }
    try {
      const { stdout } = await execFileAsync('git', [
        '-C', p.repoPath, 'show', `${p.ref}:${p.filePath}`
      ]);
      return stdout;
    } catch {
      return '';
    }
  }
}

export class GraphPanel {
  private static instance: GraphPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private repoPath: string;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, repoPath: string) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.repoPath = repoPath;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Auto-refresh when HEAD changes (branch switch) or index changes (stage/unstage)
    const gitDir = vscode.Uri.file(`${repoPath}/.git`);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitDir, '{HEAD,MERGE_HEAD,index,refs/heads/**,refs/remotes/**}')
    );
    const onGitChange = () => this.refresh();
    watcher.onDidChange(onGitChange, null, this.disposables);
    watcher.onDidCreate(onGitChange, null, this.disposables);
    watcher.onDidDelete(onGitChange, null, this.disposables);
    this.disposables.push(watcher);

    this.panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (msg.command === 'ready') {
          await this.refresh();
        } else if (msg.command === 'mergeToCurrent') {
          this.runInTerminal(`git -C "${this.repoPath}" merge "${msg.source}"`);
        } else if (msg.command === 'checkoutBranch') {
          this.runInTerminal(`git -C "${this.repoPath}" stash; git -C "${this.repoPath}" checkout "${msg.branch}" && git -C "${this.repoPath}" pull --ff-only`);
        } else if (msg.command === 'checkoutDetach') {
          this.runInTerminal(`git -C "${this.repoPath}" stash; git -C "${this.repoPath}" checkout "${msg.hash}"`);
        } else if (msg.command === 'newBranch') {
          await this.checkoutNewBranch(msg.hash);
        } else if (msg.command === 'checkout') {
          await this.checkout(msg.hash);
        } else if (msg.command === 'copyHash') {
          await vscode.env.clipboard.writeText(msg.hash);
          const label = msg.hash.length <= 40 && /^[0-9a-f]+$/.test(msg.hash)
            ? msg.hash.slice(0, 8)
            : msg.hash;
          vscode.window.showInformationMessage(`Copied: ${label}`);
        } else if (msg.command === 'getFiles') {
          try {
            const files = await getCommitFiles(this.repoPath, msg.hash);
            this.panel.webview.postMessage({ command: 'files', hash: msg.hash, files });
          } catch {
            this.panel.webview.postMessage({ command: 'files', hash: msg.hash, files: [] });
          }
        } else if (msg.command === 'openDiff') {
          await this.openDiff(msg.hash, msg.parentHash, msg.path, msg.status);
        } else if (msg.command === 'getUnstagedDiff') {
          try {
            const { stdout } = await execFileAsync('git', [
              '-C', this.repoPath, 'diff', '--', msg.path
            ]);
            this.panel.webview.postMessage({ command: 'diffData', path: msg.path, unified: stdout });
          } catch {
            this.panel.webview.postMessage({ command: 'diffData', path: msg.path, unified: '' });
          }
        } else if (msg.command === 'getStagedDiff') {
          try {
            const { stdout } = await execFileAsync('git', [
              '-C', this.repoPath, 'diff', '--cached', '--', msg.path
            ]);
            this.panel.webview.postMessage({ command: 'diffData', path: msg.path, unified: stdout });
          } catch {
            this.panel.webview.postMessage({ command: 'diffData', path: msg.path, unified: '' });
          }
        } else if (msg.command === 'getDiff') {
          try {
            const parent = msg.parentHash ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
            const { stdout } = await execFileAsync('git', [
              '-C', this.repoPath, 'diff', parent, msg.hash, '--', msg.path
            ]);
            this.panel.webview.postMessage({ command: 'diffData', path: msg.path, unified: stdout });
          } catch {
            this.panel.webview.postMessage({ command: 'diffData', path: msg.path, unified: '' });
          }
        } else if (msg.command === 'stageFile') {
          try { await execFileAsync('git', ['-C', this.repoPath, 'add', '--', msg.path]); } catch {}
          await this.refresh();
        } else if (msg.command === 'unstageFile') {
          try { await execFileAsync('git', ['-C', this.repoPath, 'restore', '--staged', '--', msg.path]); } catch {}
          await this.refresh();
        } else if (msg.command === 'stageAll') {
          try { await execFileAsync('git', ['-C', this.repoPath, 'add', '-A']); } catch {}
          await this.refresh();
        } else if (msg.command === 'unstageAll') {
          try { await execFileAsync('git', ['-C', this.repoPath, 'restore', '--staged', '.']); } catch {}
          await this.refresh();
        } else if (msg.command === 'commit') {
          try {
            await execFileAsync('git', ['-C', this.repoPath, 'commit', '-m', msg.message]);
          } catch (e) {
            vscode.window.showErrorMessage(`Commit failed: ${e}`);
            return;
          }
          await this.refresh();
        } else if (msg.command === 'undo') {
          try { await execFileAsync('git', ['-C', this.repoPath, 'reset', '--soft', 'HEAD~1']); } catch {}
          await this.refresh();
        } else if (msg.command === 'redo') {
          try { await execFileAsync('git', ['-C', this.repoPath, 'reset', '--soft', 'HEAD@{1}']); } catch {}
          await this.refresh();
        } else if (msg.command === 'stash') {
          try { await execFileAsync('git', ['-C', this.repoPath, 'stash']); } catch {}
          await this.refresh();
        } else if (msg.command === 'mergeBranch') {
          const terminal = vscode.window.createTerminal({ name: 'Open Git', hideFromUser: false });
          terminal.sendText(`git -C "${this.repoPath}" checkout "${msg.target}"`);
          terminal.sendText(`git -C "${this.repoPath}" merge "${msg.source}"`);
        } else if (msg.command === 'popStash') {
          try { await execFileAsync('git', ['-C', this.repoPath, 'stash', 'pop', msg.name]); } catch {}
          await this.refresh();
        } else if (msg.command === 'dropStash') {
          const confirm = await vscode.window.showWarningMessage(
            `Delete ${msg.name}? This cannot be undone.`,
            { modal: true },
            'Delete'
          );
          if (confirm === 'Delete') {
            try { await execFileAsync('git', ['-C', this.repoPath, 'stash', 'drop', msg.name]); } catch {}
            await this.refresh();
          }
        }
      },
      null,
      this.disposables
    );

    this.panel.webview.html = this.buildHtml();
  }

  static createOrShow(extensionUri: vscode.Uri, repoPath: string) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (GraphPanel.instance) {
      GraphPanel.instance.repoPath = repoPath;
      GraphPanel.instance.panel.reveal(column);
      GraphPanel.instance.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'gitGraph',
      'Open Git',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true,
      }
    );

    GraphPanel.instance = new GraphPanel(panel, extensionUri, repoPath);
  }

  async refresh() {
    try {
      const data: GitGraphData = await getGitLog(this.repoPath);
      this.panel.webview.postMessage({ command: 'load', data });
    } catch (err: any) {
      this.panel.webview.postMessage({ command: 'error', message: err.message });
    }
  }

  private runInTerminal(cmd: string) {
    const terminal = vscode.window.createTerminal({ name: 'Open Git', hideFromUser: false });
    terminal.sendText(cmd);
  }

  private async checkoutNewBranch(hash: string) {
    const name = await vscode.window.showInputBox({ prompt: 'New branch name' });
    if (!name) { return; }
    this.runInTerminal(`git -C "${this.repoPath}" stash; git -C "${this.repoPath}" checkout -b "${name}" ${hash}`);
  }

  private async checkout(hash: string) {
    const choice = await vscode.window.showQuickPick(
      ['Checkout this commit (detached HEAD)', 'Create branch here'],
      { placeHolder: `Checkout ${hash.slice(0, 8)}` }
    );
    if (!choice) { return; }
    if (choice.startsWith('Checkout')) {
      this.runInTerminal(`git -C "${this.repoPath}" stash; git -C "${this.repoPath}" checkout ${hash}`);
    } else {
      await this.checkoutNewBranch(hash);
    }
  }

  private async openDiff(hash: string, parentHash: string | null, filePath: string, status: string) {
    const fileName = filePath.split('/').pop() ?? filePath;
    const makeUri = (ref: string) => vscode.Uri.parse(
      `git-graph:/${encodeURIComponent(fileName)}?${encodeURIComponent(JSON.stringify({ repoPath: this.repoPath, ref, filePath }))}`
    );
    const afterUri  = status === 'D' ? makeUri('empty') : makeUri(hash);
    const beforeUri = (!parentHash || status === 'A') ? makeUri('empty') : makeUri(parentHash);
    const title = `${fileName} (${hash.slice(0, 7)})`;
    await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
  }

  private mediaUri(filename: string): vscode.Uri {
    return this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', filename)
    );
  }

  private buildHtml(): string {
    const styleUri = this.mediaUri('style.css');
    const scriptUri = this.mediaUri('graph.js');
    const nonce = getNonce();

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${this.panel.webview.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Open Git</title>
</head>
<body>
  <!-- Toolbar -->
  <div id="toolbar">
    <button id="btn-sidebar-toggle" data-tip-bottom="Toggle branch panel" class="active">⊞</button>
    <div class="tb-sep"></div>
    <div class="tb-group">
      <span class="tb-label">Repo:</span>
      <select id="repo-select" class="tb-select"></select>
    </div>
    <div class="tb-sep"></div>
    <div class="tb-group">
      <span class="tb-label">Branches:</span>
      <select id="branch-filter" class="tb-select">
        <option value="">Show All</option>
      </select>
    </div>
    <div class="tb-sep"></div>
    <label class="tb-check">
      <input type="checkbox" id="show-remotes" checked>
      Show Remote Branches
    </label>
    <div id="search-wrap">
      <input id="search-input" type="text" placeholder="Search commits, authors, hashes…" autocomplete="off" spellcheck="false" />
    </div>
    <div id="toolbar-wip-actions" class="hidden">
      <button id="btn-undo" data-tip-bottom="Undo last commit">↶</button>
      <button id="btn-redo" data-tip-bottom="Redo undo">↷</button>
      <div class="tb-sep"></div>
      <button id="btn-tb-stash" data-tip-bottom="Stash all changes">Stash</button>
    </div>
    <button id="btn-refresh" data-tip-bottom="Refresh graph">↻</button>
  </div>

  <!-- Body: graph pane + detail panel -->
  <div id="body-layout">
    <!-- Left sidebar -->
    <div id="branch-sidebar">
      <div id="sb-top">
        <div id="sb-viewing">Viewing <strong id="sb-count">0</strong></div>
        <div id="sb-filter-wrap">
          <input id="sb-filter" type="text" placeholder="Filter (⌘ + Option + f)" autocomplete="off" spellcheck="false" />
        </div>
      </div>
      <div id="sb-body"></div>
    </div>
    <div id="sb-resize"></div>
    <div id="graph-pane">

      <!-- Column headers (outside scroll-wrap for fixed vertical position; sync horizontal scroll via JS) -->
      <div id="col-headers">
        <div id="col-headers-inner">
          <div class="th th-branch">Branch / Tag<span class="rh" data-col="branch"></span></div>
          <div class="th th-graph" id="th-graph">Graph<span class="rh" data-col="graph"></span></div>
          <div class="th th-msg">Commit Message<span class="rh" data-col="msg"></span></div>
          <div class="th th-author">Author<span class="rh" data-col="author"></span></div>
          <div class="th th-date">Date<span class="rh" data-col="date"></span></div>
          <div class="th th-hash">Hash<span class="rh" data-col="hash"></span></div>
        </div>
      </div>

      <!-- Scrollable area: canvas + rows -->
      <div id="scroll-wrap">
        <div id="rows-wrap">
          <div id="graph-clip-wrap"><canvas id="graph-canvas"></canvas></div>
        </div>
      </div>

    </div>

    <!-- Diff overlay (absolute, covers body-layout) -->
    <div id="diff-overlay" class="hidden">
      <div id="diff-toolbar">
        <span id="diff-file-title"></span>
        <div id="diff-mode-tabs">
          <button class="dm-btn active" data-m="split" data-tip="Side-by-side diff">Split</button>
          <button class="dm-btn" data-m="inline" data-tip="Unified inline diff">Inline</button>
          <button class="dm-btn" data-m="hunk" data-tip="Changed lines only">Hunk</button>
        </div>
        <button id="diff-back" data-tip="Close diff">✕</button>
      </div>
      <div id="diff-body"></div>
    </div>

    <!-- Detail panel (right) -->
    <div id="detail-panel" class="hidden">
      <div id="detail-resize-handle"></div>
      <div id="detail-header">
        <span>Commit Details</span>
        <button id="detail-close" data-tip="Close detail panel">✕</button>
      </div>
      <div id="detail-content"></div>
    </div>
  </div>

  <div id="status-bar"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose() {
    GraphPanel.instance = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}

function scanWorkspaceForGitRepos(): string[] {
  const results: string[] = [];
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const fp = folder.uri.fsPath;
    // If the workspace folder itself is a git repo
    if (fs.existsSync(nodePath.join(fp, '.git'))) {
      results.push(fp);
      continue;
    }
    // Scan immediate subdirectories for .git
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

export class GraphViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'git-graph.panelView';
  private _view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private repoWatcher?: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private repoPath: string,
    private repoPaths: string[] = [],
  ) {}

  get currentRepoPath(): string { return this.repoPath; }

  setRepoPaths(paths: string[]) {
    this.repoPaths = paths;
    this.sendRepoInfo();
  }

  setRepoPath(repoPath: string) {
    this.repoPath = repoPath;
    this.resetWatcher();
    this.refresh(); // refresh sends repoInfo too
  }

  private liveRepoPaths(): string[] {
    // 1. Try VS Code Git API (most accurate, but may be empty during init)
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (gitExt?.isActive) {
      const api = gitExt.exports.getAPI(1);
      if (api.repositories.length > 0) {
        const live = api.repositories.map((r: any) => r.rootUri.fsPath as string);
        this.repoPaths = live;
        return live;
      }
    }

    // 2. Filesystem scan: check workspace folders and their immediate subdirs for .git
    const found = scanWorkspaceForGitRepos();
    if (found.length > 0) {
      this.repoPaths = found;
      return found;
    }

    return this.repoPaths;
  }

  private resetWatcher() {
    if (this.repoWatcher) {
      const idx = this.disposables.indexOf(this.repoWatcher);
      if (idx >= 0) { this.disposables.splice(idx, 1); }
      this.repoWatcher.dispose();
      this.repoWatcher = undefined;
    }
    if (!this.repoPath) { return; }
    const gitDir = vscode.Uri.file(`${this.repoPath}/.git`);
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitDir, '{HEAD,MERGE_HEAD,index,refs/heads/**,refs/remotes/**}')
    );
    const onGitChange = () => this.refresh();
    watcher.onDidChange(onGitChange);
    watcher.onDidCreate(onGitChange);
    watcher.onDidDelete(onGitChange);
    this.repoWatcher = watcher;
    this.disposables.push(watcher);
  }

  private sendRepoInfo() {
    if (!this._view) { return; }
    const paths = this.liveRepoPaths();
    const repos = paths.map(p => ({ name: nodePath.basename(p), path: p }));
    this._view.webview.postMessage({
      command: 'repoInfo',
      name: this.repoPath ? nodePath.basename(this.repoPath) : '',
      path: this.repoPath,
      repos,
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      await this.handleMessage(msg);
    }, null, this.disposables);

    this.resetWatcher();

    // If repos not yet available (Git API still initializing), retry after a short delay
    if (this.liveRepoPaths().length === 0) {
      setTimeout(() => {
        const paths = this.liveRepoPaths();
        if (paths.length > 0 && !this.repoPath) {
          this.repoPath = paths[0];
          this.resetWatcher();
        }
        this.refresh();
      }, 1500);
    }

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) { this.refresh(); }
    }, null, this.disposables);
  }

  private showLoading() {
    this._view?.webview.postMessage({ command: 'loading' });
  }

  private sendToast(type: 'success' | 'error', title: string, detail?: string) {
    this._view?.webview.postMessage({ command: 'toast', type, title, detail: detail ?? '' });
  }

  async refresh() {
    if (!this._view) { return; }

    // Always send up-to-date repo list so the toolbar dropdown is correct
    this.sendRepoInfo();

    // If no repo selected yet, try to auto-pick from live repos
    if (!this.repoPath) {
      const paths = this.liveRepoPaths();
      if (paths.length > 0) {
        this.repoPath = paths[0];
        this.resetWatcher();
        this.sendRepoInfo();
      } else {
        this._view.webview.postMessage({ command: 'error', message: 'No Git repository found. Select a repository using the Repo: dropdown.' });
        return;
      }
    }

    try {
      const data: GitGraphData = await getGitLog(this.repoPath);
      this._view.webview.postMessage({ command: 'load', data });
    } catch (err: any) {
      this._view.webview.postMessage({ command: 'error', message: err.message });
    }
  }

  private runInTerminal(cmd: string) {
    const terminal = vscode.window.createTerminal({ name: 'Open Git', hideFromUser: false });
    terminal.sendText(cmd);
  }

  private async checkoutNewBranch(hash: string) {
    const name = await vscode.window.showInputBox({ prompt: 'New branch name' });
    if (!name) { return; }
    this.runInTerminal(`git -C "${this.repoPath}" stash; git -C "${this.repoPath}" checkout -b "${name}" ${hash}`);
  }

  private async openDiff(hash: string, parentHash: string | null, filePath: string, status: string) {
    const fileName = filePath.split('/').pop() ?? filePath;
    const makeUri = (ref: string) => vscode.Uri.parse(
      `git-graph:/${encodeURIComponent(fileName)}?${encodeURIComponent(JSON.stringify({ repoPath: this.repoPath, ref, filePath }))}`
    );
    const afterUri  = status === 'D' ? makeUri('empty') : makeUri(hash);
    const beforeUri = (!parentHash || status === 'A') ? makeUri('empty') : makeUri(parentHash);
    await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, `${fileName} (${hash.slice(0, 7)})`);
  }

  private async handleMessage(msg: any) {
    if (!this._view) { return; }
    const webview = this._view.webview;
    if (msg.command === 'ready') {
      await this.refresh();
    } else if (msg.command === 'switchRepo') {
      if (msg.path && msg.path !== this.repoPath) {
        this.setRepoPath(msg.path);
      }
    } else if (msg.command === 'pushBranch') {
      this.showLoading();
      try {
        const { stdout, stderr } = await execFileAsync('git', ['-C', this.repoPath, 'push', 'origin', msg.branch]);
        const out = (stdout + stderr).trim();
        this.sendToast('success', 'Pushed Successfully', out.split('\n')[0] || '');
      } catch (err: any) {
        this.sendToast('error', 'Push Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'pullBranch') {
      this.showLoading();
      try {
        const { stdout, stderr } = await execFileAsync('git', ['-C', this.repoPath, 'pull', 'origin', msg.branch]);
        const out = (stdout + stderr).trim();
        const upToDate = /already up.to.date/i.test(out);
        this.sendToast('success', upToDate ? 'Already Up-to-Date' : 'Pulled Successfully', out.split('\n')[0] || '');
      } catch (err: any) {
        this.sendToast('error', 'Pull Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'mergeToCurrent') {
      this.showLoading();
      try {
        const { stdout, stderr } = await execFileAsync('git', ['-C', this.repoPath, 'merge', msg.source]);
        const out = (stdout + stderr).trim();
        const upToDate = /already up.to.date/i.test(out);
        this.sendToast('success', upToDate ? 'Already Up-to-Date' : `Merged ${msg.source}`, out.split('\n')[0] || '');
      } catch (err: any) {
        this.sendToast('error', 'Merge Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'checkoutBranch') {
      this.showLoading();
      try { await execFileAsync('git', ['-C', this.repoPath, 'stash']); } catch {}
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'checkout', msg.branch]);

        // Check how many commits local is ahead of upstream
        let aheadCount = 0;
        try {
          const { stdout } = await execFileAsync('git', ['-C', this.repoPath, 'rev-list', '--count', '@{upstream}..HEAD']);
          aheadCount = parseInt(stdout.trim(), 10) || 0;
        } catch {}

        if (aheadCount > 0) {
          const word = aheadCount === 1 ? 'commit' : 'commits';
          const choice = await vscode.window.showWarningMessage(
            `Local '${msg.branch}' is ${aheadCount} ${word} ahead of origin. Reset to match origin/${msg.branch}?`,
            { modal: true },
            'Reset to Origin',
            'Keep Local'
          );
          if (choice === 'Reset to Origin') {
            await execFileAsync('git', ['-C', this.repoPath, 'reset', '--hard', '@{upstream}']);
            this.sendToast('success', `Reset to origin/${msg.branch}`);
          } else {
            this.sendToast('success', `Switched to ${msg.branch}`, `${aheadCount} ${word} ahead of origin`);
          }
        } else {
          let detail = '';
          try {
            const { stdout, stderr } = await execFileAsync('git', ['-C', this.repoPath, 'pull', '--ff-only']);
            const out = (stdout + stderr).trim();
            detail = /already up.to.date/i.test(out) ? 'Already up-to-date' : out.split('\n')[0];
          } catch {}
          this.sendToast('success', `Switched to ${msg.branch}`, detail);
        }
      } catch (err: any) {
        this.sendToast('error', 'Checkout Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'checkoutDetach') {
      this.showLoading();
      try { await execFileAsync('git', ['-C', this.repoPath, 'stash']); } catch {}
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'checkout', msg.hash]);
        this.sendToast('success', `Checked out ${(msg.hash as string).slice(0, 8)}`);
      } catch (err: any) {
        this.sendToast('error', 'Checkout Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'newBranch') {
      await this.checkoutNewBranch(msg.hash);
    } else if (msg.command === 'checkout') {
      this.showLoading();
      try { await execFileAsync('git', ['-C', this.repoPath, 'stash']); } catch {}
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'checkout', msg.hash]);
        this.sendToast('success', `Checked out ${(msg.hash as string).slice(0, 8)}`);
      } catch (err: any) {
        this.sendToast('error', 'Checkout Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'copyHash') {
      await vscode.env.clipboard.writeText(msg.hash);
      const label = msg.hash.length <= 40 && /^[0-9a-f]+$/.test(msg.hash) ? msg.hash.slice(0, 8) : msg.hash;
      vscode.window.showInformationMessage(`Copied: ${label}`);
    } else if (msg.command === 'getFiles') {
      try {
        const files = await getCommitFiles(this.repoPath, msg.hash);
        webview.postMessage({ command: 'files', hash: msg.hash, files });
      } catch {
        webview.postMessage({ command: 'files', hash: msg.hash, files: [] });
      }
    } else if (msg.command === 'openDiff') {
      await this.openDiff(msg.hash, msg.parentHash, msg.path, msg.status);
    } else if (msg.command === 'getUnstagedDiff') {
      try {
        const { stdout } = await execFileAsync('git', ['-C', this.repoPath, 'diff', '--', msg.path]);
        if (stdout.trim()) {
          webview.postMessage({ command: 'diffData', path: msg.path, unified: stdout });
        } else {
          // Untracked file — show full content as all-added diff
          const absPath = nodePath.join(this.repoPath, msg.path);
          const content = fs.readFileSync(absPath, 'utf-8');
          const lines = content.split('\n');
          const patch = `--- /dev/null\n+++ b/${msg.path}\n@@ -0,0 +1,${lines.length} @@\n`
            + lines.map(l => `+${l}`).join('\n') + '\n';
          webview.postMessage({ command: 'diffData', path: msg.path, unified: patch });
        }
      } catch { webview.postMessage({ command: 'diffData', path: msg.path, unified: '' }); }
    } else if (msg.command === 'getStagedDiff') {
      try {
        const { stdout } = await execFileAsync('git', ['-C', this.repoPath, 'diff', '--cached', '--', msg.path]);
        webview.postMessage({ command: 'diffData', path: msg.path, unified: stdout });
      } catch { webview.postMessage({ command: 'diffData', path: msg.path, unified: '' }); }
    } else if (msg.command === 'getDiff') {
      try {
        const parent = msg.parentHash ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
        const { stdout } = await execFileAsync('git', ['-C', this.repoPath, 'diff', parent, msg.hash, '--', msg.path]);
        webview.postMessage({ command: 'diffData', path: msg.path, unified: stdout });
      } catch { webview.postMessage({ command: 'diffData', path: msg.path, unified: '' }); }
    } else if (msg.command === 'stageFile') {
      this.showLoading();
      try { await execFileAsync('git', ['-C', this.repoPath, 'add', '--', msg.path]); } catch {}
      await this.refresh();
    } else if (msg.command === 'unstageFile') {
      this.showLoading();
      try { await execFileAsync('git', ['-C', this.repoPath, 'restore', '--staged', '--', msg.path]); } catch {}
      await this.refresh();
    } else if (msg.command === 'stageAll') {
      this.showLoading();
      try { await execFileAsync('git', ['-C', this.repoPath, 'add', '-A']); } catch {}
      await this.refresh();
    } else if (msg.command === 'unstageAll') {
      this.showLoading();
      try { await execFileAsync('git', ['-C', this.repoPath, 'restore', '--staged', '.']); } catch {}
      await this.refresh();
    } else if (msg.command === 'commit') {
      this.showLoading();
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'commit', '-m', msg.message]);
        this.sendToast('success', 'Commit Created');
      } catch (err: any) {
        this.sendToast('error', 'Commit Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'undo') {
      this.showLoading();
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'reset', '--soft', 'HEAD~1']);
        this.sendToast('success', 'Commit Undone');
      } catch (err: any) {
        this.sendToast('error', 'Undo Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'redo') {
      this.showLoading();
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'reset', '--soft', 'HEAD@{1}']);
        this.sendToast('success', 'Redo Complete');
      } catch (err: any) {
        this.sendToast('error', 'Redo Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'stash') {
      this.showLoading();
      try { await execFileAsync('git', ['-C', this.repoPath, 'stash']); } catch {}
      await this.refresh();
    } else if (msg.command === 'popStash') {
      this.showLoading();
      try { await execFileAsync('git', ['-C', this.repoPath, 'stash', 'pop', msg.name]); } catch {}
      await this.refresh();
    } else if (msg.command === 'dropStash') {
      const confirm = await vscode.window.showWarningMessage(
        `Delete ${msg.name}? This cannot be undone.`, { modal: true }, 'Delete'
      );
      if (confirm === 'Delete') {
        try { await execFileAsync('git', ['-C', this.repoPath, 'stash', 'drop', msg.name]); } catch {}
        await this.refresh();
      }
    } else if (msg.command === 'mergeBranch') {
      this.showLoading();
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'checkout', msg.target]);
        const { stdout, stderr } = await execFileAsync('git', ['-C', this.repoPath, 'merge', msg.source]);
        const out = (stdout + stderr).trim();
        const upToDate = /already up.to.date/i.test(out);
        this.sendToast('success', upToDate ? 'Already Up-to-Date' : `Merged ${msg.source} into ${msg.target}`, out.split('\n')[0] || '');
      } catch (err: any) {
        this.sendToast('error', 'Merge Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'cherryPick') {
      this.showLoading();
      try {
        const { stdout, stderr } = await execFileAsync('git', ['-C', this.repoPath, 'cherry-pick', msg.hash]);
        const out = (stdout + stderr).trim();
        this.sendToast('success', 'Cherry-pick Applied', out.split('\n')[0] || '');
      } catch (err: any) {
        this.sendToast('error', 'Cherry-pick Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'resetCommit') {
      const modeLabel: Record<string, string> = { soft: 'Soft', mixed: 'Mixed', hard: 'Hard' };
      if (msg.mode === 'hard') {
        const confirm = await vscode.window.showWarningMessage(
          `Hard reset to ${(msg.hash as string).slice(0, 8)}? All uncommitted changes will be discarded.`,
          { modal: true },
          'Reset'
        );
        if (confirm !== 'Reset') { return; }
      }
      this.showLoading();
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'reset', `--${msg.mode}`, msg.hash]);
        this.sendToast('success', `${modeLabel[msg.mode]} Reset Applied`);
      } catch (err: any) {
        this.sendToast('error', 'Reset Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'deleteLocalBranch') {
      const confirm = await vscode.window.showWarningMessage(
        `Delete local branch "${msg.branch}"?`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') { return; }
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'branch', '-d', msg.branch]);
        this.sendToast('success', `Branch "${msg.branch}" deleted`);
      } catch (err: any) {
        const detail = (err.stderr || err.stdout || err.message || '').trim();
        if (detail.includes('not fully merged')) {
          const force = await vscode.window.showWarningMessage(
            `Branch "${msg.branch}" is not fully merged. Force delete?`,
            { modal: true },
            'Force Delete'
          );
          if (force !== 'Force Delete') { return; }
          try {
            await execFileAsync('git', ['-C', this.repoPath, 'branch', '-D', msg.branch]);
            this.sendToast('success', `Branch "${msg.branch}" force deleted`);
          } catch (e2: any) {
            this.sendToast('error', 'Delete Failed', (e2.stderr || e2.message || '').trim().split('\n')[0]);
          }
        } else {
          this.sendToast('error', 'Delete Failed', detail.split('\n')[0]);
        }
      }
      await this.refresh();
    } else if (msg.command === 'deleteRemoteBranch') {
      const confirm = await vscode.window.showWarningMessage(
        `Delete remote branch "origin/${msg.branch}"?`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') { return; }
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'push', 'origin', '--delete', msg.branch]);
        this.sendToast('success', `Remote branch "${msg.branch}" deleted`);
      } catch (err: any) {
        this.sendToast('error', 'Delete Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'revertCommit') {
      this.showLoading();
      try {
        const { stdout, stderr } = await execFileAsync('git', ['-C', this.repoPath, 'revert', '--no-edit', msg.hash]);
        const out = (stdout + stderr).trim();
        this.sendToast('success', 'Commit Reverted', out.split('\n')[0] || '');
      } catch (err: any) {
        this.sendToast('error', 'Revert Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'rebaseOnto') {
      const confirm = await vscode.window.showWarningMessage(
        `Rebase current branch onto ${(msg.hash as string).slice(0, 8)}? This rewrites commit history.`,
        { modal: true },
        'Rebase'
      );
      if (confirm !== 'Rebase') { return; }
      this.showLoading();
      try {
        const { stdout, stderr } = await execFileAsync('git', ['-C', this.repoPath, 'rebase', msg.hash]);
        const out = (stdout + stderr).trim();
        this.sendToast('success', 'Rebase Complete', out.split('\n')[0] || '');
      } catch (err: any) {
        this.sendToast('error', 'Rebase Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'createTag') {
      const name = await vscode.window.showInputBox({ prompt: 'Tag name', placeHolder: 'e.g. v1.0.0' });
      if (!name) { return; }
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'tag', name, msg.hash]);
        this.sendToast('success', `Tag "${name}" created`);
      } catch (err: any) {
        this.sendToast('error', 'Create Tag Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'deleteTag') {
      const confirm = await vscode.window.showWarningMessage(
        `Delete tag "${msg.name}"?`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') { return; }
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'tag', '-d', msg.name]);
        this.sendToast('success', `Tag "${msg.name}" deleted`);
      } catch (err: any) {
        this.sendToast('error', 'Delete Tag Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'continueMerge') {
      this.showLoading();
      try {
        const { stdout, stderr } = await execFileAsync('git', ['-C', this.repoPath, 'merge', '--continue', '--no-edit']);
        const out = (stdout + stderr).trim();
        this.sendToast('success', 'Merge Completed', out.split('\n')[0] || '');
      } catch (err: any) {
        this.sendToast('error', 'Merge Continue Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    } else if (msg.command === 'abortMerge') {
      const confirm = await vscode.window.showWarningMessage(
        'Abort the current merge? All merge changes will be discarded.',
        { modal: true },
        'Abort Merge'
      );
      if (confirm !== 'Abort Merge') { return; }
      this.showLoading();
      try {
        await execFileAsync('git', ['-C', this.repoPath, 'merge', '--abort']);
        this.sendToast('success', 'Merge Aborted');
      } catch (err: any) {
        this.sendToast('error', 'Abort Failed', (err.stderr || err.stdout || err.message || '').trim().split('\n')[0]);
      }
      await this.refresh();
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'graph.js'));
    const nonce = getNonce();
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 style-src ${webview.cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Open Git</title>
</head>
<body>
  <div id="toolbar">
    <button id="btn-sidebar-toggle" data-tip-bottom="Toggle branch panel" class="active">⊞</button>
    <div class="tb-sep"></div>
    <div class="tb-group">
      <span class="tb-label">Repo:</span>
      <select id="repo-select" class="tb-select"></select>
    </div>
    <div class="tb-sep"></div>
    <div class="tb-group">
      <span class="tb-label">Branches:</span>
      <select id="branch-filter" class="tb-select">
        <option value="">Show All</option>
      </select>
    </div>
    <div class="tb-sep"></div>
    <label class="tb-check">
      <input type="checkbox" id="show-remotes" checked>
      Show Remote Branches
    </label>
    <div id="search-wrap">
      <input id="search-input" type="text" placeholder="Search commits, authors, hashes…" autocomplete="off" spellcheck="false" />
    </div>
    <div id="toolbar-wip-actions" class="hidden">
      <button id="btn-undo" data-tip-bottom="Undo last commit">↶</button>
      <button id="btn-redo" data-tip-bottom="Redo undo">↷</button>
      <div class="tb-sep"></div>
      <button id="btn-tb-stash" data-tip-bottom="Stash all changes">Stash</button>
    </div>
    <button id="btn-refresh" data-tip-bottom="Refresh graph">↻</button>
  </div>
  <div id="body-layout">
    <!-- Left sidebar -->
    <div id="branch-sidebar">
      <div id="sb-top">
        <div id="sb-viewing">Viewing <strong id="sb-count">0</strong></div>
        <div id="sb-filter-wrap">
          <input id="sb-filter" type="text" placeholder="Filter (⌘ + Option + f)" autocomplete="off" spellcheck="false" />
        </div>
      </div>
      <div id="sb-body"></div>
    </div>
    <div id="sb-resize"></div>
    <div id="graph-pane">
      <div id="col-headers">
        <div id="col-headers-inner">
          <div class="th th-branch">Branch / Tag<span class="rh" data-col="branch"></span></div>
          <div class="th th-graph" id="th-graph">Graph<span class="rh" data-col="graph"></span></div>
          <div class="th th-msg">Commit Message<span class="rh" data-col="msg"></span></div>
          <div class="th th-author">Author<span class="rh" data-col="author"></span></div>
          <div class="th th-date">Date<span class="rh" data-col="date"></span></div>
          <div class="th th-hash">Hash<span class="rh" data-col="hash"></span></div>
        </div>
      </div>
      <div id="scroll-wrap">
        <div id="rows-wrap">
          <div id="graph-clip-wrap"><canvas id="graph-canvas"></canvas></div>
        </div>
      </div>
    </div>
    <div id="diff-overlay" class="hidden">
      <div id="diff-toolbar">
        <span id="diff-file-title"></span>
        <div id="diff-mode-tabs">
          <button class="dm-btn active" data-m="split" data-tip="Side-by-side diff">Split</button>
          <button class="dm-btn" data-m="inline" data-tip="Unified inline diff">Inline</button>
          <button class="dm-btn" data-m="hunk" data-tip="Changed lines only">Hunk</button>
        </div>
        <button id="diff-back" data-tip="Close diff">✕</button>
      </div>
      <div id="diff-body"></div>
    </div>
    <div id="detail-panel" class="hidden">
      <div id="detail-resize-handle"></div>
      <div id="detail-header">
        <span>Commit Details</span>
        <button id="detail-close" data-tip="Close detail panel">✕</button>
      </div>
      <div id="detail-content"></div>
    </div>
  </div>
  <div id="loading-overlay" class="hidden">
    <div class="spinner"></div>
  </div>
  <div id="toast-container"></div>
  <div id="status-bar"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
