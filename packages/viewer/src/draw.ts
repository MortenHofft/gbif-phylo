// Canvas2D drawing of one frame's draw list. Everything here reads typed arrays and the draw list; nothing
// allocates per node. Strokes are batched into one path per colour class.

import { ARC_SAGITTA_K, CLAMP_Y_PAD_PX, RADIAL_FAR_ARC_R } from './constants.ts';
import { DrawList, K_NODE, K_STUB, K_SUMMARY, K_TIP, isSlice } from './lod.ts';
import { MARKER_PX } from './hit.ts';
import { labelMinPx } from './sizes.ts';
import type { LayoutProjection, Pt, RadialProjection, RectProjection } from './projection.ts';
import { internalSupport, type NodeLabelKind, type NodeLabelsOption } from './node-label.ts';
import type { LabelDensity, RadialRings, TreeTheme } from './types.ts';

export interface Scene {
  proj: LayoutProjection; // the frame's tree, layout and transform (proj.tree, proj.L, proj.T) and where nodes and clades are on screen
  list: DrawList;
  theme: TreeTheme;
  colours: string[]; // colour by class; class 0 = default branch colour
  classOf: Uint8Array | null;
  highlight: Uint8Array | null; // by tip rank
  hlRanks: Int32Array; // sorted highlighted ranks
  hlPrefix: Int32Array | null; // highlighted tips before each rank (length tipCount + 1); non-null = dimming: what holds none is drawn at theme.dimOpacity
  density: LabelDensity;
  alignLabels: boolean; // the option; it acts only in a phylogram (see alignedX and alignedR)
  labelRoom: number; // radial, aligned labels: the room (px) the text keeps in view when the circle is pinned (see alignedR)
  format: (id: string) => string;
  /** The label of a collapsed clade (node = row of the snapshot): `formatCollapsedLabel` of its name and size. null: collapsed clades get no label. */
  cladeText: ((node: number) => string) | null;
  nodeLabels: NodeLabelsOption; // the option
  formatNode: (value: number, kind: NodeLabelKind) => string; // formatNodeLabel
  scale: number; // canvas backing pixels per CSS pixel (after the DPR cap)
  thin: boolean; // radial and dense: branches are one device pixel wide (Skia hairline path, 10x cheaper on CPU raster)
  measure: TextMeasurer; // label widths, owned by the renderer
}

/** Labels laid out this frame, for hit-testing and for the DOM overlay (one entry per drawn label). */
export class LabelList {
  rank = new Int32Array(512); // the tip's rank; a collapsed clade's label has -(node + 1)
  x = new Float32Array(512); // start of the text (CSS px)
  y = new Float32Array(512); // vertical centre
  w = new Float32Array(512);
  h = new Float32Array(512);
  ang = new Float32Array(512); // radial: rotation in rad (0 for rectangular)
  flip = new Uint8Array(512);
  gap = new Float32Array(512); // distance from the tip (or the far edge of a collapsed clade's triangle) to the text
  count = 0;
  clear(): void {
    this.count = 0;
  }
  add(rank: number, x: number, y: number, w: number, h: number, ang: number, flip: number, gap = 8): void {
    if (this.count === this.rank.length) {
      const g = <A extends Float32Array | Int32Array | Uint8Array>(a: A): A => {
        const b = new (a.constructor as new (n: number) => A)(a.length * 2);
        b.set(a);
        return b;
      };
      this.rank = g(this.rank);
      this.x = g(this.x);
      this.y = g(this.y);
      this.w = g(this.w);
      this.h = g(this.h);
      this.ang = g(this.ang);
      this.flip = g(this.flip);
      this.gap = g(this.gap);
    }
    const c = this.count++;
    this.rank[c] = rank;
    this.x[c] = x;
    this.y[c] = y;
    this.w[c] = w;
    this.h[c] = h;
    this.ang[c] = ang;
    this.flip[c] = flip;
    this.gap[c] = gap;
  }
  /** The label under (x, y) in CSS px, or -1: its text box, which in the radial layout is turned along its ray (2 px slack along). */
  at(x: number, y: number, rect: boolean): number {
    for (let k = 0; k < this.count; k++) {
      let u = x - this.x[k],
        v = y - this.y[k];
      if (!rect) {
        // into the label's own frame: u along its ray from the gap on, v across it (a flipped label is turned round, its text still runs outward)
        const c = Math.cos(this.ang[k]),
          s = Math.sin(this.ang[k]);
        const t = u * c + v * s;
        v = v * c - u * s;
        u = (this.flip[k] ? -t : t) - this.gap[k];
      }
      if (u >= -2 && u <= this.w[k] + 2 && Math.abs(v) <= this.h[k] / 2) return k;
    }
    return -1;
  }
}

export const RADIAL_LABEL_CAP = 300;
const MAX_RECT_LABELS = 600;
const STROKE_CHUNK = 256; // segments per stroke() call: a path with thousands of subpaths rasterises superlinearly (measured, CPU)
const FILL_CHUNK = 32; // fans per fill() call, same reason
const MAX_RADIAL_STRIPES = 256; // rays per fan: a fan zoomed far past the screen draws every 2nd, 4th, ... ray of its grid, not more of them
const MAX_PITCH_GAPS = 8; // stripes further apart than this many gaps (a few hidden tips over a tall summary) are not drawn: the summary gets their mean tone
const STRIPE_PX = 1; // line width of the stripes: hairlines, thinner than any branch, so they read as a texture and not as branches
const TIP_DOT_PX = 6; // tip dots are drawn when rows are at least this tall
const LABEL_GAP_PX = 8; // tip (or aligned column) to the start of the text
const LEADER_END_GAP_PX = 3; // a leader stops this far before its label

/** Text widths by font and text. One per renderer, so renderers with different fonts do not clear each other's entries; bounded by
 *  clearing when the font family changes or the table passes MAX entries (checked when the font changes). */
export class TextMeasurer {
  private static readonly MAX = 20000;
  private cache = new Map<string, number>();
  private font = '';
  width(ctx: CanvasRenderingContext2D, text: string, font: string): number {
    if (font !== this.font) {
      // the cache key includes the size, so a family change is the only reason to clear
      const fam = font.slice(font.indexOf('px') + 2);
      if (this.font.slice(this.font.indexOf('px') + 2) !== fam || this.cache.size > TextMeasurer.MAX) this.cache.clear();
      this.font = font;
    }
    const key = font + '|' + text;
    let w = this.cache.get(key);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(text).width;
      this.cache.set(key, w);
    }
    return w;
  }
}

/** 1 when draw-list entry `e` is outside the highlighted set (drawn dimmed), else 0. A clade is dimmed only when none of its tips is
 *  highlighted, so a mixed clade, a triangle holding a match and the path to a match keep full strength. A run (siblings drawn as one
 *  slice) spans its members' tips, `leafStart` of the first to `leafEnd` of the last. */
function dimmed(S: Scene, e: number): number {
  const pre = S.hlPrefix;
  if (pre === null) return 0;
  const i = S.list.node[e];
  const lm = S.list.last[e];
  const t = S.proj.tree;
  const n = pre.length - 1;
  return pre[Math.min(t.leafEnd[lm >= 0 ? lm : i], n)] - pre[Math.min(t.leafStart[i], n)] === 0 ? 1 : 0;
}

const clampY = (y: number, H: number) => (y < -CLAMP_Y_PAD_PX ? -CLAMP_Y_PAD_PX : y > H + CLAMP_Y_PAD_PX ? H + CLAMP_Y_PAD_PX : y);

// Summaries (placeholders: triangles, fans, bands). Every one has one look: a faint background fill of its shape (`summaryOpacity`) with
// hairline stripes over it (`summaryStripeOpacity`), in the direction the hidden branches would run. The stripes of a frame's summaries are
// collected as segments (x0, y0, x1, y1) in one scratch buffer, in groups (one per summary), then stroked per (dimming pass, colour class),
// like the branches. A summary without room for stripes gets their mean tone as a second fill instead (its entry goes to `toneBuf`). The
// buffers are module state used only inside one drawBody call, grown by doubling, never held across calls. Cost: the stripes are bounded by
// the summary's extent over the gap, rectangular ones by the visible rows only, radial ones by the visible angles and MAX_RADIAL_STRIPES per fan.
let stripeBuf = new Float32Array(4096);
let stripeN = 0; // floats used
let groupEnd = new Int32Array(256); // per summary: the end of its segments in stripeBuf
let groupN = 0;
let toneBuf = new Int32Array(256); // draw-list entries of the summaries filled with the stripes' mean tone
let tonePitch = new Float32Array(256); // and the distance their stripes would have (px)
let toneN = 0;

function pushTone(e: number, pitch: number): void {
  if (toneN === toneBuf.length) {
    const b = new Int32Array(toneN * 2),
      p = new Float32Array(toneN * 2);
    b.set(toneBuf);
    p.set(tonePitch);
    toneBuf = b;
    tonePitch = p;
  }
  tonePitch[toneN] = pitch;
  toneBuf[toneN++] = e;
}

function pushStripe(x0: number, y0: number, x1: number, y1: number): void {
  if (stripeN + 4 > stripeBuf.length) {
    const b = new Float32Array(stripeBuf.length * 2);
    b.set(stripeBuf);
    stripeBuf = b;
  }
  stripeBuf[stripeN++] = x0;
  stripeBuf[stripeN++] = y0;
  stripeBuf[stripeN++] = x1;
  stripeBuf[stripeN++] = y1;
}

/** Close the stripes pushed since the last group (one summary's). */
function endGroup(): void {
  if (groupN === groupEnd.length) {
    const e = new Int32Array(groupN * 2);
    e.set(groupEnd);
    groupEnd = e;
  }
  groupEnd[groupN++] = stripeN;
}

