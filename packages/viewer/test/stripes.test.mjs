// Unit tests of the look of summaries (placeholders: triangles, fans, bands; theme `summary`, `summaryOpacity`, `summaryStripeOpacity`,
// `summaryStripeGap`), read from the calls the recording context saw: every summary is one background fill() in the summary colour at
// summaryOpacity, with stripes over it, stroked segments in the same colour at summaryStripeOpacity; a summary without room for stripes gets
// a second fill at their mean tone (stripeToneAlpha) instead.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { makeViewer, destroyAll } = await import('./viewer-harness.mjs');
const { FALLBACK_THEME, DEFAULT_OPTIONS } = await import('../src/types.ts');
const { THEME_CSS_VARS } = await import('../src/theme.ts');
const { stripeToneAlpha } = await import('../src/draw.ts');

afterEach(destroyAll);

const STRIPE = '#ff0000';
// the summary colour, and a stripe opacity whose tone (stripeToneAlpha: 0.4 at the default 2 px gap) differs from the background's opacity,
// so the fills can be told apart by their alpha
const THEME = { summary: STRIPE, summaryStripeOpacity: 0.8 };
const DIM = 0.3;

/** A balanced binary tree with 2^depth tips named t0, t1, ... */
function balanced(depth) {
  let id = 0;
  const build = (d) => (d === 0 ? 't' + id++ : '(' + build(d - 1) + ',' + build(d - 1) + ')');
  return build(depth) + ';';
}
const TREE = balanced(11); // 2048 tips

/** Stripes in the log: each stroked segment (moveTo + lineTo) in colour `colour`, with the globalAlpha it was stroked at. */
function stripes(ctx, colour = STRIPE) {
  const out = [];
  let style = null,
    alpha = 1,
    width = 1,
    path = [],
    id = 0,
    lastW = -1,
    lastA = -1,
    prevCount = 0;
  for (const e of ctx.log) {
    if (e[0] === 'strokeStyle=') style = e[1];
    else if (e[0] === 'globalAlpha=') alpha = e[1];
    else if (e[0] === 'lineWidth=') width = e[1];
    else if (e[0] === 'beginPath') path = [];
    else if (e[0] === 'moveTo') path.push([e[1], e[2]]);
    else if (e[0] === 'lineTo' && path.length) {
      path.push([e[1], e[2]]);
    } else if (e[0] === 'stroke' && style === colour) {
      // a summary's stripes are stroked in chunks of 256 with one width and alpha: a stroke after a full chunk continues its group
      if (!(prevCount === 256 && width === lastW && alpha === lastA)) id++;
      lastW = width;
      lastA = alpha;
      prevCount = path.length / 2;
      for (let k = 0; k + 1 < path.length; k += 2)
        out.push({ x0: path[k][0], y0: path[k][1], x1: path[k + 1][0], y1: path[k + 1][1], alpha, width, id });
    }
  }
  return out;
}
const fillAlphas = (ctx) => fills(ctx).map((f) => f.alpha);
/** Every fill() in the log: its colour, alpha and the number of shapes in its path (a shape starts with moveTo or is a rect). */
function fills(ctx) {
  let alpha = 1,
    style = null,
    shapes = 0;
  const out = [];
  for (const e of ctx.log) {
    if (e[0] === 'globalAlpha=') alpha = e[1];
    else if (e[0] === 'fillStyle=') style = e[1];
    else if (e[0] === 'beginPath') shapes = 0;
    else if (e[0] === 'moveTo' || e[0] === 'rect') shapes++;
    else if (e[0] === 'fill') out.push({ alpha, style, shapes });
  }
  return out;
}
/** The shapes filled in `colour` at `alpha`. */
const filled = (ctx, colour, alpha) =>
  fills(ctx)
    .filter((f) => f.style === colour && Math.abs(f.alpha - alpha) < 1e-12)
    .reduce((t, f) => t + f.shapes, 0);
/** The summaries in the frame's draw list. */
const summaryCount = (viewer) => {
  let n = 0;
  for (let e = 0; e < viewer.list.count; e++) if (viewer.list.kind[e] === 2) n++; // K_SUMMARY
  return n;
};

