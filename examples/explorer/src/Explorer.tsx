// The explorer: the styled showcase of the library. Its look started from Reactree (reactreejs 1.0.3: two toolbar rows over a dotted tree
// pane, an inspector, a floating search, a colour palette, an export menu); it is built only from the public API of @gbif-phylo:
// <TreeView> and its handle for the drawing, its props for clades / highlights / collapsed clades / columns / theme / the node menu,
// its callbacks for clicks and hovers, tree-ops for every edit and view (focus, collapse by support) and the viewer's options and controls.
// Which control uses which API is the table in ../README.md.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TreeModel, toNewick, toNexus, splitInternalLabel } from '@gbif-phylo/io';
import * as ops from '@gbif-phylo/tree-ops';
import {
  TreeView,
  useTreeEvent,
  useTreeTheme,
  useTreeViewer,
  useViewport,
  type CladeProp,
  type NodeMenuItem,
  type TreeNodeEvent,
  type TreeViewHandle,
} from '@gbif-phylo/react';
import {
  defaultControls,
  defaultFormatNodeLabel,
  detectAlphabet,
  residueColours,
  residueGroups,
  type Column,
  type TreeViewer,
  type Viewport,
} from '@gbif-phylo/viewer';
import * as I from './icons.tsx';
import * as J from './icons-ours.tsx';
import { Scroller } from './Scroller.tsx';

type Mode = 'none' | 'reroot' | 'flip' | 'swap' | 'color';
type Layout = 'rectangular' | 'radial';
type NodeLabelMode = 'none' | 'bootstrap' | 'branchlength';
type LadderBy = 'tips' | 'depth' | 'height';
type HighlightStyle = 'band' | 'dim' | 'both';
const NO_NODES: number[] = [];
/** Rooting inside a clade shown alone puts its tips on both sides of the new root, so it would no longer be one clade. */
const REROOT_IN_FOCUS = 'Reroot inside a clade shown alone would split it: go Up one level or Back to the whole tree first';
/** Drill-down (tree-ops autoCollapse): the rows of the overview of the clade shown, and of a collapsed clade expanded in place. */
const OVERVIEW_ROWS = 50;
const EXPAND_ROWS = 20;

/** Reactree's 12 swatches; the colours themselves are CSS custom properties (--ex-palette-<name>) in explorer.css. */
const PALETTE = ['Red', 'Orange', 'Amber', 'Lime', 'Emerald', 'Teal', 'Sky', 'Indigo', 'Violet', 'Pink', 'Slate', 'Brown'];
const ERASE = 'reset';
const TRUNCATE_AT = 30; // Reactree: names longer than 30 characters become 28 plus an ellipsis

interface Step {
  tree: TreeModel;
  clades: CladeProp[];
  collapsed: number[];
  /** The node map of the edit that made this step from the one before it (old tree -> this tree); none for the first. */
  map?: Int32Array;
  /** How many steps before this one were dropped to stay within the memory budget: then `map` is from the tree as published, and
   *  Undo stops here. */
  dropped?: number;
}

/** What the trees kept for Undo may take, the tree as published and the current one aside (#44): about 45 to 60 steps of a 10k-tip tree, two
 *  of the 190k-tip GTDB tree, none of a tree of a million tips, where only Reset is offered. */
const UNDO_BUDGET = 64 * 1024 * 1024;

/** Keeps the steps between the tree as published (`h[0]`) and the current one (the last) within `budget` bytes (tree-ops' treeBytes),
 *  dropping the oldest first. The step after a dropped one takes a map from the tree as published, so Reset still keeps the view. */
function trimHistory(h: Step[], budget: number): Step[] {
  let bytes = 0;
  for (let k = 1; k < h.length - 1; k++) bytes += ops.treeBytes(h[k].tree);
  while (h.length > 2 && bytes > budget) {
    bytes -= ops.treeBytes(h[1].tree);
    h = [h[0], { ...h[2], map: ops.composeMaps(h[1].map!, h[2].map!), dropped: (h[1].dropped ?? 0) + 1 }, ...h.slice(3)];
  }
  return h;
}

/** Undo (only while a step is available) and Reset, shown once there is an edit; a note says why when Undo is off for the tree or
 *  stops at a dropped step. */
function UndoControls(p: { canUndo: boolean; undoOn: boolean; onUndo: () => void; onReset: () => void }) {
  return (
    <>
      {p.canUndo && (
        <button type="button" className="ex-btn ex-fade" title="Undo last action" onClick={p.onUndo}>
          <I.IconUndo />
          Undo
        </button>
      )}
      <button type="button" className="ex-btn ex-fade" title="Back to the tree as published" onClick={p.onReset}>
        <J.IconReset />
        Reset
      </button>
      {!p.canUndo && (
        <span className="ex-undo-note">
          {p.undoOn ? 'Older steps were dropped to save memory' : 'Undo is off: the tree is too large to keep earlier versions'}
        </span>
      )}
      <div className="ex-divider" />
    </>
  );
}

// clamped: a slider that follows the view (Width / Height) can be past its range after a wheel zoom
const pct = (v: number, lo: number, hi: number) => `${Math.min(1, Math.max(0, (v - lo) / (hi - lo))) * 100}%`;
const sameWindow = (a: Viewport, b: Viewport) => a.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1;
const fmt = (x: number) => x.toFixed(6).replace(/\.?0+$/, '');
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** A pointer click on the triangle of a collapsed clade expands it (drill-down); a click on its branch, or Enter, opens its menu. */
const expandsOnClick = (e: TreeNodeEvent) => e.collapsed && e.kind === 'summary' && e.via === 'pointer' && !e.run;

/** The selected node (of the tree) in the ids of what is shown: itself, or the nearest ancestor the view keeps (collapse by support
 *  contracts inner nodes into their parent; the selection then moves to that clade, as the viewer's does to a collapsed clade). Null when
 *  nothing is selected or the view shows none of them. */
function shownSelection(selected: number | null, view: { toView: Int32Array } | null, parent: ArrayLike<number>): number | null {
  if (selected === null || !view) return selected;
  const toView = view.toView;
  for (let u = selected; u >= 0 && u < toView.length; u = parent[u]) if (toView[u] >= 0) return toView[u];
  return null;
}

/** Whether the "Scroll to zoom" hint is drawn. The rectangular one shares the bottom-right corner with the viewer's clade legend, so it gives way while that shows. */
function hintShown(gone: boolean, layout: Layout, legendOn: boolean, shownCladeCount: number): boolean {
  return !gone && (layout === 'radial' || !(legendOn && shownCladeCount > 0));
}

// What ladderise sorts by: 'height' is not on offer without branch lengths, so a tree without them falls back to tips.
function effectiveLadderBy(choice: LadderBy, hasLengths: boolean): LadderBy {
  return choice === 'height' && !hasLengths ? 'tips' : choice;
}

function LadderBySelect(p: { value: LadderBy; hasLengths: boolean; onChange: (by: LadderBy) => void }) {
  return (
    <select aria-label="Ladderize by" value={p.value} onChange={(e) => p.onChange(e.target.value as LadderBy)}>
      <option value="tips">tips</option>
      <option value="depth">depth</option>
      {p.hasLengths && <option value="height">height</option>}
    </select>
  );
}

// The Collapse by support control, with the divider before it. Not rendered at all for a tree without support values.
function SupportGroup(p: {
  range: { lo: number; hi: number } | null;
  step: number;
  threshold: number;
  active: boolean;
  collapsedCount: number;
  onToggle: () => void;
  onThreshold: (x: number) => void;
}) {
  if (!p.range) return null;
  return (
    <>
      <div className="ex-divider" />
      <div className="ex-support">
        <button
          type="button"
          className={`ex-btn ex-toggle${p.active ? ' active' : ''}`}
          aria-label="Collapse by support"
          aria-pressed={p.active}
          title="Collapse the branches with support below the threshold into polytomies. A view only: switch it off or lower the threshold to get them back. Clades you collapsed stay collapsed."
          onClick={p.onToggle}
        >
          <J.IconSupport />
          Support
        </button>
        {p.active && (
          <>
            <input
              className="ex-num"
              type="number"
              aria-label="Minimum support"
              title={`Support below this is collapsed (the tree's support runs ${p.range.lo} to ${p.range.hi})`}
              value={p.threshold}
              min={0}
              step={p.step}
              onChange={(e) => e.target.value !== '' && p.onThreshold(Number(e.target.value))}
            />
            <span className="ex-support-n" role="status">
              {p.collapsedCount ? `${p.collapsedCount.toLocaleString('en')} collapsed` : 'none below'}
            </span>
          </>
        )}
      </div>
    </>
  );
}

