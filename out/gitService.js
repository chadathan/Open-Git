"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BRANCH_COLORS = void 0;
exports.getGitLog = getGitLog;
exports.getCommitFiles = getCommitFiles;
const child_process_1 = require("child_process");
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const SEP = '\x1f';
const REC = '\x1e';
async function getGitLog(repoPath, limit = 300) {
    const format = [
        '%H', // hash
        '%P', // parents (space separated)
        '%s', // subject
        '%an', // author name
        '%ae', // author email
        '%ci', // commit date iso
        '%D', // ref names
    ].join(SEP);
    const { stdout } = await execFileAsync('git', [
        '-C', repoPath,
        'log',
        '--all',
        '--decorate=full',
        `--pretty=format:${format}${REC}`,
        `--max-count=${limit}`,
    ]);
    const commits = stdout
        .split(REC)
        .map(s => s.trim())
        .filter(Boolean)
        .map(line => {
        const [hash, parentsRaw, subject, author, email, date, refsRaw] = line.split(SEP);
        const parents = parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [];
        const refs = refsRaw ? refsRaw.split(', ').filter(Boolean) : [];
        return { hash, parents, subject, author, email, date, refs, column: 0, color: 0 };
    });
    const { stdout: headOut } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', 'HEAD']);
    const head = headOut.trim();
    // Fetch stashes before filtering so we can exclude stash-related commits from main log
    let stashes = [];
    const stashHashSet = new Set();
    try {
        const { stdout: stashOut } = await execFileAsync('git', [
            '-C', repoPath, 'stash', 'list',
            `--pretty=format:%H${SEP}%gd${SEP}%s${SEP}%P${SEP}%ci${REC}`,
        ]);
        stashes = stashOut.split(REC).map(s => s.trim()).filter(Boolean).map(line => {
            const [hash, name, message, parentsRaw, date] = line.split(SEP);
            const parents = parentsRaw ? parentsRaw.trim().split(' ').filter(Boolean) : [];
            // stash commit + index commit (parent[1]) + untracked commit (parent[2]) all excluded from main log
            stashHashSet.add(hash);
            if (parents[1]) {
                stashHashSet.add(parents[1]);
            }
            if (parents[2]) {
                stashHashSet.add(parents[2]);
            }
            return { hash, name: name.trim(), message, parentHash: parents[0] || '', date: (date || '').trim() };
        });
    }
    catch { }
    // Remove stash-internal commits from the main commit list
    const filteredCommits = commits.filter(c => !stashHashSet.has(c.hash));
    assignColumns(filteredCommits, head);
    const { stdout: branchOut } = await execFileAsync('git', ['-C', repoPath, 'branch', '-a']);
    const branches = branchOut.split('\n').map(b => b.replace(/^\*?\s+/, '').trim()).filter(Boolean);
    let staged = [];
    try {
        const { stdout: stagedOut } = await execFileAsync('git', ['-C', repoPath, 'diff', '--cached', '--name-status']);
        staged = stagedOut.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('\t');
            const status = parts[0].charAt(0);
            if ((status === 'R' || status === 'C') && parts.length >= 3) {
                return { status, oldPath: parts[1], path: parts[2] };
            }
            return { status, path: parts[1] };
        });
    }
    catch { }
    let unstaged = [];
    try {
        const { stdout: unstagedOut } = await execFileAsync('git', ['-C', repoPath, 'diff', '--name-status']);
        unstaged = unstagedOut.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('\t');
            const status = parts[0].charAt(0);
            if ((status === 'R' || status === 'C') && parts.length >= 3) {
                return { status, oldPath: parts[1], path: parts[2] };
            }
            return { status, path: parts[1] };
        });
    }
    catch { }
    let mergeHead;
    try {
        const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--verify', 'MERGE_HEAD']);
        mergeHead = stdout.trim();
    }
    catch { }
    return { commits: filteredCommits, branches, head, staged, unstaged, stashes, mergeHead };
}
function assignColumns(commits, headHash) {
    // Each active "lane" tracks which commit hash it's waiting to merge into
    // Pre-seed HEAD at lane 0 so the current branch always renders leftmost
    const lanes = headHash ? [headHash] : [];
    const colorMap = new Map();
    let nextColor = 0;
    for (const commit of commits) {
        let col = lanes.indexOf(commit.hash);
        if (col === -1) {
            // New branch: find first empty lane or add one
            const emptyCol = lanes.indexOf(null);
            col = emptyCol !== -1 ? emptyCol : lanes.length;
            if (emptyCol !== -1) {
                lanes[emptyCol] = commit.hash;
            }
            else {
                lanes.push(commit.hash);
            }
        }
        if (!colorMap.has(commit.hash)) {
            colorMap.set(commit.hash, nextColor++ % exports.BRANCH_COLORS.length);
        }
        commit.column = col;
        commit.color = colorMap.get(commit.hash);
        // Replace this lane with first parent; close if no parents
        if (commit.parents.length === 0) {
            lanes[col] = null;
        }
        else {
            lanes[col] = commit.parents[0];
            if (!colorMap.has(commit.parents[0])) {
                colorMap.set(commit.parents[0], commit.color);
            }
        }
        // Additional parents (merges) occupy new lanes or existing ones
        for (let i = 1; i < commit.parents.length; i++) {
            const p = commit.parents[i];
            if (!lanes.includes(p)) {
                const emptyCol = lanes.indexOf(null);
                if (emptyCol !== -1) {
                    lanes[emptyCol] = p;
                }
                else {
                    lanes.push(p);
                }
            }
            if (!colorMap.has(p)) {
                colorMap.set(p, nextColor++ % exports.BRANCH_COLORS.length);
            }
        }
    }
}
async function getCommitFiles(repoPath, hash) {
    const { stdout } = await execFileAsync('git', [
        '-C', repoPath,
        'diff-tree', '--no-commit-id', '-r', '--name-status', '-M', hash,
    ]);
    return stdout.trim().split('\n').filter(Boolean).map((line) => {
        const parts = line.split('\t');
        const status = parts[0].charAt(0);
        if ((status === 'R' || status === 'C') && parts.length >= 3) {
            return { status, oldPath: parts[1], path: parts[2] };
        }
        return { status, path: parts[1] };
    });
}
exports.BRANCH_COLORS = [
    '#4CAF50', '#2196F3', '#FF9800', '#E91E63',
    '#9C27B0', '#00BCD4', '#FF5722', '#8BC34A',
    '#FFC107', '#03A9F4', '#673AB7', '#F44336',
];
//# sourceMappingURL=gitService.js.map