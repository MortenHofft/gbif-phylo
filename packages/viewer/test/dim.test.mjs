// Unit tests of the dim mode of setHighlighted (`highlightStyle` 'dim' / 'both', theme `dimOpacity`), read from the draw calls the
// recording context saw: the alpha each label, stroke and fill was painted with.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { makeViewer, destroyAll } = await import('./viewer-harness.mjs');
const { FALLBACK_THEME } = await import('../src/types.ts');
const { THEME_CSS_VARS } = await import('../src/theme.ts');

afterEach(destroyAll);

const DIM = 0.3;
const TWO = '((a,b)x,(c,d)y)r;'; // preorder: 0 r, 1 x, 2 a, 3 b, 4 y, 5 c, 6 d

/** The globalAlpha in force at each call named `name`, with its first argument. */
function alphas(ctx, name) {
  let alpha = 1;
  const out = [];
  for (const e of ctx.log) {
    if (e[0] === 'globalAlpha=') alpha = e[1];
    else if (e[0] === name) out.push({ alpha, arg: e[1] });
  }
  return out;
}
const labelAlpha = (ctx) => Object.fromEntries(alphas(ctx, 'fillText').map((x) => [x.arg, x.alpha]));

async function viewerWith(style, tips, tree = TWO, extra = {}) {
  const m = await makeViewer(tree, { options: { highlightStyle: style, ...extra.options }, theme: { dimOpacity: DIM }, ...extra.init });
  m.viewer.setHighlighted(tips);
  m.env.flush();
  return m;
}

test('dimOpacity is a theme token with a CSS variable', () => {
  assert.ok(FALLBACK_THEME.dimOpacity > 0 && FALLBACK_THEME.dimOpacity < 1);
  assert.equal(THEME_CSS_VARS.dimOpacity, '--phylo-dim-opacity');
});

test('band (the default) draws no dimmed primitives', async () => {
  const { viewer, env, ctx } = await viewerWith('band', ['a']);
  assert.equal(viewer.opts.highlightStyle, 'band');
  env.flush();
  assert.ok(alphas(ctx(), 'fillText').every((x) => x.alpha === 1));
  assert.ok(!ctx().log.some((e) => e[0] === 'globalAlpha=' && e[1] === DIM));
});

test('dim: labels outside the highlighted set are drawn at dimOpacity, matches at full strength, and no band is drawn', async () => {
  const dim = await viewerWith('dim', ['a']);
  assert.deepEqual(labelAlpha(dim.ctx()), { a: 1, b: DIM, c: DIM, d: DIM });
  const band = await viewerWith('band', ['a']);
  const rects = (m) => m.ctx().calls('fillRect').length;
  assert.equal(rects(band) - rects(dim), 1, 'the band behind the matching row is not drawn');
});

test('both: bands and dimming together', async () => {
  const both = await viewerWith('both', ['a']);
  assert.deepEqual(labelAlpha(both.ctx()), { a: 1, b: DIM, c: DIM, d: DIM });
  const band = await viewerWith('band', ['a']);
  assert.equal(both.ctx().calls('fillRect').length, band.ctx().calls('fillRect').length);
});

test('dim: branches of a clade with no highlighted tip are stroked at dimOpacity, the rest at full strength', async () => {
  const { ctx } = await viewerWith('dim', ['a']);
  const strokes = alphas(ctx(), 'stroke').map((x) => x.alpha);
  assert.ok(strokes.includes(1), 'the path to the match');
  assert.ok(strokes.includes(DIM), 'the other clade');
});

test('dim follows the highlighted set as it changes: a clade is lit when any tip below it matches', async () => {
  const { viewer, env, ctx } = await viewerWith('dim', ['a']);
  assert.deepEqual(labelAlpha(ctx()), { a: 1, b: DIM, c: DIM, d: DIM });
  ctx().reset();
  viewer.setHighlighted(['a', 'c']);
  env.flush();
  assert.deepEqual(labelAlpha(ctx()), { a: 1, b: DIM, c: 1, d: DIM });
  const strokes = alphas(ctx(), 'stroke').map((x) => x.alpha);
  assert.ok(strokes.includes(1) && strokes.includes(DIM), 'the cherries x and y are each lit by one match; b and d are dim');
  ctx().reset();
  viewer.setHighlighted([]);
  env.flush();
  assert.ok(alphas(ctx(), 'fillText').every((x) => x.alpha === 1));
  assert.ok(!ctx().log.some((e) => e[0] === 'globalAlpha=' && e[1] === DIM), 'no highlights, no dimming');
});

test("'band' builds no dim state (no prefix array); a switch to dim or both, or a dim viewer, builds it on the next frame", async () => {
  const band = await viewerWith('band', ['a']);
  assert.equal(band.viewer.hlPrefix, null);
  band.viewer.setOptions({ highlightStyle: 'both' });
  band.env.flush();
  assert.ok(band.viewer.hlPrefix instanceof Int32Array);
  band.viewer.setHighlighted(['b']);
  assert.equal(band.viewer.hlPrefix, null, 'dropped when the highlights change');
});