function Slider(p: {
  icon: React.ReactNode;
  label?: string;
  title: string;
  value: number;
  min: number;
  max: number;
  step: number;
  reset: number;
  width?: number;
  digits?: string;
  onChange(v: number): void;
}) {
  return (
    <div className="ex-slider-group" title={p.title}>
      <span className="ex-slider-icon">{p.icon}</span>
      {p.label && <span className="ex-slider-label">{p.label}</span>}
      <input
        className="ex-slider"
        type="range"
        aria-label={p.title}
        min={p.min}
        max={p.max}
        step={p.step}
        value={p.value}
        style={{ width: p.width, ['--ex-fill' as string]: pct(p.value, p.min, p.max) }}
        onChange={(e) => p.onChange(Number(e.target.value))}
        onDoubleClick={() => p.onChange(p.reset)}
      />
      <button type="button" className="ex-slider-val" onClick={() => p.onChange(p.reset)}>
        {p.value.toFixed(1)}
        {p.digits ?? '×'}
      </button>
    </div>
  );
}

/** Width / Height (Size in circular): Reactree stretches the drawing; here they are the visible window relative to the fitted one. They
 *  are read from the viewport in force, so they follow a wheel zoom, a pinch, the keyboard and Fit as well as setting the window
 *  themselves. Its own component, so that a pan or zoom (a `viewchange` per frame) renders the sliders and not the whole explorer. */
function SizeSliders({ viewer, radial }: { viewer: TreeViewer | null; radial: boolean }) {
  const vp = useViewport(viewer);
  const [fitted, setFitted] = useState<Viewport | null>(null);
  const readFit = useCallback(() => {
    if (!viewer) return;
    const f = viewer.fitViewport(); // the window fit() would go to, without moving
    setFitted((prev) => (prev && sameWindow(prev, f) ? prev : f));
  }, [viewer]);
  // The fitted window moves with the rows (the tree shown, collapsing), the layout, the tree type, the label size, the columns and the
  // pane's size. Read it again after every render (cheap, and an unchanged window is no new state) in a passive effect, which runs
  // after the <TreeView>'s layout effects have applied those changes, wherever it sits in the page.
  useEffect(readFit);
  useTreeEvent(viewer, 'resize', readFit); // the pane's size
  const hScale = fitted && vp ? (fitted.x1 - fitted.x0) / (vp.x1 - vp.x0) : 1;
  const vScale = radial ? hScale : fitted && vp ? (fitted.y1 - fitted.y0) / (vp.y1 - vp.y0) : 1;
  // an axis at 1x goes back to the fitted window's centre; one zoomed keeps the current centre
  const setScales = (h: number, v: number) => {
    const f = fitted;
    if (!viewer || !f || !vp) return;
    const cx = h === 1 ? (f.x0 + f.x1) / 2 : (vp.x0 + vp.x1) / 2;
    const cy = v === 1 ? (f.y0 + f.y1) / 2 : (vp.y0 + vp.y1) / 2;
    const w = (f.x1 - f.x0) / h;
    const hh = (f.y1 - f.y0) / v;
    viewer.setViewport({ x0: cx - w / 2, x1: cx + w / 2, y0: cy - hh / 2, y1: cy + hh / 2 });
  };
  return (
    <>
      <Slider
        icon={<I.IconWidth />}
        label={radial ? 'Size' : 'Width'}
        title="Width"
        value={hScale}
        min={0.3}
        max={4}
        step={0.05}
        reset={1}
        onChange={(h) => setScales(h, radial ? h : vScale)}
      />
      {!radial && (
        <>
          <div className="ex-divider" />
          <Slider
            icon={<I.IconHeight />}
            title="Height"
            label="Height"
            value={vScale}
            min={0.3}
            max={4}
            step={0.05}
            reset={1}
            onChange={(v) => setScales(hScale, v)}
          />
        </>
      )}
    </>
  );
}

