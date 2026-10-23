// Unit tests of collapsed clades as a view of the viewer (#29): `setCollapsed(nodeIds)` takes ids of the FULL tree, the clade is one row
// and one summary, and everything that puts a tip on the screen (cut, hit, columns, focus, keyboard, highlights, window) goes through the
// rank <-> row tables of the layout. The pure parts run on the layout and the cut; the rest on a real TreeViewer over the recording canvas.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { parseNewick } = await import(path.join(root, 'packages/io/src/newick.ts'));
const core = path.join(root, 'packages/viewer/src');
const { computeLayout, ensureTrig, remapRow } = await import(path.join(core, 'layout.ts'));
const { InMemorySource } = await import(path.join(core, 'source.ts'));
const { makeTransform } = await import(path.join(core, 'geom.ts'));
const { projectionFor } = await import(path.join(core, 'projection.ts'));
const { cut, newCutResult, DrawList, Seen, K_SUMMARY, K_NODE, K_TIP } = await import(path.join(core, 'lod.ts'));
const { navigate, defaultActiveNode } = await import(path.join(core, 'keyboard.ts'));
const { makeViewer, destroyAll } = await import('./viewer-harness.mjs');

afterEach(destroyAll);

// preorder: 0 r, 1 x, 2 a, 3 b, 4 y, 5 c, 6 z, 7 d, 8 e, 9 f ; ranks: a0 b1 c2 d3 e4 f5
const NWK = '((a:1,b:2)x:1,(c:1,(d:2,e:3)z:1)y:2,f:4)r;';
// dated: every tip is 3 from the root
const DATED = '((a:2,b:2)x:1,(c:1,d:1,e:1)y:2,f:3)r;';

const snapshot = (nwk = NWK) => new InMemorySource(parseNewick(nwk)).snapshot();
const mask = (n, ...ids) => {
  const m = new Uint8Array(n);
  for (const i of ids) m[i] = 1;
  return m;
};
const node = (t, label) => t.tipIndex(label);
const parentOf = (t, label) => t.parent[node(t, label)];

// ---------------------------------------------------------------------------------------------------------------------------- layout

test('layout: a collapsed clade is one row; rank <-> row tables, rows of every node, hidden nodes share the clade row', () => {
  const t = snapshot();
  const x = parentOf(t, 'a'),
    z = parentOf(t, 'd');
  const L = computeLayout(t, true, mask(t.nodeCount, x));
  assert.equal(L.tips, 6);
  assert.equal(L.rows, 5, 'a and b share one row');
  assert.deepEqual([...L.rowOfRank], [0, 0, 1, 2, 3, 4]);
  assert.deepEqual([...L.rankOfRow], [0, 2, 3, 4, 5, 6], 'first rank of each row, then the tip count');
  assert.equal(L.rowNode[0], x, 'the row of the clade is the clade');
  assert.equal(L.rowNode[1], node(t, 'c'), 'the other rows are tips');
  assert.deepEqual([L.rowStart[x], L.rowEnd[x]], [0, 1]);
  assert.deepEqual([L.rowStart[node(t, 'a')], L.rowEnd[node(t, 'a')]], [0, 1], 'a hidden tip has the row of its clade');
  assert.equal(L.ROW[x], 0.5);
  assert.equal(L.ROW[node(t, 'a')], 0.5);
  assert.equal(L.ROW[node(t, 'c')], 1.5);
  assert.equal(L.ROW[z], 3, 'a clade after the collapsed one is shifted up by the freed row (d on row 2, e on row 3)');
  const y = parentOf(t, 'c');
  assert.deepEqual([L.rowStart[y], L.rowEnd[y]], [1, 4]);
  assert.equal(L.ROW[y], (1.5 + 3) / 2);
  assert.deepEqual([L.rowStart[0], L.rowEnd[0]], [0, 5]);
  assert.equal(L.collapsed[x], 1);
  assert.equal(L.collapsed[node(t, 'a')], 0);
  // X and XMAX do not depend on the collapse: the triangle ends at the clade's deepest tip
  const plain = computeLayout(t, true);
  assert.deepEqual([...L.X], [...plain.X]);
  assert.deepEqual([...L.XMAX], [...plain.XMAX]);
});

