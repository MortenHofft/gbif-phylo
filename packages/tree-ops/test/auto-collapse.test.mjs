// Run from packages/tree-ops: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { autoCollapse, mergeAutoCollapse, subtree } from '../src/index.ts';
import { parseNewick, TreeModel } from '@gbif-phylo/io'; // fixtures: text -> TreeInput

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data');
const readTree = (p) => parseNewick(zlib.gunzipSync(fs.readFileSync(path.join(DATA, p))).toString('utf8'));
const size = (t, v) => t.leafEnd[v] - t.leafStart[v];

/** Rows the clade `root` shows with `collapsed` collapsed: tips outside them, plus one per collapsed clade. */
function rowsOf(t, collapsed, root = 0) {
  const set = new Set(collapsed);
  let rows = 0;
  for (let i = root; i < t.subtreeEnd[root];) {
    if (set.has(i)) {
      rows++;
      i = t.subtreeEnd[i];
    } else {
      if (t.childCount[i] === 0) rows++;
      i++;
    }
  }
  return rows;
}

/** The same greedy, written the slow and obvious way: sort the collapsed clades at every step. */
function reference(t, maxRows, root = 0, minTips = 1) {
  if (t.childCount[root] === 0 || size(t, root) <= maxRows) return [];
  const whole = (c) => t.childCount[c] === 0 || size(t, c) < minTips;
  let open = [root];
  const out = [];
  let rows = 1;
  while (open.length) {
    open.sort((a, b) => size(t, b) - size(t, a) || a - b);
    const v = open.shift();
    let next = rows - 1;
    const kids = [];
    for (let c = t.firstChild[v]; c >= 0; c = t.nextSibling[c]) {
      next += whole(c) ? size(t, c) : 1;
      if (!whole(c)) kids.push(c);
    }
    if (next > maxRows) out.push(v);
    else {
      rows = next;
      open = open.concat(kids);
    }
  }
  return out.sort((a, b) => a - b);
}

function checkResult(t, ids, maxRows, root = 0, minTips = 1) {
  assert.ok(rowsOf(t, ids, root) <= maxRows, `${rowsOf(t, ids, root)} rows, at most ${maxRows}`);
  for (let k = 0; k < ids.length; k++) {
    const v = ids[k];
    assert.ok(v >= root && v < t.subtreeEnd[root], `${v} is inside the clade`);
    assert.ok(t.childCount[v] > 0, `${v} is a clade`);
    if (k > 0) assert.ok(v >= t.subtreeEnd[ids[k - 1]], 'in preorder, none nested');
    if (!(ids.length === 1 && v === root)) assert.ok(size(t, v) >= minTips, `${v} has at least ${minTips} tips`);
  }
}

const TREES = ['real-ladder/trees/gtdb-1k-nitrososphaeria.nwk.gz', 'real-ladder/trees/otl-10k-amphibia.nwk.gz'];

test('autoCollapse stays within maxRows and matches the greedy, on GTDB (binary) and OTL (polytomies, one-child nodes)', () => {
  for (const p of TREES) {
    const t = readTree(p);
    for (const maxRows of [1, 2, 3, 7, 50, 200, 999]) {
      for (const minTips of [1, 5]) {
        const ids = autoCollapse(t, { maxRows, minTips });
        checkResult(t, ids, maxRows, 0, minTips);
        assert.deepEqual(ids, reference(t, maxRows, 0, minTips), `${p} maxRows ${maxRows} minTips ${minTips}`);
      }
    }
    // a budget of 50 is used: about 50 rows, not far fewer
    assert.ok(rowsOf(t, autoCollapse(t, { maxRows: 50 })) >= 40, `${p}: close to 50 rows`);
  }
});

test('autoCollapse opens the largest clade first', () => {
  // L = (a,b) 2 tips, R = ((c,d),(e,(f,g))) 5 tips; R1 = (c,d) 2, R2 = (e,(f,g)) 3
  const t = new TreeModel(parseNewick('((a,b),((c,d),(e,(f,g))));'));
  const mrca = (...l) => t.mrcaOf(l.map((x) => t.tipIndex(x)));
  const [L, R1, R2, FG] = [mrca('a', 'b'), mrca('c', 'd'), mrca('e', 'g'), mrca('f', 'g')];
  assert.deepEqual(autoCollapse(t, { maxRows: 2 }), [L, mrca('c', 'g')]);
  assert.deepEqual(autoCollapse(t, { maxRows: 3 }), [L, R1, R2]); // R (5) opened, not L (2)
  assert.deepEqual(autoCollapse(t, { maxRows: 4 }), [L, R1, FG]); // then R2 (3)
  assert.deepEqual(autoCollapse(t, { maxRows: 5 }), [R1, FG]); // then L, first in preorder of the 2-tip clades
  assert.deepEqual(autoCollapse(t, { maxRows: 6 }), [FG]);
  assert.deepEqual(autoCollapse(t, { maxRows: 7 }), []); // all 7 tips fit
  assert.deepEqual(autoCollapse(t, { maxRows: 1 }), [0]);
});

