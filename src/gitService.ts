import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitCommit {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  email: string;
  date: string;
  refs: string[];    // branch/tag labels
  column: number;   // assigned by layout algorithm
  color: number;    // branch color index
}

export interface StashEntry {
  hash: string;
  name: string;        // stash@{0}
  message: string;
  parentHash: string;
  date: string;
}

export interface GitGraphData {
  commits: GitCommit[];
  branches: string[];
  head: string;
  staged: CommitFile[];
  unstaged: CommitFile[];
  stashes: StashEntry[];
  mergeHead?: string;   // hash of commit being merged (MERGE_HEAD)
}

const SEP = '\x1f';
const REC = '\x1e';

export async function getGitLog(repoPath: string, limit = 300): Promise<GitGraphData> {
  const format = [
    '%H',   // hash
    '%P',   // parents (space separated)
    '%s',   // subject
    '%an',  // author name
    '%ae',  // author email
    '%ci',  // commit date iso
    '%D',   // ref names
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
  let stashes: StashEntry[] = [];
  const stashHashSet = new Set<string>();
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
      if (parents[1]) { stashHashSet.add(parents[1]); }
      if (parents[2]) { stashHashSet.add(parents[2]); }
      return { hash, name: name.trim(), message, parentHash: parents[0] || '', date: (date || '').trim() };
    });
  } catch {}

  // Remove stash-internal commits from the main commit list
  const filteredCommits = commits.filter(c => !stashHashSet.has(c.hash));

  assignColumns(filteredCommits, head);

  const { stdout: branchOut } = await execFileAsync('git', ['-C', repoPath, 'branch', '-a']);
  const branches = branchOut.split('\n').map(b => b.replace(/^\*?\s+/, '').trim()).filter(Boolean);

  let staged: CommitFile[] = [];
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
  } catch {}

  let unstaged: CommitFile[] = [];
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
  } catch {}

  let mergeHead: string | undefined;
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--verify', 'MERGE_HEAD']);
    mergeHead = stdout.trim();
  } catch {}

  return { commits: filteredCommits, branches, head, staged, unstaged, stashes, mergeHead };
}

function assignColumns(commits: GitCommit[], headHash?: string) {
  // Each active "lane" tracks which commit hash it's waiting to merge into
  // Pre-seed HEAD at lane 0 so the current branch always renders leftmost
  const lanes: (string | null)[] = headHash ? [headHash] : [];
  const colorMap = new Map<string, number>();
  let nextColor = 0;

  for (const commit of commits) {
    let col = lanes.indexOf(commit.hash);

    if (col === -1) {
      // New branch: find first empty lane or add one
      const emptyCol = lanes.indexOf(null);
      col = emptyCol !== -1 ? emptyCol : lanes.length;
      if (emptyCol !== -1) {
        lanes[emptyCol] = commit.hash;
      } else {
        lanes.push(commit.hash);
      }
    }

    if (!colorMap.has(commit.hash)) {
      colorMap.set(commit.hash, nextColor++ % BRANCH_COLORS.length);
    }
    commit.column = col;
    commit.color = colorMap.get(commit.hash)!;

    // Replace this lane with first parent; close if no parents
    if (commit.parents.length === 0) {
      lanes[col] = null;
    } else {
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
        } else {
          lanes.push(p);
        }
      }
      if (!colorMap.has(p)) {
        colorMap.set(p, nextColor++ % BRANCH_COLORS.length);
      }
    }
  }
}

export interface CommitFile {
  status: string;
  path: string;
  oldPath?: string;
}

export async function getCommitFiles(repoPath: string, hash: string): Promise<CommitFile[]> {
  const { stdout } = await execFileAsync('git', [
    '-C', repoPath,
    'diff-tree', '--no-commit-id', '-r', '--name-status', '-M', hash,
  ]);
  return stdout.trim().split('\n').filter(Boolean).map((line: string) => {
    const parts = line.split('\t');
    const status = parts[0].charAt(0);
    if ((status === 'R' || status === 'C') && parts.length >= 3) {
      return { status, oldPath: parts[1], path: parts[2] };
    }
    return { status, path: parts[1] };
  });
}

export interface LineBlame {
  hash: string;
  author: string;
  date: Date;
  summary: string;
  isUncommitted: boolean;
}

export async function getLineBlame(repoPath: string, filePath: string, line: number): Promise<LineBlame | null> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', repoPath, 'blame',
      '-L', `${line},${line}`,
      '--porcelain', '--',
      filePath,
    ]);
    if (!stdout.trim()) { return null; }

    const lines = stdout.split('\n');
    const hash = lines[0].split(' ')[0];

    if (/^0+$/.test(hash)) {
      return { hash, author: 'You', date: new Date(), summary: 'Uncommitted changes', isUncommitted: true };
    }

    let author = '', timestamp = 0, summary = '';
    for (const l of lines) {
      if (l.startsWith('author '))      { author    = l.slice(7); }
      else if (l.startsWith('author-time ')) { timestamp = parseInt(l.slice(12)); }
      else if (l.startsWith('summary ')) { summary   = l.slice(8); }
    }
    return { hash, author, date: new Date(timestamp * 1000), summary, isUncommitted: false };
  } catch {
    return null;
  }
}

export const BRANCH_COLORS = [
  '#4CAF50', '#2196F3', '#FF9800', '#E91E63',
  '#9C27B0', '#00BCD4', '#FF5722', '#8BC34A',
  '#FFC107', '#03A9F4', '#673AB7', '#F44336',
];