export function Explorer({
  published,
  fasta,
  defaultHeight = 520,
  undoBudget = UNDO_BUDGET,
}: {
  published: TreeModel;
  fasta: Record<string, string> | null;
  defaultHeight?: number;
  /** Bytes the trees kept for Undo may take ({@link UNDO_BUDGET}); a tree larger than this has Reset only. */
  undoBudget?: number;
}) {
  const ref = useRef<TreeViewHandle>(null);
  // the viewer as state, and the theme in force: React follows every theme change, whoever made it (the viewport is read by
  // <SizeSliders> alone, so a pan or zoom renders only the sliders)
  const viewer = useTreeViewer(ref);
  const treeTheme = useTreeTheme(viewer);
  const outer = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<Step[]>([{ tree: published, clades: [], collapsed: [] }]);
  const tree = history[history.length - 1].tree;
  // Undo needs one more tree in memory than Reset: off when even one does not fit; it stops at a step whose earlier steps were dropped
  const undoOn = useMemo(() => ops.treeBytes(published) <= undoBudget, [published, undoBudget]);
  const canUndo = undoOn && history.length > 1 && !history[history.length - 1].dropped;
  // the last change of `tree` and the map it came with (edit: the op's map; undo: its inverse), to keep the view across it
  const [move, setMove] = useState<{ from: TreeModel; to: TreeModel; map: Int32Array } | null>(null);
  const [clades, setClades] = useState<CladeProp[]>([]);
  const [collapsed, setCollapsed] = useState<number[]>([]); // clades the user collapsed (ids of `tree`)
  const [focus, setFocus] = useState<ops.Focus>(ops.NO_FOCUS); // the clade shown alone, with Back and Up one level (tree-ops focus)
  const [supportOn, setSupportOn] = useState(false); // collapse the branches below `minSupport` (a view, tree-ops collapseBySupport)
  const [minSupport, setMinSupport] = useState<number | null>(null); // null: the default for the tree's support scale
  const [ladderByChoice, setLadderBy] = useState<LadderBy>('tips');
  const [highlightStyle, setHighlightStyle] = useState<HighlightStyle>('dim');
  const [supportPercent, setSupportPercent] = useState(false);
  const [showOverview, setShowOverview] = useState(false);
  // the "Scroll to zoom · Drag to pan" hint goes for good once the user zooms or pans (a wheel turn, a drag or pinch, a zoom or arrow key);
  // a click does not count, and a new tree or layout does not bring it back
  const [hintGone, setHintGone] = useState(false);
  const dismissHint = () => setHintGone(true);
  const dragFrom = useRef<{ x: number; y: number } | null>(null); // where a drag in the pane began (not on the resize grip)
  const [showLegend, setShowLegend] = useState(true); // the clade legend: hidden by itself while no clade is coloured

  const [fontScale, setFontScale] = useState(1);
  const [strokeWidth, setStrokeWidth] = useState(1.5);
  const [layout, setLayout] = useState<Layout>('rectangular');
  const [phylogram, setPhylogram] = useState(true);
  const [truncate, setTruncate] = useState(true);
  const [labelMode, setLabelMode] = useState<NodeLabelMode>('none');
  const [showAlignment, setShowAlignment] = useState(false);
  const [alignLabels, setAlignLabels] = useState(false);

  const [mode, setMode] = useState<Mode>('none');
  const [swapFirst, setSwapFirst] = useState<number | null>(null);
  const [activeColor, setActiveColor] = useState('Red');
  const [hoveredSwatch, setHoveredSwatch] = useState<string | null>(null);
  const [pickAt, setPick] = useState<{ node: number; x: number; y: number } | null>(null); // the node (of `tree`) the menu's Colour… is for, and where the palette opens (px in the component)
  const pick = pickAt?.node ?? null;

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchIdx, setMatchIdx] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);

  // the selected node (of `tree`): the viewer's selection (a click selects, Info opens the inspector on it). It stays across layout and
  // tree type switches, which centre the view on it; an edit, Undo or a navigation clears it
  const [selected, setSelected] = useState<number | null>(null);
  const [infoOpen, setInfoOpen] = useState(false); // the inspector shows `selected`
  const deselect = () => {
    setSelected(null);
    setInfoOpen(false);
  };
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [height, setHeight] = useState(defaultHeight);

  // ---- what is shown: a VIEW of the current tree, not a step in its history. First the clade shown alone (focus), then the branches
  // below the support threshold collapsed (collapseBySupport). Both make a different tree, so node ids shift: `toView` maps a node of
  // `tree` to the view (-1: hidden), `toTree` the other way. The clades the user collapsed are NOT part of it: the viewer collapses them
  // on the tree it is given (`collapsed` below, in the view's ids), and collapseBySupport leaves them alone (`keep`).
  const supportRange = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of tree.support) {
      if (Number.isNaN(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return lo <= hi ? { lo, hi } : null;
  }, [tree]);
  const hasSupport = supportRange !== null;
  const supportStep = supportRange && supportRange.hi <= 1 ? 0.05 : 1; // files differ: 0.95 or 95
  const threshold = minSupport ?? (supportStep < 1 ? 0.7 : 70);
  const supportActive = supportOn && hasSupport;
  const ladderBy = effectiveLadderBy(ladderByChoice, tree.hasLengths);
  // Nodes collapse by support must keep (ids of `tree`): the clades collapsed by hand, which the viewer draws as one triangle, and the
  // coloured clades, which would vanish into their parent. Empty while it is off, so a collapse or a colour alone does not rebuild the view.
  const protectedNodes = useMemo(() => (supportActive ? [...collapsed, ...clades.map((c) => c.node)] : NO_NODES), [supportActive, collapsed, clades]);
  // a dated tree stays dated: the contracted edge's length goes to its children, so the time axis does not change
  const dated = useMemo(() => supportActive && tree.hasLengths && tree.isUltrametric(1e-3), [supportActive, tree]);
  const view = useMemo(() => {
    const acc: { shown: TreeModel; toView: Int32Array | null } = { shown: tree, toView: null }; // toView: tree -> shown, composed
    const step = (r: ops.OpResult) => {
      if (!r.changed) return false;
      acc.toView = acc.toView ? ops.composeMaps(acc.toView, r.map) : r.map;
      acc.shown = new TreeModel(r.tree);
      return true;
    };
    step(ops.showFocus(tree, focus));
    let supportCollapsed = 0;
    if (supportActive) {
      const before = acc.shown.nodeCount;
      // a clade the viewer collapses keeps its node (tree-ops' `keep`), in the ids of what is shown
      const keep = protectedNodes.map((v) => (acc.toView ? acc.toView[v] : v)).filter((k) => k > 0);
      if (step(ops.collapseBySupport(acc.shown, threshold, { keep, extend: dated }))) supportCollapsed = before - acc.shown.nodeCount;
    }
    const { shown, toView } = acc;
    if (!toView) return null;
    return { tree: shown, toView, toTree: ops.invertMap(toView, shown.nodeCount), supportCollapsed };
  }, [tree, focus, supportActive, threshold, protectedNodes, dated]);
  const shown = view?.tree ?? tree;
  // a node of what is shown -> the node of `tree` an action works on; -1 for an id the shown tree does not have. The hover box is rendered
  // with the last hover event, which can hold an id of the tree shown BEFORE Show only / Up / Back changed it.
  const toTree = (k: number) => {
    const v = view ? view.toTree[k] : k;
    return v === undefined || v < 0 || v >= tree.nodeCount ? -1 : v;
  };
  const selectedShown = shownSelection(selected, view, tree.parent);
  // Swap's first pick keeps a ring of its own (the viewer's marks) until the second click or Escape
  const swapShown = shownSelection(swapFirst, view, tree.parent);
  const marked = useMemo(() => (swapShown === null ? [] : [swapShown]), [swapShown]);
  const shownClades = useMemo(
    () =>
      view
        ? clades.flatMap((c) => {
            const k = view.toView[c.node];
            return k >= 0 ? [{ ...c, node: k }] : [];
          })
        : clades,
    [view, clades],
  );
  // the collapsed clades in the shown tree's ids (a clade that focus left out, or that collapse by support contracted into its parent, has none)
  const collapsedIds = useMemo(
    () => (view ? collapsed.map((v) => view.toView[v]) : collapsed).filter((k) => k > 0 && k < shown.nodeCount),
    [collapsed, view, shown],
  );

  // What the viewer is told when what is shown changes, so it keeps the view: shown (before) -> tree (before) -> tree (now) -> shown
  // (now), each leg a node map (an edit's, and the view's two). Changing the focus is a navigation: fitted, no map. The previous values
  // are kept in a ref written after the commit.
  const lastShown = useRef<{ shown: TreeModel; tree: TreeModel; focus: ops.Focus; toTree: Int32Array | null }>({
    shown,
    tree,
    focus,
    toTree: view?.toTree ?? null,
  });
  const treeMap = useMemo(() => {
    const prev = lastShown.current;
    if (prev.shown === shown) return undefined;
    let leg: Int32Array | null = null;
    if (prev.tree !== tree) {
      if (!move || move.from !== prev.tree || move.to !== tree) return undefined; // not an edit we know the map of: fit
      leg = move.map;
    } else if (prev.focus !== focus) return undefined;
    // compose only the legs there are (a missing one is the identity: no array of the tree's size is made for it)
    const legs = [prev.toTree, leg, view?.toView ?? null].filter((m): m is Int32Array => m !== null);
    if (legs.length === 0) return undefined;
    try {
      return legs.reduce((a, b) => ops.composeMaps(a, b));
    } catch {
      return undefined;
    }
  }, [shown, tree, view, focus, move]);
  useLayoutEffect(() => {
    lastShown.current = { shown, tree, focus, toTree: view?.toTree ?? null };
  }, [shown, tree, view, focus]);

  const hasTruncatable = useMemo(() => published.tipLabels.some((l) => l.length > TRUNCATE_AT), [published]);
  const formatLabel = useMemo(
    () => (id: string) => {
      const n = id.replace(/_/g, ' ');
      return truncate && n.length > TRUNCATE_AT ? n.slice(0, TRUNCATE_AT - 2) + '…' : n;
    },
    [truncate],
  );

  // ---- search: case-insensitive substring of the displayed name (Reactree's rule; an underscore and a space are the same); matches
  // highlighted, the current one centred. One regular expression over the labels, not a string rebuilt per label (about 0.1 s on 2.4
  // million labels), and every match kept: highlighting a million tips costs little (docs/design/highlight-cost.md, #58).
  const matches = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ _]/g, '[ _]'), 'i');
    // node ids, not labels: a label that several tips carry is several matches, each focused in turn and counted
    const out: number[] = [];
    const labels = shown.tipLabels;
    for (let r = 0; r < labels.length; r++) if (re.test(labels[r])) out.push(shown.tipNode[r]);
    return out;
  }, [query, shown]);
  const currentIdx = matches.length ? ((matchIdx % matches.length) + matches.length) % matches.length : -1;
  const current = currentIdx >= 0 ? matches[currentIdx] : null;
  const [focusSeq, setFocusSeq] = useState(0);
  useEffect(() => setFocusSeq((s) => s + 1), [current]);

  // ---- the alignment column (one `values` object per FASTA, so the viewer compiles it once)
  const alignment = useMemo(() => {
    if (!fasta) return null;
    const values: Record<string, string> = {};
    let matched = 0;
    let sites = 0;
    for (const l of published.tipLabels) {
      const sq = fasta[l];
      if (sq === undefined) continue;
      values[l] = sq;
      matched++;
      sites = Math.max(sites, sq.length);
    }
    const alphabet = detectAlphabet(Object.values(values)); // the column would pick the same; it is passed so the legend cannot disagree
    const column: Column = { id: 'alignment', kind: 'alignment', header: 'Alignment', width: 'fill', values, alphabet };
    return { column, matched, sites, alphabet };
  }, [fasta, published]);
  // the legend: the viewer's own table (default for dark or light, --phylo-residue-* overrides), one swatch per group. It reads the
  // residue colours of the theme in force, so it follows every theme change, whoever made it
  const legend = useMemo(() => {
    if (!alignment) return [];
    const colours = residueColours(treeTheme ?? {}, alignment.alphabet);
    return residueGroups(alignment.alphabet).map((g) => ({ label: g.label, colour: colours[g.residues[0]] }));
  }, [alignment, treeTheme]);
  const columns = useMemo(
    () => (showAlignment && alignment && layout === 'rectangular' ? [alignment.column] : []),
    [showAlignment, alignment, layout],
  );

  // ---- node labels: the viewer draws them (`nodeLabels`). 'support' reads `support` of the tree, which is the same for a support in
  // the labels (0.95, 100) and for one that load() copied there from an annotation (BEAST posterior). A collapsed clade shows its own
  // support or length on its stem.
  const nodeLabels = labelMode === 'bootstrap' ? 'support' : labelMode === 'branchlength' ? 'length' : 'none';
  // support as a percentage (0.95 as 95): a `formatNodeLabel`; a support above 1 is one already, and lengths keep the default
  const formatNodeLabel = useMemo(
    () =>
      supportPercent
        ? (v: number, kind: 'support' | 'length') => (kind === 'support' && v <= 1 ? String(Math.round(v * 100)) : defaultFormatNodeLabel(v, kind))
        : undefined,
    [supportPercent],
  );
  // the viewer's own overview and clade legend, over the tree; its zoom and fit buttons are not shown (the toolbar has Fit)
  const controls = useMemo(
    () => defaultControls({ zoom: false, fit: false, overview: showOverview, legend: showLegend }),
    [showOverview, showLegend],
  );

  // for the browser check (tests/browser/scripts/check-explorer.mjs): the viewer, to find where nodes are
  useEffect(() => {
    (window as unknown as { __explorer?: () => unknown }).__explorer = () => ref.current?.renderer() ?? null;
  }, []);
  // ... and the tree with its support (the viewer's snapshot has none), to pick a clade by its support
  const treeNow = useRef(tree);
  treeNow.current = tree;
  useEffect(() => {
    (window as unknown as { __explorerTree?: () => TreeModel }).__explorerTree = () => treeNow.current;
  }, []);

  const flash = (msg: string) => setToast(msg);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- edits: each returns a new tree (tree-ops), the step before is kept for Undo
  const apply = (op: (t: TreeModel) => ops.OpResult, what: string) => {
    let r: ops.OpResult;
    try {
      r = op(tree);
    } catch (err) {
      return flash(`${what}: ${(err as Error).message}`);
    }
    if (!r.changed) return flash(`${what}: nothing to change`);
    setSwapFirst(null);
    setPick(null);
    const next = new TreeModel(r.tree);
    const followedClades = ops.followClades(
      tree,
      next,
      r.map,
      clades.map((c) => c.node),
    );
    const keptClades = clades.flatMap((c, i) => {
      const m = followedClades[i].node;
      return m >= 0 ? [{ ...c, node: m }] : [];
    });
    const keptCollapsed = ops
      .followClades(tree, next, r.map, collapsed)
      .map((f) => f.node)
      .filter((m) => m > 0 && next.childCount[m] > 0);
    // so does the focus: navigation is not in the history, so Undo leaves it as it is (remapped through the inverse map). A focused
    // clade the edit split is gone from it (Back skips it)
    const remapped = ops.remapFocus(focus, tree, next, r.map);
    const keptFocus = remapped.stack.length === focus.stack.length && remapped.stack.every((v, i) => v === focus.stack[i]) ? focus : remapped; // same object while nothing changed
    const notes: string[] = [];
    if (keptClades.length < clades.length) notes.push(`${clades.length - keptClades.length} colour(s) removed: their tips are no longer one clade`);
    if (ops.focusedNode(focus) >= 0 && ops.focusedNode(keptFocus) < 0)
      notes.push('the clade shown alone is no longer one clade after this edit: showing the whole tree');
    if (notes.length) flash(notes.join(' · '));
    setHistory((h) =>
      trimHistory(
        [...h.slice(0, -1), { ...h[h.length - 1], clades, collapsed }, { tree: next, clades: keptClades, collapsed: keptCollapsed, map: r.map }],
        undoBudget,
      ),
    );
    setMove({ from: tree, to: next, map: r.map });
    setClades(keptClades);
    setCollapsed(keptCollapsed);
    setFocus(keptFocus);
    deselect();
  };
  // back to step `to` of the history: Undo is the step before the last, Reset the first (the tree as published)
  const back = (to: number) => {
    const prev = history[to];
    // the way back: the inverses of the edits' maps, last first, chained (a tip stays the tip it was; an edit that added nodes has none
    // to send back)
    let way: Int32Array | null = null;
    for (let k = history.length - 1; k > to; k--) {
      const inverse = ops.invertMap(history[k].map!, history[k].tree.nodeCount);
      way = way ? ops.composeMaps(way, inverse) : inverse;
    }
    if (way) {
      const w = way;
      setMove({ from: tree, to: prev.tree, map: w });
      setFocus((f) => (ops.canGoBack(f) || ops.canGoUp(f) ? ops.remapFocus(f, tree, prev.tree, w) : f)); // navigation stays; it follows the tips
    }
    setHistory((h) => h.slice(0, to + 1));
    setSwapFirst(null);
    setClades(prev.clades);
    setCollapsed(prev.collapsed);
    deselect();
    setPick(null);
  };
  const undo = () => back(history.length - 2);

  const closePick = () => {
    setPick(null);
    ref.current?.renderer()?.focus(); // back to the tree
  };
  const exitModes = () => {
    setMode('none');
    setSwapFirst(null);
  };
  const toggleMode = (m: Mode) => {
    setSwapFirst(null);
    setPick(null);
    setMode((cur) => (cur === m ? 'none' : m));
  };

  // ---- show only a clade: a navigation, not an edit, so it is not in the undo history. Back and Up one level come from tree-ops' focus.
  const navigate = (f: ops.Focus) => {
    setFocus(f);
    deselect();
    const v = ops.focusedNode(f);
    flash(v < 0 ? 'Showing the whole tree' : `Showing only a clade of ${tree.tipCountOf(v).toLocaleString('en')} tips`);
  };
  // ---- drill-down (#57): the overview of the clade shown (its largest clades open, the rest collapsed, about OVERVIEW_ROWS rows), and
  // on a collapsed clade expand in place (a click) or jump into it (Show only). tree-ops mergeAutoCollapse replaces the collapsed clades
  // inside the clade by its own overview and keeps the others. Rows are counted on `tree`, before collapse by support.
  const overviewOfShown = () => {
    const root = Math.max(0, ops.focusedNode(focus));
    const next = ops.mergeAutoCollapse(tree, collapsed, { root, maxRows: OVERVIEW_ROWS });
    // the clade shown alone stays collapsed in the view around it (as jumpInto leaves it), so Back returns to that view
    if (root > 0 && collapsed.includes(root)) {
      next.push(root);
      next.sort((a, b) => a - b);
    }
    setCollapsed(next);
    deselect();
    const n = next.filter((v) => v > root && v < tree.subtreeEnd[root]).length;
    flash(n ? `Overview: the largest clades open, ${n.toLocaleString('en')} collapsed. Click one to expand it` : 'The clade shown fits open');
  };
  /** Open the collapsed clade `v` (of `tree`) with its own overview of about EXPAND_ROWS rows inside. */
  const expandInPlace = (v: number) => setCollapsed((cs) => ops.mergeAutoCollapse(tree, cs, { root: v, maxRows: EXPAND_ROWS }));
  /** Show only the collapsed clade `v`, with its overview inside. It stays collapsed in the view around it, so Back returns to that view. */
  const jumpInto = (v: number) => {
    setCollapsed((cs) => [...ops.mergeAutoCollapse(tree, cs, { root: v, maxRows: OVERVIEW_ROWS }), v].sort((a, b) => a - b));
    navigate(ops.focusOn(tree, focus, v));
  };
  const colourOf = (name: string) => cssVar(`--ex-palette-${name.toLowerCase()}`);
  /** Paint (or with ERASE, unpaint) the clade `v` of `tree`. The label is left out: the legend then names the clade by its node. */
  const paint = (v: number, name: string) => {
    const rest = clades.filter((c) => c.node !== v);
    setClades(name === ERASE ? rest : [...rest, { node: v, colour: colourOf(name) }]);
  };
  /** Put text on the clipboard: the async API where there is one, else a hidden textarea and execCommand('copy'). */
  const copyText = async (text: string): Promise<boolean> => {
    const was = document.activeElement as HTMLElement | null; // the fallback selects a textarea: give the focus back after it
    try {
      await navigator.clipboard.writeText(text); // throws when there is no clipboard API (insecure page) or it is refused
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      was?.focus?.({ preventScroll: true });
      return ok;
    }
  };
  const copyNewick = (v: number) => {
    const text = toNewick(new TreeModel(ops.subtree(tree, v).tree));
    const n = tree.tipCountOf(v).toLocaleString('en');
    void copyText(text).then((ok) => {
      if (ok) return flash(`Copied the Newick of a clade of ${n} tips`);
      download(new Blob([text], { type: 'text/plain' }), 'clade.nwk'); // the clipboard is not available: offer the text as a file
      flash('The clipboard is not available here: downloaded the Newick of the clade as clade.nwk instead');
    });
  };

  // ---- clicks: with a tool active a click acts at once, as in Reactree. With none, the viewer's node menu opens (nodeMenu below).
  const onToolClick = (e: TreeNodeEvent) => {
    // a click on a collapsed clade expands it: no menu (its branch or Enter opens the menu), no selection
    if (mode === 'none' && expandsOnClick(e)) {
      e.preventDefault();
      const v = toTree(e.node);
      if (v >= 0) expandInPlace(v);
      return;
    }
    if (mode !== 'none') e.preventDefault(); // a tool acts on the click: it neither selects nor opens the menu
    onClick(e);
  };
  const onClick = (e: TreeNodeEvent) => {
    if (e.run) return flash('Zoom in: this is a run of small clades drawn as one');
    const v = toTree(e.node);
    if (v < 0) return;
    switch (mode) {
      case 'reroot':
        if (v === 0) return flash('Already the root');
        if (ops.canGoUp(focus) && e.node !== 0) return flash(REROOT_IN_FOCUS);
        return apply((t) => ops.reroot(t, v), 'Reroot');
      case 'flip':
        if (e.isTip) return flash('Flip needs an internal node');
        return apply((t) => ops.rotate(t, v), 'Flip');
      case 'swap': {
        if (v === 0) return flash('The root has no sibling');
        if (swapFirst === null) return setSwapFirst(v);
        const a = swapFirst;
        setSwapFirst(null);
        if (a === v) return;
        if (tree.parent[a] !== tree.parent[v]) return flash('Swap needs two sibling branches');
        return apply((t) => ops.swap(t, a, v), 'Swap');
      }
      case 'color':
        return paint(v, activeColor);
    }
  };

  // the node menu: what a click on this tip or clade offers. Not while a tool is active, which acts on the click itself.
  const nodeMenu = (e: TreeNodeEvent): NodeMenuItem[] | null => {
    const v = toTree(e.node);
    if (mode !== 'none' || e.run || v < 0) return null;
    const isTip = e.isTip;
    const isCollapsed = e.collapsed;
    const shownRoot = e.node === 0; // the root of what is shown: the tree's, or the clade shown alone
    const trueRoot = v === 0;
    const info: NodeMenuItem = {
      id: 'info',
      label: 'Info',
      onSelect: () => {
        setSelected(v);
        setInfoOpen(true);
      },
    };
    const expand: NodeMenuItem = {
      id: 'expand',
      label: 'Expand',
      onSelect: () => setCollapsed((cs) => cs.filter((c) => c !== v)), // the whole clade, unlike a click on it (expandInPlace)
    };
    const collapse: NodeMenuItem = {
      id: 'collapse',
      label: 'Collapse',
      onSelect: () => setCollapsed((cs) => [...cs, v]),
    };
    const only: NodeMenuItem = {
      id: 'subtree',
      label: 'Show only',
      onSelect: () => navigate(ops.focusOn(tree, focus, v)),
    };
    const reroot: NodeMenuItem = {
      id: 'reroot',
      label: 'Reroot here',
      onSelect: () => apply((t) => ops.reroot(t, v), 'Reroot'),
    };
    const flip: NodeMenuItem = {
      id: 'flip',
      label: 'Flip',
      onSelect: () => apply((t) => ops.rotate(t, v), 'Flip'),
    };
    const swap: NodeMenuItem = {
      id: 'swap',
      label: 'Swap with…',
      disabled: tree.childCount[tree.parent[v]] < 2,
      onSelect: () => {
        setMode('swap');
        setSwapFirst(v);
        flash('Now click a sibling branch to swap with'); // what the item's label leaves out
      },
    };
    const colour: NodeMenuItem = {
      id: 'colour',
      label: 'Colour…',
      onSelect: (ev) => {
        const r = outer.current?.getBoundingClientRect();
        setPick({ node: v, x: r ? ev.clientX - r.left : 16, y: r ? ev.clientY - r.top : 92 });
      },
    };
    const copy: NodeMenuItem = { id: 'copy', label: 'Copy Newick', onSelect: () => copyNewick(v) };
    if (isCollapsed) return [expand, info, { ...only, onSelect: () => jumpInto(v) }, colour];
    // inside a clade shown alone a reroot would split it (REROOT_IN_FOCUS): the menu leaves it out there
    const canReroot = !ops.canGoUp(focus) || shownRoot;
    if (isTip) return canReroot ? [info, reroot, swap, colour] : [info, swap, colour];
    const items: NodeMenuItem[] = [];
    // the root of a clade shown alone leads out of it
    if (shownRoot && ops.canGoUp(focus)) {
      items.push({
        id: 'up',
        label: 'Up one level',
        onSelect: () => navigate(ops.focusUp(tree, focus)),
      });
      items.push({ id: 'back', label: 'Back', onSelect: () => navigate(ops.focusBack(focus)) });
    }
    items.push(info);
    if (trueRoot) return [...items, flip, colour];
    // the root of what is shown is not collapsed or shown alone again
    if (!shownRoot) items.push(collapse, only);
    if (canReroot) items.push(reroot);
    items.push(flip, swap, colour, copy);
    return items;
  };

  // the hover box says what a click would do
  const tooltip = (e: TreeNodeEvent) => {
    const v = toTree(e.node);
    if (e.run || v < 0) return null;
    const name = e.isTip ? formatLabel(tree.labels[v]) : `${tree.tipCountOf(v)} tips`;
    const tag = (cls: string, icon: React.ReactNode, text: React.ReactNode) => (
      <span className={`ex-tip ex-tip--${cls}`}>
        {icon}
        {text}
        <span className="ex-tip-name">{name}</span>
      </span>
    );
    switch (mode) {
      case 'reroot':
        return tag('reroot', <I.IconReroot size={11} />, 'Set as root');
      case 'flip':
        return tag('flip', <I.IconFlip />, 'Flip subtree');
      case 'swap':
        return tag(
          'swap',
          <span className="ex-tip-step">{swapFirst === null ? '1/2' : '2/2'}</span>,
          swapFirst === null ? 'Select first branch' : 'Swap with…',
        );
      case 'color':
        return tag(
          'color',
          <span
            className="ex-tip-dot"
            style={{ background: activeColor === ERASE ? 'var(--ex-muted)' : `var(--ex-palette-${activeColor.toLowerCase()})` }}
          />,
          activeColor === ERASE ? 'Erase color' : `Paint ${activeColor}`,
        );
      default:
        return (
          <span className="ex-tip ex-tip--menu">
            {expandsOnClick(e) ? 'Click to expand' : 'Click for actions'}
            <span className="ex-tip-name">{e.collapsed ? `${name} (collapsed)` : name}</span>
          </span>
        );
    }
  };

  // ---- keyboard, as Reactree: Ctrl/Cmd+F search, Ctrl/Cmd+Z undo, Escape leaves a mode or closes a panel (only while focus is in here)
  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      setSearchOpen(true);
      searchInput.current?.focus(); // already open; a new panel focuses itself (autoFocus)
    } else if (mod && e.key.toLowerCase() === 'z' && canUndo) {
      e.preventDefault();
      undo();
    } else if (e.key === 'Escape') {
      if (pick !== null) closePick();
      else if (mode !== 'none') exitModes();
      else if (searchOpen) closeSearch();
      else setInfoOpen(false);
    }
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery('');
    setMatchIdx(0);
  };

  // ---- export: PNG is the viewer's toBlob; Newick and NEXUS through @gbif-phylo/io
  const download = (blob: Blob, name: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const exportPng = (scale: 1 | 2 | 4) => {
    // the view as an image, `scale` canvas pixels per CSS pixel, on the theme's background (the pane's grey), as on screen
    ref.current
      ?.renderer()
      ?.toBlob({ scale })
      .then((b) => download(b, scale === 1 ? 'phylotree.png' : `phylotree@${scale}x.png`))
      .catch((err) => flash(`PNG export at ${scale}×: ${(err as Error).message}`));
  };
  const exportText = (text: string, name: string) => download(new Blob([text], { type: 'text/plain' }), name);

  // close the export menu on a press outside it
  const exportRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!downloadOpen) return;
    const f = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!exportRef.current?.contains(t) && !menuRef.current?.contains(t)) setDownloadOpen(false);
    };
    document.addEventListener('pointerdown', f);
    return () => document.removeEventListener('pointerdown', f);
  }, [downloadOpen]);

  // ---- resize handle: drag the bottom edge of the pane
  const onResizeDown = (e: React.PointerEvent) => {
    const y0 = e.clientY;
    const h0 = height;
    const move = (m: PointerEvent) => setHeight(Math.max(240, h0 + m.clientY - y0));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---- inspector rows for a node of `tree`
  const inspector = useMemo(() => {
    const info = infoOpen ? selected : null;
    if (info === null || info >= tree.nodeCount) return null;
    let root = 0;
    let any = false;
    for (let u = info; u > 0; u = tree.parent[u])
      if (!Number.isNaN(tree.length[u])) {
        root += tree.length[u];
        any = true;
      }
    const isTip = tree.childCount[info] === 0;
    const sup = isTip ? (info > 0 ? tree.support[tree.parent[info]] : NaN) : tree.support[info];
    return {
      name: isTip ? tree.labels[info] : splitInternalLabel(tree.labels[info]).name || `Clade of ${tree.tipCountOf(info)} tips`,
      raw: tree.labels[info],
      branch: Number.isNaN(tree.length[info]) ? null : tree.length[info],
      root: any ? root : null,
      depth: tree.depth[info],
      support: Number.isNaN(sup) ? null : sup,
    };
  }, [infoOpen, selected, tree]);

  const labelCycle: NodeLabelMode[] = ['none', ...(hasSupport ? ['bootstrap' as const] : []), ...(tree.hasLengths ? ['branchlength' as const] : [])];
  const nextLabel = labelCycle[(labelCycle.indexOf(labelMode) + 1) % labelCycle.length];
  const theme = useMemo(
    () => ({ labelSize: 11.5 * fontScale, branchWidth: strokeWidth, cladeBranchWidth: strokeWidth + 0.7 }),
    [fontScale, strokeWidth],
  );
  const activeHex = activeColor === ERASE ? 'var(--ex-muted)' : `var(--ex-palette-${activeColor.toLowerCase()})`;
  const feedback = hoveredSwatch ?? (activeColor === ERASE ? 'Erase' : activeColor);

  return (
    <div className={`ex-outer ex-mode-${mode}`} ref={outer} onKeyDown={onKeyDown}>
      {/* ── Row 1: view settings ── */}
      <Scroller className="ex-row" role="toolbar" aria-label="View">
        <SizeSliders viewer={viewer} radial={layout === 'radial'} />
        <div className="ex-divider" />
        <Slider
          icon={<I.IconFont />}
          title="Font size"
          value={fontScale}
          min={0.5}
          max={2.5}
          step={0.05}
          reset={1}
          width={64}
          onChange={setFontScale}
        />
        <Slider
          icon={<I.IconBranchWidth />}
          title="Branch width"
          value={strokeWidth}
          min={0.5}
          max={4}
          step={0.1}
          reset={1.5}
          width={64}
          digits=""
          onChange={setStrokeWidth}
        />
        <div className="ex-divider" />
        <div className="ex-group">
          <button
            type="button"
            className={layout === 'rectangular' ? 'active' : ''}
            aria-pressed={layout === 'rectangular'}
            title="Rectangular"
            onClick={() => setLayout('rectangular')}
          >
            <I.IconRect />
          </button>
          <button
            type="button"
            className={layout === 'radial' ? 'active' : ''}
            aria-pressed={layout === 'radial'}
            title="Circular"
            onClick={() => setLayout('radial')}
          >
            <I.IconCirc />
          </button>
        </div>
        <div className="ex-divider" />
        <div className="ex-group">
          <button
            type="button"
            className={phylogram ? 'active' : ''}
            aria-pressed={phylogram}
            disabled={!tree.hasLengths}
            title="Phylogram — branch lengths proportional"
            onClick={() => setPhylogram(true)}
          >
            <I.IconPhylo />
          </button>
          <button
            type="button"
            className={!phylogram ? 'active' : ''}
            aria-pressed={!phylogram}
            title="Cladogram — topology only"
            onClick={() => setPhylogram(false)}
          >
            <I.IconClado />
          </button>
        </div>
        {hasTruncatable && (
          <>
            <div className="ex-divider" />
            <button
              type="button"
              className={`ex-btn ex-toggle${truncate ? ' active' : ''}`}
              title={truncate ? 'Names truncated — click to show full names' : 'Full names shown — click to truncate'}
              onClick={() => setTruncate((t) => !t)}
            >
              <I.IconTruncate />
              {truncate ? 'Truncate' : 'Full names'}
            </button>
          </>
        )}
        <div className="ex-spacer" />
        <button
          type="button"
          className={`ex-btn ex-toggle${showOverview ? ' active' : ''}`}
          aria-label="Overview"
          aria-pressed={showOverview}
          title="Overview: the whole tree in small, with the window you are looking at"
          onClick={() => setShowOverview((o) => !o)}
        >
          <J.IconOverview />
        </button>
        <button
          type="button"
          className={`ex-btn ex-toggle${showLegend ? ' active' : ''}`}
          aria-label="Legend"
          aria-pressed={showLegend}
          title="Legend: the coloured clades, by name (appears when a clade is coloured)"
          onClick={() => setShowLegend((l) => !l)}
        >
          <J.IconLegend />
        </button>
        <div className="ex-pinned">
          <button
            type="button"
            className={`ex-btn${searchOpen ? ' ex-search-active' : ''}`}
            aria-label="Search tips"
            title="Search tips (⌘F)"
            onClick={() => {
              if (searchOpen) return closeSearch();
              setSearchOpen(true);
              searchInput.current?.focus(); // already open; a new panel focuses itself (autoFocus)
            }}
          >
            <I.IconSearch />
          </button>
          <div className="ex-divider" />
          <div className="ex-export" ref={exportRef}>
            <button
              type="button"
              className={`ex-btn${downloadOpen ? ' open' : ''}`}
              aria-haspopup="menu"
              aria-expanded={downloadOpen}
              title="Export tree"
              onClick={() => setDownloadOpen((o) => !o)}
            >
              <I.IconExport />
              Export
              <I.IconChevronDown />
            </button>
          </div>
        </div>
      </Scroller>

      {/* ── Row 2: interaction tools ── */}
      <Scroller className="ex-row" role="toolbar" aria-label="Edit">
        {history.length > 1 && <UndoControls canUndo={canUndo} undoOn={undoOn} onUndo={undo} onReset={() => back(0)} />}
        <button type="button" className="ex-btn" title="Fit tree" onClick={() => viewer?.fit(false)}>
          <J.IconFit />
          Fit
        </button>
        {(ops.canGoBack(focus) || ops.canGoUp(focus)) && (
          <>
            <div className="ex-group" role="group" aria-label="Clade shown">
              <button
                type="button"
                disabled={!ops.canGoBack(focus)}
                title="Back to the view before (Show only this clade / Up one level)"
                onClick={() => navigate(ops.focusBack(focus))}
              >
                <J.IconBack />
                Back
              </button>
              <button
                type="button"
                disabled={!ops.canGoUp(focus)}
                title="Up one level: show the clade that contains the one shown"
                onClick={() => navigate(ops.focusUp(tree, focus))}
              >
                <J.IconUpLevel />
                Up one level
              </button>
            </div>
            <span className="ex-chip" title="Only this clade is shown">
              <J.IconSubtree />
              {ops.canGoUp(focus) ? (
                <span>
                  Clade of <span className="ex-mono">{shown.tipCount.toLocaleString('en')}</span> tips
                </span>
              ) : (
                'Whole tree'
              )}
            </span>
          </>
        )}
        <div className="ex-divider" />
        <button
          type="button"
          className={`ex-btn ex-tool${mode === 'reroot' ? ' active' : ''}`}
          aria-pressed={mode === 'reroot'}
          title={mode === 'reroot' ? 'Exit reroot mode (Esc)' : 'Reroot — click any node'}
          onClick={() => toggleMode('reroot')}
        >
          <I.IconReroot />
          {mode === 'reroot' ? (
            <>
              Click… <span className="ex-dot" />
            </>
          ) : (
            'Reroot'
          )}
        </button>
        <button
          type="button"
          className="ex-btn ex-tool"
          disabled={!tree.hasLengths}
          title={tree.hasLengths ? 'Midpoint root — place root at the midpoint of the longest path' : 'Midpoint root requires branch lengths'}
          onClick={() => {
            exitModes();
            apply(ops.midpointRoot, 'Midpoint');
          }}
        >
          <I.IconMidpoint />
          Midpoint
        </button>
        <button
          type="button"
          className={`ex-btn ex-tool${mode === 'flip' ? ' active' : ''}`}
          aria-pressed={mode === 'flip'}
          title={mode === 'flip' ? 'Exit flip mode (Esc)' : 'Flip — reverse children order at a node'}
          onClick={() => toggleMode('flip')}
        >
          <I.IconFlip />
          Flip
          {mode === 'flip' && <span className="ex-dot" />}
        </button>
        <button
          type="button"
          className={`ex-btn ex-tool${mode === 'swap' ? ' active' : ''}`}
          aria-pressed={mode === 'swap'}
          title={mode === 'swap' ? 'Exit swap mode (Esc)' : 'Swap — exchange two sibling branches'}
          onClick={() => toggleMode('swap')}
        >
          <I.IconSwap />
          Swap
          {mode === 'swap' && (
            <span className="ex-steps">
              <span className={swapFirst === null ? 'on' : 'done'}>1</span>→<span className={swapFirst !== null ? 'on' : ''}>2</span>
            </span>
          )}
        </button>
        <button
          type="button"
          className={`ex-btn ex-color${mode === 'color' ? ' active' : ''}`}
          aria-pressed={mode === 'color'}
          title={mode === 'color' ? 'Exit color mode (Esc)' : 'Color clades, branches & leaves'}
          style={mode === 'color' ? ({ '--ex-active': activeHex } as React.CSSProperties) : undefined}
          onClick={() => toggleMode('color')}
        >
          <I.IconPalette />
          Color
          {mode === 'color' && <span className="ex-color-dot" style={{ background: activeHex }} />}
          {mode !== 'color' && clades.length > 0 && <span className="ex-count">{clades.length}</span>}
        </button>
        <div className="ex-divider" />
        <div className="ex-group">
          <button
            type="button"
            title={`Ladderize ascending by ${ladderBy} — smallest clades at top`}
            onClick={() => apply((t) => ops.ladderise(t, { by: ladderBy }), 'Ladderize')}
          >
            <J.IconLadderBy />
          </button>
          <button
            type="button"
            title={`Ladderize descending by ${ladderBy} — largest clades at top`}
            onClick={() => apply((t) => ops.ladderise(t, { by: ladderBy, order: 'decreasing' }), 'Ladderize')}
          >
            <J.IconLadderBy descending />
          </button>
          <label
            className="ex-group-select"
            title="What ladderise sorts the clades by: tips (number of descendants), depth (most nested path) or height (longest path, in branch length)"
          >
            <LadderBySelect value={ladderBy} hasLengths={tree.hasLengths} onChange={setLadderBy} />
          </label>
        </div>
        <SupportGroup
          range={supportRange}
          step={supportStep}
          threshold={threshold}
          active={supportActive}
          collapsedCount={view?.supportCollapsed ?? 0}
          onToggle={() => setSupportOn((o) => !o)}
          onThreshold={setMinSupport}
        />
        {(collapsed.length > 0 || shown.tipCount > OVERVIEW_ROWS) && <div className="ex-divider" />}
        {shown.tipCount > OVERVIEW_ROWS && (
          <button
            type="button"
            className="ex-btn ex-clades"
            title={`Collapse the clade shown to about ${OVERVIEW_ROWS} rows, its largest clades open. Click a collapsed clade to expand it; Show only in its menu (its branch, or Enter) jumps into it`}
            onClick={overviewOfShown}
          >
            <J.IconClades />
            Overview: {OVERVIEW_ROWS} clades
          </button>
        )}
        {collapsed.length > 0 && (
          <>
            <button
              type="button"
              className="ex-btn ex-expand"
              title={`Expand all collapsed clades (${collapsed.length})`}
              onClick={() => setCollapsed([])}
            >
              <I.IconExpandAll />
              Expand all
              <span className="ex-count">{collapsed.length}</span>
            </button>
          </>
        )}
        <div className="ex-spacer" />
        {alignment && layout === 'rectangular' && (
          <button
            type="button"
            className={`ex-btn ex-toggle${showAlignment ? ' active' : ''}`}
            title={showAlignment ? 'Hide alignment track' : 'Show alignment alongside leaf nodes'}
            onClick={() => setShowAlignment((s) => !s)}
          >
            <I.IconAlnTrack />
            Alignment
          </button>
        )}
        {phylogram && tree.hasLengths && (
          <button
            type="button"
            className={`ex-btn ex-toggle${alignLabels ? ' active' : ''}`}
            aria-pressed={alignLabels}
            title={
              alignLabels
                ? 'Labels follow their tips'
                : `Align leaf labels ${layout === 'radial' ? 'on one circle' : 'in one column'}, with leader lines`
            }
            onClick={() => setAlignLabels((a) => !a)}
          >
            <I.IconAlignLabels />
            Align
          </button>
        )}
        {labelCycle.length > 1 && (
          <button
            type="button"
            className={`ex-btn ex-toggle ex-labels${labelMode !== 'none' ? ' active' : ''}`}
            title={`Node labels: ${labelMode === 'none' ? 'hidden' : labelMode === 'bootstrap' ? 'support values' : 'branch lengths'} — click to cycle`}
            onClick={() => setLabelMode(nextLabel)}
          >
            {labelMode === 'bootstrap' ? <I.IconBootstrap /> : labelMode === 'branchlength' ? <I.IconBranchLen /> : <I.IconLabelsOff />}
            {labelMode === 'bootstrap' ? 'Bootstrap' : labelMode === 'branchlength' ? 'Length' : 'No labels'}
          </button>
        )}
        {labelMode === 'bootstrap' && (
          <button
            type="button"
            className={`ex-btn ex-toggle${supportPercent ? ' active' : ''}`}
            aria-label="Support as percent"
            aria-pressed={supportPercent}
            title={supportPercent ? 'Support shown as a percentage (95)' : 'Show support as a percentage (0.95 as 95)'}
            onClick={() => setSupportPercent((p) => !p)}
          >
            <J.IconPercent />%
          </button>
        )}
      </Scroller>

      {/* ── Body: the tree ── */}
      <div
        className="ex-pane"
        style={{ height }}
        onWheel={dismissHint}
        onPointerDown={(e) => {
          dragFrom.current = (e.target as Element).closest('.ex-resize') ? null : { x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          const d = dragFrom.current;
          if (d && e.buttons > 0 && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) dismissHint();
        }}
        onPointerUp={() => (dragFrom.current = null)}
        onKeyDown={(e) => ['+', '=', '-', '_'].includes(e.key) && dismissHint()}
      >
        <TreeView
          ref={ref}
          tree={shown}
          treeMap={treeMap}
          layout={layout}
          branchLengths={phylogram}
          clades={shownClades}
          highlighted={matches}
          collapsed={collapsedIds}
          columns={columns}
          controls={controls}
          theme={theme}
          focus={current ? { tipId: current, seq: focusSeq } : null}
          selected={selectedShown}
          marked={marked}
          onSelectionChange={(k) => setSelected(k === null || toTree(k) < 0 ? null : toTree(k))}
          options={{
            formatLabel,
            labelDensity: 'dense',
            highlightStyle,
            // summaries are at most about minCladePx tall, and only ones with room for two stripes get any: on a big tree, whose summaries are
            // many, raise it (a small tree keeps every tip)
            minCladePx: tree.tipCount > 1500 ? 14 : undefined,
            alignLabels,
            nodeLabels,
            formatNodeLabel,
            // with the alignment shown, the tree takes 40% of the width and the 'fill' column the rest
            treeWidth: columns.length ? '40%' : undefined,
            themeObserver: 'document',
            // the hover ring grows in, as in Reactree (the default; said here as the look depends on it)
            hoverAnimation: true,
          }}
          tooltip={tooltip}
          tooltipBare
          nodeMenu={nodeMenu}
          onNodeClick={onToolClick}
          onTipClick={onToolClick}
        />

        {searchOpen && (
          <div className="ex-search">
            <span className="ex-search-icon">
              <I.IconSearch />
            </span>
            <input
              ref={searchInput}
              autoFocus
              type="text"
              aria-label="Search tips"
              placeholder="Search tips…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMatchIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'Enter') {
                  e.preventDefault();
                  setMatchIdx((i) => i + 1);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMatchIdx((i) => i - 1);
                }
              }}
            />
            {query.trim() && (
              <span className={`ex-search-count${matches.length ? '' : ' none'}`}>
                {matches.length ? `${(currentIdx + 1).toLocaleString('en')} / ${matches.length.toLocaleString('en')}` : 'No match'}
              </span>
            )}
            {matches.length > 1 && (
              <span className="ex-search-nav">
                <button type="button" title="Previous match (↑)" onClick={() => setMatchIdx((i) => i - 1)}>
                  <I.IconUp />
                </button>
                <button type="button" title="Next match (↓ or Enter)" onClick={() => setMatchIdx((i) => i + 1)}>
                  <I.IconDown />
                </button>
              </span>
            )}
            <label className="ex-select ex-select--bare" title="How the matches show: a band on the row, everything else dimmed, or both">
              <J.IconHighlight />
              <select aria-label="Highlight style" value={highlightStyle} onChange={(e) => setHighlightStyle(e.target.value as HighlightStyle)}>
                <option value="band">band</option>
                <option value="dim">dim</option>
                <option value="both">both</option>
              </select>
            </label>
            <button type="button" className="ex-search-close" title="Close search (Esc)" onClick={closeSearch}>
              <I.IconClose />
            </button>
          </div>
        )}

        {inspector && (
          <div className="ex-info" role="dialog" aria-label="Node information">
            <div className="ex-info-head">
              <span className="ex-info-name">{inspector.name.replace(/_/g, ' ')}</span>
              <button type="button" title="Close" onClick={() => setInfoOpen(false)}>
                <I.IconClose />
              </button>
            </div>
            <dl className="ex-info-rows">
              {inspector.branch !== null && (
                <>
                  <dt>Branch length</dt>
                  <dd>{fmt(inspector.branch)}</dd>
                </>
              )}
              {inspector.root !== null && (
                <>
                  <dt>Root distance</dt>
                  <dd>{fmt(inspector.root)}</dd>
                </>
              )}
              <dt>Depth</dt>
              <dd>{inspector.depth}</dd>
              {inspector.support !== null && (
                <>
                  <dt>Bootstrap</dt>
                  <dd>{inspector.support}</dd>
                </>
              )}
            </dl>
            <button
              type="button"
              className="ex-info-copy"
              title="Copy raw taxon name"
              onClick={() => void navigator.clipboard?.writeText(inspector.raw)}
            >
              <I.IconCopy />
              Copy name
            </button>
          </div>
        )}

        {toast && (
          <div className="ex-toast" role="status">
            {toast}
          </div>
        )}
        {/* the viewer's clade legend is bottom right too, and grows with its entries: the rectangular hint (also bottom right) gives way to it.
            The radial hint is bottom left, clear of it. */}
        {hintShown(hintGone, layout, showLegend, shownClades.length) && (
          <div className={`ex-hint ex-hint--${layout}`}>Scroll to zoom · Drag to pan</div>
        )}
        <div className="ex-resize" title="Drag to resize" onPointerDown={onResizeDown}>
          <div className="ex-grip" />
        </div>
      </div>

      {columns.length > 0 && alignment && (
        <div className="ex-legend">
          <span className={`ex-legend-type${alignment.alphabet === 'protein' ? ' aa' : ''}`}>{alignment.alphabet === 'protein' ? 'AA' : 'NT'}</span>
          <span className="ex-legend-meta">
            {alignment.sites.toLocaleString('en')} sites · {alignment.matched} of {published.tipCount} tips matched
          </span>
          <span className="ex-legend-divider" />
          {legend.map((l) => (
            <span key={l.label} className="ex-legend-item">
              <span className="ex-legend-dot" style={{ background: l.colour }} />
              {l.label}
            </span>
          ))}
          <span className="ex-legend-item">
            <span className="ex-legend-dash" />
            Gap
          </span>
        </div>
      )}

      {downloadOpen && (
        <div className="ex-menu" role="menu" ref={menuRef}>
          {(
            [
              ['PNG 1×', 'Screen size', <I.IconFilePng key="i" />, () => exportPng(1)],
              ['PNG 2×', 'Twice', <I.IconFilePng key="i" />, () => exportPng(2)],
              ['PNG 4×', 'Print', <I.IconFilePng key="i" />, () => exportPng(4)],
              null,
              ['Newick', 'Tree', <I.IconFileNewick key="i" />, () => exportText(toNewick(tree), 'phylotree.nwk')],
              ['NEXUS', 'Tree', <I.IconFileNexus key="i" />, () => exportText(toNexus(tree), 'phylotree.nex')],
            ] as const
          ).map((item, k) =>
            item === null ? (
              <div key={k} className="ex-menu-divider" />
            ) : (
              <button
                key={item[0]}
                type="button"
                role="menuitem"
                onClick={() => {
                  item[3]();
                  setDownloadOpen(false);
                }}
              >
                <span className="ex-menu-icon">{item[2]}</span>
                <span className="ex-menu-label">{item[0]}</span>
                <span className="ex-menu-desc">{item[1]}</span>
              </button>
            ),
          )}
        </div>
      )}

      {/* ── The node menu's Colour…: one colour for one clade ── */}
      {pickAt !== null && pickAt.node < tree.nodeCount && (
        <div
          className="ex-palette ex-palette--near"
          role="dialog"
          aria-label="Colour this clade"
          // opens where the click was, kept inside the component (the palette is about 240 x 150 px)
          style={{ left: Math.max(8, Math.min(pickAt.x, (outer.current?.clientWidth ?? 1000) - 262)), top: Math.max(8, pickAt.y), right: 'auto' }}
        >
          <div className="ex-palette-head">
            <I.IconPalette />
            <span>
              Colour this {tree.childCount[pickAt.node] === 0 ? 'tip' : `clade of ${tree.tipCountOf(pickAt.node).toLocaleString('en')} tips`}
            </span>
            <span className="ex-palette-tip">Esc to close</span>
          </div>
          <div className="ex-palette-grid">
            {PALETTE.map((name, k) => (
              <button
                key={name}
                type="button"
                title={name}
                aria-label={name}
                className="ex-swatch"
                autoFocus={k === 0} // focus moves into the palette; Esc closes it
                style={{ ['--sw' as string]: `var(--ex-palette-${name.toLowerCase()})` }}
                onClick={() => {
                  paint(pickAt.node, name);
                  closePick();
                }}
              />
            ))}
          </div>
          <div className="ex-palette-divider" />
          <div className="ex-palette-foot">
            <button
              type="button"
              className="ex-erase"
              disabled={!clades.some((c) => c.node === pickAt.node)}
              onClick={() => {
                paint(pickAt.node, ERASE);
                closePick();
              }}
            >
              <I.IconEraser /> Erase
            </button>
          </div>
        </div>
      )}

      {/* ── Colour palette (floating, as Reactree's) ── */}
      {mode === 'color' && (
        <div className="ex-palette" role="dialog" aria-label="Paint clades">
          <div className="ex-palette-head">
            <I.IconPalette />
            <span>Paint clades, branches &amp; leaves</span>
            <span className="ex-palette-tip">Esc to exit</span>
          </div>
          <div className="ex-palette-grid">
            {PALETTE.map((name) => (
              <button
                key={name}
                type="button"
                title={name}
                aria-label={name}
                aria-pressed={activeColor === name}
                className={`ex-swatch${activeColor === name ? ' active' : ''}`}
                style={{ ['--sw' as string]: `var(--ex-palette-${name.toLowerCase()})` }}
                onClick={() => setActiveColor(name)}
                onMouseEnter={() => setHoveredSwatch(name)}
                onMouseLeave={() => setHoveredSwatch(null)}
              />
            ))}
          </div>
          <div className="ex-palette-divider" />
          <div className="ex-palette-foot">
            <button
              type="button"
              className={`ex-erase${activeColor === ERASE ? ' active' : ''}`}
              onClick={() => setActiveColor(ERASE)}
              onMouseEnter={() => setHoveredSwatch('Erase')}
              onMouseLeave={() => setHoveredSwatch(null)}
            >
              <I.IconEraser /> Erase
            </button>
            {clades.length > 0 && (
              <button type="button" className="ex-clear" onClick={() => setClades([])}>
                Clear all ({clades.length})
              </button>
            )}
            <span className="ex-palette-feedback">
              <span
                className="ex-tip-dot"
                style={{ background: feedback === 'Erase' ? 'var(--ex-muted)' : `var(--ex-palette-${feedback.toLowerCase()})` }}
              />
              {feedback}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