// the radial tests measure angles from 3 o'clock (0..2pi) and name the window through angle 0: they run on the whole circle from there
// (radialOpening 0, radialRotation 0); the fan's opening is covered by radial-opening.test.mjs
const CIRCLE = { radialOpening: 0, radialRotation: 0 };

async function make(layout, options = {}, tree = TREE, extra = {}) {
  const m = await makeViewer(tree, {
    options: { layout, minCladePx: 20, ...(layout === 'radial' ? CIRCLE : {}), ...options },
    theme: { ...THEME, ...extra.theme },
    size: layout === 'radial' ? [500, 500] : [500, 300],
  });
  m.env.flush();
  return m;
}

test('one look: no summaryStyle or stripeCollapsed option; background and stripe opacity and the gap are theme tokens with CSS variables', () => {
  assert.ok(!('summaryStyle' in DEFAULT_OPTIONS) && !('stripeCollapsed' in DEFAULT_OPTIONS));
  assert.ok(!('summaryStripeColour' in FALLBACK_THEME));
  assert.ok(
    FALLBACK_THEME.summaryOpacity > 0 && FALLBACK_THEME.summaryOpacity < FALLBACK_THEME.summaryStripeOpacity,
    'a light background, darker stripes',
  );
  assert.ok(FALLBACK_THEME.summaryStripeGap >= 1);
  assert.equal(THEME_CSS_VARS.summaryOpacity, '--phylo-summary-opacity');
  assert.equal(THEME_CSS_VARS.summaryStripeOpacity, '--phylo-summary-stripe-opacity');
  assert.equal(THEME_CSS_VARS.summaryStripeGap, '--phylo-summary-stripe-gap');
});

for (const layout of ['rectangular', 'radial']) {
  test(`${layout}: every summary is one background fill in the summary colour at summaryOpacity, with stripes over it at summaryStripeOpacity`, async () => {
    const { viewer, ctx } = await make(layout, { minCladePx: 40 });
    const n = summaryCount(viewer);
    assert.ok(n > 0, 'summaries are drawn');
    assert.equal(filled(ctx(), STRIPE, viewer.theme.summaryOpacity), n, 'one background shape per summary');
    const s = stripes(ctx());
    assert.ok(s.length > 0, 'striped');
    assert.ok(
      s.every((x) => x.alpha === viewer.theme.summaryStripeOpacity && x.width === 1),
      'hairlines at the stripe opacity',
    );
    // the background is drawn before the stripes
    const log = ctx().log;
    const firstBg = log.findIndex((e, k) => e[0] === 'fill' && log.slice(0, k).findLast((x) => x[0] === 'fillStyle=')?.[1] === STRIPE);
    const firstStripe = log.findIndex((e, k) => e[0] === 'stroke' && log.slice(0, k).findLast((x) => x[0] === 'strokeStyle=')?.[1] === STRIPE);
    assert.ok(firstBg >= 0 && firstBg < firstStripe, 'background under the stripes');
  });

  test(`${layout}: the tokens reach the drawing: summaryOpacity the fill, summaryStripeOpacity the stripes, summary the colour of both`, async () => {
    const { viewer, env, ctx } = await make(layout, { minCladePx: 40 });
    const n = summaryCount(viewer);
    ctx().reset();
    viewer.setTheme({ summary: '#00ff00', summaryOpacity: 0.11, summaryStripeOpacity: 0.66 });
    env.flush();
    assert.equal(filled(ctx(), '#00ff00', 0.11), n, 'the background follows summaryOpacity');
    const s = stripes(ctx(), '#00ff00');
    assert.ok(s.length > 0 && s.every((x) => x.alpha === 0.66), 'the stripes follow summaryStripeOpacity');
    assert.equal(stripes(ctx()).length, 0, 'nothing left in the old colour');
  });
}

