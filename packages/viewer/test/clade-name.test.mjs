// internalName (the viewer's copy of the support-stripping rule) must agree with @gbif-phylo/io's splitInternalLabel on a fixed corpus.
// io is a devDependency of the viewer, used here only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { internalName } = await import('../src/clade-name.ts');
const { internalSupport } = await import('../src/node-label.ts');
const { splitInternalLabel } = await import('@gbif-phylo/io');

const CORPUS = [
  '',
  '  ',
  '95',
  '0.95',
  '1e-3',
  '.5',
  '5.',
  '+3',
  '-1',
  ' 95 ',
  '98.0:c__Nitrososphaeria',
  '95:Chelodina_ott235768',
  '95:',
  '95: Foo',
  '95:Foo:Bar',
  ':Foo',
  '1:2',
  "'95'",
  'Chelodina',
  'Chelodina_ott235768',
  '16S_clade',
  '1_ott123',
  'mrcaott99343ott3606205',
  'Infinity',
  'NaN',
  '0x10',
  '1e',
  'e5',
  '95 : Foo',
  '1,000',
  '100/95',
  '95%',
  '\u00A095', // no-break space, BOM and ideographic space: io's \s accepts them, so does the viewer
  '\uFEFF95',
  '\u300095',
  '95\u3000:Foo',
];

test('internalName agrees with io splitInternalLabel(...).name over a fixed corpus', () => {
  for (const s of CORPUS) assert.equal(internalName(s), splitInternalLabel(s).name, JSON.stringify(s));
});

test('internalSupport agrees with io splitInternalLabel(...).support over the same corpus (Object.is)', () => {
  for (const s of CORPUS) assert.ok(Object.is(internalSupport(s), splitInternalLabel(s).support), JSON.stringify(s));
});

test('internalName: support values are no name, "support:name" is the name, and "100/95" and "95%" are names', () => {
  assert.equal(internalName('95'), '');
  assert.equal(internalName('98.0:c__Nitrososphaeria'), 'c__Nitrososphaeria');
  assert.equal(internalName('100/95'), '100/95');
  assert.equal(internalName('95%'), '95%');
});

// ---------------------------------------------------------------- summaries of collapsed clades (#57)
const { namedDescendants, defaultFormatCollapsedLabel } = await import('../src/clade-name.ts');
const { InMemorySource } = await import('../src/source.ts');
const { parseNewick } = await import('@gbif-phylo/io');
const { partialSnapshot } = await import('./partial-snapshot.mjs');

const snap = (nwk) => new InMemorySource(parseNewick(nwk)).snapshot();
const FMT = { formatLabel: (s) => s.replace(/_/g, ' ') };
const names = (r) => r.names.map((d) => d.name);

// Below the '90' node: A (named), 95 (support only) and mrcaott1ott2 (synthetic). Below 95: B and C; below the synthetic one: D (named)
// and, under an unnamed node, E. A's own subclade A1 is never reached: A is named.
const TREE = '((((a1,a2)A1,a3)A,((b1,b2)B,(c1,c2,c3)C)95,((d1,d2)D,((e1,e2)E,e3)80)mrcaott1ott2)90,z)R;';
const OTL_SYNTHETIC = /^mrcaott\d+ott\d+$/;
const hideSynthetic = (node, t) => {
  const n = internalName(t.labels[t.toLocal(node)]);
  return OTL_SYNTHETIC.test(n) ? null : n;
};

test('namedDescendants: the shallowest named clades, breadth-first, not below a named one; support values and hidden names do not count', () => {
  const t = snap(TREE);
  const top = t.firstChild[0]; // the '90' node, everything but z
  assert.deepEqual(names(namedDescendants(t, top, FMT)), ['A', 'mrcaott1ott2', 'B', 'C'], 'without cladeLabel the synthetic name counts');
  assert.deepEqual(names(namedDescendants(t, 0, FMT)), ['A', 'mrcaott1ott2', 'B', 'C'], "from the root: '90' is no name");
  const r = namedDescendants(t, top, { ...FMT, cladeLabel: hideSynthetic });
  assert.deepEqual(names(r), ['A', 'B', 'C', 'D', 'E'], 'A first (depth 1), then B, C and D (depth 2), then E (depth 3); A1 is under A');
  assert.equal(r.more, false, 'everything was seen');
  const A = r.names[0];
  assert.equal(A.tips, 3);
  assert.equal(t.labels[A.node], 'A', 'node is the full-tree id');
  // max: the first names only, and `more` says there may be others
  const two = namedDescendants(t, top, { ...FMT, cladeLabel: hideSynthetic }, { max: 2 });
  assert.deepEqual(names(two), ['A', 'B']);
  assert.equal(two.more, true);
  // a tip, a clade with no named descendant, and a row out of range
  assert.deepEqual(namedDescendants(t, t.tipIndex('z'), FMT), { names: [], more: false });
  assert.deepEqual(namedDescendants(t, t.labels.indexOf('B'), FMT), { names: [], more: false });
  assert.deepEqual(namedDescendants(t, -1, FMT), { names: [], more: false });
  // formatLabel formats, as everywhere a clade is named
  assert.deepEqual(names(namedDescendants(snap('((a,b)Canis_lupus,c);'), 0, FMT)), ['Canis lupus']);
});

