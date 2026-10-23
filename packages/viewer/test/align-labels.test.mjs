// Unit tests of aligned tip labels (`alignLabels`): the label x, the leader lines, dimming, hit areas and DOM anchors, read from the
// draw calls of the recording context.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { makeViewer, destroyAll } = await import('./viewer-harness.mjs');
const { FALLBACK_THEME } = await import('../src/types.ts');
const { THEME_CSS_VARS } = await import('../src/theme.ts');

afterEach(destroyAll);

const PHYLO = '((a:1,b:4)x:1,(c:2,d:6)y:1)r;'; // tips end at x = 2, 5, 3, 7 (of 7)
const CLADO = '((a,b)x,(c,d)y)r;';
const DIM = 0.3;

/** The text positions of the fillText calls: label -> x. */
function labelXs(ctx) {
  return Object.fromEntries(
    ctx
      .calls('fillText')
      .filter((e) => /^[a-d]$/.test(e[1]))
      .map((e) => [e[1], e[2]]),
  );
}
/** The leader lines: the moveTo / lineTo pairs drawn while the dash was set (between setLineDash([..]) and setLineDash([])). */
function leaders(ctx) {
  const out = [];
  let dashed = false;
  let alpha = 1;
  let from = null;
  for (const e of ctx.log) {
    if (e[0] === 'setLineDash') dashed = e[1].length > 0;
    else if (e[0] === 'globalAlpha=') alpha = e[1];
    else if (dashed && e[0] === 'moveTo') from = e;
    else if (dashed && e[0] === 'lineTo' && from) {
      out.push({ x0: e[1], x1: from[1], y: from[2], alpha }); // drawn from the column leftward: x1 is the column end
      from = null;
    }
  }
  return out;
}
async function make(newick, options = {}, extra = {}) {
  const m = await makeViewer(newick, { options: { alignLabels: true, ...options }, theme: { dimOpacity: DIM }, size: [500, 200], ...extra });
  m.env.flush();
  return m;
}

test('leader tokens are theme fields with CSS variables', () => {
  assert.equal(FALLBACK_THEME.leaderDash, '1 3');
  assert.equal(FALLBACK_THEME.leaderColour, '');
  assert.equal(THEME_CSS_VARS.leaderColour, '--phylo-leader-colour');
  assert.equal(THEME_CSS_VARS.leaderDash, '--phylo-leader-dash');
  assert.equal(THEME_CSS_VARS.leaderWidth, '--phylo-leader-width');
  assert.equal(THEME_CSS_VARS.leaderOpacity, '--phylo-leader-opacity');
});

test('off by default: labels follow their tips and no dashed line is drawn', async () => {
  const m = await make(PHYLO, { alignLabels: false });
  assert.equal(m.viewer.opts.alignLabels, false);
  const xs = Object.values(labelXs(m.ctx()));
  assert.equal(new Set(xs).size, 4, 'ragged edge');
  assert.equal(leaders(m.ctx()).length, 0);
});

test('phylogram: every drawn label starts at one x, right of the farthest tip, and each tip that ends earlier has a leader that stops before it', async () => {
  const m = await make(PHYLO);
  const ctx = m.ctx();
  const xs = labelXs(ctx);
  assert.deepEqual(Object.keys(xs).sort(), ['a', 'b', 'c', 'd']);
  const x = xs.a;
  assert.ok(Object.values(xs).every((v) => v === x));
  const far = m.viewer.proj.T.ox + m.viewer.proj.T.kx; // the farthest tip
  assert.equal(x, far + 8);
  const ls = leaders(ctx);
  assert.equal(ls.length, 4, 'one per tip, also the farthest (its dot is not the column)');
  for (const l of ls) assert.ok(l.x1 < x && l.x1 >= far, 'ends before the label, right of the farthest tip');
  assert.equal(ls.filter((l) => l.x0 < far - 1).length, 3, 'a, b and c start short of the column');
  assert.ok(ls.every((l) => l.alpha === FALLBACK_THEME.leaderOpacity));
  assert.ok(ctx.calls('setLineDash').some((e) => e[1].join(' ') === '1 3'));
  assert.deepEqual(ctx.calls('setLineDash').at(-1)[1], [], 'the dash is reset');
});