test('rectangular: the stripes are horizontal, run rightwards, at least the gap apart, and their count is bounded by the height over the gap', async () => {
  const { viewer, ctx } = await make('rectangular');
  const s = stripes(ctx());
  assert.ok(s.length > 0);
  for (const x of s) {
    assert.equal(x.y0, x.y1, 'horizontal: the direction of the tip branches');
    assert.ok(x.x1 > x.x0);
  }
  const gap = viewer.theme.summaryStripeGap;
  const ys = [...new Set(s.map((x) => x.y0))].sort((a, b) => a - b);
  // the stripes of one clade are evenly spaced at least `gap` apart; across clades the same holds (their bands do not overlap)
  for (let k = 1; k < ys.length; k++) assert.ok(ys[k] - ys[k - 1] >= gap - 1e-6, 'gap ' + (ys[k] - ys[k - 1]));
  assert.ok(s.length <= 300 / gap + viewer.getStats().summaries, 'bounded by the plot height over the gap');
});

/** Group the stripes by stroke (one summary each). */
const groups = (s) => [...Map.groupBy(s, (x) => x.id).values()];

test('stripeToneAlpha: the mean tone of hairline stripes a pitch apart, at most 1', () => {
  assert.equal(stripeToneAlpha(0.5, 2), 0.25);
  assert.ok(Math.abs(stripeToneAlpha(0.6, 3) - 0.2) < 1e-12);
  assert.equal(stripeToneAlpha(0.9, 1), 0.9);
  assert.equal(stripeToneAlpha(1, 0.5), 1);
});

test('rectangular: a larger gap gives fewer stripes, all 1 px wide', async () => {
  const a = await make('rectangular', {}, TREE, { theme: { summaryStripeGap: 3 } });
  const na = stripes(a.ctx()).length;
  const b = await make('rectangular', {}, TREE, { theme: { summaryStripeGap: 8 } });
  const sb = stripes(b.ctx());
  assert.ok(sb.length > 0 && sb.length < na);
  assert.ok(
    sb.every((x) => x.width === 1),
    'hairlines',
  );
});

test('radial: the stripes lie on rays from the root (their line passes through the centre), pointing outwards', async () => {
  const { viewer, ctx } = await make('radial');
  const s = stripes(ctx());
  assert.ok(s.length > 0);
  const { cx, cy } = viewer.proj.T;
  for (const x of s) {
    const dx = x.x1 - x.x0,
      dy = x.y1 - x.y0;
    const len = Math.hypot(dx, dy);
    const cross = Math.abs(dx * (x.y0 - cy) - dy * (x.x0 - cx)) / len; // distance of the centre from the stripe's line
    assert.ok(cross < 1e-3, 'on a ray: ' + cross); // the segments are kept as 32-bit floats
    assert.ok(Math.hypot(x.x1 - cx, x.y1 - cy) > Math.hypot(x.x0 - cx, x.y0 - cy), 'outwards');
  }
});

test('radial: a fan gets at most 256 stripes, and the total is bounded by the circle over the gap plus one per fan', async () => {
  const { viewer, ctx } = await make('radial');
  const s = stripes(ctx());
  const circ = 2 * Math.PI * Math.min(viewer.proj.T.cx, viewer.proj.T.cy);
  assert.ok(s.length <= circ / viewer.theme.summaryStripeGap + viewer.getStats().summaries, 'count ' + s.length);
});

test('summaries too small for two stripes get their mean tone: the background plus a second fill at stripeToneAlpha, no stripes', async () => {
  const { viewer, ctx } = await make('rectangular', { minCladePx: 3 });
  const n = summaryCount(viewer);
  assert.ok(n > 0);
  assert.equal(stripes(ctx()).length, 0, 'every summary is under two gaps tall');
  const t = viewer.theme;
  assert.equal(filled(ctx(), STRIPE, t.summaryOpacity), n, 'the background of each');
  assert.equal(filled(ctx(), STRIPE, stripeToneAlpha(t.summaryStripeOpacity, t.summaryStripeGap)), n, 'and the tone over it');
});

