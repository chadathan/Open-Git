// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  // ── Constants ────────────────────────────────────────────────────────────────
  const ROW_H    = 34;
  const COL_W    = 18;
  const NODE_R   = 10;
  const GRAPH_PAD = 8;

  const COLORS = [
    '#3794ff','#4ec9b0','#f472b6','#a78bfa',
    '#fb923c','#34d399','#f87171','#fbbf24',
    '#22d3ee','#c084fc','#86efac','#e879f9',
  ];

  // ── SVG icons (inline, CSP-safe) ──────────────────────────────────────────────
  const SVG_LOCAL = '<svg class="ref-icon" viewBox="0 0 12 11" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="0.7" width="10" height="7" rx="1.3"/><path d="M6 7.7v2M4 9.7h4"/></svg>';
  const SVG_REMOTE = '<svg class="ref-icon" viewBox="0 0 12 10" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><path d="M9 8.5H3.5C2.4 8.5 1.5 7.6 1.5 6.5c0-1 .7-1.8 1.7-2C3.6 3.1 4.7 2 6 2c1.2 0 2.2.7 2.7 1.6.2-.1.4-.1.6-.1 1.2 0 2.2 1 2.2 2.2S10.3 8.5 9 8.5z"/></svg>';
  const SVG_TAG   = '<svg class="ref-icon" viewBox="0 0 10 12" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><path d="M1 1h5.5l2.5 5-2.5 5H1z"/><circle cx="3.2" cy="6" r="1" fill="currentColor" stroke="none"/></svg>';

  // ── State ─────────────────────────────────────────────────────────────────────
  let data = null;
  let selectedIdx = -1;
  let lastGraphW = 0;   // guard: only auto-update --col-graph when branch count changes
  let diffMode = 'split';
  let currentDiffHunks = null;
  let wipOffset = 0;
  let flatRows  = [];
  let commitRowY = new Map();
  let activeBranchFilter = '';
  let showRemoteBranches = true;
  let sidebarBranchFilter = '';
  let pendingFilesHash = null;  // track which commit's files we're waiting for
  let canvasOffset = 0;         // virtual canvas: Y offset from top of rows-wrap
  let totalCanvasH = 0;         // full virtual canvas height
  let activeSidebarBranch = '';  // branch name selected in sidebar
  let wipViewMode = 'path';           // 'path' | 'tree'
  let wipSortMode = 'name';           // 'name' | 'status'
  let commitViewMode = 'tree';        // 'path' | 'tree' for commit detail
  let expandedUnstagedDirs = new Set();
  let expandedStagedDirs   = new Set();
  let currentCommitData = [];         // for commit detail tree rendering

  // ── DOM ───────────────────────────────────────────────────────────────────────
  const canvas          = document.getElementById('graph-canvas');
  const ctx             = canvas.getContext('2d');
  const graphClipWrap   = document.getElementById('graph-clip-wrap');
  const rowsWrap        = document.getElementById('rows-wrap');
  const detailPanel     = document.getElementById('detail-panel');
  const detailContent   = document.getElementById('detail-content');
  const statusBar       = document.getElementById('status-bar');
  const btnRefresh      = document.getElementById('btn-refresh');
  const btnClose        = document.getElementById('detail-close');
  const toolbarWipActions = document.getElementById('toolbar-wip-actions');
  const btnTbStash      = document.getElementById('btn-tb-stash');
  const searchInput     = document.getElementById('search-input');
  const scrollWrap      = document.getElementById('scroll-wrap');
  const colHeadersInner = document.getElementById('col-headers-inner');
  const graphPane       = document.getElementById('graph-pane');
  const diffOverlay     = document.getElementById('diff-overlay');
  const diffFileTitle   = document.getElementById('diff-file-title');
  const diffBody        = document.getElementById('diff-body');
  const repoSelect      = document.getElementById('repo-select');
  const branchFilter    = document.getElementById('branch-filter');
  const showRemotesChk  = document.getElementById('show-remotes');
  const sbFilter = document.getElementById('sb-filter');
  const sbBody   = document.getElementById('sb-body');
  const sbCount  = document.getElementById('sb-count');

  // ── Init ──────────────────────────────────────────────────────────────────────
  initColumnResize();
  initScrollSync();
  initDetailResize();
  initSidebarResize();

  document.getElementById('diff-back').addEventListener('click', () => {
    diffOverlay.classList.add('hidden');
    graphPane.style.display = '';
  });
  document.querySelectorAll('.dm-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      diffMode = btn.dataset.m;
      document.querySelectorAll('.dm-btn').forEach(b => b.classList.toggle('active', b === btn));
      if (currentDiffHunks) { renderDiffContent(); }
    });
  });

  btnRefresh.addEventListener('click', () => {
    statusBar.textContent = 'Refreshing…';
    vscode.postMessage({ command: 'ready' });
  });
  document.getElementById('btn-sidebar-toggle').addEventListener('click', function() {
    const sidebar = document.getElementById('branch-sidebar');
    const resize  = document.getElementById('sb-resize');
    const hidden  = sidebar.classList.toggle('hidden');
    resize.classList.toggle('hidden', hidden);
    this.classList.toggle('active', !hidden);
  });
  repoSelect.addEventListener('change', () => {
    vscode.postMessage({ command: 'switchRepo', path: repoSelect.value });
  });
  branchFilter.addEventListener('change', () => {
    activeBranchFilter = branchFilter.value;
    selectedIdx = -1;
    detailPanel.classList.add('hidden');
    render();
  });
  showRemotesChk.addEventListener('change', () => {
    showRemoteBranches = showRemotesChk.checked;
    populateBranchFilter();
    selectedIdx = -1;
    detailPanel.classList.add('hidden');
    render();
  });
  btnTbStash.addEventListener('click', () => vscode.postMessage({ command: 'stash' }));
  btnClose.addEventListener('click', () => {
    detailPanel.classList.add('hidden');
    selectedIdx = -1;
    setRowSelected(-1);
    redrawCanvas();
  });
  searchInput.addEventListener('input', applySearch);
  sbFilter.addEventListener('input', () => {
    sidebarBranchFilter = sbFilter.value.toLowerCase();
    renderBranchSidebar();
  });

  // ── Messages ──────────────────────────────────────────────────────────────────
  window.addEventListener('message', (/** @type {MessageEvent} */ e) => {
    const msg = e.data;
    if (msg.command === 'loading') {
      document.getElementById('loading-overlay').classList.remove('hidden');
    } else if (msg.command === 'load') {
      document.getElementById('loading-overlay').classList.add('hidden');
      // Remember which commit/WIP was open so we can restore it after refresh
      const prevHash = pendingFilesHash ||
        (!detailPanel.classList.contains('hidden') && selectedIdx >= 0 && data
          ? data.commits[selectedIdx]?.hash : null);
      const wasWip = !detailPanel.classList.contains('hidden') && selectedIdx === -1;
      data = msg.data;
      selectedIdx = -1;
      detailPanel.classList.add('hidden');
      activeBranchFilter = '';
      populateBranchFilter();
      activeSidebarBranch = '';
      renderBranchSidebar();
      statusBar.textContent = `${data.commits.length} commits · ${data.branches.length} branches`;
      render();
      // Restore detail panel if the commit still exists
      if (prevHash) {
        const newIdx = data.commits.findIndex(c => c.hash === prevHash);
        if (newIdx >= 0) { selectCommit(newIdx); }
      } else if (wasWip) {
        selectWip();
      }
    } else if (msg.command === 'files') {
      renderFiles(msg.hash, msg.files);
    } else if (msg.command === 'diffData') {
      currentDiffHunks = parseDiff(msg.unified);
      diffFileTitle.textContent = msg.path;
      renderDiffContent();
    } else if (msg.command === 'toast') {
      showToast(msg.type, msg.title, msg.detail);
    } else if (msg.command === 'error') {
      statusBar.textContent = '⚠ ' + msg.message;
      rowsWrap.innerHTML = `<div class="err-row">${esc(msg.message)}</div>`;
    } else if (msg.command === 'repoInfo') {
      populateRepoSelect(msg.repos || [], msg.path || '');
    }
  });

  // ── Flat row list (commits + stashes interleaved by timeline) ────────────────
  // ── Repo select ────────────────────────────────────────────────────────────
  function populateRepoSelect(repos, activePath) {
    repoSelect.innerHTML = '';
    if (repos.length === 0) {
      const opt = document.createElement('option');
      opt.value = activePath;
      opt.textContent = activePath.split('/').pop() || activePath;
      repoSelect.appendChild(opt);
      return;
    }
    repos.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.path;
      opt.textContent = r.name;
      opt.selected = r.path === activePath;
      repoSelect.appendChild(opt);
    });
  }

  // ── Branch filter ──────────────────────────────────────────────────────────
  function populateBranchFilter() {
    if (!data) { return; }
    const prev = activeBranchFilter;
    branchFilter.innerHTML = '<option value="">Show All</option>';
    const branches = (data.branches || []).filter(b => {
      if (!showRemoteBranches && (b.startsWith('remotes/') || b.startsWith('origin/'))) { return false; }
      return true;
    });
    branches.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      branchFilter.appendChild(opt);
    });
    // Restore selection if branch still exists
    if (prev && branches.includes(prev)) {
      branchFilter.value = prev;
      activeBranchFilter = prev;
    } else {
      branchFilter.value = '';
      activeBranchFilter = '';
    }
  }

  // ── Branch sidebar ──────────────────────────────────────────────────────────
  function getCurrentBranch() {
    if (!data) { return ''; }
    for (const c of data.commits) {
      for (const r of c.refs) {
        if (r.startsWith('HEAD -> ')) {
          const m = r.match(/HEAD -> refs\/heads\/(.+)/);
          if (m) { return m[1]; }
          // fallback if not full ref format
          return r.slice(8);
        }
      }
    }
    return '';
  }

  function renderBranchSidebar() {
    if (!data) { return; }
    const currentBranch = getCurrentBranch();
    const filter = sidebarBranchFilter;

    // Separate local and remote branches
    const localBranches = [];
    const remoteBranches = {}; // grouped by remote name

    for (const b of (data.branches || [])) {
      if (b.startsWith('remotes/')) {
        // remotes/origin/main → remote=origin, branch=main
        const parts = b.slice(8).split('/');
        const remote = parts[0];
        const name = parts.slice(1).join('/');
        if (!remoteBranches[remote]) { remoteBranches[remote] = []; }
        remoteBranches[remote].push(name);
      } else {
        localBranches.push(b);
      }
    }

    // Total count for "Viewing N"
    const total = localBranches.length + Object.values(remoteBranches).reduce((s, arr) => s + arr.length, 0) + (data.stashes || []).length;
    sbCount.textContent = total;

    sbBody.innerHTML = '';

    // ── LOCAL section ──
    const localSection = buildSection('LOCAL', localBranches.length, (body) => {
      // Group branches by prefix (e.g. BTD/BTD-225 → group BTD)
      const groups = {};   // prefix → [branchName]
      const ungrouped = [];
      for (const b of localBranches) {
        if (filter && !b.toLowerCase().includes(filter)) { continue; }
        const slash = b.indexOf('/');
        if (slash > 0) {
          const prefix = b.slice(0, slash);
          if (!groups[prefix]) { groups[prefix] = []; }
          groups[prefix].push(b);
        } else {
          ungrouped.push(b);
        }
      }
      // Render ungrouped first
      for (const b of ungrouped) {
        body.appendChild(makeBranchItem(b, b, currentBranch, 0));
      }
      // Render groups
      for (const [prefix, members] of Object.entries(groups)) {
        const groupEl = document.createElement('div');
        groupEl.className = 'sb-group';
        const ghdr = document.createElement('div');
        ghdr.className = 'sb-group-hdr';
        ghdr.innerHTML = `<span class="sb-group-chevron">▾</span><span>${esc(prefix)}</span>`;
        ghdr.addEventListener('click', () => groupEl.classList.toggle('collapsed'));
        const gbody = document.createElement('div');
        gbody.className = 'sb-group-body';
        for (const b of members) {
          const shortName = b.slice(prefix.length + 1);
          gbody.appendChild(makeBranchItem(b, shortName, currentBranch, 1));
        }
        groupEl.appendChild(ghdr);
        groupEl.appendChild(gbody);
        body.appendChild(groupEl);
      }
    });
    sbBody.appendChild(localSection);

    // ── REMOTE section ──
    const remoteCount = Object.values(remoteBranches).reduce((s, arr) => s + arr.length, 0);
    const remoteSection = buildSection('REMOTE', remoteCount, (body) => {
      for (const [remote, branches] of Object.entries(remoteBranches)) {
        const groupEl = document.createElement('div');
        groupEl.className = 'sb-group';
        const ghdr = document.createElement('div');
        ghdr.className = 'sb-group-hdr';
        ghdr.innerHTML = `<span class="sb-group-chevron">▾</span><span>${esc(remote)}</span>`;
        ghdr.addEventListener('click', () => groupEl.classList.toggle('collapsed'));
        const gbody = document.createElement('div');
        gbody.className = 'sb-group-body';
        for (const b of branches) {
          const fullRemoteBranch = `remotes/${remote}/${b}`;
          if (filter && !b.toLowerCase().includes(filter)) { continue; }
          gbody.appendChild(makeBranchItem(fullRemoteBranch, b, currentBranch, 1));
        }
        groupEl.appendChild(ghdr);
        groupEl.appendChild(gbody);
        body.appendChild(groupEl);
      }
    });
    sbBody.appendChild(remoteSection);

    // ── STASHES section ──
    const stashes = data.stashes || [];
    const stashSection = buildSection('STASHES', stashes.length, (body) => {
      for (const s of stashes) {
        if (filter && !s.name.toLowerCase().includes(filter) && !s.message.toLowerCase().includes(filter)) { continue; }
        const el = document.createElement('div');
        el.className = 'sb-stash' + (activeSidebarBranch === s.hash ? ' active' : '');
        el.innerHTML = `<span class="sb-stash-icon">⚑</span><span class="sb-stash-name" title="${esc(s.message)}">${esc(s.name)}: ${esc(s.message)}</span>`;
        el.addEventListener('contextmenu', e => { e.preventDefault(); showStashCtxMenu(e, s); });
        el.addEventListener('click', () => {
          activeSidebarBranch = activeSidebarBranch === s.hash ? '' : s.hash;
          renderBranchSidebar();
          const row = flatRows.find(r => r.type === 'stash' && r.stash.hash === s.hash);
          if (row) { scrollToY(row.y); }
        });
        body.appendChild(el);
      }
    });
    sbBody.appendChild(stashSection);
  }

  function makeBranchItem(fullBranch, displayName, currentBranch, depth) {
    const isCurrent = fullBranch === currentBranch || displayName === currentBranch;
    const isActive = activeSidebarBranch === fullBranch;
    const el = document.createElement('div');
    el.className = 'sb-branch' + (isCurrent ? ' current' : '') + (isActive ? ' active' : '') + ` depth-${depth}`;
    el.innerHTML = `<span class="sb-check">${isCurrent ? '✓' : ''}</span><span class="sb-branch-name" title="${esc(fullBranch)}">${esc(displayName)}</span>`;
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      showSidebarBranchCtxMenu(e, fullBranch);
    });
    el.addEventListener('click', () => {
      activeSidebarBranch = fullBranch;
      renderBranchSidebar();
      // Find the tip commit for this branch and select + scroll to it
      const targetRef = fullBranch.startsWith('remotes/')
        ? 'refs/' + fullBranch
        : 'refs/heads/' + fullBranch;
      const commits = getFilteredCommits();
      const tipIdx = commits.findIndex(c => c.refs.some(r => {
        const clean = r.startsWith('HEAD -> ') ? r.slice(8) : r;
        return clean === targetRef || clean === fullBranch;
      }));
      if (tipIdx >= 0) {
        selectedIdx = tipIdx;
        setRowSelected(tipIdx);
        redrawCanvas();
        const y = commitRowY.get(tipIdx);
        if (y !== undefined) { scrollToY(y); }
      }
    });
    return el;
  }

  function buildSection(title, count, fillFn) {
    const section = document.createElement('div');
    section.className = 'sb-section';
    const hdr = document.createElement('div');
    hdr.className = 'sb-section-hdr';
    hdr.innerHTML = `<span class="sb-chevron">▾</span>${esc(title)}<span class="sb-count">${count}</span>`;
    hdr.addEventListener('click', () => section.classList.toggle('collapsed'));
    const body = document.createElement('div');
    body.className = 'sb-section-body';
    fillFn(body);
    section.appendChild(hdr);
    section.appendChild(body);
    return section;
  }

  function scrollToY(targetY) {
    const wrap = scrollWrap;
    const h = wrap.clientHeight;
    const current = wrap.scrollTop;
    if (targetY < current + 40 || targetY > current + h - 40) {
      wrap.scrollTop = Math.max(0, targetY - h / 2);
    }
  }

  function initSidebarResize() {
    const handle = document.getElementById('sb-resize');
    const sidebar = document.getElementById('branch-sidebar');
    if (!handle || !sidebar) { return; }
    let startX = 0, startW = 0;
    handle.addEventListener('mousedown', e => {
      startX = e.clientX;
      startW = sidebar.offsetWidth;
      handle.classList.add('dragging');
      const onMove = ev => {
        const w = Math.max(140, Math.min(400, startW + ev.clientX - startX));
        sidebar.style.width = w + 'px';
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Commit filter ──────────────────────────────────────────────────────────
  function getFilteredCommits() {
    if (!data) { return []; }
    let commits = data.commits;

    if (!showRemoteBranches) {
      commits = commits.filter(c => {
        if (!c.refs || c.refs.length === 0) { return true; }
        // Keep if has any non-remote ref (HEAD, local branch, tag)
        return c.refs.some(r => {
          const clean = r.startsWith('HEAD -> ') ? r.slice(8) : r;
          return !clean.startsWith('refs/remotes/') && !clean.startsWith('remotes/');
        });
      });
    }

    if (activeBranchFilter) {
      const targetRef = activeBranchFilter.startsWith('remotes/')
        ? 'refs/' + activeBranchFilter
        : 'refs/heads/' + activeBranchFilter;
      const hashMap = new Map(commits.map(c => [c.hash, c]));
      // Find tip commit for this branch
      const tip = commits.find(c => c.refs.some(r => {
        const clean = r.startsWith('HEAD -> ') ? r.slice(8) : r;
        return clean === targetRef || clean === activeBranchFilter;
      }));
      if (tip) {
        const included = new Set();
        const queue = [tip.hash];
        while (queue.length) {
          const h = queue.shift();
          if (included.has(h)) { continue; }
          included.add(h);
          const c = hashMap.get(h);
          if (c) { c.parents.forEach(p => queue.push(p)); }
        }
        commits = commits.filter(c => included.has(c.hash));
      }
    }

    return commits;
  }

  function buildFlatRows(commits) {
    // Merge commits + stashes by date (newest first), like a single timeline
    const stashes = (data.stashes || []).slice().sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    flatRows = [];
    commitRowY = new Map();
    let pos = 0;
    let si = 0;

    for (let i = 0; i < commits.length; i++) {
      const commitTime = new Date(commits[i].date).getTime();
      // Insert all stashes newer than this commit
      while (si < stashes.length && new Date(stashes[si].date).getTime() >= commitTime) {
        flatRows.push({ type: 'stash', stash: stashes[si], y: wipOffset + pos * ROW_H + ROW_H / 2 });
        pos++;
        si++;
      }
      commitRowY.set(i, wipOffset + pos * ROW_H + ROW_H / 2);
      flatRows.push({ type: 'commit', idx: i });
      pos++;
    }

    // Remaining stashes older than all commits in the window
    while (si < stashes.length) {
      flatRows.push({ type: 'stash', stash: stashes[si], y: wipOffset + pos * ROW_H + ROW_H / 2 });
      pos++;
      si++;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  function render() {
    if (!data) { return; }
    const commits = getFilteredCommits();
    const maxCol  = commits.reduce((m, c) => Math.max(m, c.column), 0);
    const graphW  = GRAPH_PAD + (maxCol + 1) * COL_W + GRAPH_PAD;

    // Only reset --col-graph when branch layout actually changes width
    if (graphW !== lastGraphW) {
      lastGraphW = graphW;
      document.documentElement.style.setProperty('--col-graph', graphW + 'px');
    }

    const hasUnstaged = data.unstaged && data.unstaged.length > 0;
    const hasStaged   = data.staged   && data.staged.length   > 0;
    const hasWipRow   = hasStaged || hasUnstaged;
    wipOffset = hasWipRow ? ROW_H : 0;

    buildFlatRows(commits);

    toolbarWipActions.classList.toggle('hidden', !hasWipRow);
    totalCanvasH = wipOffset + flatRows.length * ROW_H;

    canvas.width       = graphW;
    canvas.style.width = graphW + 'px';

    positionVirtualCanvas();
    drawCanvas(commits);
    buildRows(commits);
    applySearch();
  }

  // ── Virtual canvas ────────────────────────────────────────────────────────────
  function positionVirtualCanvas() {
    const viewH   = scrollWrap.clientHeight || 600;
    const scrollT = scrollWrap.scrollTop || 0;
    const overscan = viewH;
    canvasOffset = Math.max(0, scrollT - overscan);
    const canvasH = Math.min(totalCanvasH - canvasOffset, viewH + overscan * 2);
    canvas.height       = Math.max(1, canvasH);
    canvas.style.height = canvas.height + 'px';
    graphClipWrap.style.height = canvas.height + 'px';
    graphClipWrap.style.top    = canvasOffset + 'px';
  }

  // ── Canvas ────────────────────────────────────────────────────────────────────
  function drawCanvas(commits) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const idxMap = new Map(commits.map((c, i) => [c.hash, i]));

    // edges
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      const x1 = nx(c.column), y1 = ny(i);

      for (const ph of c.parents) {
        const pi = idxMap.get(ph);
        if (pi === undefined) { continue; }
        const pc = commits[pi];
        const x2 = nx(pc.column), y2 = ny(pi);
        const color = COLORS[c.color % COLORS.length];

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;

        if (c.column === pc.column) {
          ctx.moveTo(x1, y1 + NODE_R);
          ctx.lineTo(x2, y2 - NODE_R);
        } else {
          const dy = y2 - y1;
          const startX = x1;
          const startY = y1 + NODE_R;
          const endX = x2;
          const endY = y2 - NODE_R;
          ctx.moveTo(startX, startY);
          ctx.bezierCurveTo(startX, startY + dy * 0.4, endX, endY - dy * 0.4, endX, endY);
        }
        ctx.stroke();
      }
    }

    // horizontal connection lines from label column (x=0) to node
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      const grouped = groupRefs(c.refs);
      if (grouped.length) {
        const x = nx(c.column);
        const y = ny(i);
        const color = COLORS[c.color % COLORS.length];
        const isCurrent = grouped.some(g => g.current);

        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = isCurrent ? 1.8 : 1.0;
        ctx.moveTo(0, y);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    }

    // nodes
    for (let i = 0; i < commits.length; i++) {
      drawNode(commits[i], i, i === selectedIdx);
    }

    // Stash nodes + dashed lines to parent commits (inline positions from flatRows)
    const stashColor = '#a78bfa';
    for (const item of flatRows) {
      if (item.type !== 'stash') { continue; }
      const s = item.stash;
      const sy = item.y;
      const parentIdx = idxMap.get(s.parentHash);
      const x = parentIdx !== undefined ? nx(commits[parentIdx].column) : nx(0);

      ctx.strokeStyle = stashColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);

      if (parentIdx !== undefined) {
        ctx.beginPath();
        ctx.moveTo(x, sy + NODE_R);
        ctx.lineTo(x, ny(parentIdx) - NODE_R);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.moveTo(x,           sy - NODE_R);
      ctx.lineTo(x + NODE_R,  sy);
      ctx.lineTo(x,           sy + NODE_R);
      ctx.lineTo(x - NODE_R,  sy);
      ctx.closePath();
      ctx.fillStyle = hexToRgba(stashColor, 0.15);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // WIP dashed circle + line to HEAD
    if (wipOffset > 0) {
      const headIdx = commits.findIndex(c => c.refs.some(r => r === 'HEAD' || r.startsWith('HEAD ->')));
      if (headIdx !== -1) {
        const hc = commits[headIdx];
        const x = nx(hc.column);
        const color = COLORS[hc.color % COLORS.length];
        const wy = wipOffset / 2;

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);

        ctx.beginPath();
        ctx.moveTo(x, wy + NODE_R);
        ctx.lineTo(x, ny(headIdx) - NODE_R);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(x, wy, NODE_R, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(color, 0.1);
        ctx.fill();
        ctx.stroke();

        ctx.setLineDash([]);
      }

      // MERGE_HEAD: curved dashed line from same WIP circle to the merging commit
      if (data && data.mergeHead && headIdx !== -1) {
        const mIdx = commits.findIndex(c => c.hash === data.mergeHead || data.mergeHead.startsWith(c.hash));
        if (mIdx !== -1) {
          const hc = commits[headIdx];
          const mc = commits[mIdx];
          const wx = nx(hc.column);   // WIP node is at HEAD column
          const mx = nx(mc.column);
          const mergeColor = '#f0a04b';
          const wy = wipOffset / 2;

          ctx.strokeStyle = mergeColor;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);

          ctx.beginPath();
          if (wx === mx) {
            ctx.moveTo(wx, wy + NODE_R);
            ctx.lineTo(mx, ny(mIdx) - NODE_R);
          } else {
            const dy = ny(mIdx) - wy;
            const startY = wy + NODE_R;
            const endY = ny(mIdx) - NODE_R;
            ctx.moveTo(wx, startY);
            ctx.bezierCurveTo(wx, startY + dy * 0.4, mx, endY - dy * 0.4, mx, endY);
          }
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  }

  function redrawCanvas() {
    if (!data) { return; }
    positionVirtualCanvas();
    drawCanvas(getFilteredCommits());
  }

  function drawNode(commit, idx, selected) {
    const x = nx(commit.column), y = ny(idx);
    const color = COLORS[commit.color % COLORS.length];
    const initials = toInitials(commit.author);
    const isHead = commit.refs.some(r => r === 'HEAD' || r.startsWith('HEAD ->'));

    ctx.beginPath();
    ctx.arc(x, y, NODE_R, 0, Math.PI * 2);
    ctx.fillStyle = selected ? '#fff' : hexToRgba(color, 0.2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;

    if (isHead && !selected) {
      ctx.setLineDash([3, 2]);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (selected) {
      ctx.lineWidth = 2.5;
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fill();
      ctx.stroke();
    }

    ctx.fillStyle = selected ? color : lighten(color);
    ctx.font = 'bold 8.5px var(--vscode-editor-font-family, monospace)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initials, x, y + 0.5);
  }

  // ── Rows ──────────────────────────────────────────────────────────────────────
  const SVG_STASH = '<svg class="ft-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="12" height="12" rx="1.2"/><line x1="1.8" y1="6" x2="12.2" y2="6"/><line x1="4.5" y1="9.5" x2="9.5" y2="9.5"/></svg>';

  function buildRows(commits) {
    const frag = document.createDocumentFragment();

    const isMerging = !!data.mergeHead;
    const hasWip = (data.staged && data.staged.length > 0) || (data.unstaged && data.unstaged.length > 0) || isMerging;
    if (hasWip) {
      const row = document.createElement('div');
      row.className = 'row row-wip' + (isMerging ? ' row-merging' : '');
      row.dataset.idx = 'wip';

      const branchCell = document.createElement('div');
      branchCell.className = 'cell cell-branch';
      if (isMerging) {
        branchCell.innerHTML = `<span class="merge-badge">MERGING</span>`;
      }

      const graphCell = document.createElement('div');
      graphCell.className = 'cell cell-graph';

      const msgCell = document.createElement('div');
      msgCell.className = 'cell cell-msg';
      const span = document.createElement('span');
      span.className = 'msg-text';
      span.textContent = isMerging ? 'Merging…' : 'Work in Progress';
      msgCell.appendChild(span);

      const authorCell = document.createElement('div');
      authorCell.className = 'cell cell-author';
      if (data.staged && data.staged.length) {
        authorCell.innerHTML = `<span class="wip-stat wip-staged">&#8593; ${data.staged.length} staged</span>`;
      }

      const dateCell = document.createElement('div');
      dateCell.className = 'cell cell-date';
      if (data.unstaged && data.unstaged.length) {
        dateCell.innerHTML = `<span class="wip-stat wip-unstaged">~ ${data.unstaged.length} modified</span>`;
      }

      const hashCell = document.createElement('div');
      hashCell.className = 'cell cell-hash';

      row.append(branchCell, graphCell, msgCell, authorCell, dateCell, hashCell);
      row.addEventListener('click', () => selectWip());
      row.addEventListener('contextmenu', e => {
        e.preventDefault();
        removeCtxMenu();
        ctxEl = document.createElement('div');
        ctxEl.className = 'ctx-menu';
        ctxEl.style.cssText = `left:${e.pageX}px;top:${e.pageY}px`;
        ctxEl.innerHTML = isMerging
          ? `<div class="ctx-item" data-a="continueMerge">Continue Merge</div>
             <div class="ctx-item ctx-danger" data-a="abortMerge">Abort Merge</div>`
          : `<div class="ctx-item" data-a="stash">Stash all</div>`;
        ctxEl.addEventListener('click', ev => {
          const a = /** @type {HTMLElement} */(ev.target).dataset.a;
          if (a === 'stash') { vscode.postMessage({ command: 'stash' }); }
          else if (a === 'continueMerge') { vscode.postMessage({ command: 'continueMerge' }); }
          else if (a === 'abortMerge') { vscode.postMessage({ command: 'abortMerge' }); }
          removeCtxMenu();
        });
        document.body.appendChild(ctxEl);
        setTimeout(() => document.addEventListener('click', removeCtxMenu, { once: true }), 0);
      });
      frag.appendChild(row);
    }

    for (const item of flatRows) {
      if (item.type === 'stash') {
        const s = item.stash;
        const row = document.createElement('div');
        row.className = 'row row-stash';
        row.dataset.idx = `stash-${s.hash}`;

        const branchCell = document.createElement('div');
        branchCell.className = 'cell cell-branch';
        branchCell.innerHTML = `<span class="stash-chip">${SVG_STASH}${esc(s.name)}</span>`;
        const graphCell = document.createElement('div');
        graphCell.className = 'cell cell-graph';
        const msgCell = document.createElement('div');
        msgCell.className = 'cell cell-msg';
        const span = document.createElement('span');
        span.className = 'msg-text';
        span.textContent = s.message;
        msgCell.appendChild(span);
        const authorCell = document.createElement('div');
        authorCell.className = 'cell cell-author';
        const dateCell = document.createElement('div');
        dateCell.className = 'cell cell-date';
        const hashCell = document.createElement('div');
        hashCell.className = 'cell cell-hash';
        hashCell.textContent = s.hash.slice(0, 7);

        row.append(branchCell, graphCell, msgCell, authorCell, dateCell, hashCell);
        row.addEventListener('contextmenu', e => { e.preventDefault(); showStashCtxMenu(e, s); });
        frag.appendChild(row);
        continue;
      }

      const i = item.idx;
      const c = commits[i];
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.idx     = String(i);
      row.dataset.subject = c.subject.toLowerCase();
      row.dataset.author  = c.author.toLowerCase();
      row.dataset.hash    = c.hash;

      // branch cell
      const branchCell = document.createElement('div');
      branchCell.className = 'cell cell-branch';
      const grouped = groupRefs(c.refs);
      if (grouped.length) {
        const isCurrent = grouped.some(g => g.current);
        if (isCurrent) {
          row.classList.add('row-current');
          const color = COLORS[c.color % COLORS.length];
          row.style.setProperty('--branch-color', color);
          row.style.setProperty('--branch-color-bg', hexToRgba(color, 0.05));
        }
        const wrap = document.createElement('div');
        wrap.className = 'ref-chips-wrap';
        
        // Show first branch chip
        const firstGroup = [grouped[0]];
        const fragFirst = renderGroupedRefs(firstGroup, c.color, c);
        wrap.appendChild(fragFirst);
        
        if (grouped.length > 1) {
          // Add +N badge
          const badge = document.createElement('span');
          badge.className = 'ref-more-badge';
          badge.textContent = `+${grouped.length - 1}`;
          wrap.appendChild(badge);
          
          // Add hover popup with all branch chips
          const popup = document.createElement('div');
          popup.className = 'ref-more-popup';
          
          const fragAll = renderGroupedRefs(grouped, c.color, c);
          popup.appendChild(fragAll);
          branchCell.appendChild(popup);
        }
        
        // Add connector line to canvas boundary
        const line = document.createElement('div');
        line.className = 'branch-connector-line';
        if (grouped.some(g => g.current)) {
          line.classList.add('current-branch-line');
        }
        line.style.backgroundColor = COLORS[c.color % COLORS.length];
        wrap.appendChild(line);
        
        branchCell.appendChild(wrap);
      }

      // graph spacer (canvas draws here)
      const graphCell = document.createElement('div');
      graphCell.className = 'cell cell-graph';

      // message cell
      const msgCell = document.createElement('div');
      msgCell.className = 'cell cell-msg';
      msgCell.title = c.subject;
      const msgSpan = document.createElement('span');
      msgSpan.className = 'msg-text';
      msgSpan.textContent = c.subject;
      msgCell.appendChild(msgSpan);

      // author cell
      const authorCell = document.createElement('div');
      authorCell.className = 'cell cell-author';
      authorCell.textContent = c.author;

      // date cell
      const dateCell = document.createElement('div');
      dateCell.className = 'cell cell-date';
      dateCell.textContent = fmtDate(c.date);

      // hash cell
      const hashCell = document.createElement('div');
      hashCell.className = 'cell cell-hash';
      hashCell.textContent = c.hash.slice(0, 8);

      row.append(branchCell, graphCell, msgCell, authorCell, dateCell, hashCell);
      row.addEventListener('click', () => selectCommit(i));
      row.addEventListener('contextmenu', e => { e.preventDefault(); showCtxMenu(e, c); });

      frag.appendChild(row);
    }

    // Remove only .row elements — keep #graph-clip-wrap intact
    rowsWrap.querySelectorAll('.row').forEach(r => r.remove());
    rowsWrap.appendChild(frag);
  }

  // ── Ref grouping ──────────────────────────────────────────────────────────────
  function groupRefs(refs) {
    /** @type {Map<string, {local:boolean, remote:boolean, current:boolean, remoteNames: string[]}>} */
    const map = new Map();
    /** @type {string[]} */
    const tags = [];

    function ensure(name) {
      if (!map.has(name)) {
        map.set(name, { local: false, remote: false, current: false, remoteNames: [] });
      }
    }

    for (const r of refs) {
      if (!r) { continue; }

      // 1. Current HEAD pointing to a local branch (e.g. "HEAD -> refs/heads/master")
      if (r.startsWith('HEAD -> ')) {
        const target = r.slice(8).trim();
        if (target.startsWith('refs/heads/')) {
          const name = target.slice(11);
          ensure(name);
          map.get(name).local = true;
          map.get(name).current = true;
        } else {
          // Detached HEAD or tags, e.g. "HEAD -> refs/tags/v1.0"
          ensure('HEAD');
          map.get('HEAD').local = true;
          map.get('HEAD').current = true;
        }
        continue;
      }

      // 2. Tags (e.g. "refs/tags/v1.0" or "tag: refs/tags/v1.0" for annotated tags)
      const tagRef = r.startsWith('tag: ') ? r.slice(5).trim() : r;
      if (tagRef.startsWith('refs/tags/')) {
        tags.push(tagRef.slice(10));
        continue;
      }

      // 3. Local branches (e.g. "refs/heads/master")
      if (r.startsWith('refs/heads/')) {
        const name = r.slice(11);
        ensure(name);
        map.get(name).local = true;
        continue;
      }

      // 4. Remote branches (e.g. "refs/remotes/origin/master")
      if (r.startsWith('refs/remotes/')) {
        const path = r.slice(13);
        const slashIdx = path.indexOf('/');
        if (slashIdx !== -1) {
          const remoteName = path.slice(0, slashIdx);
          const branchName = path.slice(slashIdx + 1);
          if (branchName === 'HEAD') { continue; } // skip origin/HEAD helper
          
          ensure(branchName);
          map.get(branchName).remote = true;
          map.get(branchName).remoteNames.push(remoteName);
        }
        continue;
      }
    }

    const result = [];
    for (const [branchName, info] of map) {
      if (info.local && info.remote) {
        result.push({
          type: 'branch',
          name: branchName,
          local: true,
          remote: true,
          current: info.current
        });
      } else if (info.local) {
        result.push({
          type: 'branch',
          name: branchName,
          local: true,
          remote: false,
          current: info.current
        });
      } else if (info.remote) {
        for (const remoteName of info.remoteNames) {
          const displayName = remoteName === 'origin' ? branchName : `${remoteName}/${branchName}`;
          result.push({
            type: 'branch',
            name: displayName,
            local: false,
            remote: true,
            current: false
          });
        }
      }
    }
    tags.forEach(t => result.push({ type: 'tag', name: t, local: false, remote: false, current: false }));
    return result;
  }

  function renderGroupedRefs(groups, colorIdx, commit) {
    const frag = document.createDocumentFragment();
    const color = COLORS[colorIdx % COLORS.length];

    for (const g of groups) {
      const chip = document.createElement('span');
      chip.className = 'ref-chip';

      if (g.type === 'tag') {
        chip.classList.add('ref-tag');
        chip.innerHTML = SVG_TAG + esc(g.name);
      } else {
        // choose chip color class
        if (g.current) {
          chip.classList.add('ref-current');
        } else if (g.local && g.remote) {
          chip.classList.add('ref-both');
        } else if (g.remote) {
          chip.classList.add('ref-remote');
        } else {
          chip.classList.add('ref-local');
        }

        if (g.current) {
          chip.style.background = hexToRgba(color, 0.85);
          chip.style.borderColor = color;
          chip.style.borderWidth = '1px';
          chip.style.boxShadow = `0 0 6px ${hexToRgba(color, 0.35)}`;
          chip.style.fontWeight = '600';
        } else {
          chip.style.background = hexToRgba(color, 0.25);
          chip.style.borderColor = color;
          chip.style.boxShadow = 'none';
          chip.style.fontWeight = 'normal';
        }
        chip.style.color = '#fff';

        let inner = '';
        if (g.current) { inner += '<span class="ri-current">✓</span>'; }
        if (g.local)   { inner += '<span class="ri">' + SVG_LOCAL + '</span>'; }
        if (g.remote)  { inner += '<span class="ri">' + SVG_REMOTE + '</span>'; }
        inner += esc(g.name);
        chip.innerHTML = inner;
      }

      chip.addEventListener('dblclick', e => {
        e.stopPropagation();
        // Remote-only branch → strip remote prefix so git DWIM switches/creates local tracking branch
        const branch = (!g.local && g.remote) ? g.name.replace(/^[^/]+\//, '') : g.name;
        vscode.postMessage({ command: 'checkoutBranch', branch });
      });

      chip.setAttribute('draggable', 'true');
      chip.addEventListener('dragstart', e => {
        e.dataTransfer.setData('text/plain', g.name);
        e.dataTransfer.effectAllowed = 'link';
        chip.classList.add('chip-dragging');
      });
      chip.addEventListener('dragend', () => chip.classList.remove('chip-dragging'));
      chip.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        chip.classList.add('chip-drag-over');
      });
      chip.addEventListener('dragleave', () => chip.classList.remove('chip-drag-over'));
      chip.addEventListener('drop', e => {
        e.preventDefault();
        e.stopPropagation();
        chip.classList.remove('chip-drag-over');
        const source = e.dataTransfer.getData('text/plain');
        if (!source || source === g.name) { return; }
        removeCtxMenu();
        ctxEl = document.createElement('div');
        ctxEl.className = 'ctx-menu';
        ctxEl.style.cssText = `left:${e.pageX}px;top:${e.pageY}px`;
        ctxEl.innerHTML = `<div class="ctx-item" data-a="merge">Merge ${esc(source)} into ${esc(g.name)}</div>`;
        ctxEl.addEventListener('click', ev => {
          if (/** @type {HTMLElement} */(ev.target).dataset.a === 'merge') {
            vscode.postMessage({ command: 'mergeBranch', source, target: g.name });
          }
          removeCtxMenu();
        });
        document.body.appendChild(ctxEl);
        setTimeout(() => document.addEventListener('click', removeCtxMenu, { once: true }), 0);
      });

      chip.addEventListener('contextmenu', e => {
        e.preventDefault();
        e.stopPropagation();
        if (!commit) { return; }
        if (g.type === 'tag') { showTagCtxMenu(e, g.name); }
        else { showChipCtxMenu(e, commit, g); }
      });

      frag.appendChild(chip);
    }
    return frag;
  }

  // ── Search ────────────────────────────────────────────────────────────────────
  function applySearch() {
    const term = searchInput.value.toLowerCase().trim();
    document.querySelectorAll('.row').forEach(el => {
      const row = /** @type {HTMLElement} */(el);
      if (row.classList.contains('row-wip') || row.classList.contains('row-stash')) { row.classList.remove('dim'); return; }
      const match = !term ||
        (row.dataset.subject || '').includes(term) ||
        (row.dataset.author  || '').includes(term) ||
        (row.dataset.hash    || '').startsWith(term);
      row.classList.toggle('dim', !match);
    });
  }

  // ── Select ────────────────────────────────────────────────────────────────────
  function selectCommit(idx) {
    if (!data) { return; }
    selectedIdx = idx;
    setRowSelected(idx);
    redrawCanvas();
    showDetail(data.commits[idx]);
  }

  function selectWip() {
    if (!data) { return; }
    selectedIdx = -1;
    setRowSelected('wip');
    redrawCanvas();
    showWipDetail();
  }

  function expandDirsFor(files) {
    for (const f of files) {
      const parts = f.path.split('/');
      let prefix = '';
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
        expandedDirs.add(prefix);
      }
    }
  }

  function mergeWipFiles(staged, unstaged) {
    const map = new Map();
    for (const f of staged)   { map.set(f.path, { ...f, cmd: 'getStagedDiff' }); }
    for (const f of unstaged) { if (!map.has(f.path)) { map.set(f.path, { ...f, cmd: 'getUnstagedDiff' }); } }
    return Array.from(map.values());
  }

  function showWipDetail() {
    if (!data) { return; }
    const staged   = data.staged   || [];
    const unstaged = data.unstaged || [];
    const isMerging = !!data.mergeHead;

    expandedUnstagedDirs = new Set();
    expandedStagedDirs   = new Set();
    expandDirsForSet(unstaged, expandedUnstagedDirs);
    expandDirsForSet(staged,   expandedStagedDirs);

    detailContent.innerHTML = `
      <div class="d-subject">${isMerging ? 'Merge in Progress' : 'Work in Progress'}</div>
      <div class="wip-toolbar">
        <button class="wip-sort-btn" id="wip-sort-btn" title="Sort files">↕</button>
        <div class="wip-view-toggle">
          <button class="wip-view-btn${wipViewMode==='path'?' active':''}" data-view="path">≡ Path</button>
          <button class="wip-view-btn${wipViewMode==='tree'?' active':''}" data-view="tree">⊞ Tree</button>
        </div>
      </div>

      <div class="wip-section">
        <div class="wip-sec-header">
          <span class="wip-sec-chevron">▾</span>
          <span class="wip-sec-title">Unstaged Files (${unstaged.length})</span>
          <button class="wip-sec-action wip-stage-all-btn" ${unstaged.length===0?'disabled':''}
            style="border:1px solid rgba(52,211,153,0.5);color:#34d399">Stage All Changes</button>
        </div>
        <div class="wip-sec-body" id="wip-unstaged-body">
          <span class="wip-expand-all" data-type="unstaged">Expand All</span>
          <div id="d-unstaged-files">${renderWipFiles(unstaged, expandedUnstagedDirs, 'unstaged')}</div>
        </div>
      </div>

      <div class="wip-section">
        <div class="wip-sec-header">
          <span class="wip-sec-chevron">▾</span>
          <span class="wip-sec-title">Staged Files (${staged.length})</span>
          <button class="wip-sec-action wip-unstage-all-btn" ${staged.length===0?'disabled':''}
            style="border:1px solid rgba(248,113,113,0.5);color:#f87171">Unstage All Changes</button>
        </div>
        <div class="wip-sec-body" id="wip-staged-body">
          <span class="wip-expand-all" data-type="staged">Expand All</span>
          <div id="d-staged-files">${renderWipFiles(staged, expandedStagedDirs, 'staged')}</div>
        </div>
      </div>`;

    detailPanel.classList.remove('hidden');

    // Sort toggle
    detailContent.querySelector('#wip-sort-btn').onclick = () => {
      wipSortMode = wipSortMode === 'name' ? 'status' : 'name';
      reRenderWip();
    };

    // Path / Tree toggle
    detailContent.querySelectorAll('.wip-view-btn').forEach(btn => {
      btn.onclick = () => {
        wipViewMode = btn.dataset.view;
        detailContent.querySelectorAll('.wip-view-btn').forEach(b => b.classList.toggle('active', b === btn));
        reRenderWip();
      };
    });

    // Stage All / Unstage All
    const stageAllBtn = detailContent.querySelector('.wip-stage-all-btn');
    if (stageAllBtn) { stageAllBtn.onclick = () => vscode.postMessage({ command: 'stageAll' }); }
    const unstageAllBtn = detailContent.querySelector('.wip-unstage-all-btn');
    if (unstageAllBtn) { unstageAllBtn.onclick = () => vscode.postMessage({ command: 'unstageAll' }); }

    // Collapse sections
    detailContent.querySelectorAll('.wip-sec-header').forEach(hdr => {
      hdr.onclick = e => {
        if (/** @type {HTMLElement} */(e.target).closest('button')) { return; }
        const body    = hdr.nextElementSibling;
        const chevron = hdr.querySelector('.wip-sec-chevron');
        const collapsed = body.classList.toggle('wip-sec-collapsed');
        chevron.textContent = collapsed ? '›' : '▾';
      };
    });

    // Expand All
    detailContent.querySelectorAll('.wip-expand-all').forEach(btn => {
      btn.onclick = () => {
        const type  = btn.dataset.type;
        const files = type === 'staged' ? staged : unstaged;
        const dirs  = type === 'staged' ? expandedStagedDirs : expandedUnstagedDirs;
        expandDirsForSet(files, dirs);
        reRenderWipSection(type);
      };
    });

    // File & dir clicks — delegated
    detailContent.onclick = e => {
      const stBtn = /** @type {HTMLElement} */(e.target).closest('[data-stage-action]');
      if (stBtn) {
        e.stopPropagation();
        vscode.postMessage({
          command: stBtn.dataset.stageAction === 'stage' ? 'stageFile' : 'unstageFile',
          path: stBtn.dataset.stagePath,
        });
        return;
      }
      const fileRow = /** @type {HTMLElement} */(e.target).closest('[data-file]');
      if (fileRow) {
        const cmd = fileRow.dataset.cmd || 'getStagedDiff';
        currentDiffHunks = null;
        diffBody.innerHTML = '<div class="diff-loading">Loading…</div>';
        diffFileTitle.textContent = fileRow.dataset.file;
        graphPane.style.display = 'none';
        diffOverlay.classList.remove('hidden');
        vscode.postMessage({ command: cmd, path: fileRow.dataset.file, status: fileRow.dataset.status });
        return;
      }
      const dirRow = /** @type {HTMLElement} */(e.target).closest('[data-dir][data-dtype]');
      if (dirRow) {
        const p     = dirRow.dataset.dir;
        const dtype = dirRow.dataset.dtype;
        const dirs  = dtype === 'staged' ? expandedStagedDirs : expandedUnstagedDirs;
        if (dirs.has(p)) { dirs.delete(p); } else { dirs.add(p); }
        reRenderWipSection(dtype);
      }
    };
  }

  function expandDirsForSet(files, set) {
    for (const f of files) {
      const parts = f.path.split('/');
      let prefix = '';
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
        set.add(prefix);
      }
    }
  }

  function reRenderWip() {
    const staged   = data ? (data.staged   || []) : [];
    const unstaged = data ? (data.unstaged || []) : [];
    const uEl = document.getElementById('d-unstaged-files');
    if (uEl) { uEl.innerHTML = renderWipFiles(unstaged, expandedUnstagedDirs, 'unstaged'); }
    const sEl = document.getElementById('d-staged-files');
    if (sEl) { sEl.innerHTML = renderWipFiles(staged, expandedStagedDirs, 'staged'); }
  }

  function reRenderWipSection(type) {
    const files = type === 'staged' ? (data?.staged || []) : (data?.unstaged || []);
    const dirs  = type === 'staged' ? expandedStagedDirs : expandedUnstagedDirs;
    const el    = document.getElementById(`d-${type}-files`);
    if (el) { el.innerHTML = renderWipFiles(files, dirs, type); }
  }

  function renderWipFiles(files, expandedSet, type) {
    if (!files.length) { return '<div class="d-loading">No changes</div>'; }
    const cmd         = type === 'staged' ? 'getStagedDiff' : 'getUnstagedDiff';
    const stageAction = type === 'unstaged' ? 'stage' : 'unstage';
    const sorted = wipSortMode === 'status'
      ? [...files].sort((a, b) => (a.status < b.status ? -1 : a.status > b.status ? 1 : a.path.localeCompare(b.path)))
      : [...files].sort((a, b) => a.path.localeCompare(b.path));
    const filesCmd = sorted.map(f => ({ ...f, cmd }));
    if (wipViewMode === 'path') { return renderWipPathList(filesCmd, stageAction); }
    return renderWipTreeHtml(buildFileTree(filesCmd), 0, '', expandedSet, type, stageAction);
  }

  function renderWipPathList(files, stageAction) {
    const parts = [];
    for (const f of files) {
      const color = FS_COLOR[f.status] || '#ccc';
      parts.push(`<div class="ft-file-row" data-file="${esc(f.path)}" data-status="${f.status}" data-cmd="${f.cmd}" style="padding-left:6px" title="${esc(f.path)}">${SVG_FILE_I}<span class="ft-name">${esc(f.path)}</span><span class="ft-badge" style="color:${color}">${f.status}</span><button class="ft-stage-btn" data-stage-action="${stageAction}" data-stage-path="${esc(f.path)}">${stageAction==='stage'?'+':'−'}</button></div>`);
    }
    return parts.join('');
  }

  function renderWipTreeHtml(node, depth, prefix, expandedSet, dtype, stageAction) {
    const parts = [];
    const pad   = depth * 14;
    const dirs  = Object.keys(node).filter(k => k !== '__files').sort();
    for (const key of dirs) {
      const fullPath = prefix ? `${prefix}/${key}` : key;
      const open     = expandedSet.has(fullPath);
      const counts   = getFolderCounts(node[key]);
      parts.push(`<div class="ft-dir-row" data-dir="${esc(fullPath)}" data-dtype="${dtype}" style="padding-left:${pad}px"><span class="ft-arrow">${open ? '▾' : '›'}</span>${open ? SVG_FOLDER_O : SVG_FOLDER_C}<span class="ft-name">${esc(key)}</span><span class="ft-dir-counts">${renderFolderCounts(counts)}</span></div>`);
      if (open) { parts.push(renderWipTreeHtml(node[key], depth + 1, fullPath, expandedSet, dtype, stageAction)); }
    }
    for (const f of (node.__files || [])) {
      const name    = f.path.split('/').pop();
      const display = f.oldPath ? `${f.oldPath.split('/').pop()} → ${name}` : name;
      const color   = FS_COLOR[f.status] || '#ccc';
      parts.push(`<div class="ft-file-row" data-file="${esc(f.path)}" data-status="${f.status}" data-cmd="${f.cmd}" style="padding-left:${pad + 18}px" title="${esc(f.path)}">${SVG_FILE_I}<span class="ft-name">${esc(display)}</span><span class="ft-badge" style="color:${color}">${f.status}</span><button class="ft-stage-btn" data-stage-action="${stageAction}" data-stage-path="${esc(f.path)}">${stageAction==='stage'?'+':'−'}</button></div>`);
    }
    return parts.join('');
  }

  function getFolderCounts(node) {
    const counts = {};
    function walk(n) {
      for (const f of (n.__files || [])) { counts[f.status] = (counts[f.status] || 0) + 1; }
      for (const k of Object.keys(n).filter(x => x !== '__files')) { walk(n[k]); }
    }
    walk(node);
    return counts;
  }

  const STATUS_SYMBOL = { A: '+', M: '✏', D: '−', R: '→', C: '⊕' };

  function renderFolderCounts(counts) {
    return Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `<span class="ft-dir-cnt" style="color:${FS_COLOR[s]||'#ccc'}">${STATUS_SYMBOL[s]||s} ${n}</span>`)
      .join('');
  }

  function setRowSelected(idx) {
    document.querySelectorAll('.row').forEach(el => {
      el.classList.toggle('selected', /** @type {HTMLElement} */(el).dataset.idx === String(idx));
    });
  }

  // ── Detail panel ──────────────────────────────────────────────────────────────
  function showDetail(c) {
    const color = COLORS[c.color % COLORS.length];
    detailContent.innerHTML = `
      <div class="d-subject">${esc(c.subject)}</div>
      <div class="d-meta">
        <div class="d-avatar" style="background:${hexToRgba(color,0.18)};border-color:${color};color:${lighten(color)}">${toInitials(c.author)}</div>
        <div>
          <div class="d-author">${esc(c.author)}</div>
          <div class="d-email">${esc(c.email)}</div>
        </div>
      </div>
      <div class="d-row"><span class="d-label">Hash</span>
        <code class="d-hash">${c.hash}</code>
      </div>
      <div class="d-row"><span class="d-label">Date</span><span>${esc(c.date)}</span></div>
      ${c.parents.length ? `<div class="d-row"><span class="d-label">Parents</span><span>${c.parents.map(p=>`<code class="d-hash">${p.slice(0,8)}</code>`).join(' ')}</span></div>` : ''}
      ${c.refs.filter(Boolean).length ? `<div class="d-row d-refs"><span class="d-label">Refs</span><span>${c.refs.filter(r=>r&&r!=='HEAD'&&!r.startsWith('HEAD ->')).map(r=>`<span class="ref-chip ref-local" style="border-color:${color};color:${lighten(color)}">${esc(r)}</span>`).join(' ')}</span></div>` : ''}
      <div class="d-files-header">
        <span class="d-files-label">Changed Files</span>
        <div class="d-view-toggle" style="margin-left:auto">
          <button class="d-view-btn${commitViewMode==='path'?' active':''}" data-view="path">≡ Path</button>
          <button class="d-view-btn${commitViewMode==='tree'?' active':''}" data-view="tree">⊞ Tree</button>
        </div>
      </div>
      <div id="d-files-section" class="d-files"><div class="d-loading">Loading…</div></div>`;

    detailPanel.classList.remove('hidden');

    // Path/Tree toggle for commit detail
    detailContent.querySelectorAll('.d-view-btn').forEach(btn => {
      btn.onclick = () => {
        commitViewMode = btn.dataset.view;
        detailContent.querySelectorAll('.d-view-btn').forEach(b => b.classList.toggle('active', b === btn));
        reRenderCommitFiles();
      };
    });

    pendingFilesHash = c.hash;
    vscode.postMessage({ command: 'getFiles', hash: c.hash });
  }

  // ── File explorer ─────────────────────────────────────────────────────────────
  const FS_COLOR = { A: '#34d399', M: '#fbbf24', D: '#f87171', R: '#a78bfa', C: '#22d3ee' };

  const SVG_FOLDER_C = '<svg class="ft-icon" viewBox="0 0 16 14" xmlns="http://www.w3.org/2000/svg"><path d="M0 2.5A1.5 1.5 0 0 1 1.5 1H5l1.5 2H14.5A1.5 1.5 0 0 1 16 4.5v7A1.5 1.5 0 0 1 14.5 13h-13A1.5 1.5 0 0 1 0 11.5V2.5z" fill="#e2a930" opacity="0.9"/></svg>';
  const SVG_FOLDER_O = '<svg class="ft-icon" viewBox="0 0 16 14" xmlns="http://www.w3.org/2000/svg"><path d="M0 2.5A1.5 1.5 0 0 1 1.5 1H5l1.5 2H14.5A1.5 1.5 0 0 1 16 4.5V6H0V2.5z" fill="#e2a930" opacity="0.9"/><path d="M0 6h16L14 13H2L0 6z" fill="#e2a930" opacity="0.7"/></svg>';
  const SVG_FILE_I   = '<svg class="ft-icon" viewBox="0 0 14 16" xmlns="http://www.w3.org/2000/svg"><path d="M2 1h7.5L12 3.5V15H2V1z" fill="rgba(200,200,200,0.12)" stroke="rgba(200,200,200,0.4)" stroke-width="0.8"/><path d="M9 1v2.5h3" fill="none" stroke="rgba(200,200,200,0.4)" stroke-width="0.8"/></svg>';

  let expandedDirs   = new Set();
  let currentFilesData = [];
  let cachedFileTree = null;         // cache tree to avoid rebuilding
  let cachedFileTreeDataKey = null;  // track what data was used for cache

  function buildFileTree(files) {
    const root = {};
    for (const f of files) {
      const parts = f.path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]]) { node[parts[i]] = { __files: [] }; }
        node = node[parts[i]];
      }
      if (!node.__files) { node.__files = []; }
      node.__files.push(f);
    }
    return root;
  }

  function renderTreeHtml(node, depth, prefix) {
    const parts = [];
    const pad = depth * 14;
    const dirs = Object.keys(node).filter(k => k !== '__files').sort();

    for (const key of dirs) {
      const fullPath = prefix ? `${prefix}/${key}` : key;
      const open = expandedDirs.has(fullPath);
      parts.push(`<div class="ft-dir-row" data-dir="${esc(fullPath)}" style="padding-left:${pad}px"><span class="ft-arrow">${open ? '▾' : '›'}</span>${open ? SVG_FOLDER_O : SVG_FOLDER_C}<span class="ft-name">${esc(key)}</span></div>`);
      if (open) { parts.push(renderTreeHtml(node[key], depth + 1, fullPath)); }
    }

    for (const f of (node.__files || [])) {
      const name = f.path.split('/').pop();
      const display = f.oldPath ? `${f.oldPath.split('/').pop()} → ${name}` : name;
      const color = FS_COLOR[f.status] || '#ccc';
      const btn = f.cmd === 'getUnstagedDiff' ? `<button class="ft-stage-btn" data-stage-action="stage" data-stage-path="${esc(f.path)}" data-tip="Stage file">+</button>`
               : f.cmd === 'getStagedDiff'  ? `<button class="ft-stage-btn" data-stage-action="unstage" data-stage-path="${esc(f.path)}" data-tip="Unstage file">−</button>` : '';
      parts.push(`<div class="ft-file-row" data-file="${esc(f.path)}" data-status="${f.status}" data-cmd="${f.cmd || ''}" style="padding-left:${pad + 18}px" title="${esc(f.path)}">${SVG_FILE_I}<span class="ft-name">${esc(display)}</span><span class="ft-badge" style="color:${color}">${f.status}</span>${btn}</div>`);
    }
    return parts.join('');
  }

  function rerenderTree() {
    const section = document.getElementById('d-files-section');
    if (section) { section.innerHTML = renderTreeHtml(buildFileTree(currentFilesData), 0, ''); }
  }

  function renderFiles(hash, files) {
    if (!data || hash !== pendingFilesHash) { return; }
    pendingFilesHash = null;
    const section = document.getElementById('d-files-section');
    if (!section) { return; }

    currentFilesData = files;
    expandedDirs = new Set();

    if (!files.length) {
      section.innerHTML = '<div class="d-loading">No changes</div>';
      return;
    }

    // expand all dirs by default
    for (const f of files) {
      const parts = f.path.split('/');
      let prefix = '';
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
        expandedDirs.add(prefix);
      }
    }

    // update header count
    const hdr = document.querySelector('.d-files-header .d-label');
    if (hdr) { hdr.textContent = `Changed Files (${files.length})`; }

    // Cache tree: only rebuild if data changed
    const filesKey = JSON.stringify(files.map(f => f.path).sort());
    if (cachedFileTreeDataKey !== filesKey) {
      cachedFileTree = buildFileTree(files);
      cachedFileTreeDataKey = filesKey;
    }

    section.innerHTML = commitViewMode === 'path'
      ? renderCommitPathList(files)
      : renderTreeHtml(cachedFileTree, 0, '');

    section.onclick = e => {
      const fileRow = /** @type {HTMLElement} */(e.target).closest('[data-file]');
      if (fileRow) {
        const commit = data.commits[selectedIdx];
        currentDiffHunks = null;
        diffBody.innerHTML = '<div class="diff-loading">Loading…</div>';
        diffFileTitle.textContent = fileRow.dataset.file;
        graphPane.style.display = 'none';
        diffOverlay.classList.remove('hidden');
        vscode.postMessage({
          command: 'getDiff',
          path:       fileRow.dataset.file,
          status:     fileRow.dataset.status,
          hash:       commit.hash,
          parentHash: commit.parents[0] || null,
        });
        return;
      }
      const dirRow = /** @type {HTMLElement} */(e.target).closest('[data-dir]');
      if (dirRow) {
        const p = dirRow.dataset.dir;
        if (expandedDirs.has(p)) { expandedDirs.delete(p); } else { expandedDirs.add(p); }
        rerenderTree();
      }
    };
  }

  function reRenderCommitFiles() {
    const section = document.getElementById('d-files-section');
    if (section && currentFilesData.length > 0) {
      section.innerHTML = commitViewMode === 'path'
        ? renderCommitPathList(currentFilesData)
        : renderTreeHtml(cachedFileTree || buildFileTree(currentFilesData), 0, '');
    }
  }

  function renderCommitPathList(files) {
    const parts = [];
    for (const f of files) {
      const color = FS_COLOR[f.status] || '#ccc';
      parts.push(`<div class="ft-file-row" data-file="${esc(f.path)}" data-status="${f.status}" style="padding-left:6px" title="${esc(f.path)}">${SVG_FILE_I}<span class="ft-name">${esc(f.path)}</span><span class="ft-badge" style="color:${color}">${f.status}</span></div>`);
    }
    return parts.join('');
  }

  // ── Diff overlay ──────────────────────────────────────────────────────────────
  function parseDiff(text) {
    const lines = text.split('\n');
    const hunks = [];
    let hunk = null, oldN = 0, newN = 0;
    for (const raw of lines) {
      if (raw.startsWith('@@')) {
        const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (!m) { continue; }
        oldN = parseInt(m[1]); newN = parseInt(m[2]);
        hunk = { header: raw, lines: [] };
        hunks.push(hunk);
      } else if (hunk) {
        if      (raw.startsWith('+')) { hunk.lines.push({ t: 'a', c: raw.slice(1), n: newN++ }); }
        else if (raw.startsWith('-')) { hunk.lines.push({ t: 'd', c: raw.slice(1), o: oldN++ }); }
        else if (raw.startsWith(' ')) { hunk.lines.push({ t: 'c', c: raw.slice(1), o: oldN++, n: newN++ }); }
      }
    }
    return hunks;
  }

  function toSplitPairs(lines) {
    const rows = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (l.t === 'c') { rows.push([l, l]); i++; continue; }
      const dels = [], adds = [];
      while (i < lines.length && lines[i].t === 'd') { dels.push(lines[i++]); }
      while (i < lines.length && lines[i].t === 'a') { adds.push(lines[i++]); }
      if (!dels.length && !adds.length) { i++; continue; }
      const len = Math.max(dels.length, adds.length);
      for (let j = 0; j < len; j++) { rows.push([dels[j] || null, adds[j] || null]); }
    }
    return rows;
  }

  function renderDiffContent() {
    if (!currentDiffHunks || !currentDiffHunks.length) {
      diffBody.innerHTML = '<div class="diff-loading">No diff available</div>';
      return;
    }
    if      (diffMode === 'split')  { diffBody.innerHTML = renderSplitMode(currentDiffHunks); }
    else if (diffMode === 'inline') { diffBody.innerHTML = renderInlineMode(currentDiffHunks); }
    else                            { diffBody.innerHTML = renderHunkMode(currentDiffHunks); }
  }

  function renderSplitMode(hunks) {
    let html = '<table class="diff-table">';
    for (const h of hunks) {
      html += `<tr class="diff-hunk-hdr"><td colspan="4">${esc(h.header)}</td></tr>`;
      for (const [left, right] of toSplitPairs(h.lines)) {
        const lc = left  ? (left.t  === 'd' ? ' dl' : '') : ' de';
        const rc = right ? (right.t === 'a' ? ' da' : '') : ' de';
        html += `<tr>
          <td class="diff-ln${lc}">${left?.o ?? ''}</td>
          <td class="diff-code diff-split-left${lc}">${left ? esc(left.c) : ''}</td>
          <td class="diff-ln${rc}">${right?.n ?? ''}</td>
          <td class="diff-code${rc}">${right ? esc(right.c) : ''}</td>
        </tr>`;
      }
    }
    return html + '</table>';
  }

  function renderInlineMode(hunks) {
    let html = '<table class="diff-table">';
    for (const h of hunks) {
      html += `<tr class="diff-hunk-hdr"><td colspan="3">${esc(h.header)}</td></tr>`;
      for (const l of h.lines) {
        const cls  = l.t === 'a' ? ' da' : l.t === 'd' ? ' dl' : '';
        const sign = l.t === 'a' ? '+' : l.t === 'd' ? '-' : ' ';
        const oln  = l.t !== 'a' ? String(l.o ?? '') : '';
        const nln  = l.t !== 'd' ? String(l.n ?? '') : '';
        html += `<tr class="${cls}">
          <td class="diff-ln">${oln}</td>
          <td class="diff-ln">${nln}</td>
          <td class="diff-code"><span class="diff-sign">${sign}</span>${esc(l.c)}</td>
        </tr>`;
      }
    }
    return html + '</table>';
  }

  function renderHunkMode(hunks) {
    let html = '<table class="diff-table">';
    for (const h of hunks) {
      const changed = h.lines.filter(l => l.t !== 'c');
      if (!changed.length) { continue; }
      html += `<tr class="diff-hunk-hdr"><td colspan="3">${esc(h.header)}</td></tr>`;
      for (const l of changed) {
        const cls  = l.t === 'a' ? ' da' : ' dl';
        const sign = l.t === 'a' ? '+' : '-';
        const ln   = l.t === 'a' ? String(l.n ?? '') : String(l.o ?? '');
        html += `<tr class="${cls}">
          <td class="diff-ln">${ln}</td>
          <td class="diff-code"><span class="diff-sign">${sign}</span>${esc(l.c)}</td>
        </tr>`;
      }
    }
    return html + '</table>';
  }

  // ── Context menu ──────────────────────────────────────────────────────────────
  let ctxEl = null;
  function showCtxMenu(e, commit) {
    removeCtxMenu();
    const groups = groupRefs(commit.refs);
    const localBranches  = groups.filter(g => g.type !== 'tag' && g.local).map(g => g.name);
    const remoteOnlyBranches = groups
      .filter(g => g.type !== 'tag' && !g.local && g.remote)
      .map(g => ({ full: g.name, local: g.name.replace(/^[^/]+\//, '') }));
    const branchNames    = groups.filter(g => g.type !== 'tag').map(g => g.name);
    const isCurrentBranch = groups.some(g => g.current);
    // First local branch name to use as merge source
    const mergeSource = localBranches[0] ?? (remoteOnlyBranches[0]?.local ?? null);

    // Checkout items: local branches + remote-only (strip prefix → DWIM), or detached HEAD
    let checkoutItems = '';
    if (localBranches.length || remoteOnlyBranches.length) {
      checkoutItems += localBranches.map(n =>
        `<div class="ctx-item" data-a="co-branch" data-branch="${esc(n)}">Checkout ${esc(n)}</div>`
      ).join('');
      checkoutItems += remoteOnlyBranches.map(b =>
        `<div class="ctx-item" data-a="co-branch" data-branch="${esc(b.local)}">Checkout ${esc(b.local)}</div>`
      ).join('');
    } else {
      checkoutItems = `<div class="ctx-item" data-a="co-detach">Checkout (detached HEAD)</div>`;
    }
    const createBranchItem = `<div class="ctx-sep"></div><div class="ctx-item" data-a="new-branch">Create branch here…</div>`;

    // Copy branch items
    let copyItems = '';
    if (branchNames.length === 1) {
      copyItems = `<div class="ctx-item" data-a="copy-branch" data-branch="${esc(branchNames[0])}">Copy branch name</div>`;
    } else if (branchNames.length > 1) {
      copyItems = branchNames.map(n => `<div class="ctx-item" data-a="copy-branch" data-branch="${esc(n)}">Copy "${esc(n)}"</div>`).join('');
    }

    ctxEl = document.createElement('div');
    ctxEl.className = 'ctx-menu';
    ctxEl.style.cssText = `left:${e.pageX}px;top:${e.pageY}px`;
    const mergeItem = (!isCurrentBranch && mergeSource)
      ? `<div class="ctx-sep"></div><div class="ctx-item" data-a="merge-to-current" data-branch="${esc(mergeSource)}">Merge ${esc(mergeSource)} to current branch</div>`
      : '';

    ctxEl.innerHTML = `
      ${checkoutItems}
      ${createBranchItem}
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-a="copy">Copy hash</div>
      <div class="ctx-item" data-a="detail">Show details</div>
      ${copyItems ? '<div class="ctx-sep"></div>' + copyItems : ''}
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-a="cherry-pick">Cherry-pick commit</div>
      <div class="ctx-item" data-a="revert">Revert commit</div>
      <div class="ctx-item" data-a="rebase">Rebase onto this commit</div>
      <div class="ctx-item ctx-item-has-sub">Reset branch to commit <span class="ctx-arrow">›</span>
        <div class="ctx-submenu">
          <div class="ctx-item" data-a="reset-soft">Soft — keep all changes</div>
          <div class="ctx-item" data-a="reset-mixed">Mixed — keep working copy</div>
          <div class="ctx-item ctx-item-danger" data-a="reset-hard">Hard — discard all changes</div>
        </div>
      </div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-a="create-tag">Create tag here…</div>
      ${mergeItem}`;
    ctxEl.addEventListener('click', ev => {
      const el = /** @type {HTMLElement} */(ev.target);
      const a = el.dataset.a;
      if (a === 'co-branch')        { vscode.postMessage({ command: 'checkoutBranch', branch: el.dataset.branch }); }
      if (a === 'co-detach')        { vscode.postMessage({ command: 'checkoutDetach', hash: commit.hash }); }
      if (a === 'new-branch')       { vscode.postMessage({ command: 'newBranch', hash: commit.hash }); }
      if (a === 'copy')             { vscode.postMessage({ command: 'copyHash', hash: commit.hash }); }
      if (a === 'detail')           { selectCommit(data.commits.indexOf(commit)); }
      if (a === 'copy-branch')      { vscode.postMessage({ command: 'copyHash', hash: el.dataset.branch }); }
      if (a === 'merge-to-current') { vscode.postMessage({ command: 'mergeToCurrent', source: el.dataset.branch }); }
      if (a === 'cherry-pick')      { vscode.postMessage({ command: 'cherryPick', hash: commit.hash }); }
      if (a === 'revert')           { vscode.postMessage({ command: 'revertCommit', hash: commit.hash }); }
      if (a === 'rebase')           { vscode.postMessage({ command: 'rebaseOnto', hash: commit.hash }); }
      if (a === 'reset-soft')       { vscode.postMessage({ command: 'resetCommit', hash: commit.hash, mode: 'soft' }); }
      if (a === 'reset-mixed')      { vscode.postMessage({ command: 'resetCommit', hash: commit.hash, mode: 'mixed' }); }
      if (a === 'reset-hard')       { vscode.postMessage({ command: 'resetCommit', hash: commit.hash, mode: 'hard' }); }
      if (a === 'create-tag')       { vscode.postMessage({ command: 'createTag', hash: commit.hash }); }
      removeCtxMenu();
    });
    document.body.appendChild(ctxEl);
    setTimeout(() => document.addEventListener('click', removeCtxMenu, { once: true }), 0);
  }
  function removeCtxMenu() { ctxEl?.remove(); ctxEl = null; }

  function showChipCtxMenu(e, commit, g) {
    // Local branch name (strip remote prefix if needed)
    const localName = (!g.local && g.remote) ? g.name.replace(/^[^/]+\//, '') : g.name;
    removeCtxMenu();
    ctxEl = document.createElement('div');
    ctxEl.className = 'ctx-menu';
    ctxEl.style.cssText = `left:${e.pageX}px;top:${e.pageY}px`;
    ctxEl.innerHTML = `
      <div class="ctx-item" data-a="push">Push ${esc(localName)}</div>
      <div class="ctx-item" data-a="pull">Pull ${esc(localName)}</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-a="co-branch" data-branch="${esc(localName)}">Checkout ${esc(localName)}</div>
      <div class="ctx-item" data-a="new-branch">Create branch here…</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-a="copy">Copy hash</div>
      <div class="ctx-item" data-a="copy-branch" data-branch="${esc(g.name)}">Copy branch name</div>
      <div class="ctx-sep"></div>
      ${g.local  ? `<div class="ctx-item ctx-item-danger" data-a="del-local">Delete local branch</div>` : ''}
      ${g.remote ? `<div class="ctx-item ctx-item-danger" data-a="del-remote">Delete remote branch</div>` : ''}`;
    ctxEl.addEventListener('click', ev => {
      const el = /** @type {HTMLElement} */(ev.target);
      const a = el.dataset.a;
      if (a === 'push')        { vscode.postMessage({ command: 'pushBranch', branch: localName }); }
      if (a === 'pull')        { vscode.postMessage({ command: 'pullBranch', branch: localName }); }
      if (a === 'co-branch')   { vscode.postMessage({ command: 'checkoutBranch', branch: el.dataset.branch }); }
      if (a === 'new-branch')  { vscode.postMessage({ command: 'newBranch', hash: commit.hash }); }
      if (a === 'copy')        { vscode.postMessage({ command: 'copyHash', hash: commit.hash }); }
      if (a === 'copy-branch') { vscode.postMessage({ command: 'copyHash', hash: el.dataset.branch }); }
      if (a === 'del-local')   { vscode.postMessage({ command: 'deleteLocalBranch', branch: localName }); }
      if (a === 'del-remote')  { vscode.postMessage({ command: 'deleteRemoteBranch', branch: localName }); }
      removeCtxMenu();
    });
    document.body.appendChild(ctxEl);
    setTimeout(() => document.addEventListener('click', removeCtxMenu, { once: true }), 0);
  }

  function showSidebarBranchCtxMenu(e, fullBranch) {
    const isRemote = fullBranch.startsWith('remotes/');
    const localName = isRemote ? fullBranch.split('/').slice(2).join('/') : fullBranch;
    const targetRef = isRemote ? 'refs/' + fullBranch : 'refs/heads/' + fullBranch;
    const tipCommit = (data ? data.commits : []).find(c => c.refs.some(r => {
      const clean = r.startsWith('HEAD -> ') ? r.slice(8) : r;
      return clean === targetRef || clean === fullBranch;
    }));
    removeCtxMenu();
    ctxEl = document.createElement('div');
    ctxEl.className = 'ctx-menu';
    ctxEl.style.cssText = `left:${e.pageX}px;top:${e.pageY}px`;
    if (!isRemote) {
      ctxEl.innerHTML = `
        <div class="ctx-item" data-a="push">Push ${esc(localName)}</div>
        <div class="ctx-item" data-a="pull">Pull ${esc(localName)}</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item" data-a="co-branch" data-branch="${esc(localName)}">Checkout ${esc(localName)}</div>
        ${tipCommit ? `<div class="ctx-item" data-a="new-branch">Create branch here…</div>` : ''}
        <div class="ctx-sep"></div>
        <div class="ctx-item" data-a="copy-branch" data-branch="${esc(localName)}">Copy branch name</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item ctx-item-danger" data-a="del-local">Delete local branch</div>`;
    } else {
      ctxEl.innerHTML = `
        <div class="ctx-item" data-a="co-branch" data-branch="${esc(localName)}">Checkout ${esc(localName)}</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item" data-a="copy-branch" data-branch="${esc(localName)}">Copy branch name</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item ctx-item-danger" data-a="del-remote">Delete remote branch</div>`;
    }
    ctxEl.addEventListener('click', ev => {
      const el = /** @type {HTMLElement} */(ev.target);
      const a = el.dataset.a;
      if (a === 'push')       { vscode.postMessage({ command: 'pushBranch', branch: localName }); }
      if (a === 'pull')       { vscode.postMessage({ command: 'pullBranch', branch: localName }); }
      if (a === 'co-branch')  { vscode.postMessage({ command: 'checkoutBranch', branch: el.dataset.branch }); }
      if (a === 'new-branch' && tipCommit) { vscode.postMessage({ command: 'newBranch', hash: tipCommit.hash }); }
      if (a === 'copy-branch') { vscode.postMessage({ command: 'copyHash', hash: el.dataset.branch }); }
      if (a === 'del-local')  { vscode.postMessage({ command: 'deleteLocalBranch', branch: localName }); }
      if (a === 'del-remote') { vscode.postMessage({ command: 'deleteRemoteBranch', branch: localName }); }
      removeCtxMenu();
    });
    document.body.appendChild(ctxEl);
    setTimeout(() => document.addEventListener('click', removeCtxMenu, { once: true }), 0);
  }

  function showStashCtxMenu(e, stash) {
    removeCtxMenu();
    ctxEl = document.createElement('div');
    ctxEl.className = 'ctx-menu';
    ctxEl.style.cssText = `left:${e.pageX}px;top:${e.pageY}px`;
    ctxEl.innerHTML = `
      <div class="ctx-item" data-a="pop">Pop stash</div>
      <div class="ctx-item ctx-item-danger" data-a="drop">Delete stash</div>`;
    ctxEl.addEventListener('click', ev => {
      const a = /** @type {HTMLElement} */(ev.target).dataset.a;
      if (a === 'pop')  { vscode.postMessage({ command: 'popStash',  name: stash.name }); }
      if (a === 'drop') { vscode.postMessage({ command: 'dropStash', name: stash.name }); }
      removeCtxMenu();
    });
    document.body.appendChild(ctxEl);
    setTimeout(() => document.addEventListener('click', removeCtxMenu, { once: true }), 0);
  }

  function showTagCtxMenu(e, tagName) {
    removeCtxMenu();
    ctxEl = document.createElement('div');
    ctxEl.className = 'ctx-menu';
    ctxEl.style.cssText = `left:${e.pageX}px;top:${e.pageY}px`;
    ctxEl.innerHTML = `<div class="ctx-item ctx-item-danger" data-a="delete-tag">Delete tag ${esc(tagName)}</div>`;
    ctxEl.addEventListener('click', ev => {
      if (/** @type {HTMLElement} */(ev.target).dataset.a === 'delete-tag') {
        vscode.postMessage({ command: 'deleteTag', name: tagName });
      }
      removeCtxMenu();
    });
    document.body.appendChild(ctxEl);
    setTimeout(() => document.addEventListener('click', removeCtxMenu, { once: true }), 0);
  }

  // ── Column resize ─────────────────────────────────────────────────────────────
  function initColumnResize() {
    const colVars = {
      branch: '--col-branch',
      graph:  '--col-graph',
      msg:    '--col-msg',
      author: '--col-author',
      date:   '--col-date',
      hash:   '--col-hash',
    };
    const minWidths = { branch: 80, graph: 36, msg: 120, author: 60, date: 60, hash: 50 };

    let drag = null;

    document.querySelectorAll('.rh').forEach(handle => {
      handle.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        const col = /** @type {HTMLElement} */(handle).dataset.col;
        const cssVar = colVars[col];
        const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar)) || 100;
        drag = { col, cssVar, startX: /** @type {MouseEvent} */(e).clientX, startW, min: minWidths[col] };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });
    });

    document.addEventListener('mousemove', e => {
      if (!drag) { return; }
      const delta = e.clientX - drag.startX;
      const newW  = Math.max(drag.min, drag.startW + delta);
      document.documentElement.style.setProperty(drag.cssVar, newW + 'px');
    });

    document.addEventListener('mouseup', () => {
      if (!drag) { return; }
      drag = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ── Detail panel resize ───────────────────────────────────────────────────────
  function initDetailResize() {
    const handle = document.getElementById('detail-resize-handle');
    let drag = null;

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      drag = { startX: e.clientX, startW: detailPanel.offsetWidth };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', e => {
      if (!drag) { return; }
      const maxW = Math.floor(window.innerWidth * 0.7);
      const newW = Math.max(180, Math.min(maxW, drag.startW + (drag.startX - e.clientX)));
      detailPanel.style.width     = newW + 'px';
      detailPanel.style.flexBasis = newW + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!drag) { return; }
      drag = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // ── Scroll sync ───────────────────────────────────────────────────────────────
  function initScrollSync() {
    let scrollRaf = null;
    scrollWrap.addEventListener('scroll', () => {
      colHeadersInner.style.transform = `translateX(-${scrollWrap.scrollLeft}px)`;
      if (scrollRaf) { return; }
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        redrawCanvas();
      });
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function nx(col) { return GRAPH_PAD + col * COL_W + COL_W / 2; }
  function ny(commitIdx) {
    const absY = commitRowY.get(commitIdx) ?? (wipOffset + commitIdx * ROW_H + ROW_H / 2);
    return absY - canvasOffset;
  }

  function toInitials(name) {
    const p = (name || '?').trim().split(/\s+/);
    return p.length === 1 ? p[0].slice(0, 2).toUpperCase()
                          : (p[0][0] + p[p.length - 1][0]).toUpperCase();
  }

  function hexToRgba(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function lighten(hex) {
    const r = Math.min(255, parseInt(hex.slice(1,3),16) + 80);
    const g = Math.min(255, parseInt(hex.slice(3,5),16) + 80);
    const b = Math.min(255, parseInt(hex.slice(5,7),16) + 80);
    return `rgb(${r},${g},${b})`;
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' }); }
    catch { return iso; }
  }

  // ── Toast notifications ───────────────────────────────────────────────────────
  function showToast(type, title, detail) {
    const c = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    const icon = type === 'success'
      ? '<svg class="toast-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="2,8 6,12 14,4"/></svg>'
      : '<svg class="toast-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>';
    el.innerHTML = `<div class="toast-icon">${icon}</div><div class="toast-text"><div class="toast-title">${esc(title)}</div>${detail ? `<div class="toast-detail">${esc(detail)}</div>` : ''}</div><button class="toast-close" title="Dismiss">×</button>`;
    el.querySelector('.toast-close').addEventListener('click', () => removeToast(el));
    c.appendChild(el);
    el._tid = setTimeout(() => removeToast(el), 5000);
  }

  function removeToast(el) {
    if (el._tid) { clearTimeout(el._tid); }
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 270);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  vscode.postMessage({ command: 'ready' });
  statusBar.textContent = 'Loading…';
})();
