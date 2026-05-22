# Open Git

A VS Code extension for visualizing and managing Git repositories with an interactive graph view.

## Features

### Graph View
- Visual commit graph with branch lines and merge connections
- Color-coded branch lanes
- Commit details panel: changed files, diffs (split / inline / hunk)

### Toolbar
- **Repo:** — switch between repositories in a multi-root workspace
- **Branches:** — filter graph to a specific branch
- **Show Remote Branches** — toggle remote branch visibility

### Branch Sidebar
- **LOCAL** — local branches, grouped by prefix (e.g. `BTD/BTD-225` → group `BTD`)
- **REMOTE** — remote branches grouped by remote name (origin, upstream, etc.)
- **STASHES** — list of stashes with pop/drop actions
- Click a branch → scroll to and select its tip commit in the graph
- Right-click → context menu (push, pull, checkout, delete, copy name, etc.)
- Filter input to search branches
- Resizable sidebar, toggle with `⊞` button

### Commit Actions (right-click on commit row)
- Checkout, Create branch, Cherry-pick
- Revert commit, Rebase onto this commit
- Reset branch (soft / mixed / hard)
- Create tag, Copy hash

### Branch Chip Actions (right-click on branch chip)
- Push / Pull branch
- Checkout, Create branch here
- Delete local / remote branch

### Tag Actions (right-click on tag chip)
- Delete tag

### WIP Row (uncommitted changes)
- Stage / unstage individual files
- View unstaged and staged diffs
- Stash all changes
- Continue Merge / Abort Merge (when in merging state)

### Multi-Root Workspace Support
- Auto-detects all Git repositories in the workspace (including subdirectories)
- Automatically switches to the active file's repository
- No configuration required

## Installation

### From `.vsix`
1. Download or build `open-git-x.x.x.vsix`
2. In VS Code: `Cmd+Shift+P` → **Extensions: Install from VSIX…**
3. Select the `.vsix` file and reload

### Build from Source
```bash
git clone https://github.com/chadathan/Open-Git.git
cd Open-Git
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
# Install the generated .vsix file
```

## Keyboard Shortcut

| Action | Mac | Windows/Linux |
|--------|-----|---------------|
| Show Graph | `Cmd+Alt+G` | `Ctrl+Alt+G` |

## Requirements

- VS Code 1.85+
- Git installed and available in `PATH`