test('a clade colour tints both the background and the stripes of its summaries', async () => {
  const m = await make('rectangular', { minCladePx: 40 });
  m.viewer.setClades([{ node: 1, colour: '#0000ff' }]);
  m.ctx().reset();
  m.env.flush();
  assert.ok(stripes(m.ctx(), '#0000ff').length > 0, 'the coloured clade is striped in its colour');
  assert.ok(filled(m.ctx(), '#0000ff', m.viewer.theme.summaryOpacity) > 0, 'over a background in its colour');
  assert.ok(stripes(m.ctx(), STRIPE).length > 0, 'the rest in the summary colour');
  assert.ok(filled(m.ctx(), STRIPE, m.viewer.theme.summaryOpacity) > 0);
});

test('dimming: a summary without a highlighted tip has its background and stripes at dimOpacity times their opacity, the others at full', async () => {
  const m = await make('rectangular', { minCladePx: 40, highlightStyle: 'dim' }, TREE, { theme: { dimOpacity: DIM } });
  m.viewer.setHighlighted(['t5']);
  m.env.flush();
  const t = m.viewer.theme;
  const close = (a, b) => Math.abs(a - b) < 1e-12;
  const alphas = [...new Set(stripes(m.ctx()).map((x) => x.alpha))];
  assert.equal(alphas.length, 2);
  assert.ok(alphas.some((a) => close(a, t.summaryStripeOpacity)) && alphas.some((a) => close(a, t.summaryStripeOpacity * DIM)), 'stripes ' + alphas);
  assert.ok(filled(m.ctx(), STRIPE, t.summaryOpacity) > 0, 'the lit background');
  assert.ok(filled(m.ctx(), STRIPE, t.summaryOpacity * DIM) > 0, 'the dimmed background');
});

for (const layout of ['rectangular', 'radial']) {
  test(`${layout}: a clade the app collapsed has the same look as any summary, and keeps its label`, async () => {
    const tree =
      '((' + Array.from({ length: 20 }, (_, k) => 'a' + k).join(',') + ')X,(' + Array.from({ length: 20 }, (_, k) => 'b' + k).join(',') + ')Y)r;';
    const m = await makeViewer(tree, { options: { layout, ...(layout === 'radial' ? CIRCLE : {}) }, theme: THEME, size: [500, 500] });
    m.viewer.setCollapsed([1]);
    m.env.flush();
    assert.ok(stripes(m.ctx()).length > 0, 'collapsed clade X is striped; Y is expanded');
    assert.equal(filled(m.ctx(), STRIPE, m.viewer.theme.summaryOpacity), 1, 'over one background');
    assert.ok(
      m.ctx().log.some((e) => e[0] === 'fillText' && e[1] === 'X · 20 tips'),
      'the label is drawn',
    );
  });
}

/** The canvases of the overview strip: every recording canvas but the main and the top one. */
function stripCanvases(m) {
  const canvases = [];
  const walk = (el) => {
    for (const c of el.children ?? []) {
      if (c.ctx) canvases.push(c);
      walk(c);
    }
  };
  walk(m.viewer.element);
  return canvases.filter((c) => c !== m.canvas() && c !== m.topCanvas());
}

test('the overview strip draws summaries with the same look: a background fill under each, its tone where there is no room for stripes', async () => {
  const { OverviewControl } = await import('../src/controls/index.ts');
  const m = await makeViewer(TREE, { controls: [new OverviewControl()], options: { minCladePx: 20 }, theme: THEME, size: [500, 300] });
  m.env.flush();
  const strips = stripCanvases(m);
  assert.ok(strips.length > 0, 'the overview canvas exists');
  const t = m.viewer.theme;
  assert.ok(
    strips.some((c) => filled(c.ctx, STRIPE, t.summaryOpacity) > 0),
    'background fills',
  );
  assert.ok(
    strips.some((c) => filled(c.ctx, STRIPE, stripeToneAlpha(t.summaryStripeOpacity, t.summaryStripeGap)) > 0),
    'the tone of the small ones',
  );
});

const poly = (n, p) => '(' + Array.from({ length: n }, (_, k) => p + k).join(',') + ')';
const BANDS = `(${poly(400, 'p')}P,${poly(400, 'q')}Q)r;`; // two polytomies of tips: slices

