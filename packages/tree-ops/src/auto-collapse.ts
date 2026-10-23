// Auto-collapse: a readable overview of a big tree in at most N rows, the largest clades opened first. For browsing a tree such as
// GTDB or the Open Tree of Life from the root, and drilling down into a clade with the same overview there. Pure: node ids out, which
// a viewer collapses (`viewer.setCollapsed`); the tree is not changed.

import { checkNode } from './draft.ts';
import type { TreeInput } from './types.ts';

export interface AutoCollapseOptions {
  /** At most this many rows: the tips shown plus the collapsed clades. At least 1. */
  maxRows: number;
  /** Work inside this clade (drill-down): its rows are counted, and only nodes below it are returned. Default the root. */
  root?: number;
  /** A clade with fewer tips than this is never collapsed: it opens whole with its parent, and counts its tips as rows. Default 1. */
  minTips?: number;
}

/**
 * The clades to collapse so that the clade `root` shows at most `maxRows` rows (tips and collapsed clades), the largest opened first.
 * Starts with `root` collapsed, then repeatedly opens the collapsed clade with the most tips (ties: the first in preorder), replacing
 * it by its children, as long as the rows stay within `maxRows`. A clade whose children don't fit (a wide polytomy) stays collapsed,
 * and smaller clades are still opened. Returns node ids in preorder, none nested: `[]` when the whole clade fits open, `[root]` when
 * not even its children fit (also when `root` has fewer than `minTips` tips: the budget comes first). Iterative, with a max-heap of the collapsed clades: the cost grows with `maxRows` and the children of the
 * clades opened, not with the size of the tree.
 */
export function autoCollapse(t: TreeInput, o: AutoCollapseOptions): number[] {
  const root = o.root ?? 0;
  checkNode(t, root);
  const max = Math.floor(o.maxRows);
  if (!(max >= 1)) throw new RangeError(`autoCollapse: maxRows must be at least 1 (got ${o.maxRows})`);
  const minTips = o.minTips ?? 1;
  const { leafStart, leafEnd, childCount, firstChild, nextSibling } = t;
  if (childCount[root] === 0 || leafEnd[root] - leafStart[root] <= max) return [];
  // the heap holds collapsed clades that may open; each is a row, so there are never more than `max`
  const heap = new Int32Array(max);
  let n = 0;
  // a before b: more tips, then earlier in preorder
  const above = (a: number, b: number) => {
    const d = leafEnd[a] - leafStart[a] - (leafEnd[b] - leafStart[b]);
    return d > 0 || (d === 0 && a < b);
  };
  const push = (v: number) => {
    let i = n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!above(v, heap[p])) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = v;
  };
  const pop = () => {
    const top = heap[0];
    const last = heap[--n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && above(heap[c + 1], heap[c])) c++;
      if (!above(heap[c], last)) break;
      heap[i] = heap[c];
      i = c;
    }
    if (n > 0) heap[i] = last;
    return top;
  };
  const opensWhole = (v: number) => childCount[v] === 0 || leafEnd[v] - leafStart[v] < minTips; // rows: its tips
  const out: number[] = [];
  let rows = 1;
  push(root);
  while (n > 0) {
    const v = pop();
    // the rows its children take in its place, stopping as soon as they don't fit
    let next = rows - 1;
    for (let c = firstChild[v]; c >= 0 && next <= max; c = nextSibling[c]) next += opensWhole(c) ? leafEnd[c] - leafStart[c] : 1;
    if (next > max) {
      out.push(v);
      continue;
    }
    rows = next;
    for (let c = firstChild[v]; c >= 0; c = nextSibling[c]) if (!opensWhole(c)) push(c);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Drill-down: the collapsed set `collapsed` with the clade `o.root` (default the root) replaced by its own overview. The ids in that
 * clade, `root` included, are dropped and {@link autoCollapse}'s are added, so `root` itself is open: for a collapsed clade that is
 * "expand in place" (its largest subclades open, the rest collapsed, within `maxRows`); for the clade shown alone it is the overview
 * inside it. When not even the children of `root` fit in `maxRows` (a wide polytomy), each child that is a clade of at least `minTips`
 * tips is collapsed instead, one row each. Ids outside the clade are kept as they are. Returns node ids in preorder, without duplicates; the input is not changed.
 */
export function mergeAutoCollapse(t: TreeInput, collapsed: readonly number[], o: AutoCollapseOptions): number[] {
  const root = o.root ?? 0;
  let inside = autoCollapse(t, o);
  if (inside.length === 1 && inside[0] === root) {
    inside = [];
    const minTips = o.minTips ?? 1;
    for (let c = t.firstChild[root]; c >= 0; c = t.nextSibling[c])
      if (t.childCount[c] > 0 && t.leafEnd[c] - t.leafStart[c] >= minTips) inside.push(c);
  }
  const end = t.subtreeEnd[root];
  const out = new Set(inside);
  for (const v of collapsed) if (v < root || v >= end) out.add(v);
  return [...out].sort((a, b) => a - b);
}