/** Stripes for the summary of node `i` (a run first=i..last when lm >= 0), geometry from `proj.d0..t1` set by summaryExtent. `gap` is at
 *  least 1. Rectangular stripes are at least a gap apart; radial rays are a gap apart at the outer edge and closer toward the apex (below
 *  1 px there, which only makes them merge). Returns 0 when the stripes are pushed (nothing pushed: it is off screen). Otherwise the summary
 *  gets the stripes' mean tone instead, and the return is the distance (px) its stripes would have, for that tone: when there is no room
 *  for two stripes `gap` px apart (one per hidden tip, at least `gap`), or when the stripes would be more than MAX_PITCH_GAPS gaps apart (a
 *  few hidden tips over a tall summary, or a radial fan zoomed so far in that its visible rays are thinned that much). */
function pushStripes(proj: LayoutProjection, i: number, lm: number, solidShape: boolean, gap: number): number {
  const { tree } = proj;
  const hidden = tree.leafEnd[lm >= 0 ? lm : i] - tree.leafStart[i];
  if (hidden < 2) return gap;
  if (proj.kind === 'rectangular') {
    const { T } = proj;
    const y0 = proj.t0,
      y1 = proj.t1,
      h = y1 - y0;
    const n = Math.min(hidden, Math.floor(h / gap));
    if (n < 2) return Math.max(gap, h / hidden);
    const pitch = h / n;
    if (pitch > MAX_PITCH_GAPS * gap) return pitch;
    const sx = proj.d0,
      sy = proj.tip(i),
      xm = Math.max(sx + 2, proj.d1);
    // only the stripes in the visible rows (the clip window); the pitch comes from the whole extent
    let k0 = Math.floor((T.clipT - 6 - y0) / pitch),
      k1 = Math.ceil((T.clipB + 6 - y0) / pitch);
    if (k0 < 0) k0 = 0;
    if (k1 > n) k1 = n;
    const up = sy - y0 > 1e-6 ? (xm - sx) / (sy - y0) : 0,
      down = y1 - sy > 1e-6 ? (xm - sx) / (y1 - sy) : 0;
    for (let k = k0; k < k1; k++) {
      const y = y0 + (k + 0.5) * pitch;
      // a triangle's stripe starts on its edge (apex at (sx, sy)); a band's (slice, run) at the left side
      const xs = solidShape ? sx : Math.min(xm, sx + (y < sy ? (sy - y) * up : (y - sy) * down));
      pushStripe(xs, y, xm, y);
    }
    if (stripeN > (groupN ? groupEnd[groupN - 1] : 0)) endGroup();
    return 0;
  }
  const r0 = proj.d0,
    r1 = Math.max(r0 + 2, proj.d1);
  const a0 = proj.t0,
    a1 = proj.t1;
  // the visible angles of the clade: one interval, or two when the window wraps through angle 0 (u0..u1 and v0..v1)
  let u0 = a0,
    u1 = a1,
    v0 = 0,
    v1 = 0;
  if (!proj.all) {
    if (!proj.wrap) {
      u0 = Math.max(a0, proj.lo);
      u1 = Math.min(a1, proj.hi);
    } else {
      u1 = Math.min(a1, proj.hi);
      v0 = Math.max(a0, proj.lo);
      v1 = a1;
    }
  }
  if (!(u1 > u0) && !(v1 > v0)) return 0; // off screen
  // the ray grid belongs to the whole fan (rays at a0 + (k + 0.5) * da), not to what is visible, so a pan moves the rays and never
  // re-spaces them; only the rays inside the visible angles are drawn
  const nFull = Math.min(hidden, Math.floor(((a1 - a0) * r1) / gap));
  if (nFull < 2) return Math.max(gap, ((a1 - a0) * r1) / hidden);
  const da = (a1 - a0) / nFull;
  const k0 = u1 > u0 ? Math.max(0, Math.ceil((u0 - a0) / da - 0.5)) : 0,
    k1 = u1 > u0 ? Math.min(nFull - 1, Math.floor((u1 - a0) / da - 0.5)) : -1;
  const m0 = v1 > v0 ? Math.max(0, Math.ceil((v0 - a0) / da - 0.5)) : 0,
    m1 = v1 > v0 ? Math.min(nFull - 1, Math.floor((v1 - a0) / da - 0.5)) : -1;
  const visible = (k1 >= k0 ? k1 - k0 + 1 : 0) + (m1 >= m0 ? m1 - m0 + 1 : 0);
  if (visible === 0) return 0;
  // more than MAX_RADIAL_STRIPES visible: every 2nd, 4th, ... ray of the same grid (the stride is a power of two, so it changes only when
  // the visible part doubles or halves)
  let stride = 1;
  while ((visible + 2) / stride > MAX_RADIAL_STRIPES) stride *= 2;
  const pitchAngle = da * stride;
  if (pitchAngle * r1 > MAX_PITCH_GAPS * gap) return pitchAngle * r1; // zoomed so far in that the rays would be too far apart, or too few hidden tips
  const phi = solidShape ? 0 : proj.tip(i); // the node's own angle, where the fan's apex lies
  const { cx, cy } = proj.T;
  // a fan's ray starts where it meets the fan's side (the segment from the apex to the edge's end), a ring segment's at r0
  const ax = r0 * Math.cos(phi),
    ay = r0 * Math.sin(phi);
  const e0x = r1 * Math.cos(a0) - ax,
    e0y = r1 * Math.sin(a0) - ay,
    e1x = r1 * Math.cos(a1) - ax,
    e1y = r1 * Math.sin(a1) - ay;
  for (let iv = 0; iv < 2; iv++) {
    const first = iv === 0 ? k0 : m0,
      last = iv === 0 ? k1 : m1;
    for (let k = Math.ceil(first / stride) * stride; k <= last; k += stride) {
      const a = a0 + (k + 0.5) * da;
      const c = Math.cos(a),
        sn = Math.sin(a);
      let rs = r0;
      if (!solidShape) {
        const ex = a < phi ? e0x : e1x,
          ey = a < phi ? e0y : e1y;
        const den = c * ey - sn * ex;
        let t = den !== 0 ? (sn * ax - c * ay) / den : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        rs = c * (ax + t * ex) + sn * (ay + t * ey);
      }
      pushStripe(cx + rs * c, cy + rs * sn, cx + r1 * c, cy + r1 * sn);
    }
  }
  endGroup();
  return 0;
}

/** The alpha of the fill that stands in for the stripes of a summary that does not get them: their mean tone, stripes `STRIPE_PX` wide at
 *  alpha `a` (`summaryStripeOpacity`, dimming included) every `pitch` px (the distance they would have, see pushStripes), so a summary
 *  crossing a limit while zooming keeps its darkness. Drawn over the background fill, as the stripes are. */
export function stripeToneAlpha(a: number, pitch: number): number {
  return Math.min(1, (a * STRIPE_PX) / pitch);
}

/** Stroke the collected stripes in `colour` at alpha `a` (the dimming included), one stroke per summary, and empty the buffer. */
function strokeStripes(ctx: CanvasRenderingContext2D, colour: string, a: number): void {
  if (groupN === 0) return;
  ctx.strokeStyle = colour;
  ctx.lineCap = 'butt';
  ctx.lineWidth = STRIPE_PX;
  ctx.globalAlpha = a;
  for (let g = 0, j = 0; g < groupN; j = groupEnd[g++]) {
    ctx.beginPath();
    for (let c = 0; j < groupEnd[g]; j += 4) {
      ctx.moveTo(stripeBuf[j], stripeBuf[j + 1]);
      ctx.lineTo(stripeBuf[j + 2], stripeBuf[j + 3]);
      if (++c >= STROKE_CHUNK) {
        ctx.stroke();
        ctx.beginPath();
        c = 0;
      }
    }
    ctx.stroke();
  }
  stripeN = 0;
  groupN = 0;
}

/** Rectangular: add the shape of the summary whose extent `proj.summaryExtent` just set (node `i`) to the path: a band (`band`: a polytomy
 *  of tips or a run) or a triangle from the node, at least 2 px wide and 1.5 px tall. */
function rectSummaryShape(ctx: CanvasRenderingContext2D, proj: RectProjection, i: number, band: boolean): void {
  const sx = proj.d0,
    sy = proj.tip(i);
  let y0 = proj.t0,
    y1 = proj.t1;
  if (y1 - y0 < 1.5) {
    const m = (y0 + y1) / 2;
    y0 = m - 0.75;
    y1 = m + 0.75;
  }
  const xm = Math.max(sx + 2, proj.d1);
  if (band) {
    ctx.rect(sx, y0, xm - sx, y1 - y0);
    return;
  }
  ctx.moveTo(sx, sy);
  ctx.lineTo(xm, y0);
  ctx.lineTo(xm, y1);
  ctx.closePath();
}

/** Radial: add the shape of the summary whose extent `proj.summaryExtent` just set (node `i`) to the path: a ring segment (`band`) or a fan
 *  from the node (apex) to the clade's radius, the outer arc only where it is visibly curved, at least 1.5 px wide at its outer edge. */
export function fanSummaryShape(ctx: CanvasRenderingContext2D, proj: RadialProjection, i: number, band: boolean): void {
  const { cx, cy } = proj.T;
  let a0 = proj.t0,
    a1 = proj.t1;
  const r0 = proj.d0;
  const r1 = Math.max(r0 + 2, proj.d1);
  if ((a1 - a0) * r1 < 1.5) {
    const m = (a0 + a1) / 2,
      h = 0.75 / r1;
    a0 = m - h;
    a1 = m + h;
  } // keep slivers visible
  if (band) {
    // polytomy of tips: the ring segment between the node's depth and the longest tip, over the clade's angles. Far off, only its
    // visible angles (padded), with its edges as arcs, as the connectors do: a run reaches as far out of the window as its members (#77),
    // and a chord over all of them would cut inside the tips in view. A wrapped window (lo..2pi and 0..hi) can show both ends.
    if (r1 < RADIAL_FAR_ARC_R || proj.all) bandPiece(ctx, proj, r0, r1, a0, a1, false);
    else if (!proj.wrap) bandPiece(ctx, proj, r0, r1, Math.max(a0, proj.lo), Math.min(a1, proj.hi), true);
    else {
      bandPiece(ctx, proj, r0, r1, Math.max(a0, proj.lo), a1, true);
      bandPiece(ctx, proj, r0, r1, a0, Math.min(a1, proj.hi), true);
    }
    return;
  }
  ctx.moveTo(cx + r0 * proj.L.COS![i], cy + r0 * proj.L.SIN![i]);
  ctx.lineTo(cx + r1 * Math.cos(a0), cy + r1 * Math.sin(a0));
  const len = (a1 - a0) * r1;
  if (len * len > ARC_SAGITTA_K * r1 && r1 < RADIAL_FAR_ARC_R) ctx.arc(cx, cy, r1, a0, a1);
  else ctx.lineTo(cx + r1 * Math.cos(a1), cy + r1 * Math.sin(a1));
  ctx.closePath();
}