test('rectangular: a triangle summary starts each stripe on its sloping side, a polytomy band at its left edge; all end at the outer edge', async () => {
  const tri = groups(stripes((await make('rectangular', { minCladePx: 40 })).ctx())).filter((g) => g.length > 3);
  assert.ok(tri.length > 3);
  for (const g of tri) {
    assert.equal(new Set(g.map((x) => x.x1)).size, 1, 'one outer edge');
    const xs = g.map((x) => x.x0);
    assert.ok(Math.max(...xs) - Math.min(...xs) > 1, 'the start follows the triangle side');
    assert.ok(Math.min(...xs) >= g[0].x1 - 400 && Math.max(...xs) <= g[0].x1, 'inside the triangle');
  }
  const band = groups(stripes((await make('rectangular', {}, BANDS)).ctx()));
  assert.ok(band.length >= 2 && band.every((g) => g.length > 5));
  for (const g of band) assert.equal(new Set(g.map((x) => x.x0)).size, 1, 'a band starts at one x');
});

test('radial: a fan starts each ray on its side (the start radius varies), a polytomy ring segment at one radius', async () => {
  const { cx, cy } = (await make('radial')).viewer.proj.T;
  const r = (x) => Math.hypot(x.x0 - cx, x.y0 - cy);
  const fans = groups(stripes((await make('radial', { minCladePx: 40 })).ctx())).filter((g) => g.length > 3);
  assert.ok(fans.length > 3);
  for (const g of fans) {
    const rs = g.map(r);
    assert.ok(Math.max(...rs) - Math.min(...rs) > 1, 'start radii vary');
    assert.ok(Math.min(...rs) < Math.hypot(g[0].x1 - cx, g[0].y1 - cy), 'and lie inside the fan');
  }
  const rings = groups(stripes((await make('radial', {}, BANDS)).ctx()));
  assert.ok(rings.length >= 2 && rings.every((g) => g.length > 5));
  for (const g of rings) {
    const rs = g.map(r);
    assert.ok(Math.max(...rs) - Math.min(...rs) < 1e-3, 'one start radius');
  }
});

test('rectangular, zoomed: only the stripes of the visible rows are drawn', async () => {
  const m = await make('rectangular', { minCladePx: 400 });
  m.viewer.setViewport({ x0: 0, x1: 1, y0: 300, y1: 310 });
  m.env.flush();
  const s = stripes(m.ctx());
  assert.ok(s.length > 0, 'summaries taller than the screen are striped');
  const gap = m.viewer.theme.summaryStripeGap;
  assert.ok(
    s.every((x) => x.y0 > -20 && x.y0 < 320),
    'inside the clip window',
  );
  assert.ok(s.length <= (330 / gap) * (m.viewer.getStats().summaries + 1), 'bounded by the window, not the clade');
});

test('radial, zoomed: at most 256 rays per fan, drawn over the visible angles only', async () => {
  const m = await make('radial', { minCladePx: 600 });
  let drawn = 0;
  for (const vp of [
    { x0: 0.2, x1: 0.4, y0: -0.1, y1: 0.1 },
    { x0: 0.5, x1: 0.52, y0: 0.2, y1: 0.22 },
  ]) {
    m.viewer.setViewport(vp);
    m.env.flush();
    const gs = groups(stripes(m.ctx()));
    for (const g of gs) assert.ok(g.length <= 256, 'rays per fan ' + g.length);
    // every ray is at an angle the window can see (proj.lo..hi, its complement when it wraps; the whole circle when the root is inside)
    const p = m.viewer.proj;
    const inWindow = (x) => {
      let a = Math.atan2(x.y1 - p.T.cy, x.x1 - p.T.cx);
      if (a < 0) a += 2 * Math.PI;
      return p.all || (p.wrap ? a <= p.hi + 1e-6 || a >= p.lo - 1e-6 : a >= p.lo - 1e-6 && a <= p.hi + 1e-6);
    };
    for (const x of gs.flat()) assert.ok(inWindow(x), 'a ray outside the visible angles');
    drawn += gs.length;
    m.ctx().reset();
  }
  assert.ok(drawn > 0, 'some fan is striped in the zoomed views');
});