test('layout: nothing collapsed gives the identity (the very leaf arrays, no tables); tips and unknown marks collapse nothing', () => {
  const t = snapshot();
  for (const m of [null, new Uint8Array(t.nodeCount), mask(t.nodeCount, node(t, 'a'), node(t, 'f'))]) {
    const L = computeLayout(t, true, m);
    assert.equal(L.rows, t.tipCount);
    assert.equal(L.rowStart, t.leafStart, 'the same array: nothing is copied or slower');
    assert.equal(L.rowEnd, t.leafEnd);
    assert.equal(L.rowOfRank, null);
    assert.equal(L.rankOfRow, null);
    assert.equal(L.rowNode, null);
    assert.equal(L.collapsed, null);
  }
});

test('layout: of nested collapsed clades the outermost wins; the inner one is hidden, not marked', () => {
  const t = snapshot();
  const y = parentOf(t, 'c'),
    z = parentOf(t, 'd');
  const L = computeLayout(t, true, mask(t.nodeCount, z, y));
  assert.equal(L.rows, 4, 'a b c(de) f -> a, b, y, f');
  assert.deepEqual([...L.rowOfRank], [0, 1, 2, 2, 2, 3]);
  assert.equal(L.collapsed[y], 1);
  assert.equal(L.collapsed[z], 0);
  assert.equal(L.rowNode[2], y);
  assert.deepEqual([L.rowStart[z], L.rowEnd[z]], [2, 3]);
});

test('layout: the root collapsed is one row; rows of the whole tree', () => {
  const t = snapshot();
  const L = computeLayout(t, true, mask(t.nodeCount, 0));
  assert.equal(L.rows, 1);
  assert.deepEqual([...L.rankOfRow], [0, 6]);
  assert.equal(L.ROW[0], 0.5);
});

test('layout: the axis does not change: a dated tree stays ultrametric with a collapsed clade', () => {
  const t = snapshot(DATED);
  const x = parentOf(t, 'a');
  assert.equal(computeLayout(t, true).ultrametric, true);
  const L = computeLayout(t, true, mask(t.nodeCount, x));
  assert.equal(L.ultrametric, true);
  assert.equal(L.usedLengths, true);
  assert.equal(L.maxLen, computeLayout(t, true).maxLen, 'the scale is that of the whole tree');
  assert.ok(Math.abs(L.XMAX[x] - 1) < 1e-6, 'the triangle ends at the present');
});

test('remapRow: a position follows its tips from one layout to another, and back', () => {
  const t = snapshot();
  const x = parentOf(t, 'a');
  const a = computeLayout(t, true);
  const b = computeLayout(t, true, mask(t.nodeCount, x));
  assert.equal(remapRow(3.5, a, b), 2.5, 'the freed row shifts what is below');
  assert.equal(remapRow(2.5, b, a), 3.5);
  assert.equal(remapRow(0, a, b), 0);
  assert.equal(remapRow(1, a, b), 0.5, 'half way through the clade, the middle of its row');
  assert.equal(remapRow(0.4, a, a), 0.4, 'the same layout');
  assert.equal(remapRow(5.5, a, b), 4.5);
});

// ---------------------------------------------------------------------------------------------------------------------------- cut

function cutOf(L, t, kind, o = {}) {
  const N = L.rows;
  if (kind === 'radial') ensureTrig(L);
  const rect = kind === 'rectangular';
  const [W, H] = rect ? [600, 120] : [400, 400];
  const area = { ax: 0, ay: 0, aw: W, ah: H, clipL: 0, clipT: 0, clipR: W, clipB: H };
  const view = rect ? { x0: 0, x1: 1, y0: 0, y1: N } : { x0: -1.2, x1: 1.2, y0: -1.2, y1: 1.2 };
  const T = makeTransform(kind, W, H, view, area, N);
  const proj = projectionFor(t, L, T);
  const list = new DrawList();
  cut(proj, { lod: o.lod ?? true, minPx: o.minPx ?? 3, budget: 10000, summaries: o.summaries ?? true }, null, list, new Seen(), newCutResult());
  const out = [];
  for (let e = 0; e < list.count; e++) out.push([list.node[e], list.kind[e], list.last[e]]);
  return out;
}