/** One ring segment of a band (see fanSummaryShape): radius r0..r1 over the angles a0..a1, nothing when a1 <= a0. An edge is an arc where
 *  it is visibly curved, if it is near (under RADIAL_FAR_ARC_R) or `far` (the angles are already cut to the window), else a straight line. */
function bandPiece(ctx: CanvasRenderingContext2D, proj: RadialProjection, r0: number, r1: number, a0: number, a1: number, far: boolean): void {
  if (!(a1 > a0)) return;
  const { cx, cy } = proj.T;
  const len0 = (a1 - a0) * r1;
  ctx.moveTo(cx + r0 * Math.cos(a0), cy + r0 * Math.sin(a0));
  ctx.lineTo(cx + r1 * Math.cos(a0), cy + r1 * Math.sin(a0));
  if (len0 * len0 > ARC_SAGITTA_K * r1 && (r1 < RADIAL_FAR_ARC_R || far)) ctx.arc(cx, cy, r1, a0, a1);
  else ctx.lineTo(cx + r1 * Math.cos(a1), cy + r1 * Math.sin(a1));
  ctx.lineTo(cx + r0 * Math.cos(a1), cy + r0 * Math.sin(a1));
  const len1 = (a1 - a0) * r0;
  if (len1 * len1 > ARC_SAGITTA_K * r0 && (r0 < RADIAL_FAR_ARC_R || far)) ctx.arc(cx, cy, r0, a1, a0, true);
  ctx.closePath();
}

/** Add the shape of summary entry `e` to the path (its extent is left in `proj.d0..t1`) and fill the path every `chunk` shapes. Returns the
 *  number of shapes now in the path. */
function addSummaryShape(ctx: CanvasRenderingContext2D, proj: LayoutProjection, list: DrawList, e: number, n: number, chunk: number): number {
  const i = list.node[e];
  const lm = list.last[e]; // run: from the parent's depth to the deepest member, over the members' rows (angles)
  const band = lm >= 0 || isSlice(proj.tree, i, proj.L.collapsed);
  proj.summaryExtent(i, lm, list.xmax[e]);
  if (proj.kind === 'rectangular') rectSummaryShape(ctx, proj, i, band);
  else fanSummaryShape(ctx, proj, i, band);
  if (++n < chunk) return n;
  ctx.fill();
  ctx.beginPath();
  return 0;
}

/** Fill the summaries listed in `toneBuf` with their stripes' mean tone (stripes at alpha `stripeA`), one fill per run of equal alphas
 *  (and per `chunk` shapes), and empty the list. */
function fillTones(ctx: CanvasRenderingContext2D, proj: LayoutProjection, list: DrawList, stripeA: number, chunk: number): void {
  let alpha = -1,
    n = 0;
  for (let k = 0; k < toneN; k++) {
    const a = stripeToneAlpha(stripeA, tonePitch[k]);
    if (a !== alpha) {
      if (n) ctx.fill();
      ctx.globalAlpha = alpha = a;
      ctx.beginPath();
      n = 0;
    }
    n = addSummaryShape(ctx, proj, list, toneBuf[k], n, chunk);
  }
  if (n) ctx.fill();
  toneN = 0;
}

/** The summaries of one (dimming pass, colour class), both layouts: the background fill of every summary in `colour` at `summaryOpacity`
 *  (fans in chunks of FILL_CHUNK shapes), then the stripe tone over the summaries that get no stripes, then the stripes. `dim` is 1, or
 *  `dimOpacity` on the dimmed pass. */
function drawSummaries(ctx: CanvasRenderingContext2D, S: Scene, pass: number, cls: number, colour: string, dim: number): void {
  const { list, theme, proj } = S;
  const passes = S.hlPrefix ? 2 : 1;
  const nCls = S.colours.length;
  const gap = theme.summaryStripeGap >= 1 ? theme.summaryStripeGap : 1; // at least 1 px: no stripe per tip
  const stripeA = theme.summaryStripeOpacity * dim;
  const chunk = proj.kind === 'rectangular' ? Infinity : FILL_CHUNK; // fans are filled in chunks (see FILL_CHUNK), triangles and bands at once
  ctx.fillStyle = colour;
  ctx.globalAlpha = theme.summaryOpacity * dim;
  ctx.beginPath();
  let n = 0;
  for (let e = 0; e < list.count; e++) {
    if (list.kind[e] !== K_SUMMARY || (nCls > 1 && list.cls[e] !== cls)) continue;
    if (passes > 1 && dimmed(S, e) !== pass) continue;
    n = addSummaryShape(ctx, proj, list, e, n, chunk);
    const lm = list.last[e];
    const pitch = pushStripes(proj, list.node[e], lm, lm >= 0 || isSlice(proj.tree, list.node[e], proj.L.collapsed), gap);
    if (pitch > 0) pushTone(e, pitch);
  }
  if (n) ctx.fill();
  if (toneN) fillTones(ctx, proj, list, stripeA, chunk);
  strokeStripes(ctx, colour, stripeA);
}

/** Branches and collapsed clades. Positions and clade extents come from the layout projection; what is drawn differs by layout
 *  (axis-aligned strokes and triangles vs arcs and fans), so each has its own loop. */
export function drawBody(ctx: CanvasRenderingContext2D, S: Scene, lineW: number): void {
  const proj = S.proj;
  if (proj.kind === 'radial') return drawBodyRadial(ctx, S, proj, lineW);
  const { list, colours, theme } = S;
  const { tree, L, T } = proj;
  const { firstChild } = tree;
  const { LAST } = L;
  const nCls = colours.length;
  const p: Pt = { x: 0, y: 0 },
    q: Pt = { x: 0, y: 0 };
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  const passes = S.hlPrefix ? 2 : 1; // second pass: the dimmed entries, at dimOpacity
  for (let pass = 0; pass < passes; pass++)
    for (let cls = 0; cls < nCls; cls++) {
      const col = cls === 0 ? theme.branch : colours[cls];
      ctx.strokeStyle = col;
      ctx.globalAlpha = pass ? theme.dimOpacity : 1;
      ctx.lineWidth = cls === 0 ? lineW : Math.max(lineW, theme.cladeBranchWidth);
      ctx.beginPath();
      let any = false;
      for (let e = 0; e < list.count; e++) {
        if (nCls > 1 && list.cls[e] !== cls) continue;
        if (passes > 1 && dimmed(S, e) !== pass) continue;
        any = true;
        if (list.last[e] >= 0) continue; // a run has no branch of its own (its members' branches lie inside the slice)
        const i = list.node[e];
        const kind = list.kind[e];
        proj.nodeXY(i, p);
        if (i > 0) {
          proj.parentXY(i, q);
          ctx.moveTo(q.x, p.y);
          ctx.lineTo(p.x, p.y);
        }
        if (kind === K_NODE) {
          ctx.moveTo(p.x, clampY(proj.tip(firstChild[i]), T.H));
          ctx.lineTo(p.x, clampY(proj.tip(LAST[i]), T.H));
        }
      }
      if (any) ctx.stroke();
    }
  // summaries: triangles (bands) from the node to the clade's extent
  for (let pass = 0; pass < passes; pass++)
    for (let cls = 0; cls < nCls; cls++) drawSummaries(ctx, S, pass, cls, cls === 0 ? theme.summary : colours[cls], pass ? theme.dimOpacity : 1);
  ctx.globalAlpha = 1;
}

/** Radial branches: one stroke() per colour class and 256 segments, connector arcs only where the arc differs from its
 *  chord by more than about 0.3 px (sagitta s^2/8r), long arcs of far-off clades clipped to the visible angles (the
 *  projection's window), summaries as filled fans. No trigonometry per node (cached cos/sin of the node angles). */