test('summaryStripeGap below 1 is taken as 1: no stripe per tip, no tone above the stripe opacity', async () => {
  const m = await make('rectangular', {}, TREE, { theme: { summaryStripeGap: 0 } });
  const s = stripes(m.ctx());
  assert.ok(s.length > 0);
  assert.ok(fillAlphas(m.ctx()).every((a) => Number.isFinite(a) && a <= 1));
  assert.ok(s.length <= 300 + m.viewer.getStats().summaries, 'at most one per px');
});

test('the overview strip stripes a summary with room for stripes (a polytomy band hundreds of tips tall)', async () => {
  const { OverviewControl } = await import('../src/controls/index.ts');
  const m = await makeViewer(BANDS, { controls: [new OverviewControl()], theme: THEME, size: [500, 300] });
  m.env.flush();
  assert.ok(stripes(m.ctx()).length > 0, 'the main canvas stripes the bands');
  const strips = stripCanvases(m);
  assert.ok(
    strips.some((c) => stripes(c.ctx).length > 0),
    'and so does the strip',
  );
  assert.ok(strips.some((c) => filled(c.ctx, STRIPE, m.viewer.theme.summaryOpacity) > 0));
});

test('one stripe per hidden tip when the rows are wider than the gap (not one per gap)', async () => {
  const m = await make('rectangular', { minCladePx: 100 }, balanced(3), { theme: { summaryStripeGap: 6 } }); // 8 tips, 37 px rows: the cherries are 75 px summaries
  const gs = groups(stripes(m.ctx()));
  assert.ok(gs.length >= 2);
  for (const g of gs) assert.equal(g.length, 2, 'a cherry has two hidden tips, so two stripes');
});

const TWO_POLY = `(${poly(800, 'p')}P,${poly(800, 'q')}Q)r;`; // two bands of 800 tips: one fan each at fit
const twoPoly = () =>
  makeViewer(TWO_POLY, {
    options: { layout: 'radial', ...CIRCLE },
    theme: THEME,
    size: [900, 900],
  });
/** Shapes filled with the stripes' tone (the summaries without stripes). */
const toneFills = (m) =>
  fills(m.ctx())
    .filter((f) => f.style === STRIPE && f.alpha > 0 && f.alpha !== m.viewer.theme.summaryOpacity)
    .reduce((t, f) => t + f.shapes, 0);
/** The alphas of the tone fills. */
const toneAlphas = (m) => [
  ...new Set(
    fills(m.ctx())
      .filter((f) => f.style === STRIPE && f.alpha !== m.viewer.theme.summaryOpacity)
      .map((f) => f.alpha),
  ),
];
/** The angle (0..2pi) of a ray's outer end seen from the root of the frame. */
const rayAngle = (m, x) => {
  const { cx, cy } = m.viewer.proj.T;
  const a = Math.atan2(x.y1 - cy, x.x1 - cx);
  return a < 0 ? a + 2 * Math.PI : a;
};

test('radial: a fan with more than 256 rays in view draws every 2nd, 4th, ... ray of its grid (at most 256, evenly spaced)', async () => {
  const m = await twoPoly();
  m.env.flush();
  const gs = groups(stripes(m.ctx()));
  assert.equal(gs.length, 2);
  for (const g of gs) {
    assert.ok(g.length <= 256 && g.length > 128, 'rays per fan ' + g.length);
    const a = g.map((x) => rayAngle(m, x)).sort((p, q) => p - q);
    const step = a[1] - a[0];
    for (let k = 2; k < a.length; k++) assert.ok(Math.abs(a[k] - a[k - 1] - step) < 1e-6, 'even spacing');
  }
});

test('radial: stripes more than eight gaps apart (a few hidden tips over a wide ring segment) are not drawn: the summary gets their tone', async () => {
  const sparse = `(${poly(10, 'p')}P,${poly(10, 'q')}Q)r;`;
  const m = await makeViewer(sparse, {
    options: { layout: 'radial', minCladePx: 3000 },
    theme: THEME,
    size: [500, 500],
  });
  m.env.flush();
  assert.ok(m.viewer.getStats().summaries >= 2, 'the polytomies are summarised');
  assert.equal(stripes(m.ctx()).length, 0);
  assert.ok(toneFills(m) >= 1, 'filled with the tone instead');
  m.ctx().reset();
  m.viewer.setTheme({ ...THEME, summaryStripeGap: 30 }); // the same fan with a gap that makes ten rays fit
  m.env.flush();
  assert.ok(stripes(m.ctx()).length >= 10, 'striped when the pitch is within eight gaps');
});

