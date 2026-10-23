// The name of a clade, shared by every place the viewer names one (the legend, the node menu title, the default tooltip, the live-region
// announcement), so they all apply the same rule: an internal node's label with its support value taken off, shown as the app's
// `formatLabel` shows a tip. A tip is named by its own label, whole. Also the label of a collapsed clade (`formatCollapsedLabel`) and
// its highest named descendants (`namedDescendants`), for summaries of collapsed clades.

import type { TreeSnapshot } from './types.ts';

/**
 * `(node, tree)`: the name of the internal node `node` (its preorder id in the full tree, as `setClades` and `TreeEvent.node` use), or
 * null for none. `tree` is the viewer's snapshot: read the label as `tree.labels[tree.toLocal(node)]`. The viewer formats what it returns.
 */
export type CladeLabelFn = (node: number, tree: TreeSnapshot) => string | null | undefined;

const NUMERIC_PREFIX = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*(?::(.*))?$/s;

/**
 * The name part of an internal node label. Labels in the wild are names ('Canidae_ott770319'), support values ('0.95', '100') or both
 * ('98.0:c__Nitrososphaeria'); a support-only label has no name (''). The same rule as `splitInternalLabel` in @gbif-phylo/io, which the
 * viewer does not depend on.
 */
export function internalName(label: string): string {
  if (label === '') return '';
  const m = NUMERIC_PREFIX.exec(label);
  return m ? (m[1] ?? '') : label;
}

/**
 * The display name of the node at snapshot row `row`, or null when it has none: a tip's label through `formatLabel`; an internal
 * node's name (from `cladeLabel`, called with the node's full-tree id, when set, else its label without the support) through
 * `formatLabel`. Whitespace-only names count as none.
 */
export function cladeName(
  tree: TreeSnapshot,
  row: number,
  opts: { formatLabel: (s: string) => string; cladeLabel?: CladeLabelFn | null },
): string | null {
  if (row < 0) return null;
  const label = tree.labels[row] ?? '';
  const node = tree.globalId === null ? row : tree.globalId[row];
  const raw = tree.childCount[row] === 0 ? label : opts.cladeLabel ? opts.cladeLabel(node, tree) : internalName(label);
  const s = raw ? opts.formatLabel(raw).trim() : '';
  return s === '' ? null : s;
}

/** The default `formatCollapsedLabel`: 'Firmicutes · 12,345 tips', or '12,345 tips' without a name. */
export function defaultFormatCollapsedLabel(name: string | null, tips: number): string {
  const n = `${tips.toLocaleString('en')} ${tips === 1 ? 'tip' : 'tips'}`;
  return name ? `${name} · ${n}` : n;
}

/** A named descendant of a clade, as {@link namedDescendants} finds it. */
export interface NamedDescendant {
  /** Preorder id in the full tree, as the public API speaks. */
  node: number;
  /** Its display name, as {@link cladeName} gives it. */
  name: string;
  /** Its number of tips. */
  tips: number;
}

/**
 * The highest named descendants of the internal node at snapshot row `row`, to summarise a collapsed clade: the shallowest internal
 * nodes below it that have a name (by {@link cladeName}, so `cladeLabel` decides, and support values and the names an app hides do
 * not count), found breadth-first and in preorder within a level. Below a named node it does not look further. It stops after `max`
 * names (default 5) or after looking at `maxVisits` children (default 2,000; tips count too, so a wide polytomy of tips is cut there), so a clade of a million tips costs no more than a small one;
 * `more` is true when it stopped before seeing every place a name could be (also at the rows of a partial source that are not loaded).
 * The clade's own name is not included. Tips are not names here. Cost: O(`maxVisits`), with one queue of that size; `names` holds at
 * most `max` entries.
 */
export function namedDescendants(
  tree: TreeSnapshot,
  row: number,
  opts: { formatLabel: (s: string) => string; cladeLabel?: CladeLabelFn | null },
  limits: { max?: number; maxVisits?: number } = {},
): { names: NamedDescendant[]; more: boolean } {
  const max = Math.max(0, Math.floor(limits.max ?? 5));
  const cap = Math.max(1, Math.floor(limits.maxVisits ?? 2000));
  const names: NamedDescendant[] = [];
  if (row < 0 || row >= tree.nodeCount || tree.childCount[row] === 0) return { names, more: false };
  const { firstChild, nextSibling, childCount, leafStart, leafEnd, stub } = tree;
  // the internal nodes still to look at, in breadth-first order (a ring is not needed: at most `cap` are ever queued)
  const queue = new Int32Array(Math.min(cap, tree.nodeCount));
  let head = 0;
  let tail = 0;
  let seen = 0; // children looked at, tips included: a wide polytomy of tips costs `cap`, not its degree
  let more = false;
  const enqueueChildren = (v: number): void => {
    if (stub !== null && stub[v] === 1) {
      more = true; // its rows are not loaded
      return;
    }
    for (let c = firstChild[v]; c >= 0; c = nextSibling[c]) {
      if (seen === cap) {
        more = true;
        return;
      }
      seen++;
      if (childCount[c] > 0) queue[tail++] = c;
    }
  };
  enqueueChildren(row);
  while (head < tail) {
    if (names.length >= max) {
      more = true;
      break;
    }
    const v = queue[head++];
    const name = cladeName(tree, v, opts);
    if (name !== null) names.push({ node: tree.globalId === null ? v : tree.globalId[v], name, tips: leafEnd[v] - leafStart[v] });
    else enqueueChildren(v);
  }
  return { names, more };
}