test('dim: node markers and tip dots are filled at markerOpacity, dimmed ones at markerOpacity * dimOpacity', async () => {
  const { ctx } = await viewerWith('dim', ['a']);
  const mo = FALLBACK_THEME.markerOpacity;
  const fills = alphas(ctx(), 'fill').map((x) => x.alpha);
  assert.ok(fills.includes(mo), 'the lit markers');
  assert.ok(fills.includes(mo * DIM), 'the dimmed markers');
});

test('dim: the triangle of a collapsed clade is dimmed unless one of its tips matches', async () => {
  const { viewer, env, ctx } = await viewerWith('dim', ['a']);
  viewer.setCollapsed([1, 4]); // the clades x (holds a) and y
  ctx().reset();
  env.flush();
  const so = FALLBACK_THEME.summaryOpacity;
  const fills = alphas(ctx(), 'fill').map((x) => x.alpha);
  assert.ok(fills.includes(so), 'x, a tip of it matches');
  assert.ok(fills.includes(so * DIM), 'y');
  const labels = alphas(ctx(), 'fillText')
    .filter((x) => x.arg === 'x · 2 tips' || x.arg === 'y · 2 tips')
    .map((x) => x.alpha);
  assert.deepEqual(labels, [1, DIM], 'the labels of the clades follow their triangles');
});

// runs: siblings drawn as one slice. Its tips are [leafStart of the first member, leafEnd of the last], so a match at either end, in the
// middle, or in another clade must each give the right lit / dimmed count.
const cher = (k) => `(p${k}a,p${k}b)c${k}`;
const RUNS = '((' + Array.from({ length: 200 }, (_, k) => cher(k)).join(',') + ')P,(z1,z2)Z)root;';
function fillGroups(ctx) {
  let alpha = 1,
    prims = 0;
  const out = {};
  for (const e of ctx.log) {
    if (e[0] === 'globalAlpha=') alpha = e[1];
    else if (e[0] === 'beginPath') prims = 0;
    else if (e[0] === 'rect' || e[0] === 'moveTo') prims++;
    else if (e[0] === 'fill') out[alpha] = (out[alpha] ?? 0) + prims;
  }
  return out;
}
for (const tip of ['p0a', 'p17b', 'p100a', 'p199b', 'z1']) {
  test('dim: runs and slices are lit exactly when a tip of their members matches (' + tip + ')', async () => {
    // a stripe opacity whose tone (0.45, see stripeToneAlpha) differs from the background's: the background fills are counted, one per summary
    const m = await makeViewer(RUNS, { options: { highlightStyle: 'dim' }, theme: { dimOpacity: DIM, summaryStripeOpacity: 0.9 }, size: [400, 120] });
    m.viewer.setHighlighted([tip]);
    m.env.flush();
    const { list, tree: t } = m.viewer;
    const r = t.tipRank[t.tipIndex(tip)];
    let runs = 0,
      expDim = 0,
      expLit = 0;
    for (let e = 0; e < list.count; e++) {
      if (list.kind[e] !== 2) continue; // K_SUMMARY
      const i = list.node[e],
        lm = list.last[e];
      if (lm >= 0) runs++;
      if (r >= t.leafStart[i] && r < t.leafEnd[lm >= 0 ? lm : i]) expLit++;
      else expDim++;
    }
    const g = fillGroups(m.ctx());
    const so = m.viewer.theme.summaryOpacity;
    assert.ok(runs > 0, 'the frame draws runs');
    assert.equal(g[so * DIM] ?? 0, expDim, 'dimmed summaries');
    assert.equal(g[so] ?? 0, expLit, 'lit summaries');
  });
}

test('dim: nothing is dimmed without highlights, and unknown ids highlight nothing', async () => {
  for (const tips of [[], ['nope']]) {
    const { ctx } = await viewerWith('dim', tips);
    assert.ok(alphas(ctx(), 'fillText').every((x) => x.alpha === 1));
  }
});

test('setOptions switches the style and redraws', async () => {
  const { viewer, env, ctx } = await viewerWith('band', ['a']);
  ctx().reset();
  viewer.setOptions({ highlightStyle: 'dim' });
  env.flush();
  assert.equal(labelAlpha(ctx()).b, DIM);
  ctx().reset();
  viewer.setOptions({ highlightStyle: 'band' });
  env.flush();
  assert.equal(labelAlpha(ctx()).b, 1);
});