for (const kind of ['rectangular', 'radial']) {
  test(`cut (${kind}): a collapsed clade is one summary and is never descended into, with or without level of detail or summaries`, () => {
    const t = snapshot();
    const x = parentOf(t, 'a');
    const L = computeLayout(t, true, mask(t.nodeCount, x));
    for (const o of [{}, { lod: false }, { summaries: false }, { minPx: 0.001 }]) {
      const list = cutOf(L, t, kind, o);
      const mine = list.filter(([n]) => n === x);
      assert.deepEqual(mine, [[x, K_SUMMARY, -1]], `one summary (${JSON.stringify(o)})`);
      assert.ok(!list.some(([n]) => n === node(t, 'a') || n === node(t, 'b')), 'its tips are not visited');
      assert.ok(
        list.some(([n, k]) => n === node(t, 'c') && k === K_TIP),
        'the rest of the tree is cut as before',
      );
    }
    // not collapsed: the same clade is opened at this size
    const open = cutOf(computeLayout(t, true), t, kind, { minPx: 1 });
    assert.ok(open.some(([n, k]) => n === x && k === K_NODE));
  });
}

test('cut (rectangular): a collapsed clade a pixel high is not merged into a run of small siblings', () => {
  // 40 sibling clades under one parent, every one 2 tips; the 21st is collapsed. At minPx 50 all of them are sub-threshold and would be
  // slices; the collapsed one stays its own summary (so a click on it still says which clade it is) and splits the run in two.
  const ch = (k) => `(p${k}a:1,p${k}b:1)c${k}:1`;
  const t = snapshot('(' + Array.from({ length: 40 }, (_, k) => ch(k)).join(',') + ')root;');
  const c20 = parentOf(t, 'p20a');
  const L = computeLayout(t, true, mask(t.nodeCount, c20));
  const list = cutOf(L, t, 'rectangular', { minPx: 50 });
  const own = list.filter(([n, , last]) => n === c20 && last === -1);
  assert.equal(own.length, 1);
  assert.equal(list.filter(([, k, last]) => k === K_SUMMARY && last >= 0).length, 2, 'the others are runs, before it and after it');
});

// ---------------------------------------------------------------------------------------------------------------------------- viewer

const make = (nwk, init = {}) => makeViewer(nwk, { size: [500, 200], ...init });

test('setCollapsed: rows are freed and the clade is drawn as one summary on its row', async () => {
  const m = await make(NWK);
  m.env.flush();
  const v = m.viewer;
  const t = v.tree;
  const x = parentOf(t, 'a'),
    y = parentOf(t, 'c');
  assert.equal(v.L.rows, 6);
  assert.deepEqual(v.getViewport().y1, 6);
  v.setCollapsed([x, y]);
  m.env.flush();
  assert.equal(v.L.rows, 3, 'x, y, f');
  assert.equal(v.getViewport().y1, 3, 'a fitted view fits the new rows');
  const list = v.list;
  const entries = [...Array(list.count).keys()].map((e) => [list.node[e], list.kind[e]]);
  assert.deepEqual(
    entries.filter(([, k]) => k === K_SUMMARY),
    [
      [x, K_SUMMARY],
      [y, K_SUMMARY],
    ],
    'one summary per collapsed clade',
  );
  assert.ok(!entries.some(([n]) => n === node(t, 'a') || n === node(t, 'c') || n === node(t, 'd')), 'nothing below a collapsed clade is drawn');
  assert.deepEqual(
    entries.filter(([, k]) => k === K_TIP).map(([n]) => n),
    [node(t, 'f')],
  );
  // the ky is 3 rows over the area, so a row is much taller than before
  assert.ok(v.getStats().ky > 40);
  // setting the same ids again does nothing, an empty list expands
  const L = v.L;
  v.setCollapsed([x, y]);
  assert.equal(v.L, L, 'no new layout for the same ids');
  v.setCollapsed([]);
  m.env.flush();
  assert.equal(v.L.rows, 6);
  assert.equal(v.L.collapsed, null);
  assert.equal(v.getViewport().y1, 6);
});