test('autoCollapse: a polytomy that does not fit stays collapsed, and smaller clades are still opened', () => {
  const star = '(' + Array.from({ length: 3000 }, (_, i) => 's' + i).join(',') + ')';
  const t = new TreeModel(parseNewick(`(${star},((a,b),(c,d)));`));
  const S = t.mrcaOf([t.tipIndex('s0'), t.tipIndex('s1')]);
  const ids = autoCollapse(t, { maxRows: 50 });
  assert.deepEqual(ids, [S]);
  assert.equal(rowsOf(t, ids), 5); // the star, a, b, c, d
  // a root with more children than rows: the whole clade stays one row
  const wide = parseNewick('(' + Array.from({ length: 200000 }, (_, i) => 't' + i).join(',') + ');');
  assert.deepEqual(autoCollapse(wide, { maxRows: 50 }), [0]);
});

test('autoCollapse inside a clade (root): only nodes below it, the same as on the clade as its own tree', () => {
  const t = readTree('real-ladder/trees/otl-10k-amphibia.nwk.gz');
  let v = 1;
  for (let i = 1; i < t.nodeCount; i++) if (t.childCount[i] > 0 && size(t, i) > 500 && size(t, i) < 3000) v = i;
  const s = subtree(t, v);
  const st = new TreeModel(s.tree);
  for (const maxRows of [1, 20, 50]) {
    const ids = autoCollapse(t, { maxRows, root: v });
    checkResult(t, ids, maxRows, v);
    assert.deepEqual(
      ids.map((k) => s.map[k]),
      autoCollapse(st, { maxRows }),
    );
  }
  assert.deepEqual(autoCollapse(t, { maxRows: 50, root: t.tipNode[0] }), [], 'a tip: nothing to collapse');
});

test('autoCollapse: minTips keeps small clades open, within the budget', () => {
  const t = readTree('real-ladder/trees/gtdb-1k-nitrososphaeria.nwk.gz');
  const ids = autoCollapse(t, { maxRows: 100, minTips: 20 });
  checkResult(t, ids, 100, 0, 20);
  assert.ok(ids.length > 0);
});

test('autoCollapse checks its arguments', () => {
  const t = parseNewick('((a,b),c);');
  assert.throws(() => autoCollapse(t, { maxRows: 0 }), RangeError);
  assert.throws(() => autoCollapse(t, { maxRows: NaN }), RangeError);
  assert.throws(() => autoCollapse(t, { maxRows: 5, root: 99 }), RangeError);
  assert.deepEqual(autoCollapse(t, { maxRows: Infinity }), []);
  assert.deepEqual(autoCollapse(t, { maxRows: 2.9 }), [1]); // rounded down to 2
});

/** A tree of `tips` tips as the arrays autoCollapse reads, built without parsing: each clade splits its tips one third, two thirds. */
function synthetic(tips) {
  const nodeCount = 2 * tips - 1;
  const childCount = new Int32Array(nodeCount);
  const firstChild = new Int32Array(nodeCount).fill(-1);
  const nextSibling = new Int32Array(nodeCount).fill(-1);
  const leafStart = new Int32Array(nodeCount);
  const leafEnd = new Int32Array(nodeCount);
  const subtreeEnd = new Int32Array(nodeCount);
  // preorder: the stack holds [lo, hi, parent, leftSibling] of the clades still to number
  const stack = [[0, tips, -1, -1]];
  let id = 0;
  while (stack.length) {
    const [lo, hi, parent, left] = stack.pop();
    const v = id++;
    leafStart[v] = lo;
    leafEnd[v] = hi;
    subtreeEnd[v] = v + 2 * (hi - lo) - 1;
    if (left >= 0) nextSibling[left] = v;
    else if (parent >= 0) firstChild[parent] = v;
    if (hi - lo > 1) {
      childCount[v] = 2;
      const mid = lo + Math.max(1, Math.floor((hi - lo) / 3));
      // the right child is numbered after the whole left clade: its left sibling is the left child, v + 1
      stack.push([mid, hi, v, v + 1], [lo, mid, v, -1]);
    }
  }
  return { nodeCount, tipCount: tips, childCount, firstChild, nextSibling, leafStart, leafEnd, subtreeEnd };
}