test('dim: a summary holding a highlighted tip keeps full strength, the others are dimmed', async () => {
  // 8 clades of 40 tips in 120 px: every clade is collapsed to a triangle
  const clade = (c) => '(' + Array.from({ length: 40 }, (_, i) => `t${c}_${i}`).join(',') + `)c${c}`;
  const tree = '(' + Array.from({ length: 8 }, (_, c) => clade(c)).join(',') + ')root;';
  const { viewer, ctx } = await viewerWith('dim', ['t3_7'], tree, { init: { size: [400, 120] } });
  assert.ok(viewer.getStats().summaries > 0, 'the clades are summarised');
  const fills = alphas(ctx(), 'fill').map((x) => x.alpha);
  const so = FALLBACK_THEME.summaryOpacity;
  assert.ok(fills.includes(so), 'the clade with the match');
  assert.ok(fills.includes(so * DIM), 'the others');
});

test('dim: radial layout dims the same rows', async () => {
  const { ctx } = await viewerWith('dim', ['a'], TWO, { options: { layout: 'radial' }, init: { size: [400, 400] } });
  const strokes = alphas(ctx(), 'stroke').map((x) => x.alpha);
  assert.ok(strokes.includes(1) && strokes.includes(DIM));
});

test('dim after setTree: the dim prefix is built for the new tree, not the old length', async () => {
  const { viewer, env, ctx } = await viewerWith('dim', ['a']);
  assert.equal(viewer.hlPrefix.length, 5);
  const { parseNewick } = await import('../../io/src/newick.ts');
  viewer.setTree(parseNewick('((a,b)x,((c,d)y,(e,f)z)w)r;'), { highlighted: ['a', 'f'] });
  assert.equal(viewer.hlPrefix, null, 'dropped with the tree');
  ctx().reset();
  env.flush();
  assert.equal(viewer.hlPrefix.length, 7, 'rebuilt for six tips');
  assert.deepEqual(labelAlpha(ctx()), { a: 1, b: DIM, c: DIM, d: DIM, e: DIM, f: 1 });
});

test('band: thousands of matched rows that share pixels cost canvas calls per pixel, not per match (#58)', async () => {
  // a star of 4,000 tips in a 300 px high view: rows are 0.07 px apart, every tip highlighted
  const n = 4000;
  const tips = Array.from({ length: n }, (_, k) => `t${k}`);
  const m = await makeViewer(`(${tips.join(',')})r;`, { options: { highlightStyle: 'band' } });
  m.viewer.setHighlighted(tips);
  m.ctx().reset();
  m.viewer.renderNow();
  let alpha = 1;
  const bands = [];
  for (const e of m.ctx().log) {
    if (e[0] === 'globalAlpha=') alpha = e[1];
    else if (e[0] === 'fillRect' && alpha === m.viewer.getTheme().highlightOpacity) bands.push(e);
  }
  const rings = m
    .ctx()
    .calls('arc')
    .filter((e) => e[3] === 7);
  assert.equal(bands.length, 1, 'overlapping bands are one run');
  assert.ok(bands[0][4] > 250, 'the run spans the rows');
  assert.ok(rings.length > 0 && rings.length <= 300, `one ring per pixel at most, got ${rings.length}`);
});

test('band, zoomed in: matches on rows partly in view are drawn, matches above and below the clip are not visited (#58)', async () => {
  const n = 200;
  const tips = Array.from({ length: n }, (_, k) => `t${k}`);
  const m = await makeViewer(`(${tips.join(',')})r;`, { options: { highlightStyle: 'band' } });
  const v = m.viewer;
  v.focusTip(100, false);
  v.renderNow();
  const T = v.T;
  const top = Math.floor((T.clipT - T.oy) / T.ky); // the first row in view, maybe partly
  const bot = Math.floor((T.clipB - T.oy) / T.ky); // the last
  assert.ok(T.ky >= 3 && top > 3 && bot < n - 4, `zoomed in on the middle (rows ${top}..${bot}, ${T.ky} px each)`);
  const rows = [0, top - 2, top - 1, top, 100, bot, bot + 1, bot + 2, n - 1];
  v.setHighlighted(rows.map((r) => `t${r}`));
  m.ctx().reset();
  v.renderNow();
  let alpha = 1;
  const bands = [];
  for (const e of m.ctx().log) {
    if (e[0] === 'globalAlpha=') alpha = e[1];
    else if (e[0] === 'fillRect' && alpha === v.getTheme().highlightOpacity) bands.push(e);
  }
  const rowOf = (y) => Math.round((y - T.oy - T.ky / 2) / T.ky);
  const banded = bands.map((e) => rowOf(e[2] + e[4] / 2));
  const ringed = m
    .ctx()
    .calls('arc')
    .filter((e) => e[3] === 7)
    .map((e) => rowOf(e[2]));
  // rows whose band reaches into the clip: top (partly) to bot (partly); top - 1 and bot + 1 only if their row touches the clip
  const inView = rows.filter((r) => T.oy + (r + 1) * T.ky >= T.clipT && T.oy + r * T.ky <= T.clipB);
  assert.deepEqual(banded, inView, 'a band for each matched row in view, the edge rows included');
  assert.deepEqual(ringed, inView, 'and a ring');
  assert.ok(!banded.includes(0) && !banded.includes(n - 1));
});