test('setCollapsed: tips and unknown ids collapse nothing (a partial source: collapse-partial.test.mjs)', async () => {
  const m = await make(NWK);
  m.env.flush();
  const v = m.viewer;
  const L = v.L;
  v.setCollapsed([node(v.tree, 'a'), 99, -1]);
  assert.equal(v.L.rows, 6);
  assert.equal(v.L.collapsed, null);
  assert.equal(v.L.rowStart, v.tree.leafStart);
  void L;
});

test('hit-test and click on the triangle give the clade: kind summary, node = the full-tree id, collapsed: true', async () => {
  const m = await make(NWK);
  m.env.flush();
  const v = m.viewer;
  const t = v.tree;
  const x = parentOf(t, 'a');
  v.setCollapsed([x]);
  m.env.flush();
  const p = { x: 0, y: 0 };
  v.proj.summaryExtent(x, -1, 0);
  const tx = (v.proj.d0 + v.proj.d1) / 2,
    ty = v.proj.tip(x);
  void p;
  const h = v.hitTest(tx + 2, ty);
  assert.deepEqual(h, { node: x, kind: 'summary' });
  let ev = null;
  v.on('click', (e) => (ev = e));
  v.inputHost().click(h, 11, 22);
  assert.equal(ev.node, x);
  assert.equal(ev.kind, 'summary');
  assert.equal(ev.collapsed, true);
  assert.equal(ev.isTip, false);
  assert.deepEqual([ev.tipStart, ev.tipEnd, ev.tipCount], [0, 2, 2], 'the clade keeps its full-tree tips');
  assert.deepEqual(ev.tipIds(), ['a', 'b']);
  // an open clade and a tip report collapsed: false
  v.inputHost().click({ node: node(t, 'f'), kind: 'tip' }, 0, 0);
  assert.equal(ev.collapsed, false);
  // the row under a hidden tip hits the clade, never the tip
  assert.notEqual(v.hitTest(tx + 2, ty)?.node, node(t, 'a'));
});

test('the label of a collapsed clade is its name (or its size) and a click on it is the clade', async () => {
  const m = await make('((a,b)x,(c,d),f)r;');
  m.env.flush();
  const v = m.viewer;
  const t = v.tree;
  v.setCollapsed([parentOf(t, 'a'), parentOf(t, 'c')]);
  m.ctx().reset();
  m.env.flush();
  const texts = m
    .ctx()
    .calls('fillText')
    .map((e) => e[1]);
  assert.ok(texts.includes('x · 2 tips'), 'its name and size');
  assert.ok(texts.includes('2 tips'), 'else its size');
  assert.ok(texts.includes('f'));
  const L = v.labels;
  const k = [...Array(L.count).keys()].find((i) => L.rank[i] < 0 && -L.rank[i] - 1 === parentOf(t, 'a'));
  assert.ok(k !== undefined, 'the label list carries the clade');
  const h = v.hitTest(L.x[k] + 2, L.y[k]);
  assert.deepEqual(h, { node: parentOf(t, 'a'), kind: 'summary' });
  assert.equal(v.overlay.layer.children.length, 1, 'only the tip f has a DOM anchor; a collapsed clade is reached by its triangle');
});

test('formatCollapsedLabel makes the label of a collapsed clade from its name (cladeLabel, formatLabel) and size', async () => {
  const m = await make('((a,b)x_1,(c,d)mrca9,f)r;');
  m.env.flush();
  const v = m.viewer;
  const t = v.tree;
  v.setCollapsed([parentOf(t, 'a'), parentOf(t, 'c')]);
  const texts = () => {
    m.ctx().reset();
    m.env.flush();
    return m
      .ctx()
      .calls('fillText')
      .map((e) => e[1]);
  };
  const before = texts();
  assert.ok(before.includes('x 1 · 2 tips') && before.includes('mrca9 · 2 tips'), before.join('|'));
  v.setOptions({
    formatCollapsedLabel: (name, tips) => `[${name ?? '-'}|${tips}]`,
    cladeLabel: (node, tr) => (tr.labels[tr.toLocal(node)] === 'mrca9' ? null : tr.labels[tr.toLocal(node)]),
  });
  const after = texts();
  assert.ok(after.includes('[x 1|2]') && after.includes('[-|2]'), after.join('|'));
});