function drawBodyRadial(ctx: CanvasRenderingContext2D, S: Scene, proj: RadialProjection, lineW: number): void {
  const { list, colours, theme } = S;
  const { tree, L, T } = proj;
  const COS = L.COS!,
    SIN = L.SIN!;
  const { firstChild } = tree;
  const { LAST } = L;
  const { cx, cy } = T;
  const nCls = colours.length;
  const inv = 1 / S.scale;
  const p: Pt = { x: 0, y: 0 },
    q: Pt = { x: 0, y: 0 };
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'bevel';
  const passes = S.hlPrefix ? 2 : 1; // second pass: the dimmed entries, at dimOpacity
  for (let pass = 0; pass < passes; pass++)
    for (let cls = 0; cls < nCls; cls++) {
      ctx.strokeStyle = cls === 0 ? theme.branch : colours[cls];
      ctx.globalAlpha = pass ? theme.dimOpacity : 1;
      ctx.lineWidth = S.thin ? inv : cls === 0 ? lineW : Math.max(lineW, theme.cladeBranchWidth);
      ctx.beginPath();
      let segs = 0;
      for (let e = 0; e < list.count; e++) {
        if (nCls > 1 && list.cls[e] !== cls) continue;
        if (passes > 1 && dimmed(S, e) !== pass) continue;
        if (list.last[e] >= 0) continue; // run: no branch of its own
        const i = list.node[e];
        if (i > 0) {
          proj.parentXY(i, q);
          proj.nodeXY(i, p);
          ctx.moveTo(q.x, q.y);
          ctx.lineTo(p.x, p.y);
          segs++;
        }
        if (list.kind[e] === K_NODE) {
          const fc = firstChild[i],
            lc = LAST[i];
          const r = proj.depth(i);
          const len = proj.tipSpan(fc, lc) * r;
          ctx.moveTo(cx + r * COS[fc], cy + r * SIN[fc]);
          if (len * len <= ARC_SAGITTA_K * r) ctx.lineTo(cx + r * COS[lc], cy + r * SIN[lc]);
          else {
            let a0 = proj.tip(fc),
              a1 = proj.tip(lc);
            if (!proj.all && r > RADIAL_FAR_ARC_R) {
              // far-off clade: only the visible angles (padded), as one or two arcs; a wrapped window can show both ends
              if (proj.wrap) {
                if (a1 >= proj.lo) {
                  ctx.moveTo(cx + r * Math.cos(Math.max(a0, proj.lo)), cy + r * Math.sin(Math.max(a0, proj.lo)));
                  ctx.arc(cx, cy, r, Math.max(a0, proj.lo), a1);
                  segs++;
                }
                if (a0 <= proj.hi) {
                  ctx.moveTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
                  ctx.arc(cx, cy, r, a0, Math.min(a1, proj.hi));
                  segs++;
                }
              } else {
                a0 = Math.max(a0, proj.lo);
                a1 = Math.min(a1, proj.hi);
                if (a1 > a0) {
                  ctx.moveTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
                  ctx.arc(cx, cy, r, a0, a1);
                }
              }
            } else ctx.arc(cx, cy, r, a0, a1);
          }
          segs++;
        }
        if (segs >= STROKE_CHUNK) {
          ctx.stroke();
          ctx.beginPath();
          segs = 0;
        }
      }
      if (segs) ctx.stroke();
    }
  // summaries: fans (apex at the node, outer edge at the clade's radius) and ring segments
  for (let pass = 0; pass < passes; pass++)
    for (let cls = 0; cls < nCls; cls++) drawSummaries(ctx, S, pass, cls, cls === 0 ? theme.summary : colours[cls], pass ? theme.dimOpacity : 1);
  ctx.globalAlpha = 1;
}

/** Tip dots and internal node markers. Returns nothing; positions are recomputed by hit-testing. */
export function drawMarkers(ctx: CanvasRenderingContext2D, S: Scene): void {
  const { proj, list, theme, colours } = S;
  const p: Pt = { x: 0, y: 0 };
  const tipPx = proj.tipPitch;
  const dots = tipPx >= TIP_DOT_PX;
  const rTip = Math.min(theme.tipRadius, Math.max(Math.min(1.5, theme.tipRadius), tipPx * 0.25));
  const m = theme.nodeMarkerSize;
  // internal markers: small filled squares (cheap), only for clades big enough to click
  const passes = S.hlPrefix ? 2 : 1; // second pass: the dimmed entries, at dimOpacity
  for (let pass = 0; pass < passes; pass++)
    for (let cls = 0; cls < colours.length; cls++) {
      ctx.globalAlpha = pass ? theme.markerOpacity * theme.dimOpacity : theme.markerOpacity;
      ctx.fillStyle = cls === 0 ? theme.branch : colours[cls];
      ctx.beginPath();
      let any = false;
      for (let e = 0; e < list.count; e++) {
        if (list.cls[e] !== cls) continue;
        if (passes > 1 && dimmed(S, e) !== pass) continue;
        const kind = list.kind[e];
        const i = list.node[e];
        if (kind === K_TIP) {
          if (!dots) continue;
          proj.nodeXY(i, p);
          ctx.moveTo(p.x + rTip, p.y);
          ctx.arc(p.x, p.y, rTip, 0, 6.2832);
          any = true;
        } else if (kind === K_NODE) {
          if (proj.cladeSize(i) < MARKER_PX) continue;
          proj.nodeXY(i, p);
          ctx.rect(p.x - m / 2, p.y - m / 2, m, m);
          any = true;
        }
      }
      if (any) ctx.fill();
    }
  ctx.globalAlpha = 1;
}

export function drawHighlights(ctx: CanvasRenderingContext2D, S: Scene, rightEdge: number): void {
  const { proj, theme, hlRanks } = S;
  const T = proj.T;
  if (!hlRanks.length) return;
  const rect = proj.kind === 'rectangular';
  const p: Pt = { x: 0, y: 0 };
  // The canvas calls are bounded by pixels, not by matches (#58): at the fit view of a large tree thousands of matched rows share a
  // pixel. First the bands, then the rings (one path, a ring skipped when it lands within a pixel of the one before).
  ctx.fillStyle = theme.highlight;
  ctx.strokeStyle = theme.highlight;
  ctx.globalAlpha = theme.highlightOpacity;
  // rectangular: the rows grow with k, so only the matches on the rows in view are visited
  const k0 = rect ? firstAtRow(S, Math.floor((T.clipT - T.oy) / T.ky) - 1) : 0;
  const k1 = rect ? firstAtRow(S, Math.ceil((T.clipB - T.oy) / T.ky) + 1) : hlRanks.length;
  if (rect) drawBandRuns(ctx, S, k0, k1, rightEdge);
  else drawRays(ctx, S, p);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2;
  ctx.beginPath();
  let lastX = NaN,
    lastY = NaN;
  for (let k = k0; k < k1; k++) {
    const node = highlightNode(S, k);
    if (node < 0) continue;
    proj.nodeXY(node, p);
    if (!rect && (p.x < -20 || p.y < -20 || p.x > T.W + 20 || p.y > T.H + 20)) continue;
    if (Math.abs(p.x - lastX) < 1 && Math.abs(p.y - lastY) < 1) continue;
    lastX = p.x;
    lastY = p.y;
    ctx.moveTo(p.x + 7, p.y);
    ctx.arc(p.x, p.y, 7, 0, 6.2832);
  }
  ctx.stroke();
}

/** The rectangular bands of the matches k0..k1-1: bands that overlap (rows under 3 px apart) are merged into one fillRect per run. */
function drawBandRuns(ctx: CanvasRenderingContext2D, S: Scene, k0: number, k1: number, rightEdge: number): void {
  const T = S.proj.T;
  const h = Math.max(3, T.ky);
  let runTop = 0,
    runBot = -Infinity;
  for (let k = k0; k < k1; k++) {
    if (highlightNode(S, k) < 0) continue;
    const top = T.oy + tipRow(S, k) * T.ky + T.ky / 2 - h / 2;
    if (top >= runBot) {
      if (runBot > runTop) ctx.fillRect(0, runTop, rightEdge, runBot - runTop);
      runTop = top;
    }
    runBot = top + h;
  }
  if (runBot > runTop) ctx.fillRect(0, runTop, rightEdge, runBot - runTop);
}

/** The radial bands: a ray from the centre past each matched tip, skipped when it ends within a pixel of the one before and is no
 *  wider. `p` is scratch. */