test('radial, window through angle 0: the rays of both visible intervals are drawn, as many as the grid puts there', async () => {
  const m = await twoPoly();
  m.viewer.setViewport({ x0: 0.3, x1: 1.5, y0: -0.6, y1: 0.6 });
  m.env.flush();
  const p = m.viewer.proj;
  assert.ok(p.wrap && !p.all, 'the window wraps');
  const gs = groups(stripes(m.ctx()));
  assert.equal(gs.length, 2);
  const [lowFan, highFan] = gs; // P covers the angles 0..pi, Q pi..2pi
  const a1 = lowFan.map((x) => rayAngle(m, x)).sort((u, v) => u - v);
  const a2 = highFan.map((x) => rayAngle(m, x)).sort((u, v) => u - v);
  assert.ok(a1.length > 20 && a1.every((a) => a <= p.hi + 1e-6), 'P: rays at angles up to hi');
  assert.ok(a2.length > 20 && a2.every((a) => a >= p.lo - 1e-6), 'Q: rays at angles from lo');
  for (const [a, from, to] of [
    [a1, 0, p.hi],
    [a2, p.lo, 2 * Math.PI],
  ]) {
    const step = (a[a.length - 1] - a[0]) / (a.length - 1);
    const expected = (to - from) / step;
    assert.ok(Math.abs(a.length - expected) <= 2, `${a.length} rays, the visible angle holds ${expected.toFixed(1)}`);
  }
});

const FOUR_K = `(${poly(4000, 'p')}P,${poly(4000, 'q')}Q)r;`;
const fourK = () => makeViewer(FOUR_K, { options: { layout: 'radial', ...CIRCLE }, theme: THEME, size: [900, 900] });

test('radial, window not through angle 0: only rays at visible angles are drawn', async () => {
  const m = await fourK();
  m.viewer.setViewport({ x0: -0.3, x1: 0.3, y0: 0.5, y1: 1.1 });
  m.env.flush();
  const p = m.viewer.proj;
  assert.ok(!p.wrap && !p.all);
  const rays = groups(stripes(m.ctx())).flat();
  assert.ok(rays.length > 50);
  for (const x of rays) {
    const a = rayAngle(m, x);
    assert.ok(a >= p.lo - 1e-6 && a <= p.hi + 1e-6, `angle ${a} outside ${p.lo}..${p.hi}`);
  }
});

for (const [name, vp] of [
  ['one ray per grid step', { x0: -0.3, x1: 0.3, y0: 0.5, y1: 1.1 }],
  ['every other ray of the grid', { x0: -0.6, x1: 0.6, y0: 0.3, y1: 1.5 }],
]) {
  test(`radial: panning a partly visible fan moves its rays, it does not re-space them (${name})`, async () => {
    const m = await fourK();
    const frame = (dx, dy) => {
      m.ctx().reset();
      m.viewer.setViewport({ x0: vp.x0 + dx, x1: vp.x1 + dx, y0: vp.y0 + dy, y1: vp.y1 + dy });
      m.env.flush();
      return groups(stripes(m.ctx())).map((g) => g.map((x) => rayAngle(m, x)));
    };
    const spacing = (a) => Math.min(...a.slice(1).map((v, k) => v - a[k]));
    const before = frame(0, 0);
    assert.ok(before.length >= 1);
    let shared = 0;
    for (const [dx, dy] of [
      [0.0031, 0.002],
      [0.0057, 0.004],
      [0.01, 0.007],
      [0.0137, 0.001],
    ]) {
      const after = frame(dx, dy); // a small pan
      assert.equal(after.length, before.length);
      assert.ok(Math.abs(spacing(after[0]) - spacing(before[0])) < 1e-6, 'same spacing after the pan');
      for (let g = 0; g < before.length; g++) {
        const lo = Math.min(...after[g]),
          hi = Math.max(...after[g]);
        for (const a of before[g]) {
          if (a <= lo + 1e-9 || a >= hi - 1e-9) continue; // inside the second frame's angles
          shared++;
          assert.ok(
            after[g].some((b) => Math.abs(a - b) < 1e-6),
            `ray at ${a} is not in the frame panned by ${dx}`,
          );
        }
      }
    }
    assert.ok(shared > 100, 'rays compared: ' + shared);
  });
}