test('a dated tree keeps its time axis with a collapsed clade, and the triangle ends at the clade tips', async () => {
  const m = await make(DATED, { options: { axis: true } });
  m.env.flush();
  const v = m.viewer;
  const x = parentOf(v.tree, 'a');
  v.setCollapsed([x]);
  m.ctx().reset();
  m.env.flush();
  assert.equal(v.L.ultrametric, true);
  assert.ok(
    m
      .ctx()
      .calls('fillText')
      .some((e) => e[1] === 'time before tips (tree units)'),
  );
  v.proj.summaryExtent(x, -1, 0);
  assert.ok(Math.abs(v.proj.d1 - (v.T.ox + v.T.kx)) < 1e-6, 'the far edge is where the tips of the other clades end');
});

test('columns: the collapsed clade is one blank row, the other rows move up with their tips', async () => {
  const values = { a: 5, b: 6, c: 7, d: 8, e: 9, f: 10 };
  const m = await make(NWK, { columns: [{ id: 'v', kind: 'bar', header: 'v', width: 60, values }] });
  m.env.flush();
  const v = m.viewer;
  const bars = () =>
    m
      .ctx()
      .calls('fillRect')
      .filter((e) => e[1] === v.columns[0].x + 2);
  assert.equal(bars().length, 6);
  const x = parentOf(v.tree, 'a');
  v.setCollapsed([x]);
  m.ctx().reset();
  m.env.flush();
  const T = v.T;
  const ys = bars().map((e) => Math.round((e[2] - T.oy) / T.ky - 0.1));
  assert.deepEqual(ys, [1, 2, 3, 4], 'c, d, e, f on rows 1..4; row 0 (the clade) draws nothing');
  // cells: a tip is found on its row; a hidden tip has no cell
  assert.ok(v.columnCell('v', node(v.tree, 'c') && v.tree.tipRank[node(v.tree, 'c')]), 'c');
  assert.equal(v.columnCell('v', 0), null, 'a is inside the collapsed clade');
  assert.equal(v.columnCell('v', 1), null);
  const c = v.columnCell('v', 2);
  assert.ok(Math.abs(c.y - (v.root.getBoundingClientRect().top + T.oy + 1 * T.ky + T.ky * 0.1)) < 1e-6, 'c is on row 1');
});

test('columns: a custom renderer keeps the rank contract: one call per stretch of consecutive ranks, oy shifted, collapsed rows blank', async () => {
  let calls = [];
  const renderer = {
    prepare: () => null,
    draw: (_c, f) => calls.push({ r0: f.r0, r1: f.r1, oy: f.oy, h: f.rowHeight, map: f.rankOfRow && [...f.rankOfRow] }),
  };
  const m = await make(NWK, { columns: [{ id: 'c', kind: 'custom', header: 'c', width: 40, values: {}, renderer }] });
  m.env.flush();
  const v = m.viewer;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].map, null, 'identity without collapsed clades');
  assert.deepEqual([calls[0].r0, calls[0].r1], [0, 5]);
  // y = (c, (d, e)) collapsed: rows a, b, y, f -> stretches of ranks 0..1 and 5
  calls = [];
  v.setCollapsed([parentOf(v.tree, 'c')]);
  m.env.flush();
  const oy = v.T.oy,
    ky = v.T.ky;
  assert.deepEqual(
    calls.slice(-2).map((c) => [c.r0, c.r1]),
    [
      [0, 1],
      [5, 5],
    ],
  );
  const [s1, s2] = calls.slice(-2);
  assert.equal(s1.oy + 0 * ky, oy, 'rank 0 is on row 0');
  assert.equal(s2.oy + 5 * ky, oy + 3 * ky, 'rank 5 (f) is on row 3');
  assert.deepEqual(s2.map, [0, 1, 2, 5, 6]);
  // x collapsed: one stretch, ranks 2..5 on rows 1..4
  calls = [];
  v.setCollapsed([parentOf(v.tree, 'a')]);
  m.env.flush();
  const last = calls.at(-1);
  assert.deepEqual([last.r0, last.r1], [2, 5]);
  assert.equal(last.oy + 2 * v.T.ky, v.T.oy + 1 * v.T.ky);
});