function drawRays(ctx: CanvasRenderingContext2D, S: Scene, p: Pt): void {
  const { proj } = S;
  const { L, T } = proj;
  let lastX = NaN,
    lastY = NaN,
    lastW = 0;
  for (let k = 0; k < S.hlRanks.length; k++) {
    const node = highlightNode(S, k);
    if (node < 0) continue;
    proj.nodeXY(node, p);
    if (p.x < -20 || p.y < -20 || p.x > T.W + 20 || p.y > T.H + 20) continue;
    const a = proj.tip(node);
    const w = Math.max(3, T.da * L.X[node] * T.k);
    const ex = T.cx + 1.15 * T.k * Math.cos(a),
      ey = T.cy + 1.15 * T.k * Math.sin(a);
    if (Math.abs(ex - lastX) < 1 && Math.abs(ey - lastY) < 1 && w <= lastW) continue;
    lastX = ex;
    lastY = ey;
    lastW = w;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(T.cx, T.cy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
}

/** The first k whose row is at least `row` (the highlighted ranks are sorted, and rows grow with ranks). */
function firstAtRow(S: Scene, row: number): number {
  let lo = 0,
    hi = S.hlRanks.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (tipRow(S, m) < row) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** The row of the k-th highlighted rank. */
function tipRow(S: Scene, k: number): number {
  const r = S.hlRanks[k];
  const rowOfRank = S.proj.L.rowOfRank;
  return rowOfRank ? rowOfRank[r] : r;
}

/** The node to mark for the k-th highlighted rank, or -1 to skip it: tips below a collapsed clade are marked once, on the clade's row
 *  and at its apex (the ranks are sorted, so a row's are adjacent), and in the rectangular layout a row outside the clip is skipped. */
function highlightNode(S: Scene, k: number): number {
  const { tree, L, T } = S.proj;
  const row = tipRow(S, k);
  if (L.rowOfRank && k > 0 && tipRow(S, k - 1) === row) return -1;
  if (S.proj.kind === 'rectangular') {
    const y = T.oy + row * T.ky;
    if (y + T.ky < T.clipT || y > T.clipB) return -1;
  }
  return L.rowNode ? L.rowNode[row] : tree.tipNode[S.hlRanks[k]];
}

export function drawRing(ctx: CanvasRenderingContext2D, proj: LayoutProjection, node: number, radius: number, colour: string, width: number): void {
  if (node < 0) return;
  const p: Pt = { x: 0, y: 0 };
  proj.nodeXY(node, p);
  if (p.x < -20 || p.y < -20 || p.x > proj.T.W + 20 || p.y > proj.T.H + 20) return;
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, 6.2832);
  ctx.stroke();
}

/** The ring of the selected node (row `node`): `selectionColour` ('' = `foreground`) `selectionWidth` px wide at `selectionRadius`, over a
 *  halo of the background 2 px wider, so it reads over branches and is told apart from the hover and keyboard rings. */
export function drawSelectionRing(ctx: CanvasRenderingContext2D, proj: LayoutProjection, node: number, theme: TreeTheme): void {
  const w = theme.selectionWidth;
  if (!(w > 0)) return;
  drawRing(ctx, proj, node, theme.selectionRadius, theme.background, w + 2);
  drawRing(ctx, proj, node, theme.selectionRadius, theme.selectionColour || theme.foreground, w);
}

/** The rings of the marked nodes (`rows`, rows of the snapshot; -1 is skipped): `markColour` ('' = `highlight`) `markWidth` px wide at
 *  `markRadius`, dashed as `markDash`, over a solid halo of the background 2 px wider. One path per pass, whatever the number of marks. */
export function drawMarkRings(ctx: CanvasRenderingContext2D, proj: LayoutProjection, rows: Int32Array, theme: TreeTheme): void {
  const w = theme.markWidth;
  if (!(w > 0) || rows.length === 0) return;
  const r = theme.markRadius;
  const p: Pt = { x: 0, y: 0 };
  const W = proj.T.W,
    H = proj.T.H;
  for (let pass = 0; pass < 2; pass++) {
    ctx.beginPath();
    let n = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] < 0) continue;
      proj.nodeXY(rows[i], p);
      if (p.x < -r || p.y < -r || p.x > W + r || p.y > H + r) continue;
      ctx.moveTo(p.x + r, p.y);
      ctx.arc(p.x, p.y, r, 0, 6.2832);
      n++;
    }
    if (n === 0) return;
    ctx.setLineDash(pass === 0 ? [] : dashOf(theme.markDash));
    ctx.strokeStyle = pass === 0 ? theme.background : theme.markColour || theme.highlight;
    ctx.lineWidth = pass === 0 ? w + 2 : w;
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

/** The polyline of `drawRootPath`, drawn as it is walked: corners less than a pixel from the last one drawn are merged into the next, and
 *  a stretch with both ends beyond one side of the box (x0..x1 x y0..y1) is skipped, so the canvas calls are about one per pixel of path on
 *  screen whatever the depth (a 100k-level caterpillar at the fit view: about 1,100). `x` / `y` is where the path is now (drawn or not), `pend` that it has not been drawn yet, `pen` that the canvas's current point
 *  is the last corner drawn. */
class RootPathPen {
  x = 0;
  y = 0;
  private lx = 0;
  private ly = 0;
  private pen = false;
  private pend = false;
  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly x0: number,
    private readonly y0: number,
    private readonly x1: number,
    private readonly y1: number,
  ) {}
  start(x: number, y: number): void {
    this.x = this.lx = x;
    this.y = this.ly = y;
    this.pen = this.pend = false;
  }
  to(x: number, y: number): void {
    const { lx, ly } = this;
    this.x = x;
    this.y = y;
    if ((lx < this.x0 && x < this.x0) || (lx > this.x1 && x > this.x1) || (ly < this.y0 && y < this.y0) || (ly > this.y1 && y > this.y1)) {
      this.start(x, y); // out of view: the next stretch in view starts here
      return;
    }
    if (!this.pen) this.ctx.moveTo(lx, ly);
    this.pen = true;
    if (Math.abs(x - lx) < 1 && Math.abs(y - ly) < 1) {
      this.pend = true;
      return;
    }
    this.ctx.lineTo(x, y);
    this.lx = x;
    this.ly = y;
    this.pend = false;
  }
  /** Draw up to where the path is now (before an arc, and at the end). */
  flush(): void {
    if (this.pend) this.ctx.lineTo(this.x, this.y);
    this.lx = this.x;
    this.ly = this.y;
    this.pend = false;
  }
}

/** The path from row `node` up to the root (the hover path, #40): every ancestor's branch and its part of the parent's connector, as one
 *  stroke in `hoverPathColour` ('' = `highlight`), `hoverPathWidth` px wide (0 = none). Straight from `parent[]`, no allocation per node;
 *  the walk is O(depth), the canvas calls are bounded by what is on screen (see RootPathPen). Radial connectors are arcs where they are
 *  visibly curved and their circle crosses the view; far-off ones are clipped to the visible angles, as the branches are. */
export function drawRootPath(ctx: CanvasRenderingContext2D, proj: LayoutProjection, node: number, theme: TreeTheme): void {
  const w = theme.hoverPathWidth;
  if (!(w > 0) || node < 0) return;
  const { T } = proj;
  const parent = proj.tree.parent;
  const rect = proj.kind === 'rectangular';
  const pad = w + 2;
  // the tree's clip of the main canvas (rect: not over the axis or the columns)
  const cx0 = 0,
    cy0 = rect ? T.clipT - 6 : 0,
    cx1 = rect ? T.clipR : T.W,
    cy1 = rect ? T.clipB + 6 : T.H;
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx0, cy0, cx1 - cx0, cy1 - cy0);
  ctx.clip();
  ctx.strokeStyle = theme.hoverPathColour || theme.highlight;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  const pen = new RootPathPen(ctx, cx0 - pad, cy0 - pad, cx1 + pad, cy1 + pad);
  const p: Pt = { x: 0, y: 0 };
  proj.nodeXY(node, p);
  pen.start(p.x, rect ? clampY(p.y, T.H) : p.y);
  for (let i = node; i > 0; i = parent[i]) {
    proj.parentXY(i, p);
    if (rect) {
      pen.to(p.x, clampY(p.y, T.H)); // the branch
      pen.to(p.x, clampY(proj.tip(parent[i]), T.H)); // the connector, to the parent
    } else {
      pen.to(p.x, p.y);
      rootPathArc(ctx, proj, pen, i, parent[i], pad, p);
    }
  }
  pen.flush();
  ctx.stroke();
  ctx.restore();
}

/** Radial: the connector of `drawRootPath` from child `i` (the pen is at its branch's start) to its parent `pa`, at the parent's radius. A
 *  connector shorter than a pixel, or one differing from its chord by under 0.3 px, is a straight corner of the pen; one whose circle is
 *  out of view only moves the pen. */
function rootPathArc(ctx: CanvasRenderingContext2D, proj: RadialProjection, pen: RootPathPen, i: number, pa: number, pad: number, p: Pt): void {
  const r = proj.depth(pa);
  const a0 = proj.tip(i),
    a1 = proj.tip(pa);
  const len = Math.abs(a1 - a0) * r;
  proj.nodeXY(pa, p);
  if (len < 1 || len * len <= ARC_SAGITTA_K * r) return pen.to(p.x, p.y);
  if (r < proj.rMin - pad || r > proj.rMax + pad) return pen.start(p.x, p.y);
  pen.flush();
  const lo = Math.min(a0, a1),
    hi = Math.max(a0, a1);
  if (proj.all || r <= RADIAL_FAR_ARC_R) arcPiece(ctx, proj, r, lo, hi);
  else if (!proj.wrap) arcPiece(ctx, proj, r, Math.max(lo, proj.lo), Math.min(hi, proj.hi));
  else {
    // far off: only the visible angles; a wrapped window (lo..2pi and 0..hi) can show both ends
    arcPiece(ctx, proj, r, Math.max(lo, proj.lo), hi);
    arcPiece(ctx, proj, r, lo, Math.min(hi, proj.hi));
  }
  pen.start(p.x, p.y);
}

function arcPiece(ctx: CanvasRenderingContext2D, proj: RadialProjection, r: number, a0: number, a1: number): void {
  if (!(a1 > a0)) return;
  const { cx, cy } = proj.T;
  ctx.moveTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
  ctx.arc(cx, cy, r, a0, a1);
}

/** Where aligned labels start (CSS px, before the gap): right of the farthest tip (a collapsed clade's triangle ends at its tips, so it
 *  is never farther), so all labels share one x. Zoomed in on x so far that the farthest tip is right of the plot area, the column is pinned
 *  at the area's right edge (where the farthest tip is at the fit view): the labels stay readable, and the branches of the tips beyond it
 *  run on under the text. NaN when labels are not aligned: the option is off, or the layout has no tips that end at
 *  different x (radial, cladogram, tree without lengths). */
export function alignedX(S: Scene): number {
  const { proj } = S;
  if (!S.alignLabels || proj.kind !== 'rectangular' || !proj.L.usedLengths) return NaN;
  const { T, L } = proj;
  return Math.min(T.ox + L.XMAX[0] * T.kx, T.area.ax + T.area.aw);
}

/** Radial phylogram: the radius (px) of the circle aligned labels start on (before the gap): the outermost tip's (a collapsed clade's
 *  triangle ends at its tips, so it is never farther), so all labels share one circle. Zoomed in so far that the furthest visible radius
 *  (from the root to the farthest corner of the plot) is less than that plus `labelRoom`, the circle is pinned at the furthest visible
 *  radius less `labelRoom`: the labels of the tips in view stay readable, and the branches of the tips beyond it run on under the text.
 *  NaN when labels are not aligned: the option is off, or the layout is rectangular or has no tips that end at different radii
 *  (cladogram, tree without lengths). */
export function alignedR(S: Scene): number {
  const { proj } = S;
  if (!S.alignLabels || proj.kind !== 'radial' || !proj.L.usedLengths) return NaN;
  const { T } = proj;
  const far = Math.hypot(Math.max(Math.abs(T.cx - T.clipL), Math.abs(T.cx - T.clipR)), Math.max(Math.abs(T.cy - T.clipT), Math.abs(T.cy - T.clipB)));
  return Math.min(proj.L.XMAX[0] * T.k, Math.max(0, far - S.labelRoom));
}

/** Distance (px) between neighbouring labels, for the density rule: the tip pitch, or with radial aligned labels (`ar`, see alignedR) the
 *  arc between neighbouring tips on their circle (smaller than the tip pitch when the circle is pinned). */
function labelPitch(S: Scene, ar: number): number {
  return Number.isNaN(ar) ? S.proj.tipPitch : S.proj.T.da * ar;
}