test('rectangular, zoomed into a summary much taller than the screen: only the stripes of the visible rows are drawn', async () => {
  const m = await make('rectangular', { minCladePx: 4000 }, balanced(11)); // clades of 1024 tips are summaries; 100 rows fill the screen
  m.viewer.setViewport({ x0: 0, x1: 1, y0: 300, y1: 400 });
  m.ctx().reset();
  m.env.flush();
  const s = stripes(m.ctx());
  const gap = m.viewer.theme.summaryStripeGap;
  assert.ok(s.length > 50, 'striped: ' + s.length);
  assert.ok(s.length <= 330 / gap + 4, 'only the visible rows: ' + s.length);
});

test('rectangular: a collapsed clade of three tips in a row zoomed to 200 px gets the tone, one in a row of 60 px is striped', async () => {
  const m = await makeViewer('((a0,a1,a2)X,(b0,b1)Y)r;', { theme: { ...THEME, summaryStripeGap: 3 }, size: [500, 300] });
  m.viewer.setCollapsed([1]);
  m.viewer.setViewport({ x0: 0, x1: 1, y0: 0, y1: 1.5 });
  m.env.flush();
  assert.equal(stripes(m.ctx()).length, 0, 'three stripes 66 px apart would be bands');
  assert.ok(toneFills(m) >= 1);
  const pitch = m.viewer.proj.T.ky / 3; // the row's three stripes
  const tones = toneAlphas(m);
  assert.ok(
    tones.length === 1 && Math.abs(tones[0] - stripeToneAlpha(0.8, pitch)) < 1e-6,
    'the tone of stripes that far apart, not of stripes a gap apart: ' + tones,
  );
  m.ctx().reset();
  m.viewer.setViewport({ x0: 0, x1: 1, y0: 0, y1: 5 });
  m.env.flush();
  assert.equal(groups(stripes(m.ctx())).length >= 1, true, 'striped at 60 px per row (20 px stripes)');
});

test('rectangular: zooming a summary across the eight-gap limit keeps its darkness: the tone just past it matches the stripes just before it', async () => {
  const m = await makeViewer('((a0,a1,a2)X,(b0,b1)Y)r;', { theme: { ...THEME, summaryStripeGap: 3 }, size: [500, 300] });
  m.viewer.setCollapsed([1]);
  const at = (rows) => {
    m.ctx().reset();
    m.viewer.setViewport({ x0: 0, x1: 1, y0: 0, y1: rows });
    m.env.flush();
  };
  at(284 / 70); // rows of 70 px (the plot is 284 px tall): three stripes 23 px apart, under the 24 px limit
  const g = groups(stripes(m.ctx()));
  assert.equal(g.length, 1, 'striped');
  const ys = g[0].map((x) => x.y0).sort((a, b) => a - b);
  const striped = (g[0][0].alpha * g[0][0].width) / (ys[1] - ys[0]); // mean darkness of the stripes
  at(284 / 74); // 74 px: 25 px apart, past the limit
  assert.equal(stripes(m.ctx()).length, 0, 'the tone');
  const [tone] = toneAlphas(m);
  assert.ok(Math.abs(tone - striped) < 0.1 * striped, `tone ${tone} against the stripes' ${striped}`);
});

test('radial: one ray per hidden tip when the tips are wider apart than the gap', async () => {
  const m = await make('radial', { minCladePx: 4000 }, balanced(3), { theme: { summaryStripeGap: 24 } });
  const gs = groups(stripes(m.ctx()));
  assert.ok(gs.length >= 2);
  for (const g of gs) assert.equal(g.length, 4, 'a clade of four tips: four rays');
});