test('focusTip on a tip inside a collapsed clade focuses the clade and expands nothing; a tip outside focuses the tip', async () => {
  const m = await make(NWK, { size: [500, 600] });
  m.env.flush();
  const v = m.viewer;
  const t = v.tree;
  const x = parentOf(t, 'a');
  v.setCollapsed([x]);
  m.env.flush();
  v.focusTip(1); // b, inside x
  const w = v.getViewport();
  assert.ok(w.y0 < 0.5 && w.y1 > 0.5, 'row 0, the clade, is in view');
  assert.equal(v.L.collapsed[x], 1, 'still collapsed');
  v.focusTip(5); // f is on row 4
  const w2 = v.getViewport();
  assert.ok(w2.y0 <= 4.5 && w2.y1 >= 4.5, 'the row of f (row 4, not rank 5) is in view');
});

test('the window keeps its scale and its place when a clade is collapsed or expanded', async () => {
  const ladder = '(' + Array.from({ length: 40 }, (_, k) => `(g${k}a,g${k}b)c${k}`).join(',') + ')r;';
  const m = await make(ladder, { size: [500, 300] });
  m.env.flush();
  const v = m.viewer;
  const t = v.tree;
  v.setViewport({ x0: 0, x1: 1, y0: 50, y1: 70 }); // rows of c25..c34
  m.env.flush();
  const before = v.getViewport();
  assert.equal(v.vs.fitted, false);
  const upper = [0, 1, 2].map((k) => parentOf(t, `g${k}a`)); // three clades above the window
  v.setCollapsed(upper);
  m.env.flush();
  const after = v.getViewport();
  assert.equal(after.y1 - after.y0, before.y1 - before.y0, 'same number of rows in view: not zoomed');
  assert.equal(after.y0, before.y0 - 3, 'three rows were freed above: the window moves up with its tips');
  assert.equal(after.x0, before.x0);
  assert.equal(v.vs.fitted, false);
  v.setCollapsed([]);
  m.env.flush();
  assert.deepEqual(v.getViewport(), before, 'and back');
  // fitted stays fitted
  v.fit(false);
  v.setCollapsed(upper);
  assert.equal(v.vs.fitted, true);
  assert.equal(v.getViewport().y1, 77);
});

test('keyboard: the cursor steps over rows; a collapsed clade is one stop and has no children to enter', () => {
  const t = snapshot();
  const x = parentOf(t, 'a'),
    y = parentOf(t, 'c'),
    f = node(t, 'f');
  const L = computeLayout(t, true, mask(t.nodeCount, x, y));
  assert.equal(L.rows, 3);
  assert.equal(navigate(t, x, 'ArrowDown', 1, L), y, 'down from a clade to the next row');
  assert.equal(navigate(t, y, 'ArrowDown', 1, L), f);
  assert.equal(navigate(t, f, 'ArrowUp', 1, L), y);
  assert.equal(navigate(t, y, 'ArrowRight', 1, L), y, 'stays: its children are hidden');
  assert.equal(navigate(t, y, 'ArrowLeft', 1, L), 0);
  assert.equal(navigate(t, f, 'End', 1, L), f);
  assert.equal(navigate(t, f, 'Home', 1, L), x);
  assert.equal(navigate(t, x, 'PageDown', 2, L), f);
  assert.equal(defaultActiveNode(t, 'rectangular', { x0: 0, x1: 1, y0: 0, y1: 1 }, L), x, 'the row at the centre of the view');
  assert.equal(defaultActiveNode(t, 'rectangular', { x0: 0, x1: 1, y0: 0, y1: 3 }, L), y);
  // without the layout the same keys walk the tips as before
  assert.equal(navigate(t, node(t, 'b'), 'ArrowDown', 1), node(t, 'c'));
});

test('highlighted tips below a collapsed clade are marked on the clade row, and the clade is not dimmed', async () => {
  const m = await make(NWK, { options: { highlightStyle: 'both' }, theme: { dimOpacity: 0.3 } });
  const v = m.viewer;
  v.setCollapsed([parentOf(v.tree, 'a')]);
  v.setHighlighted(['b']);
  m.ctx().reset();
  m.env.flush();
  const T = v.T;
  const bands = m.ctx().calls('fillRect');
  assert.ok(
    bands.some((e) => e[1] === 0 && e[2] + e[4] / 2 > T.oy && e[2] + e[4] / 2 < T.oy + T.ky),
    'a band on row 0, where b is hidden',
  );
});