/** Draw-list entry `e` is a clade the app collapsed (a summary of its own, not a run and not a clade the level of detail summarised). */
function isCollapsedEntry(S: Scene, e: number): boolean {
  const c = S.proj.L.collapsed;
  return c !== null && S.list.kind[e] === K_SUMMARY && S.list.last[e] < 0 && c[S.list.node[e]] === 1;
}

/** Some tip of the clade at row `i` is highlighted (band mode: `hlRanks`; dim mode: the prefix sums). */
function holdsHighlight(S: Scene, i: number): boolean {
  const t = S.proj.tree;
  if (S.hlPrefix !== null) {
    const n = S.hlPrefix.length - 1;
    return S.hlPrefix[Math.min(t.leafEnd[i], n)] - S.hlPrefix[Math.min(t.leafStart[i], n)] > 0;
  }
  const hr = S.hlRanks;
  let lo = 0,
    hi = hr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (hr[m] < t.leafStart[i]) lo = m + 1;
    else hi = m;
  }
  return lo < hr.length && hr[lo] < t.leafEnd[i];
}

/** Where draw-list entry `e` is labelled from, into `p`: a tip's dot, or the outer edge of a collapsed clade's triangle on its row. */
function labelAnchor(S: Scene, e: number, collapsed: boolean, p: Pt): void {
  const { proj } = S;
  const i = S.list.node[e];
  if (!collapsed) return proj.nodeXY(i, p);
  proj.summaryExtent(i, -1, 0);
  const d = Math.max(proj.d0 + 2, proj.d1);
  if (proj.kind === 'rectangular') {
    p.x = d;
    p.y = proj.tip(i);
  } else {
    p.x = proj.T.cx + d * proj.L.COS![i];
    p.y = proj.T.cy + d * proj.L.SIN![i];
  }
}

/** The rectangular label of the tip at (x, y) is not drawn: its row is out of view, or (aligned) the column is. */
function labelCulled(T: Scene['proj']['T'], x: number, y: number, ax: number): boolean {
  return y < T.clipT - 4 || y > T.clipB + 4 || (Number.isNaN(ax) ? x > T.clipR : ax + LABEL_GAP_PX > T.clipR);
}

/** Radial: the label of row `i` anchored at `p` (its tip, or the end of a collapsed clade's triangle) is not drawn, as where its text
 *  starts is far out of view. Aligned (`ar` not NaN, see alignedR), `p` is first moved along the ray onto the labels' circle. */
function radialLabelCulled(S: Scene, i: number, ar: number, p: Pt): boolean {
  const { L, T } = S.proj;
  if (!Number.isNaN(ar)) {
    p.x = T.cx + ar * L.COS![i];
    p.y = T.cy + ar * L.SIN![i];
  }
  return p.x < -50 || p.y < -50 || p.x > T.W + 50 || p.y > T.H + 50;
}

/** The leader of draw-list entry `e` (`col`: a collapsed clade): from `a`, just before the label (rectangular: in the column `ax`; radial:
 *  on the circle `ar`, along the ray), to `b`, the tip or the end of the clade's triangle. 0: the label is culled, so no leader; 1: the
 *  label is drawn but there is nothing to lead over (the tip is at or past the label, which is pinned); 2: a leader from a to b. */
function leaderOf(S: Scene, e: number, col: boolean, ax: number, ar: number, a: Pt, b: Pt): number {
  const { proj } = S;
  labelAnchor(S, e, col, b);
  if (proj.kind === 'rectangular') {
    if (labelCulled(proj.T, b.x, b.y, ax)) return 0;
    a.x = ax + LABEL_GAP_PX - LEADER_END_GAP_PX;
    a.y = b.y;
    return b.x < a.x ? 2 : 1;
  }
  const { L, T } = proj;
  const i = S.list.node[e];
  a.x = b.x;
  a.y = b.y;
  if (radialLabelCulled(S, i, ar, a)) return 0;
  const r = ar + LABEL_GAP_PX - LEADER_END_GAP_PX;
  if (Math.hypot(b.x - T.cx, b.y - T.cy) >= r) return 1;
  a.x = T.cx + r * L.COS![i];
  a.y = T.cy + r * L.SIN![i];
  return 2;
}

/** Aligned labels are drawn this frame (in the rectangular column `ax` or on the radial circle `ar`): labels are aligned and their rows
 *  (arcs) are far enough apart for the label density. */
function alignedLabelsShown(S: Scene, ax: number, ar: number): boolean {
  if (Number.isNaN(ax) && Number.isNaN(ar)) return false;
  return labelPitch(S, ar) >= labelMinPx(S.density, S.theme.labelSize);
}

/** Leader lines of aligned labels: a dotted line from each tip (from the end of the triangle of a collapsed clade) to just before its label,
 *  rectangular along the row, radial along the ray. Drawn for the tips that get a label (same density rule, cap and culling as drawLabels),
 *  below the dots. Dimmed tips' leaders are drawn at dimOpacity. Batched into one path per chunk, as the branches are. */