test('namedDescendants respects its work cap: a deep unnamed comb is cut after maxVisits nodes, and says so', () => {
  // a comb of 5,000 unnamed clades with one name at the very bottom
  let nwk = '(x0,y0)Deep';
  for (let i = 1; i < 5000; i++) nwk = `(${nwk},x${i})`;
  const t = snap(nwk + ';');
  let calls = 0;
  const counting = { ...FMT, cladeLabel: (node, tr) => (calls++, internalName(tr.labels[tr.toLocal(node)])) };
  const cut = namedDescendants(t, 0, counting, { maxVisits: 100 });
  assert.deepEqual(cut, { names: [], more: true });
  assert.ok(calls <= 100, `${calls} nodes named, at most 100`);
  calls = 0;
  const all = namedDescendants(t, 0, counting, { maxVisits: 10000 });
  assert.deepEqual(names(all), ['Deep']);
  assert.equal(all.more, false);
  assert.equal(calls, 4999, 'every internal node below the root once');
  // a wide polytomy: the queue fills at the cap, and the names found before it are kept
  const wide = snap('(' + Array.from({ length: 300 }, (_, k) => `(p${k},q${k})N${k}`).join(',') + ');');
  const w = namedDescendants(wide, 0, FMT, { max: 1000, maxVisits: 50 });
  assert.equal(w.names.length, 50);
  assert.equal(w.more, true);
});

test('namedDescendants: tips count towards the cap, so a wide polytomy of tips is cut there', () => {
  // 100,000 tips, then one named clade after them
  const star = snap('(' + Array.from({ length: 100000 }, (_, k) => `t${k}`).join(',') + ',(a,b)Named);');
  let calls = 0;
  const counting = { ...FMT, cladeLabel: (node, tr) => (calls++, internalName(tr.labels[tr.toLocal(node)])) };
  const r = namedDescendants(star, 0, counting, { maxVisits: 50 });
  assert.deepEqual(r, { names: [], more: true });
  assert.equal(calls, 0, 'the named clade after the tips is never reached');
  // and the walk over the children stopped at the cap: count the reads of nextSibling
  let reads = 0;
  const nextSibling = new Proxy(star.nextSibling, {
    get: (a, k) => {
      if (typeof k === 'string' && /^\d+$/.test(k)) reads++;
      return Reflect.get(a, k);
    },
  });
  assert.equal(namedDescendants({ ...star, nextSibling }, 0, FMT, { maxVisits: 50 }).more, true);
  assert.ok(reads <= 50, `${reads} children looked at, at most 50`);
  // with room for every child it is found
  assert.deepEqual(names(namedDescendants(star, 0, FMT, { maxVisits: 100001 })), ['Named']);
});

test('namedDescendants on a partial source: full-tree ids, and a clade that is not loaded is not entered', () => {
  const full = parseNewick(TREE);
  const at = (l) => full.labels.indexOf(l);
  // the synthetic clade is a stub; ids are shifted to catch a row taken for an id
  const { snap: p, rowOf } = partialSnapshot(full, [at('mrcaott1ott2')], 1000);
  const byId = (node) => {
    const g = node - 1000;
    return g === at('A') || g === at('B') || g === at('C') ? full.labels[g] : null;
  };
  const r = namedDescendants(p, rowOf(at('90')), { ...FMT, cladeLabel: byId });
  assert.deepEqual(names(r), ['A', 'B', 'C']);
  assert.deepEqual(
    r.names.map((d) => d.node),
    [at('A') + 1000, at('B') + 1000, at('C') + 1000],
  );
  assert.equal(r.more, true, 'the stub may hold names');
});

test('defaultFormatCollapsedLabel: "Name · 12,345 tips", or the size alone', () => {
  assert.equal(defaultFormatCollapsedLabel('Firmicutes', 12345), 'Firmicutes · 12,345 tips');
  assert.equal(defaultFormatCollapsedLabel(null, 2), '2 tips');
  assert.equal(defaultFormatCollapsedLabel('', 1), '1 tip');
});