test('locateNode of a tip inside a collapsed clade is null; of the clade it is where its apex is', async () => {
  const m = await make(NWK);
  m.env.flush();
  const v = m.viewer;
  const x = parentOf(v.tree, 'a');
  assert.ok(v.locateNode(node(v.tree, 'a')));
  v.setCollapsed([x]);
  assert.equal(v.locateNode(node(v.tree, 'a')), null);
  assert.ok(v.locateNode(x));
  assert.equal(v.nodePosition(node(v.tree, 'a')), null, 'no place for a node inside the clade');
  assert.ok(v.nodePosition(x), 'the clade itself has one');
  assert.equal(v.nodeBounds(node(v.tree, 'b')), null);
  const b = v.nodeBounds(x);
  assert.ok(b && b.height > 20, 'the bounds of the clade are its one row');
});

test('radial: a collapsed clade is one angular step; the fan is hit and its label is drawn', async () => {
  const m = await make(NWK, { options: { layout: 'radial' }, size: [400, 400] });
  m.env.flush();
  const v = m.viewer;
  const x = parentOf(v.tree, 'a');
  v.setCollapsed([x]);
  m.env.flush();
  assert.equal(v.L.rows, 5);
  assert.ok(Math.abs(v.T.da - v.T.fan.span / 5) < 1e-12, 'one row of the fan per row');
  v.proj.summaryExtent(x, -1, 0);
  const th = (v.proj.t0 + v.proj.t1) / 2,
    r = (v.proj.d0 + v.proj.d1) / 2;
  const h = v.hitTest(v.T.cx + r * Math.cos(th), v.T.cy + r * Math.sin(th));
  assert.deepEqual(h, { node: x, kind: 'summary' });
});

test('setTree keeps the collapsed clades through a map and takes them from the options', async () => {
  const m = await make(NWK);
  m.env.flush();
  const v = m.viewer;
  const t = v.tree;
  const x = parentOf(t, 'a');
  v.setCollapsed([x]);
  const same = parseNewick(NWK);
  const map = Int32Array.from({ length: t.nodeCount }, (_, i) => i);
  v.setTree(same, { map });
  m.env.flush();
  assert.equal(v.L.rows, 5, 'the same node ids are still collapsed');
  v.setTree(parseNewick(NWK), { map, collapsed: [] });
  m.env.flush();
  assert.equal(v.L.rows, 6);
  v.setTree(parseNewick(NWK), { collapsed: [parentOf(t, 'd')] });
  m.env.flush();
  assert.equal(v.L.rows, 5);
});

test('the overview draws the collapsed clades and its window box counts rows', async () => {
  const { overviewBox } = await import(path.join(core, 'overview.ts'));
  const t = snapshot();
  const L = computeLayout(t, true, mask(t.nodeCount, parentOf(t, 'a')));
  const g = { x: 0, y: 0, w: 56, h: 100 };
  const box = overviewBox('rectangular', g, { x0: 0, x1: 1, y0: 0, y1: 2.5 }, L.rows);
  assert.equal(box.h, 50, 'half of the 5 rows');
});

test('the overview ticks of highlights are placed in rows: a highlight after a collapsed clade is one row higher', async () => {
  const { OverviewControl } = await import('../src/controls/index.ts');
  const { FakeCanvas } = await import('./viewer-harness.mjs');
  const m = await make(NWK, { controls: [new OverviewControl()] });
  const v = m.viewer;
  v.setCollapsed([parentOf(v.tree, 'a')]);
  v.setHighlighted(['f']); // rank 5, row 4 of 5
  m.env.flush();
  const found = [];
  const walk = (el) => {
    if (el instanceof FakeCanvas && el !== m.canvas() && el !== m.topCanvas()) found.push(el);
    for (const c of el.children ?? []) walk(c);
  };
  walk(v.container);
  assert.ok(found.length, 'the overview canvas');
  const ov = found[0].ctx;
  // N = rows (5): the tick of row 4 is at 4/5 of the strip, not at 5/6 (rank 5 of 6 tips)
  const h = v.getStats && v.T.area.ah;
  const ticks = ov.calls('fillRect').filter((e) => e[3] > 100 === false && e[2] !== 0 && e[4] === 2.5);
  assert.ok(ticks.length >= 1, 'a tick');
  assert.ok(Math.abs(ticks[0][2] - ((4 / 5) * h - 1)) < 1e-6, `tick at ${ticks[0][2]}, wanted ${(4 / 5) * h - 1}`);
});

