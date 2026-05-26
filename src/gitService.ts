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

export async function getGitLog(repoPath: string, limit = 1500): Promise<GitGraphData> {
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

  // Run independent commands in parallel
  const [headRes, stashRes, branchRes, stagedRes, unstagedRes, untrackedRes, mergeHeadRes] = await Promise.allSettled([
    execFileAsync('git', ['-C', repoPath, 'rev-parse', 'HEAD']),
    execFileAsync('git', ['-C', repoPath, 'stash', 'list', `--pretty=format:%H${SEP}%gd${SEP}%s${SEP}%P${SEP}%ci${REC}`]),
    execFileAsync('git', ['-C', repoPath, 'branch', '-a']),
    execFileAsync('git', ['-C', repoPath, 'diff', '--cached', '--name-status']),
    execFileAsync('git', ['-C', repoPath, 'diff', '--name-status']),
    execFileAsync('git', ['-C', repoPath, 'ls-files', '--others', '--exclude-standard']),
    execFileAsync('git', ['-C', repoPath, 'rev-parse', '--verify', 'MERGE_HEAD']),
  ]);

  const head = headRes.status === 'fulfilled' ? headRes.value.stdout.trim() : '';
  const branches = branchRes.status === 'fulfilled'
    ? branchRes.value.stdout.split('\n').map(b => b.replace(/^\*?\s+/, '').trim()).filter(Boolean)
    : [];

  // Parse stashes
  let stashes: StashEntry[] = [];
  const stashHashSet = new Set<string>();
  if (stashRes.status === 'fulfilled') {
    stashes = stashRes.value.stdout.split(REC).map(s => s.trim()).filter(Boolean).map(line => {
      const [hash, name, message, parentsRaw, date] = line.split(SEP);
      const parents = parentsRaw ? parentsRaw.trim().split(' ').filter(Boolean) : [];
      stashHashSet.add(hash);
      if (parents[1]) { stashHashSet.add(parents[1]); }
      if (parents[2]) { stashHashSet.add(parents[2]); }
      return { hash, name: name.trim(), message, parentHash: parents[0] || '', date: (date || '').trim() };
    });
  }

  // Remove stash commits from main log
  const filteredCommits = commits.filter(c => !stashHashSet.has(c.hash));
  assignColumns(filteredCommits, head);

  // Parse staged files
  let staged: CommitFile[] = [];
  if (stagedRes.status === 'fulfilled') {
    staged = stagedRes.value.stdout.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      const status = parts[0].charAt(0);
      if ((status === 'R' || status === 'C') && parts.length >= 3) {
        return { status, oldPath: parts[1], path: parts[2] };
      }
      return { status, path: parts[1] };
    });
  }

  // Parse unstaged files
  let unstaged: CommitFile[] = [];
  if (unstagedRes.status === 'fulfilled') {
    unstaged = unstagedRes.value.stdout.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      const status = parts[0].charAt(0);
      if ((status === 'R' || status === 'C') && parts.length >= 3) {
        return { status, oldPath: parts[1], path: parts[2] };
      }
      return { status, path: parts[1] };
    });
  }

  // Add untracked files
  if (untrackedRes.status === 'fulfilled') {
    const untracked = untrackedRes.value.stdout.trim().split('\n').filter(Boolean)
      .map(path => ({ status: 'A', path }));
    unstaged = [...unstaged, ...untracked];
  }

  const mergeHead = mergeHeadRes.status === 'fulfilled' ? mergeHeadRes.value.stdout.trim() : undefined;

  return { commits: filteredCommits, branches, head, staged, unstaged, stashes, mergeHead };
}

function assignColumns(commits: GitCommit[], headHash?: string) {
  const lanes: (string | null)[] = headHash ? [headHash] : [];
  const laneIndex = new Map<string, number>();  // O(1) hash -> column lookup
  const colorMap = new Map<string, number>();
  let nextColor = 0;

  if (headHash) { laneIndex.set(headHash, 0); }

  for (const commit of commits) {
    let col = laneIndex.get(commit.hash) ?? -1;

    if (col === -1) {
      // Find first empty lane or add new one
      col = lanes.findIndex(l => l === null);
      if (col === -1) { col = lanes.length; }
      lanes[col] = commit.hash;
      laneIndex.set(commit.hash, col);
    }

    if (!colorMap.has(commit.hash)) {
      colorMap.set(commit.hash, nextColor++ % BRANCH_COLORS.length);
    }
    commit.column = col;
    commit.color = colorMap.get(commit.hash)!;

    // Update lane: first parent continues the lane, others get new lanes
    if (commit.parents.length === 0) {
      lanes[col] = null;
      laneIndex.delete(commit.hash);
    } else {
      const parent = commit.parents[0];
      lanes[col] = parent;
      laneIndex.delete(commit.hash);
      laneIndex.set(parent, col);
      if (!colorMap.has(parent)) {
        colorMap.set(parent, colorMap.get(commit.hash)!);
      }
    }

    // Merge parents get their own lanes
    for (let i = 1; i < commit.parents.length; i++) {
      const p = commit.parents[i];
      if (!laneIndex.has(p)) {
        const emptyCol = lanes.findIndex(l => l === null);
        const newCol = emptyCol !== -1 ? emptyCol : lanes.length;
        lanes[newCol] = p;
        laneIndex.set(p, newCol);
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
  try {
    // For merge commits (2+ parents), use git show to see actual changes
    const { stdout: logOut } = await execFileAsync('git', ['-C', repoPath, 'log', '--format=%P', '-n1', hash]);
    const parents = logOut.trim().split(' ').filter(Boolean);

    let stdout: string;
    if (parents.length >= 2) {
      // Merge commit: show changes relative to first parent
      const { stdout: showOut } = await execFileAsync('git', [
        '-C', repoPath, 'diff', '--name-status', '-M', parents[0], hash
      ]);
      stdout = showOut;
    } else {
      // Regular commit
      const { stdout: treeOut } = await execFileAsync('git', [
        '-C', repoPath,
        'diff-tree', '--no-commit-id', '-r', '--name-status', '-M', hash,
      ]);
      stdout = treeOut;
    }

    return stdout.trim().split('\n').filter(Boolean).map((line: string) => {
      const parts = line.split('\t');
      const status = parts[0].charAt(0);
      if ((status === 'R' || status === 'C') && parts.length >= 3) {
        return { status, oldPath: parts[1], path: parts[2] };
      }
      return { status, path: parts[1] };
    });
  } catch {
    return [];
  }
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
