## 🧠 Agent model strategy
 
Delegate via the `Agent` tool to save main-session tokens:
 
| Task | Agent | Mode |
|---|---|---|
| Search >3 files / single-file lookup | haiku | foreground |
| 2+ independent searches | haiku × N | **parallel** |
| Architecture / risk review | sonnet | foreground |
| Long build / test | haiku | **background** |
| Write 3+ independent large files | haiku × N | **parallel** |
 
**Rules:** sub-agents return concise summaries (not file dumps); haiku touches ≤3 files (escalate to sonnet if more); never do broad `Glob`/`Grep`/`Read` in the main session if a haiku could do it.

---

## ⚡ Speed patterns (learned from git-graph project)

### Edit tool — template strings
Always `Read` the exact lines before `Edit`. Template literals (backtick strings) fail silently on whitespace/special-char mismatches. Match 3–5 lines of stable surrounding context, not just the changed line.

### Parallel file creation
When creating ≥3 independent files (e.g. `graph.js` + `style.css` + `extension.ts`), spawn haiku agents in **parallel**, each owning one file. Do NOT write them sequentially in the main session.

### VS Code extension loop
```
Edit src/*.ts  →  npm run compile  →  F5 in VS Code  →  observe
```
Always run `npm run compile` after any `.ts` change. Never report a task done without a clean compile.

### Webview JS (`media/*.js`)
Add `// @ts-nocheck` at the top — VS Code's TS checker flags `acquireVsCodeApi` and DOM nulls as errors on plain JS files. This suppresses noise without affecting runtime.

### Inline SVG icons in webview
Use `element.innerHTML = '<svg ...>'` — **not** `<img src="data:image/svg+xml,...">`. Inline HTML SVG bypasses `img-src` CSP restrictions entirely.

### CSS variable layout pattern
When column widths are CSS vars (`--col-branch`, etc.), JS only needs:
```js
document.documentElement.style.setProperty('--col-branch', newW + 'px');
```
The entire layout (canvas position, header cells, row cells) reflows automatically. No manual DOM style updates needed.

### Column border pattern
Both header cells (`.th-*`) and row cells (`.cell-*`) carry `border-right: 1px solid var(--border)` — except the last column (`.th-hash` / `.cell-hash`). The outer container (`#col-headers`, `#scroll-wrap`) gets `border-left` + `border-right` for the table frame. This keeps header and body perfectly aligned.

### Graph edge curve — horizontal-exit arcTo
Current approach: exit from the **side** of the source node, go horizontal, then arc down to the target.
```js
const startX = x1 < x2 ? x1 + NODE_R : x1 - NODE_R;
ctx.moveTo(startX, y1);          // side of node
ctx.arcTo(x2, y1, x2, y2 - NODE_R, cr);  // horizontal → arc → vertical
ctx.lineTo(x2, y2 - NODE_R);
```
`cr = Math.min(8, dx, dy * 0.5)` — small radius keeps the corner crisp for short spans.

### Ref overflow popup (Branch column)
When a commit has many refs, show a `+N` badge and reveal extras in a hover popup:
- Wrap visible chips in `.ref-chips-wrap` (overflow hidden)
- Add `.ref-more-badge` (+N) as last child
- Add `.ref-more-popup` as sibling (hidden by default)
- `.cell-branch { position: relative; overflow: visible; }` — containing block for the popup
- Toggle visibility with CSS: `.cell-branch:hover .ref-more-popup { display: flex; }`
No JS needed for show/hide.

### Agent worktree limitation
`isolation: "worktree"` requires a git repo. Never use it for directories without `.git`. Use plain `Agent` instead.

---

## 🗂 File map — git-graph extension

```
Desktop/git/
├── AGENTS.md                  ← this file
├── .vscode/
│   ├── launch.json            ← F5 config (extensionDevelopmentPath → git-graph/)
│   └── tasks.json             ← npm compile task (cwd → git-graph/)
└── git-graph/                 ← VS Code extension root
    ├── package.json           ← manifest: command git-graph.showGraph, keybinding Cmd+Alt+G
    ├── tsconfig.json          ← compiles src/ → out/
    ├── src/
    │   ├── extension.ts       ← activate(), register command, detect git repo path
    │   ├── gitService.ts      ← git log parser → GitCommit[], column layout algorithm
    │   └── graphPanel.ts      ← WebviewPanel: HTML template, message handler, checkout/copyHash
    └── media/                 ← browser-side (webview), NOT compiled by tsc
        ├── graph.js           ← canvas renderer, HTML rows, resize, search, ref grouping + overflow popup
        └── style.css          ← CSS vars for columns; cell+header border-right; ref popup CSS
```

**Data flow:**
```
git log (gitService.ts)
  → GitCommit[] with .column / .color assigned
  → postMessage({ command:'load', data })
  → graph.js: drawCanvas() + buildRows()
  → user click → postMessage({ command:'checkout'|'copyHash' })
  → graphPanel.ts handles action
```

**Key CSS vars** (all resizable via drag except `--col-graph` which is auto):

| Var | Default | Controls |
|---|---|---|
| `--col-branch` | 170px | Branch/Tag column + canvas left offset |
| `--col-graph` | auto | Canvas width + Graph column (clip window) |
| `--col-msg` | 300px | Commit Message column |
| `--col-author` | 130px | Author column |
| `--col-date` | 96px | Date column |
| `--col-hash` | 72px | Hash column |