export function drawLeaders(ctx: CanvasRenderingContext2D, S: Scene): void {
  const ax = alignedX(S),
    ar = alignedR(S);
  if (!alignedLabelsShown(S, ax, ar)) return;
  const { proj, list, theme } = S;
  const hasCollapsed = S.cladeText !== null && proj.L.collapsed !== null; // collapsed clades are labelled
  const maxL = proj.kind === 'rectangular' ? MAX_RECT_LABELS : RADIAL_LABEL_CAP;
  const a: Pt = { x: 0, y: 0 },
    b: Pt = { x: 0, y: 0 };
  ctx.strokeStyle = theme.leaderColour || theme.muted;
  ctx.lineWidth = theme.leaderWidth;
  ctx.setLineDash(dashOf(theme.leaderDash));
  const passes = S.hlPrefix ? 2 : 1; // second pass: the dimmed entries
  for (let pass = 0; pass < passes; pass++) {
    ctx.globalAlpha = pass ? theme.leaderOpacity * theme.dimOpacity : theme.leaderOpacity;
    ctx.beginPath();
    let n = 0,
      labelled = 0;
    for (let e = 0; e < list.count && labelled < maxL; e++) {
      const col = list.kind[e] !== K_TIP;
      if (col && !(hasCollapsed && isCollapsedEntry(S, e))) continue;
      const got = leaderOf(S, e, col, ax, ar, a, b);
      if (got === 0) continue;
      labelled++;
      if (got === 1 || (passes > 1 && dimmed(S, e) !== pass)) continue;
      ctx.moveTo(a.x, a.y); // from the label back to the tip, so the dash pattern lines up at the labels
      ctx.lineTo(b.x, b.y);
      if (++n >= STROKE_CHUNK) {
        ctx.stroke();
        ctx.beginPath();
        n = 0;
      }
    }
    if (n) ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/** The dash pattern of a `leaderDash` or `markDash` token: numbers separated by spaces or commas; nothing usable = solid. */
function dashOf(v: string): number[] {
  const out: number[] = [];
  for (const s of v.split(/[\s,]+/)) {
    const n = parseFloat(s);
    if (Number.isFinite(n) && n >= 0) out.push(n);
  }
  return out.some((n) => n > 0) ? out : [];
}

/** Tip labels for drawn tips when rows (or arcs) are tall enough. Fills `labels` for hit-testing and the overlay.
 *  Aligned (`alignLabels`, a phylogram): rectangular, the text starts in one column (alignedX); radial, on one circle (alignedR), still
 *  along the tip's ray. Radial: only when the angular pitch per tip is at least the font size, at most RADIAL_LABEL_CAP labels, and one
 *  setTransform per label instead of save/translate/rotate/restore (cos/sin come from the layout cache). */
export function drawLabels(ctx: CanvasRenderingContext2D, S: Scene, labels: LabelList): void {
  const { proj, list, theme, classOf, colours, highlight } = S;
  const { tree, L, T } = proj;
  labels.clear();
  const rect = proj.kind === 'rectangular';
  const ax = alignedX(S); // NaN: labels follow their tips
  const ar = alignedR(S);
  const pitch = labelPitch(S, ar);
  const need = labelMinPx(S.density, S.theme.labelSize);
  if (pitch < need) return;
  const hasCollapsed = S.cladeText !== null && L.collapsed !== null; // collapsed clades are labelled
  const size = Math.max(8, Math.min(theme.labelSize, Math.round(pitch * 0.78)));
  const style = theme.labelFontStyle === 'italic' ? 'italic ' : '';
  const fontN = `${style}${size}px ${theme.fontFamily}`;
  const fontH = `${style}600 ${size}px ${theme.fontFamily}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const p: Pt = { x: 0, y: 0 };
  const MAXL = rect ? MAX_RECT_LABELS : RADIAL_LABEL_CAP;
  const sc = S.scale;
  let lastFont = '';
  let lastFill = '';
  let lastAlign = 'left';
  let lastAlpha = 1;
  for (let e = 0; e < list.count && labels.count < MAXL; e++) {
    const col = list.kind[e] !== K_TIP; // a collapsed clade is labelled like a tip, at the end of its triangle
    if (col && !(hasCollapsed && isCollapsedEntry(S, e))) continue;
    const i = list.node[e];
    const r = col ? -1 : tree.tipRank[i];
    labelAnchor(S, e, col, p);
    if (rect ? labelCulled(T, p.x, p.y, ax) : radialLabelCulled(S, i, ar, p)) continue; // radial aligned: p is now on the circle
    const hl = col ? highlight !== null && holdsHighlight(S, i) : highlight ? highlight[r] === 1 : false;
    const f = hl ? fontH : fontN;
    if (f !== lastFont) {
      ctx.font = f;
      lastFont = f;
    }
    const text = col ? S.cladeText!(i) : S.format(tree.tipLabels[r] ?? '');
    const w = S.measure.width(ctx, text, f);
    if (f !== lastFont) {
      ctx.font = f;
      lastFont = f;
    } // measure.width may have set the font
    const cl = classOf ? classOf[i] : 0;
    const fill = hl ? theme.highlight : cl ? colours[cl] : theme.foreground;
    if (fill !== lastFill) {
      ctx.fillStyle = fill;
      lastFill = fill;
    }
    const alpha = S.hlPrefix && (col ? dimmed(S, e) === 1 : S.hlPrefix[r + 1] === S.hlPrefix[r]) ? theme.dimOpacity : 1;
    if (alpha !== lastAlpha) {
      ctx.globalAlpha = alpha;
      lastAlpha = alpha;
    }
    // aligned: the text starts at the column (the circle), which is right of (outside) every tip and every triangle, unless pinned
    const gap = LABEL_GAP_PX;
    const key = col ? -(i + 1) : r;
    if (rect) {
      const x = Number.isNaN(ax) ? p.x + gap : ax + gap;
      ctx.fillText(text, x, p.y + 0.5);
      labels.add(key, x, p.y, w, size + 2, 0, 0, gap);
    } else {
      const left = L.COS![i] < 0;
      const c = left ? -L.COS![i] : L.COS![i],
        sn = left ? -L.SIN![i] : L.SIN![i];
      ctx.setTransform(sc * c, sc * sn, -sc * sn, sc * c, sc * p.x, sc * p.y);
      const al = left ? 'right' : 'left';
      if (al !== lastAlign) {
        ctx.textAlign = al;
        lastAlign = al;
      }
      ctx.fillText(text, left ? -gap : gap, 0.5);
      const a = proj.tip(i);
      labels.add(key, p.x, p.y, w, size + 2, left ? a + Math.PI : a, left ? 1 : 0, gap);
    }
  }
  if (!rect) ctx.setTransform(sc, 0, 0, sc, 0, 0);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------------------------------ node labels

const NODE_LABEL_GAP_PX = 3; // a support value ends this far left of its node
const NODE_LABEL_PAD_PX = 3; // free space the text keeps on each side within its branch (at least the node marker's radius + 1, see `pad`)
const NODE_LABEL_LIFT_PX = 2; // from the branch line up to the text's baseline
const NODE_LABEL_MIN_SEG_PX = 10; // a branch shorter than this is not looked at (no digit fits)

/** The text of the internal node at snapshot row `row`, or null for none. 'support' reads the snapshot's `support` array when it has one
 *  (else the numeric prefix of the label), 'length' its `length`; a function gets the node's full-tree id. A value that is not finite
 *  gives none. */
function nodeText(S: Scene, row: number): string | null {
  const t = S.proj.tree;
  const mode = S.nodeLabels;
  if (mode === 'support' || mode === 'length') {
    const v = mode === 'length' ? t.length[row] : t.support ? t.support[row] : internalSupport(t.labels[row] ?? '');
    return Number.isFinite(v) ? S.formatNode(v, mode) : null;
  }
  if (mode === 'none') return null;
  const r = mode(t.globalId === null ? row : t.globalId[row], t);
  if (typeof r === 'number') return Number.isFinite(r) ? S.formatNode(r, 'support') : null;
  return r ? r : null;
}

/** Draw-list entry `e` can get a node label: in the tip pass a tip, else an expanded internal node (not a run), a clade the app collapsed,
 *  or, when `stubs` (a length, rectangular), a stub: it is drawn as its branch only, and when its node is right of the plot (checked by the
 *  caller) the visible part of a long stem still holds a length, the same as it did while the node was a pixel nearer. */
function nodeLabelled(S: Scene, e: number, tips: boolean, stubs: boolean): boolean {
  const kind = S.list.kind[e];
  if (tips) return kind === K_TIP;
  if (kind === K_NODE) return S.list.last[e] < 0;
  return isCollapsedEntry(S, e) || (stubs && kind === K_STUB);
}

/** Radial: the room across the branch of draw-list entry `i` of kind `kind` (`r1` its radius, `room` its length; px). An expanded node:
 *  its arc at its radius. A tip: one row's angle at the middle of its branch, where its label sits (the frame's tipPitch is the angle at
 *  the outer radius, too wide for a tip near the centre). A collapsed clade or a stub: not limited. */
function acrossPx(proj: RadialProjection, kind: number, i: number, r1: number, room: number): number {
  if (kind === K_TIP) return proj.T.da * (r1 - room / 2);
  if (kind !== K_NODE) return Infinity;
  return proj.tipSpan(proj.tree.firstChild[i], proj.L.LAST[i]) * r1;
}

/** Node labels (`nodeLabels`) for the nodes of the draw list, which are expanded nodes, collapsed clades (on their own stem) and tips, so
 *  never a node inside a summary, a run or a collapsed clade. Shown only with room, by the label-density rule of tip labels: rectangular, tip rows at least `labelMinPx` (scaled with the theme's `labelSize`) apart
 *  and the text fits the visible part of the node's horizontal segment; radial, the node's arc at least that long and the text fits the
 *  branch. Support sits left of the node above its branch; a length is centred on the branch (radial: rotated along it, upright on the
 *  left half like tip labels). A length is placed by one rule at every zoom: centred on the visible part of its branch (rectangular; the
 *  whole branch, radial) if the text plus `pad` on both sides fits there, else not drawn (there is no placement at the node). Tips get a
 *  length by the same rule (their tip label is right of the tip, so the branch is free) once tip rows are far enough apart for tip labels;
 *  support and a function's text stay on internal nodes. The root has no branch and no label. At most MAX_RECT_LABELS (RADIAL_LABEL_CAP)
 *  labels, found by one pass over the draw list for the internal nodes and then one for the tips, so tips never use up the cap before the
 *  internal branches are labelled; the text is made only after the cheap geometry tests. */
export function drawNodeLabels(ctx: CanvasRenderingContext2D, S: Scene): void {
  const mode = S.nodeLabels;
  if (mode === 'none') return;
  const { proj, list, theme } = S;
  const { tree, L, T } = proj;
  const rect = proj.kind === 'rectangular';
  const need = labelMinPx(S.density, theme.labelSize);
  if (rect && proj.tipPitch < need) return;
  const size = Math.max(8, Math.min(theme.nodeLabelSize, rect ? Math.round(proj.tipPitch * 0.78) : Infinity));
  const font = `${size}px ${theme.fontFamily}`;
  ctx.font = font;
  ctx.textBaseline = 'bottom';
  const maxN = rect ? MAX_RECT_LABELS : RADIAL_LABEL_CAP;
  const sc = S.scale;
  const centred = mode === 'length'; // a function's text is placed and coloured like support
  const gap = Math.max(NODE_LABEL_GAP_PX, theme.nodeMarkerSize / 2 + 1); // a support value clears the node's marker
  const pad = Math.max(NODE_LABEL_PAD_PX, theme.nodeMarkerSize / 2 + 1); // a length keeps clear of the node marker at one end and the connector at the other
  const fit = centred ? 2 * pad : gap + NODE_LABEL_PAD_PX; // the room a label needs besides its text
  const fitTip = 2 * Math.max(pad, theme.tipRadius + 1); // a tip's length (the only label of a tip) keeps clear of the tip dot too
  const colSupport = theme.supportColour || theme.muted,
    colLength = theme.lengthColour || theme.muted;
  const p: Pt = { x: 0, y: 0 },
    q: Pt = { x: 0, y: 0 };
  const { parent } = tree;
  let n = 0;
  let lastFill = '';
  let lastAlpha = 1;
  let lastAlign = '';
  const passes = centred && proj.tipPitch >= need ? 2 : 1; // the second pass labels tip branches with their length
  for (let pass = 0; pass < passes; pass++)
    for (let e = 0; e < list.count && n < maxN; e++) {
      if (!nodeLabelled(S, e, pass === 1, centred && rect)) continue;
      const kind = list.kind[e];
      const i = list.node[e];
      if (i === 0) continue;
      let x0 = 0, // rectangular: the visible part of the segment; radial: the label's origin
        y0 = 0,
        room = 0,
        c = 1,
        sn = 0;
      proj.nodeXY(i, p);
      if (rect) {
        if (kind === K_STUB && p.x <= T.clipR) continue; // a clade cut by size, not one pushed out of view
        proj.parentXY(i, q);
        if (p.y < T.clipT - 4 || p.y > T.clipB + 4 || p.x < T.clipL || q.x > T.clipR) continue;
        x0 = Math.max(q.x, T.clipL);
        room = (centred ? Math.min(p.x, T.clipR) : p.x) - x0;
        if (!centred && p.x > T.clipR) continue; // the node is out of view: its support would float in the air
        y0 = p.y - NODE_LABEL_LIFT_PX;
      } else {
        const r1 = proj.depth(i);
        room = r1 - proj.depth(parent[i]);
        if (room < NODE_LABEL_MIN_SEG_PX || acrossPx(proj, kind, i, r1, room) < need) continue; // no room along the branch or across
        c = L.COS![i];
        sn = L.SIN![i];
        x0 = centred ? p.x - (c * room) / 2 : p.x;
        y0 = centred ? p.y - (sn * room) / 2 : p.y;
        if (x0 < -20 || y0 < -20 || x0 > T.W + 20 || y0 > T.H + 20) continue;
      }
      if (room < NODE_LABEL_MIN_SEG_PX) continue;
      const text = nodeText(S, i);
      if (text === null) continue;
      const w = S.measure.width(ctx, text, font);
      if (w + (kind === K_TIP ? fitTip : fit) > room) continue; // no room: not drawn, never moved to the node
      const fill = centred ? colLength : colSupport;
      if (fill !== lastFill) {
        ctx.fillStyle = fill;
        lastFill = fill;
      }
      const alpha = S.hlPrefix !== null && dimmed(S, e) ? theme.dimOpacity : 1;
      if (alpha !== lastAlpha) {
        ctx.globalAlpha = alpha;
        lastAlpha = alpha;
      }
      if (rect) {
        const al = centred ? 'center' : 'right';
        if (al !== lastAlign) {
          ctx.textAlign = al;
          lastAlign = al;
        }
        ctx.fillText(text, centred ? (x0 + Math.min(p.x, T.clipR)) / 2 : p.x - gap, y0);
      } else {
        const left = c < 0; // the left half is read upside down otherwise: turn the text round
        const cf = left ? -c : c,
          sf = left ? -sn : sn;
        ctx.setTransform(sc * cf, sc * sf, -sc * sf, sc * cf, sc * x0, sc * y0);
        // support: its end at the node, which is the end of the branch away from the root (the start of the text when turned round)
        const al = centred ? 'center' : left ? 'left' : 'right';
        if (al !== lastAlign) {
          ctx.textAlign = al;
          lastAlign = al;
        }
        ctx.fillText(text, centred ? 0 : left ? gap : -gap, -NODE_LABEL_LIFT_PX);
      }
      n++;
    }
  if (!rect) ctx.setTransform(sc, 0, 0, sc, 0, 0);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------------------------------ axis and scale bar

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}
const fmtTick = (v: number, step: number) => {
  const d = Math.max(0, -Math.floor(Math.log10(step)));
  return (Math.abs(v) < step * 1e-6 ? 0 : v).toFixed(Math.min(d, 6));
};

/** Rectangular phylogram: distance axis (time-before-tips axis for an ultrametric tree) in the footer band. */
export function drawAxis(ctx: CanvasRenderingContext2D, S: Scene, x0v: number, x1v: number): void {
  const { theme } = S;
  const { L, T } = S.proj;
  if (T.kind !== 'rectangular' || !L.usedLengths) return;
  const { ax, ay, ah } = T.area;
  const y = ay + ah + 2;
  const maxLen = L.maxLen;
  const dated = L.ultrametric;
  ctx.save();
  ctx.font = `${theme.axisFontSize}px ${theme.fontFamily}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.strokeStyle = theme.muted;
  ctx.fillStyle = theme.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.max(T.clipL, T.ox), y + 0.5);
  ctx.lineTo(Math.min(T.clipR, T.ox + T.kx), y + 0.5);
  ctx.stroke();
  const pxPerUnit = T.kx / 1 / maxLen; // px per tree unit
  const step = niceStep(110 / pxPerUnit);
  // values shown: distance from the root, or age (time before the tips) for an ultrametric tree
  const dLo = Math.max(0, x0v) * maxLen,
    dHi = Math.min(1, x1v) * maxLen;
  const toPx = (d: number) => T.ox + (d / maxLen) * T.kx;
  ctx.beginPath();
  const gridAlpha = dated ? 0.12 : 0;
  const ticks: { px: number; label: string }[] = [];
  if (dated) {
    for (let age = Math.ceil((maxLen - dHi) / step) * step; age <= maxLen - dLo + 1e-12; age += step)
      ticks.push({ px: toPx(maxLen - age), label: fmtTick(age, step) });
  } else {
    for (let d = Math.ceil(dLo / step) * step; d <= dHi + 1e-12; d += step) ticks.push({ px: toPx(d), label: fmtTick(d, step) });
  }
  for (const t of ticks) {
    ctx.moveTo(t.px + 0.5, y);
    ctx.lineTo(t.px + 0.5, y + 4);
  }
  ctx.stroke();
  for (const t of ticks) if (t.px > T.clipL + 8 && t.px < T.clipR - 8) ctx.fillText(t.label, t.px, y + 5);
  if (gridAlpha) {
    ctx.globalAlpha = gridAlpha;
    ctx.beginPath();
    for (const t of ticks) {
      ctx.moveTo(t.px + 0.5, ay);
      ctx.lineTo(t.px + 0.5, ay + ah);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'left';
  ctx.fillText(dated ? 'time before tips (tree units)' : 'distance from root (tree units)', Math.max(ax, 4), y + 16);
  ctx.restore();
}

/** The radial scale step in tree units at `pxPerUnit`: a round length (1, 2 or 5 x 10^n) of about 90 px, the scale bar's length and
 *  the spacing of the rings. */
export const radialStep = (pxPerUnit: number): number => niceStep(90 / pxPerUnit);

/** Radius (px) of ring j at `w` px per step: counted back from the tips (radius k) on a dated tree, out from the root otherwise. */
const ringRadius = (dated: boolean, k: number, w: number, j: number): number => (dated ? k - j * w : j * w);

/** Radial, option `radialRings`: circles about the root at the scale bar's step, behind the tree. On a dated tree they count back from
 *  the tips (ring j at radius k - j * step px, age j * step), otherwise out from the root (radius j * step px); only radii 0..k, where the
 *  tree is. Only the rings between the viewport's nearest and farthest radius are drawn, over the angles it covers (proj.rMin, rMax,
 *  lo, hi): O(rings in view), nothing per node. 'lines' strokes them; 'stripes' shades the odd bands (band j between ring j and j + 1),
 *  so the band at the tips (dated) or the root stays clear. With an opening, ring labels go along its middle where the gap fits them. */
export function drawRings(ctx: CanvasRenderingContext2D, S: Scene, mode: RadialRings): void {
  const proj = S.proj;
  const { L, T } = proj;
  if (mode === 'none' || proj.kind !== 'radial' || !L.usedLengths) return;
  const { theme } = S;
  const k = T.k;
  const pxPerUnit = k / L.maxLen;
  const step = radialStep(pxPerUnit);
  const w = step * pxPerUnit;
  const dated = L.ultrametric;
  const lo = Math.max(0, proj.rMin),
    hi = Math.min(k, proj.rMax);
  if (lo > hi) return;
  // the rings with a radius in lo..hi (ringRadius)
  const eps = 1e-9;
  const jLo = Math.ceil((dated ? k - hi : lo) / w - eps),
    jHi = Math.floor((dated ? k - lo : hi) / w + eps);
  const a0 = proj.all ? 0 : proj.lo,
    a1 = proj.all ? 2 * Math.PI : proj.wrap ? proj.hi + 2 * Math.PI : proj.hi;
  const { cx, cy } = T;
  ctx.save();
  ctx.fillStyle = theme.muted;
  ctx.strokeStyle = theme.muted;
  ctx.beginPath();
  if (mode === 'stripes') {
    // the bands touching lo..hi: one below jLo (it reaches up to ring jLo) through jHi
    for (let j = Math.max(0, jLo - 1); j <= jHi; j++) {
      if ((j & 1) === 0) continue;
      const r0 = Math.max(0, Math.min(k, ringRadius(dated, k, w, j))),
        r1 = Math.max(0, Math.min(k, ringRadius(dated, k, w, j + 1)));
      ctx.moveTo(cx + r0 * Math.cos(a0), cy + r0 * Math.sin(a0));
      ctx.arc(cx, cy, r0, a0, a1);
      ctx.arc(cx, cy, r1, a1, a0, true);
      ctx.closePath();
    }
    ctx.globalAlpha = theme.ringStripeOpacity;
    ctx.fill();
  } else {
    for (let j = jLo; j <= jHi; j++) {
      const r = ringRadius(dated, k, w, j);
      if (r <= 0) continue;
      ctx.moveTo(cx + r * Math.cos(a0), cy + r * Math.sin(a0));
      ctx.arc(cx, cy, r, a0, a1);
    }
    ctx.globalAlpha = theme.ringOpacity;
    ctx.lineWidth = theme.ringWidth;
    ctx.stroke();
  }
  ringLabels(ctx, S, jLo, jHi, w, step);
  ctx.restore();
}

/** The labels of rings jLo..jHi along the middle of the radial opening (none without one): the distance or age of each, where the
 *  opening is wider than the text at its radius, just outside its ring so the ring's line does not run through the text. */
function ringLabels(ctx: CanvasRenderingContext2D, S: Scene, jLo: number, jHi: number, w: number, step: number): void {
  const { theme } = S;
  const { L, T } = S.proj;
  const gap = 2 * Math.PI - L.fan.span; // the opening's angle
  if (gap < 1e-6) return;
  const mid = L.fan.start + L.fan.span / 2 + Math.PI;
  const c = Math.cos(mid),
    s = Math.sin(mid);
  ctx.globalAlpha = 1;
  ctx.font = `${theme.axisFontSize}px ${theme.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let j = Math.max(0, jLo); j <= jHi; j++) {
    const r = ringRadius(L.ultrametric, T.k, w, j);
    if (r <= 0) continue;
    const text = fmtTick(j * step, step);
    const tw = ctx.measureText(text).width;
    if (r * gap < tw + 6) continue;
    // out along the ray by half the text box's extent in that direction, plus 2 px
    const out = r + (Math.abs(c) * tw + Math.abs(s) * theme.axisFontSize) / 2 + 2;
    ctx.fillText(text, T.cx + out * c, T.cy + out * s);
  }
}

/** Radial: a scale bar of a round length at the bottom right. */
export function drawScaleBar(ctx: CanvasRenderingContext2D, S: Scene): void {
  const { theme } = S;
  const { L, T } = S.proj;
  if (T.kind !== 'radial' || !L.usedLengths) return;
  const pxPerUnit = T.k / L.maxLen;
  const step = radialStep(pxPerUnit);
  const w = step * pxPerUnit;
  const x = Math.max(14, T.W - w - 18),
    y = T.H - 18;
  ctx.save();
  ctx.strokeStyle = theme.muted;
  ctx.fillStyle = theme.muted;
  ctx.lineWidth = 1.5;
  ctx.font = `${theme.axisFontSize}px ${theme.fontFamily}`;
  ctx.textBaseline = 'bottom';
  ctx.beginPath();
  ctx.moveTo(x, y - 3);
  ctx.lineTo(x, y + 3);
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.moveTo(x + w, y - 3);
  ctx.lineTo(x + w, y + 3);
  ctx.stroke();
  ctx.fillText(fmtTick(step, step), x, y - 5);
  ctx.restore();
}
