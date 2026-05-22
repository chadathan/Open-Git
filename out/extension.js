"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const nodePath = require("path");
const fs = require("fs");
const graphPanel_1 = require("./graphPanel");
function activate(context) {
    const allPaths = getAllRepoPaths();
    const activePath = getActiveRepoPath(allPaths);
    const provider = new graphPanel_1.GraphViewProvider(context.extensionUri, activePath, allPaths);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(graphPanel_1.GraphViewProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
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
            }
            else {
                // Just refresh tabs without switching
                provider.setRepoPaths(paths);
            }
        };
        context.subscriptions.push(api.onDidOpenRepository(onRepoChange));
        context.subscriptions.push(api.onDidCloseRepository(onRepoChange));
    }
    // Auto-switch repo when active editor changes to a file in a different repo
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
        const paths = getAllRepoPaths();
        const active = getActiveRepoPath(paths);
        if (active && active !== provider.currentRepoPath) {
            provider.setRepoPaths(paths);
            provider.setRepoPath(active);
        }
    }));
    // Re-scan repos when workspace folders change
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        const paths = getAllRepoPaths();
        provider.setRepoPaths(paths);
    }));
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
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('git-graph', new graphPanel_1.GitGraphContentProvider()));
}
function getAllRepoPaths() {
    // 1. VS Code Git API (most accurate)
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (gitExt?.isActive) {
        const api = gitExt.exports.getAPI(1);
        if (api.repositories.length > 0) {
            return api.repositories.map((r) => r.rootUri.fsPath);
        }
    }
    // 2. Filesystem scan: workspace folders + their immediate subdirectories
    const results = [];
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
        }
        catch { }
    }
    return results;
}
function getActiveRepoPath(allPaths) {
    if (allPaths.length === 0) {
        return '';
    }
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeFile) {
        const match = allPaths
            .filter(p => activeFile.startsWith(p + nodePath.sep) || activeFile === p)
            .sort((a, b) => b.length - a.length)[0];
        if (match) {
            return match;
        }
    }
    return allPaths[0];
}
function deactivate() { }
//# sourceMappingURL=extension.js.map