for (const kind of ['rectangular', 'radial']) {
  test(`cut (${kind}): a collapsed clade is not counted as "forced" (collapsed only because of the budget)`, () => {
    const t = snapshot();
    const x = parentOf(t, 'a');
    const L = computeLayout(t, true, mask(t.nodeCount, x));
    if (kind === 'radial') ensureTrig(L);
    const rect = kind === 'rectangular';
    const [W, H] = rect ? [600, 120] : [400, 400];
    const area = { ax: 0, ay: 0, aw: W, ah: H, clipL: 0, clipT: 0, clipR: W, clipB: H };
    const view = rect ? { x0: 0, x1: 1, y0: 0, y1: L.rows } : { x0: -1.2, x1: 1.2, y0: -1.2, y1: 1.2 };
    const proj = projectionFor(t, L, makeTransform(kind, W, H, view, area, L.rows));
    const res = cut(proj, { lod: true, minPx: 3, baseMinPx: 1, budget: 10000, summaries: true }, null, new DrawList(), new Seen(), newCutResult());
    assert.equal(res.summaries, 1);
    assert.equal(res.forced, 0);
  });
}

test('two highlighted tips inside one collapsed clade give one band and one ring, and the clade label is bold', async () => {
  const m = await make(NWK);
  const v = m.viewer;
  const x = parentOf(v.tree, 'a');
  v.setCollapsed([x]);
  v.setHighlighted(['a', 'b', 'f']);
  m.ctx().reset();
  m.env.flush();
  const bands = m
    .ctx()
    .calls('fillRect')
    .filter((e) => e[1] === 0 && e[4] >= 3 && e[4] < 100);
  assert.equal(bands.length, 2, 'one band for the clade row, one for f');
  const rings = m
    .ctx()
    .calls('arc')
    .filter((e) => e[3] === 7);
  assert.equal(rings.length, 2);
  const fonts = m
    .ctx()
    .log.filter((e) => e[0] === 'font=')
    .map((e) => e[1]);
  assert.ok(
    fonts.some((f) => /600/.test(f)),
    'a bold label',
  );
  let boldFor = null;
  let bold = false;
  for (const e of m.ctx().log) {
    if (e[0] === 'font=') bold = /600/.test(e[1]);
    else if (e[0] === 'fillText' && e[1] === 'x · 2 tips') boldFor = bold;
  }
  assert.equal(boldFor, true, 'the label of the clade that holds a highlight');
});

test('zoomToNode of a node inside a collapsed clade frames the clade; the screen-reader list and the announcement say "collapsed"', async () => {
  const big = '(' + Array.from({ length: 30 }, (_, k) => `(g${k}a,g${k}b)c${k}`).join(',') + ')r;';
  const m = await make(big, { size: [500, 300] });
  m.env.flush();
  const v = m.viewer;
  const c10 = parentOf(v.tree, 'g10a');
  v.setCollapsed([c10]);
  m.env.flush();
  v.zoomToNode(v.tree.tipIndex('g10a'));
  const w = v.getViewport();
  const row = v.L.rowStart[c10];
  assert.ok(w.y0 <= row && w.y1 >= row + 1, 'the clade row is in view');
  v.overlay.updateList(v.list, v.tree, v.opts.formatLabel, v.L.collapsed, (r) => v.cladeText(r));
  const texts = v.overlay.srList.children.map((c) => c.textContent);
  assert.ok(texts.includes('c10 · 2 tips, collapsed'), texts.slice(0, 4).join('|'));
  v.setActive(c10);
  assert.match(v.overlay.live.textContent, /collapsed$/);
});