test('cladogram and a tree without lengths, rectangular and radial: no-op', async () => {
  for (const [nw, opts] of [
    [PHYLO, { branchLengths: false }],
    [CLADO, {}],
    [PHYLO, { branchLengths: false, layout: 'radial' }],
    [CLADO, { layout: 'radial' }],
  ]) {
    const off = await make(nw, { ...opts, alignLabels: false });
    const on = await make(nw, opts);
    assert.equal(leaders(on.ctx()).length, 0);
    assert.deepEqual(labelXs(on.ctx()), labelXs(off.ctx()));
  }
});

test('no leader where no label is drawn (rows under the density limit)', async () => {
  const m = await make(PHYLO, { labelDensity: 'sparse' }, { size: [500, 40] }); // 4 rows in ~16 px: under 16 px each
  assert.equal(m.viewer.labels.count, 0);
  assert.equal(leaders(m.ctx()).length, 0);
});

test('hit-testing a label returns its tip; the DOM anchors sit at the label x', async () => {
  const m = await make(PHYLO);
  const L = m.viewer.labels;
  assert.equal(L.count, 4);
  for (let k = 0; k < L.count; k++) {
    const h = m.viewer.hitTest(L.x[k] + L.w[k] / 2, L.y[k]);
    assert.deepEqual(h && { node: h.node, kind: h.kind }, { node: m.viewer.tree.tipNode[L.rank[k]], kind: 'tip' });
  }
  const anchors = [];
  const walk = (n) => {
    if (n.dataset?.tipId) anchors.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(m.viewer.root);
  assert.equal(anchors.length, 4);
  const tx = anchors.map((a) => /translate\(([-\d.]+)px/.exec(a.style.transform)[1]);
  assert.equal(new Set(tx).size, 1);
  assert.equal(Number(tx[0]), L.x[0]);
});

test('dim: the leader of a tip outside the highlighted set is drawn at leaderOpacity * dimOpacity', async () => {
  const m = await make(PHYLO, { highlightStyle: 'dim' });
  m.viewer.setHighlighted(['a']);
  m.ctx().reset();
  m.env.flush();
  const ls = leaders(m.ctx());
  assert.equal(ls.length, 4);
  const o = FALLBACK_THEME.leaderOpacity;
  const full = ls.filter((l) => l.alpha === o);
  const dim = ls.filter((l) => Math.abs(l.alpha - o * DIM) < 1e-12);
  assert.equal(full.length, 1, 'tip a');
  assert.equal(dim.length, 3, 'b, c and d');
});

test('band: the highlight band still covers the aligned label', async () => {
  const m = await make(PHYLO, { highlightStyle: 'band' });
  m.viewer.setHighlighted(['b']);
  m.env.flush();
  const ctx = m.ctx();
  const L = m.viewer.labels;
  const k = [...Array(L.count).keys()].find((i) => m.viewer.tree.tipLabels[L.rank[i]] === 'b');
  const band = ctx.calls('fillRect').find((e) => e[3] > 0 && e[1] === 0 && e[2] + e[4] / 2 > L.y[k] - 1 && e[2] < L.y[k] && e[3] > L.x[k] + L.w[k]);
  assert.ok(band, 'a band from the left edge past the end of the label');
});

test('the tokens colour, dash and size the leaders', async () => {
  const m = await make(PHYLO, {}, { theme: { leaderColour: '#ff0000', leaderDash: '4,2', leaderWidth: 2, leaderOpacity: 0.5 } });
  const ctx = m.ctx();
  assert.ok(ctx.calls('setLineDash').some((e) => e[1].join(' ') === '4 2'));
  assert.ok(ctx.log.some((e) => e[0] === 'strokeStyle=' && e[1] === '#ff0000'));
  assert.ok(ctx.log.some((e) => e[0] === 'lineWidth=' && e[1] === 2));
  assert.ok(leaders(ctx).every((l) => l.alpha === 0.5));
});

test('collapsing a clade leaves the label reserve alone (its triangle ends at its tips); zoomToNode still zooms on x', async () => {
  const LONG = '((aaaaaaaaaaaa:1,b:4)x:1,(c:2,d:6)y:1)r;'; // under 8 characters the reserve sits at its floor
  const m = await make(LONG);
  const off = await make(LONG, { alignLabels: false });
  assert.equal(m.viewer.vs.labelReserve(), off.viewer.vs.labelReserve());
  m.viewer.setCollapsed([m.viewer.tree.firstChild[0]]);
  m.env.flush();
  assert.equal(m.viewer.vs.labelReserve(), off.viewer.vs.labelReserve());
  const n = m.viewer.tree.firstChild[0];
  const v = m.viewer.vs.cladeViewport(n);
  const w = off.viewer.vs.cladeViewport(n);
  assert.ok(v.x1 - v.x0 < 0.9, 'the window is the clade, not the whole tree width');
  assert.ok(Math.abs(v.x1 - v.x0 - (w.x1 - w.x0)) < 0.1);
});

test('a collapsed clade is labelled in the column, with a leader from the end of its triangle', async () => {
  const m = await make(PHYLO);
  const x = m.viewer.tree.firstChild[0];
  m.viewer.setCollapsed([x]);
  m.ctx().reset();
  m.env.flush();
  const T = m.viewer.T;
  const ls = leaders(m.ctx());
  assert.equal(ls.length, 3, 'the collapsed clade, c and d');
  const mine = ls.find((l) => Math.abs(l.y - (T.oy + m.viewer.L.ROW[x] * T.ky)) < 1e-9);
  assert.ok(mine, 'a leader on the clade row');
  // the triangle ends at the clade's deepest tip (b, at 5 of 7), not at a fixed width past the node
  assert.ok(Math.abs(mine.x0 - (T.ox + m.viewer.L.XMAX[x] * T.kx)) < 1e-9);
  const texts = m
    .ctx()
    .calls('fillText')
    .map((e) => e[1]);
  assert.ok(texts.includes('x · 2 tips'), 'labelled with its name');
  assert.ok(!texts.includes('a') && !texts.includes('b'), 'its tips have no labels');
  const xs = Object.fromEntries(
    m
      .ctx()
      .calls('fillText')
      .map((e) => [e[1], e[2]]),
  );
  assert.equal(xs['x · 2 tips'], xs.c, 'the label shares the column with the tips');
});

/** A caterpillar-free comb of n tips with different lengths. */
const comb = (n) => '(' + Array.from({ length: n }, (_, k) => `t${k}:${1 + (k % 7)}`).join(',') + ');';

test('leaders follow the labels: same rows in a scrolled view with culled rows, and the same cap', async () => {
  const m = await make(comb(60), {}, { size: [500, 400] });
  m.viewer.setViewport({ x0: 0, x1: 1, y0: 20, y1: 30 });
  m.ctx().reset();
  m.env.flush();
  const L = m.viewer.labels;
  assert.ok(L.count > 0 && L.count < 60, 'rows outside the window are culled');
  const ys = [...Array(L.count).keys()].map((k) => L.y[k]).sort((a, b) => a - b);
  const lys = leaders(m.ctx())
    .map((l) => l.y)
    .sort((a, b) => a - b);
  assert.deepEqual(
    lys.map((y) => y.toFixed(2)),
    ys.map((y) => y.toFixed(2)),
  );
  const big = await make(comb(900), { lod: false }, { size: [500, 12000] });
  assert.equal(big.viewer.labels.count, 600, 'the label cap');
  assert.equal(leaders(big.ctx()).length, 600, 'and the leader cap');
});

test('zoomed in on x the column is pinned at the right edge of the plot area and labels stay (not culled as when unaligned)', async () => {
  const m = await make(PHYLO);
  const ax = m.viewer.vs.area.ax + m.viewer.vs.area.aw;
  m.viewer.setViewport({ x0: 0, x1: 0.5, y0: 0, y1: 4 });
  m.ctx().reset();
  m.env.flush();
  const L = m.viewer.labels;
  assert.equal(L.count, 4);
  for (let k = 0; k < L.count; k++) assert.equal(L.x[k], ax + 8);
  const off = await make(PHYLO, { alignLabels: false });
  off.viewer.setViewport({ x0: 0, x1: 0.5, y0: 0, y1: 4 });
  off.env.flush();
  assert.ok(off.viewer.labels.count < 4, 'unaligned, the tips past the right edge lose their labels');
  const ls = leaders(m.ctx());
  assert.ok(
    ls.every((l) => l.x0 < l.x1),
    'no leader for a tip at or past the column',
  );
});

// ---------------------------------------------------------------- radial

/** Distance of (x, y) from the root of a radial frame. */
const radius = (v, x, y) => Math.hypot(x - v.T.cx, y - v.T.cy);
/** The labels of a frame: where each text starts (CSS px from the root, the anchor plus the gap), and its tip id. */
function radialLabels(v) {
  const L = v.labels;
  return [...Array(L.count).keys()].map((k) => ({ k, id: v.tree.tipLabels[L.rank[k]], r: radius(v, L.x[k], L.y[k]) + L.gap[k] }));
}
async function makeRadial(newick, options = {}, extra = {}) {
  return make(newick, { layout: 'radial', ...options }, { size: [500, 500], ...extra });
}

test('radial phylogram: every drawn label starts on one circle just outside the outermost tip, along its ray', async () => {
  const m = await makeRadial(PHYLO);
  const v = m.viewer;
  const ls = radialLabels(v);
  assert.equal(ls.length, 4);
  const far = v.L.XMAX[0] * v.T.k; // the outermost tip (d)
  for (const l of ls) assert.ok(Math.abs(l.r - (far + 8)) < 1e-3, `${l.id} starts at ${l.r}, not ${far + 8}`);
  const off = await makeRadial(PHYLO, { alignLabels: false });
  assert.ok(new Set(radialLabels(off.viewer).map((l) => l.r.toFixed(3))).size > 1, 'unaligned, the labels follow their tips');
  // the text is drawn at the label's place, turned along the ray of its tip: the translation of its setTransform is the label's anchor
  const L = v.labels;
  const moves = m
    .ctx()
    .calls('setTransform')
    .filter((e) => e[1] !== e[4] || e[2] !== 0); // the rotated ones
  for (let k = 0; k < L.count; k++) assert.ok(moves.some((e) => Math.abs(e[5] - L.x[k]) < 1e-3 && Math.abs(e[6] - L.y[k]) < 1e-3)); // labels are stored as Float32
});

test('radial phylogram: a leader runs along the ray from each tip to just before its label', async () => {
  const m = await makeRadial(PHYLO);
  const v = m.viewer;
  const far = v.L.XMAX[0] * v.T.k;
  const ls = leaders(m.ctx()); // here x0 / x1 are only the x of the ends: read the log again for both ends
  assert.equal(ls.length, 4, 'one per tip, also the outermost (its dot is not the circle)');
  let dashed = false,
    from = null;
  const segs = [];
  for (const e of m.ctx().log) {
    if (e[0] === 'setLineDash') dashed = e[1].length > 0;
    else if (dashed && e[0] === 'moveTo') from = e;
    else if (dashed && e[0] === 'lineTo' && from) {
      segs.push({ ax: from[1], ay: from[2], bx: e[1], by: e[2] });
      from = null;
    }
  }
  const tipRadii = [...Array(v.tree.tipCount).keys()].map((r) => v.L.X[v.tree.tipNode[r]] * v.T.k);
  for (const s of segs) {
    assert.ok(Math.abs(radius(v, s.ax, s.ay) - (far + 5)) < 1e-6, 'starts 3 px before the label');
    const rb = radius(v, s.bx, s.by);
    assert.ok(
      tipRadii.some((r) => Math.abs(r - rb) < 1e-6),
      'ends at a tip',
    );
    // on one ray from the root: the cross product of the two ends seen from the root is 0
    const cross = (s.ax - v.T.cx) * (s.by - v.T.cy) - (s.ay - v.T.cy) * (s.bx - v.T.cx);
    assert.ok(Math.abs(cross) < 1e-6 * far * far, 'along the ray');
  }
});

test('radial: hit-testing an aligned label returns its tip; the DOM anchors sit on the circle', async () => {
  const m = await makeRadial(PHYLO);
  const v = m.viewer;
  const L = v.labels;
  for (let k = 0; k < L.count; k++) {
    const ray = L.flip[k] ? L.ang[k] - Math.PI : L.ang[k];
    const d = L.gap[k] + L.w[k] / 2; // the middle of the text
    const h = v.hitTest(L.x[k] + d * Math.cos(ray), L.y[k] + d * Math.sin(ray));
    assert.deepEqual(h && { node: h.node, kind: h.kind }, { node: v.tree.tipNode[L.rank[k]], kind: 'tip' });
  }
  const anchors = [];
  const walk = (n) => {
    if (n.dataset?.tipId) anchors.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(v.root);
  assert.equal(anchors.length, 4);
  const far = v.L.XMAX[0] * v.T.k;
  for (const a of anchors) {
    const [, x, y] = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(a.style.transform);
    const h = Number(a.style.height.replace('px', ''));
    assert.ok(Math.abs(radius(v, Number(x), Number(y) + h / 2) - far) < 1e-3, 'the anchor is on the circle');
  }
});

test('radial: no leader where no label is drawn, and dimmed leaders follow highlightStyle', async () => {
  const sparse = await makeRadial(comb(400), { labelDensity: 'sparse' }, { size: [200, 200] });
  assert.equal(sparse.viewer.labels.count, 0);
  assert.equal(leaders(sparse.ctx()).length, 0);
  const m = await makeRadial(PHYLO, { highlightStyle: 'dim' });
  m.viewer.setHighlighted(['a']);
  m.ctx().reset();
  m.env.flush();
  const ls = leaders(m.ctx());
  const o = FALLBACK_THEME.leaderOpacity;
  assert.equal(ls.filter((l) => l.alpha === o).length, 1, 'tip a');
  assert.equal(ls.filter((l) => Math.abs(l.alpha - o * DIM) < 1e-12).length, 3, 'b, c and d');
});

test('radial: a collapsed clade is labelled on the circle, with a leader from the end of its triangle', async () => {
  const m = await makeRadial(PHYLO);
  const v = m.viewer;
  v.setCollapsed([v.tree.firstChild[0]]);
  m.ctx().reset();
  m.env.flush();
  const L = v.labels;
  assert.equal(L.count, 3, 'the collapsed clade, c and d');
  const far = v.L.XMAX[0] * v.T.k;
  for (let k = 0; k < L.count; k++) assert.ok(Math.abs(radius(v, L.x[k], L.y[k]) - far) < 1e-3);
  assert.ok(
    [...L.rank.slice(0, L.count)].some((r) => r < 0),
    'one is the clade',
  );
  assert.equal(leaders(m.ctx()).length, 3);
});

test('radial: the fit keeps room for the labels outside the circle, and toggling Align refits', async () => {
  const LONG = '((aaaaaaaaaaaaaaaaaaaa:1,b:4)x:1,(c:2,d:6)y:1)r;';
  const m = await makeRadial(LONG);
  const off = await makeRadial(LONG, { alignLabels: false });
  const room = m.viewer.vs.radialLabelRoom();
  assert.ok(room > 0 && off.viewer.vs.radialLabelRoom() === 0);
  assert.ok(Math.abs(off.viewer.T.k - m.viewer.T.k - room) < 1e-6, `the circle is ${room} px smaller (a square container)`);
  off.viewer.setOptions({ alignLabels: true });
  off.env.flush();
  assert.ok(Math.abs(off.viewer.T.k - m.viewer.T.k) < 1e-6, 'Align on refits the fitted view');
});

test('radial: zoomed in so the circle is out of view, it is pinned at the furthest visible radius less the label room', async () => {
  const m = await makeRadial(comb(40));
  const v = m.viewer;
  const k0 = v.T.k;
  // zoom 4x on a point half way out on the right: the whole window is inside the circle of the tips
  const k = 4 * k0,
    a = v.vs.area;
  const cx = 0.5,
    cy = 0;
  v.setViewport({ x0: cx - a.aw / 2 / k, x1: cx + a.aw / 2 / k, y0: cy - a.ah / 2 / k, y1: cy + a.ah / 2 / k });
  m.ctx().reset();
  m.env.flush();
  const T = v.T;
  const far = Math.hypot(Math.max(Math.abs(T.cx - T.clipL), Math.abs(T.cx - T.clipR)), Math.max(Math.abs(T.cy - T.clipT), Math.abs(T.cy - T.clipB)));
  assert.ok(far < v.L.XMAX[0] * T.k, 'the outermost tip is out of view');
  const want = far - v.vs.radialLabelRoom();
  const ls = radialLabels(v);
  assert.ok(ls.length > 0, 'labels are drawn');
  for (const l of ls) assert.ok(Math.abs(l.r - (want + 8)) < 1e-3, `pinned: ${l.r} vs ${want + 8}`);
  for (const l of ls) {
    const x = v.labels.x[l.k],
      y = v.labels.y[l.k];
    assert.ok(x > -50 && y > -50 && x < T.W + 50 && y < T.H + 50, 'where the text starts is in view');
  }
});

test('radial: switching Align while zoomed keeps the view but clamps it to the zoom limits of the new fit', async () => {
  /** Zoom to scale k (px per unit radius) about (cx, 0), switch Align to `on`, and return the window widths before and after. */
  const run = async (alignBefore, k, cx) => {
    const m = await makeRadial(comb(40), { alignLabels: alignBefore });
    const v = m.viewer;
    const a = v.vs.area;
    v.setViewport({ x0: cx - a.aw / 2 / k, x1: cx + a.aw / 2 / k, y0: -a.ah / 2 / k, y1: a.ah / 2 / k });
    m.env.flush();
    assert.equal(v.vs.fitted, false);
    const before = v.vs.view.x1 - v.vs.view.x0;
    v.setOptions({ alignLabels: !alignBefore });
    m.env.flush();
    assert.equal(v.vs.fitted, false, 'not refitted');
    const c = v.vs.clampView(v.vs.view);
    assert.ok(Math.abs(c.x1 - c.x0 - (v.vs.view.x1 - v.vs.view.x0)) < 1e-9 * (c.x1 - c.x0), 'within the new limits');
    return { before, after: v.vs.view.x1 - v.vs.view.x0 };
  };
  // zoomed out to the limit with Align (a fraction of its smaller fit): without Align the limit is the larger fit's, so the view zooms in
  const out = await run(true, 1e-6, 0);
  assert.ok(out.after < out.before - 1e-9, `zoomed in to the new limit (${out.before} -> ${out.after})`);
  // zoomed in to the cap without Align (a multiple of the fit): with Align the cap is lower, so the view zooms out
  const inn = await run(false, 1e12, 0.5);
  assert.ok(inn.after > inn.before + 1e-12, `zoomed out to the new cap (${inn.before} -> ${inn.after})`);
});