test('autoCollapse on 2.4M tips at maxRows 50 takes milliseconds', () => {
  const t = synthetic(2_400_000);
  autoCollapse(t, { maxRows: 50 }); // warm-up
  const t0 = performance.now();
  const ids = autoCollapse(t, { maxRows: 50 });
  const ms = performance.now() - t0;
  assert.ok(rowsOf(t, ids) <= 50 && rowsOf(t, ids) >= 45);
  assert.ok(ms < 20, `took ${ms.toFixed(2)} ms`);
});

test('mergeAutoCollapse: expand a collapsed clade in place, its largest subclades open within the budget, the rest kept', () => {
  const t = readTree('real-ladder/trees/otl-10k-amphibia.nwk.gz');
  const top = autoCollapse(t, { maxRows: 50 });
  // the largest collapsed clade of the overview whose children fit in 20 rows, and one more to keep
  const big = top.filter((v) => autoCollapse(t, { root: v, maxRows: 20 })[0] !== v).reduce((a, b) => (size(t, b) > size(t, a) ? b : a));
  const other = top.find((v) => v !== big);
  const merged = mergeAutoCollapse(t, top, { root: big, maxRows: 20 });
  assert.ok(!merged.includes(big), 'the clade is open');
  assert.ok(merged.includes(other), 'a collapsed clade outside it stays collapsed');
  const inside = merged.filter((v) => v >= big && v < t.subtreeEnd[big]);
  assert.deepEqual(inside, autoCollapse(t, { root: big, maxRows: 20 }), 'inside it: its own overview');
  checkResult(t, inside, 20, big);
  assert.equal(rowsOf(t, merged), rowsOf(t, top) - 1 + rowsOf(t, inside, big), 'the clade adds its rows, the others stay');
  assert.deepEqual(
    merged,
    [...merged].sort((a, b) => a - b),
    'in preorder',
  );
  assert.equal(new Set(merged).size, merged.length, 'no duplicates');
  assert.deepEqual(top, autoCollapse(t, { maxRows: 50 }), 'the input is not changed');
});

test('mergeAutoCollapse replaces the collapsed clades inside the clade, and a wide polytomy gets one row per child', () => {
  // L = (a,b), R = ((c,d),(e,(f,g))); R1 = (c,d), R2 = (e,(f,g)), FG = (f,g)
  const t = new TreeModel(parseNewick('((a,b),((c,d),(e,(f,g))));'));
  const mrca = (...l) => t.mrcaOf(l.map((x) => t.tipIndex(x)));
  const [L, R, R1, R2, FG] = [mrca('a', 'b'), mrca('c', 'g'), mrca('c', 'd'), mrca('e', 'g'), mrca('f', 'g')];
  assert.deepEqual(mergeAutoCollapse(t, [L, R1, FG], { root: R, maxRows: 2 }), [L, R1, R2], 'R1 and FG replaced by R’s overview');
  assert.deepEqual(mergeAutoCollapse(t, [L, R], { root: R, maxRows: 10 }), [L], 'R fits open: only L stays');
  assert.deepEqual(mergeAutoCollapse(t, [L, R], { maxRows: 3 }), [L, R1, R2], 'the whole tree by default');
  // a clade whose children don't fit: each child that is a clade is collapsed, not the clade itself
  const star = '(' + Array.from({ length: 30 }, (_, i) => `(s${i}a,s${i}b)`).join(',') + ',x)';
  const w = new TreeModel(parseNewick(`(${star},y);`));
  const S = w.mrcaOf([w.tipIndex('s0a'), w.tipIndex('x')]);
  const merged = mergeAutoCollapse(w, [S], { root: S, maxRows: 20 });
  assert.equal(merged.length, 30);
  assert.ok(merged.every((v) => w.parent[v] === S && w.childCount[v] === 2));
  // minTips: a child clade smaller than it is left open there too
  const m = new TreeModel(parseNewick(`((${Array.from({ length: 30 }, (_, i) => `(p${i},q${i})`).join(',')},(u,v,w)),z);`));
  const P = m.mrcaOf([m.tipIndex('p0'), m.tipIndex('u')]);
  const U = m.mrcaOf([m.tipIndex('u'), m.tipIndex('w')]);
  assert.deepEqual(mergeAutoCollapse(m, [P], { root: P, maxRows: 20, minTips: 3 }), [U]);
});
