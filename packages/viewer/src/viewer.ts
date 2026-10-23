// TreeViewer: the facade of the viewer. It owns the DOM skeleton (canvas, transient canvas, the pieces below), the canvas contexts,
// the render loop (requestAnimationFrame on demand: a frame is drawn only when something changed), the frame itself (cut, draw, stats),
// the source sync, hit-testing and hover, the corner notice, the events and the public API. No framework in here: the React component
// only forwards props.
//
// Everything else lives in a module with one job, wired together here:
//   view-state.ts     the viewport: area, fit, limits, zoom, target windows, animation (pure arithmetic, no DOM)
//   input.ts          wheel / pointer / pinch / click / key events -> calls on this class (keyboard.ts: where the cursor moves)
//   overlay.ts        label anchors over the canvas, the hidden list of tips in view, the live region
//   overview.ts       the strip / disc with the window box
//   detail-loader.ts  opening the stubs of a partial TreeSource
//   node-event.ts     the NodeEvent handed to the host app
// What stays here on purpose: the interaction-LOD state (noteInput / settle / reduced frames), because it is tied to the frame loop.
// (The focus rings of the tree and of the label anchors are CSS, viewer.css.)

import { cladeName } from './clade-name.ts';
import type { Control, ControlPosition } from './control.ts';
import { cellRect, columnsFixed, columnsWidth, drawColumns, layoutColumns, recolourColumns, updateColumns, type CompiledColumn } from './columns.ts';
import { DetailLoader } from './detail-loader.ts';
import { mk } from './dom.ts';
import { Emitter, type Listener, type ListenOptions, type ViewerEventType } from './events.ts';
import {
  drawAxis,
  drawBody,
  drawHighlights,
  drawLabels,
  drawNodeLabels,
  drawLeaders,
  drawMarkers,
  drawRing,
  drawRootPath,
  drawRings,
  drawScaleBar,
  drawSelectionRing,
  drawMarkRings,
  LabelList,
  TextMeasurer,
  type Scene,
} from './draw.ts';
import { makeTransform, sectorBBox, viewportEquals, type Transform } from './geom.ts';
import { HitIndex } from './hit.ts';
import { InputController, type InputHost } from './input.ts';
import { computeLayout, ensureTrig, fanAngle, fanRow, radialFan, remapRow, setLayoutFan, type Layout } from './layout.ts';
import { live } from './live.ts';
import { DrawList, Seen, searchCut, type CutResult } from './lod.ts';
import { makeNodeEvent, toTreeEvent } from './node-event.ts';
import { LabelOverlay } from './overlay.ts';
import type { OverviewHost } from './overview.ts';
import { projectionFor, type LayoutProjection } from './projection.ts';
import { easeOut, RingAnim } from './ring-anim.ts';
import { InMemorySource, isTreeSource, type TreeSource } from './source.ts';
import {
  DEFAULT_OPTIONS,
  FALLBACK_THEME,
  stripUndefined,
  themeEquals,
  type CladeColour,
  type Column,
  type FrameStats,
  type Hit,
  type NodeEvent,
  type TipRef,
  type ViewerOptions,
  type TreeData,
  type TreeSnapshot,
  type TreeTheme,
  type Viewport,
} from './types.ts';
import { isOpaque } from './colour.ts';
import { THEME_CSS_VARS, deriveDark, themeFromCss } from './theme.ts';
import { resolveSize } from './sizes.ts';
import { keptViewport, type TipTarget } from './view-keep.ts';
import { ViewState, type ViewEnv, type ViewEvents } from './view-state.ts';

const THIN_PRIMS = 700; // radial: from this many primitives on, branches are one device pixel wide
const REDUCED_MINPX = 1.6; // collapse threshold factor while interacting (only when the last full frame was heavy)
const HEAVY_PRIMS = 1000;
const AUTO_LOD_MS = 12; // interactionLOD 'auto': reduce while moving once full-quality frames take longer than this (JS time, smoothed)
const MAX_EXPORT_PX = 16384; // longest side of a toBlob image (browser canvas limits are near this)
const MAX_EXPORT_AREA = 2 ** 26; // pixels in all (256 MB of RGBA)
const CURSOR_RING_RADIUS = 10; // the keyboard cursor's ring, CSS px (in highlight; not a theme token yet, see api.md "Known gaps")
const CURSOR_RING_WIDTH = 2.5;

/** A node handle is a preorder id of the tree the viewer holds: an integer in [0, limit) (see `nodeLimit`). */
function isNodeOf(limit: number, id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < limit;
}

/** Ids that are not nodes of the tree are ignored, with this warning, so a typo or a stale id does not fail quietly. */
function warnUnknownNodes(where: string, bad: unknown[], limit: number): void {
  const shown = bad.slice(0, 5).map((b) => (typeof b === 'string' ? JSON.stringify(b) : String(b)));
  const more = bad.length > 5 ? ` and ${bad.length - 5} more` : '';
  console.warn(
    `gbif-phylo: ${where}: ${shown.join(', ')}${more} ${bad.length === 1 ? 'is not a node' : 'are not nodes'} of this tree ` +
      `(nodes are numbers, the preorder ids 0 to ${limit - 1}); ignored`,
  );
}

function checkThemeObserver(m: unknown): void {
  if (m !== undefined && m !== 'media' && m !== 'document' && m !== 'none')
    throw new RangeError(`themeObserver must be 'media', 'document' or 'none', not ${JSON.stringify(m)}`);
}

/** `setOptions` changes in `p` (over the options `o`), besides the layout and branch lengths, that change the fit view: the axis, the row
 *  height, the tree width, and in the radial layout `alignLabels` (the fit keeps room for labels outside the circle). */
function refitsView(p: Partial<ViewerOptions>, o: ViewerOptions): boolean {
  const changes = <K extends keyof ViewerOptions>(k: K) => p[k] !== undefined && p[k] !== o[k];
  return changes('axis') || changes('rowHeight') || changes('treeWidth') || (changes('alignLabels') && (p.layout ?? o.layout) === 'radial');
}

/** What `new TreeViewer(...)` takes. One of `tree` and `source` is needed; `source` wins. */
export interface TreeViewerInit {
  /** The element the viewer fills: it appends its root there and follows its size (ResizeObserver). Give it a size. */
  target: HTMLElement;
  /** A tree in memory (wrapped in an `InMemorySource`) ... */
  tree?: TreeData;
  /** ... or a source that loads parts of a tree on demand. */
  source?: TreeSource;
  /** Over `DEFAULT_OPTIONS`; all but `softwareCanvas` can be changed later with `setOptions`. */
  options?: Partial<ViewerOptions>;
  /** Over the CSS custom properties and `FALLBACK_THEME`; see `setTheme`. */
  theme?: Partial<TreeTheme>;
  columns?: Column[];
  /** Controls to add, in this order (none by default; `defaultControls()` gives the usual set). */
  controls?: Control[];
}

/** For built-in controls that draw from the viewer's own state (the overview): not a stable API, may change in any release. */
export interface ViewerInternals {
  /** What the overview reads (live getters) and asks for. */
  readonly overviewHost: OverviewHost;
  /** Bumped whenever the tree, colours, highlights, theme, size or layout changed: a picture drawn from them is stale. */
  sceneVersion(): number;
  /** Reserve (or free) the overview strip right of the rectangular plot; refits while the view is still fitted. */
  reserveOverview(on: boolean): void;
}

const NO_RANKS = new Int32Array(0);
const INTERNALS = new WeakMap<TreeViewer, ViewerInternals>();
/** The viewer a control is on (a control has one at a time). */
const OWNER = new WeakMap<Control, TreeViewer>();

/** @internal See `ViewerInternals`. */
export function viewerInternals(v: TreeViewer): ViewerInternals {
  const i = INTERNALS.get(v);
  if (!i) throw new Error('not a live TreeViewer');
  return i;
}

/** What `setTree` takes besides the tree. */
export interface SetTreeOptions {
  /** Old node -> new node, as tree-ops returns it (-1 = removed); its length must be the old tree's node count, else it is ignored with a
   *  warning. Lets 'keep' send the tips in view to where they are now, and (when
   *  `clades` / `collapsed` are not passed) carries the clade colours and the collapsed marks across. */
  map?: Int32Array;
  /** 'keep': frame the tips that were in view (through `map`, else by tip label) at the same scale; 'fit': show the whole tree.
   *  Default 'keep' when a `map` is given, else 'fit'. A view that is still the fit view stays fitted; 'keep' also fits when no tip in
   *  view survives (a tip that is gone counts as the nearest ancestor that survived, unless that is the whole tree), and for a partial
   *  source (either side). A radial window with no tip in it is kept as it is. */
  view?: 'keep' | 'fit';
  /** The clade colours for the new tree (node ids of it), applied before the next frame. Default: the current ones sent through `map`
   *  (clades that are gone dropped). That follows node ids, not tips: a clade whose tips an operation moved keeps its colour on the node
   *  that maps from it, so for colours that must follow their tips compute the new list with tree-ops' `followClades` and pass it here.
   *  Without a `map` the ids are kept as they are, which only fits a tree with the same node ids. */
  clades?: CladeColour[];
  /** The highlighted tips for the new tree, labels and node ids of it as `setHighlighted` takes them. Default: the current ones, labels
   *  unchanged (they follow their tips) and node ids sent through `map` (tips that are gone dropped; without a `map` kept as they are). */
  highlighted?: TipRef[];
  /** The nodes (ids of the new tree) that stand for collapsed clades; default as `clades`. */
  collapsed?: number[];
}

const CORNERS: Exclude<ControlPosition, 'custom'>[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

export class TreeViewer {
  // ------------------------------------------------------------- DOM
  /** The tree element: role="tree", focusable, the canvases, labels and screen-reader list; the input controller listens on it. */
  readonly root: HTMLDivElement;
  /** What the viewer appended to its target (class phylo-viewer): the tree element and, beside it (not inside the tree role), the
   *  control layer. */
  readonly container: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private top: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** The main canvas has an alpha channel: only while the background is not opaque (an opaque canvas composites faster). */
  private canvasAlpha = false;
  private topCtx: CanvasRenderingContext2D;
  private notice: HTMLDivElement;
  private ro: ResizeObserver | null = null;
  private overlay: LabelOverlay;
  private input: InputController;
  /** The control layer over the canvas (data-phylo-ui: the input controller ignores events from inside it) and its corner boxes. */
  private uiLayer: HTMLDivElement;
  private corners = new Map<ControlPosition, HTMLDivElement>();
  private controls: Control[] = [];
  private sceneVersion = 0;
  private overviewReserved = false;

  // ------------------------------------------------------------- state
  private opts: ViewerOptions;
  private theme: TreeTheme;
  private themeOverrides: Partial<TreeTheme> = {};
  private cssTheme: Partial<TreeTheme> = {};
  private schemeQuery: MediaQueryList | null = null;
  private docObserver: MutationObserver | null = null;
  private events = new Emitter();
  private readyEmitted = false;
  private layouts = new Map<boolean, Layout>();
  private L: Layout;
  private W = 0;
  private H = 0;
  private dpr = 1;
  private vs: ViewState; // the viewport (view, fitted, area, animation)
  private T!: Transform;
  private proj!: LayoutProjection; // the layout projection of T and L (node positions, clade extents), rebuilt with T
  private columns: CompiledColumn[] = [];
  private classOf: Uint8Array | null = null;
  private colours: string[] = [''];
  private cladeKey = '';
  private clades: CladeColour[] = [];
  private detail: DetailLoader;
  private hl: Uint8Array | null = null;
  private hlRanks = new Int32Array(0);
  /** Highlighted tips before each rank (prefix sums, length tipCount + 1): a clade holds none when its range [leafStart, leafEnd) has equal
   *  ends, which is the dim state. Built on first use by a dimming frame (never in 'band' mode) and dropped when the highlights change. */
  private hlPrefix: Int32Array | null = null;
  private hlIds: TipRef[] = []; // what the last setHighlighted was given, to skip an identical call
  private collapsedNodes: number[] = []; // node ids of the last setCollapsed
  private collapsedMask: Uint8Array | null = null; // by row of the snapshot: 1 = a clade to collapse (what computeLayout reads), null = none
  private list = new DrawList();
  private seen = new Seen();
  private hit: HitIndex;
  private measurer = new TextMeasurer(); // label widths of this renderer's fonts only
  private labels = new LabelList();
  private hoverNode = -1;
  private hoverKind: Hit['kind'] | '' = '';
  private hoverRun = -1; // first member of the hovered run of small siblings, -1 for none (hoverNode is then their parent)
  private activeNode = -1;
  /** The selected node (`setSelected`, a click): a node id of the public API (preorder id of the full tree), -1 for none. Kept by id, so
   *  it survives a new snapshot of a partial source; a node inside a collapsed clade selects the clade. */
  private selected = -1;
  /** The marked nodes (`setMarked`, node ids as given), and their rows of the snapshot, filled by `drawTop` (-1: not loaded). */
  private marked: number[] = [];
  private markRows = new Int32Array(0);
  private raf = 0;
  /** The timestamp of the animation frame being drawn, NaN outside one (what the ring animation reads). */
  private frameNow = NaN;
  private dirty = true;
  private topDirty = true;
  /** The hover ring growing in, the hover ring it replaced fading out, and the keyboard cursor's ring (option `hoverAnimation`). */
  private hoverIn = new RingAnim();
  private hoverOut = new RingAnim();
  private cursorIn = new RingAnim();
  private motionQuery: MediaQueryList | null | undefined; // prefers-reduced-motion, made on first use; null without matchMedia
  private pendingHover: { x: number; y: number } | null = null;
  private destroyed = false;
  readonly stats: FrameStats = {
    frameMs: 0,
    cutMs: 0,
    drawMs: 0,
    visited: 0,
    drawn: 0,
    summaries: 0,
    tips: 0,
    labels: 0,
    minPxUsed: 0,
    budgetRetries: 0,
    budgetHit: false,
    truncated: false,
    frames: 0,
    budget: 0,
    forced: 0,
    summaryTips: 0,
    mergedTips: 0,
    reduced: false,
    scale: 1,
  };
  // interaction-time degradation: wheel, pinch, drag and animation frames are drawn reduced (interactionLOD true, or 'auto' when the
  // full frames are slow, see fullMs); one full frame follows `refineMs` after the last input. Anything that reads the draw list (click, hover, locate, bounds) settles first.
  private interacting = false;
  private reducedFrame = false;
  private refineTimer = 0;
  private minPxHint = 0;
  private lastFullDrawn = 0;
  private fullMs = 0; // smoothed JS time of the full-quality frames, for interactionLOD 'auto' (0 = not measured yet)
  private fullFrames = 0; // full-quality frames drawn; the first is not measured (one-off costs)
  private noticeText = '';
  private noticeShown = false;
  private msSum = 0;
  private msN = 0;
  private msMax = 0;
  private lastEmitted: Viewport | null = null;

  /** The tree as of the last source version we looked at. Re-read through source.snapshot() when the version changes (syncSource),
   *  so a frame always works on one consistent set of arrays. For an in-memory source the version never changes. */
  private tree: TreeSnapshot;
  private source: TreeSource;
  private srcVersion: number;
  private unsubscribe: () => void;

  private host: HTMLElement;

  constructor(init: TreeViewerInit) {
    const tree = init.source ?? init.tree;
    if (!tree) throw new TypeError('TreeViewer: `tree` or `source` is required');
    if (!init.target) throw new TypeError('TreeViewer: `target` is required');
    this.host = init.target;
    this.source = isTreeSource(tree) ? tree : new InMemorySource(tree);
    this.srcVersion = this.source.version;
    this.tree = this.source.snapshot();
    this.unsubscribe = this.source.subscribe(() => {
      this.syncSource();
      this.invalidate();
    });
    this.opts = { ...DEFAULT_OPTIONS, ...stripUndefined(init.options ?? {}) };
    this.themeOverrides = { ...stripUndefined(init.theme ?? {}) };
    this.theme = this.composeTheme();
    this.L = this.layoutFor(this.opts.branchLengths);
    this.hit = new HitIndex();
    this.detail = new DetailLoader(this.source, () => this.invalidate());
    this.vs = new ViewState(this.viewEnv(), this.viewEvents());

    const fill = 'position:absolute;left:0;top:0;width:100%;height:100%;';
    this.container = mk('div', 'position:relative;width:100%;height:100%;overflow:hidden');
    this.container.className = 'phylo-viewer';
    this.root = mk(
      'div',
      'position:relative;width:100%;height:100%;overflow:hidden;user-select:none;-webkit-user-select:none;touch-action:none;outline:none;cursor:grab',
    );
    this.root.tabIndex = 0;
    this.root.setAttribute('role', 'tree');
    this.root.setAttribute('aria-label', this.opts.ariaLabel);
    this.root.setAttribute('aria-roledescription', 'phylogenetic tree viewer');
    this.root.dataset.treeview = '';
    this.root.className = 'phylo-tree';
    this.canvas = mk('canvas', fill);
    this.canvas.setAttribute('aria-hidden', 'true');
    this.top = mk('canvas', fill + 'pointer-events:none');
    this.top.setAttribute('aria-hidden', 'true');
    this.overlay = new LabelOverlay(() => {
      if (this.destroyed) return;
      this.renderNow();
      this.overlay.updateList(this.list, this.tree, this.opts.formatLabel, this.L.collapsed, (row) => this.cladeText(row));
    });
    this.notice = mk(
      'div',
      'position:absolute;left:8px;top:6px;pointer-events:none;display:none;white-space:nowrap;max-width:calc(100% - 16px);overflow:hidden;text-overflow:ellipsis',
    );
    this.notice.className = 'phylo-notice';
    this.notice.setAttribute('role', 'status');
    this.uiLayer = mk('div', 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none');
    this.uiLayer.className = 'phylo-ui';
    this.uiLayer.dataset.phyloUi = '';
    this.root.append(this.canvas, this.top, this.overlay.layer, this.notice, this.overlay.srList, this.overlay.live);
    // the control layer is the tree element's sibling: a tree may only own tree items, so menus, buttons and the search field stay out
    this.container.append(this.root, this.uiLayer);
    // the theme from CSS custom properties of the target (and its ancestors); re-read when the colour scheme preference changes
    this.cssTheme = themeFromCss(this.host, false);
    this.theme = this.composeTheme();
    this.syncCssVars();
    this.watchTheme();
    this.host.appendChild(this.container);
    this.canvasAlpha = !isOpaque(this.theme.background);
    this.ctx = this.mainContext();
    this.topCtx = this.top.getContext('2d', { willReadFrequently: this.opts.softwareCanvas })!;

    this.input = new InputController(this.root, this.inputHost());
    // the wheel over controls and the overview zooms the tree as it does over the tree, except inside parts that scroll themselves
    this.uiLayer.addEventListener('wheel', this.onUiWheel, { passive: false });
    this.ro = new ResizeObserver(() => {
      if (!this.destroyed) this.measure();
    });
    this.ro.observe(this.host);
    this.measure();
    if (init.columns?.length) this.columns = updateColumns(this.tree, [], init.columns, this.theme).columns;
    INTERNALS.set(this, {
      overviewHost: this.overviewHost(),
      sceneVersion: () => this.sceneVersion,
      reserveOverview: (on) => {
        if (on === this.overviewReserved) return;
        this.overviewReserved = on;
        if (this.vs.fitted) this.fit(false);
        this.invalidate();
      },
    });
    this.fit(false);
    // a click (or Enter on the keyboard cursor) selects its node; a default action, so an app can preventDefault() it. A run of small
    // siblings is not one node: it selects nothing
    this.events.on('click', (e) => (e.run ? undefined : this.select(this.shownNode(e.node))), { asDefault: true });
    for (const c of init.controls ?? []) this.addControl(c);
    this.invalidate();
    // web fonts arrive after the first frame
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts) {
      void fonts.ready.then(() => this.invalidate(true));
      fonts.addEventListener?.('loadingdone', this.onFonts);
    }
  }

  private onFonts = () => this.invalidate(true);

  private onUiWheel = (e: WheelEvent) => {
    if ((e.target as Element | null)?.closest?.('[data-phylo-scroll]')) return; // a list that scrolls: let it
    this.input.wheel(e);
  };

  // ------------------------------------------------------------- wiring of the modules
  // The modules read the renderer's current fields through live() objects (getters, never copies) and report back through callbacks.

  private warnedSpacing = false;

  private viewEnv(): ViewEnv {
    return live<ViewEnv>(
      {
        layout: () => this.opts.layout,
        overview: () => this.overviewReserved,
        axis: () => this.opts.axis,
        rowHeight: () => (this.opts.rowHeight === null ? null : resolveSize(this.opts.rowHeight, this.theme.labelSize)),
        maxTipSpacing: () => {
          const m = resolveSize(this.opts.maxTipSpacing, this.theme.labelSize);
          if (m > 0) return m;
          if (!this.warnedSpacing) {
            this.warnedSpacing = true;
            console.warn(`gbif-phylo: maxTipSpacing ${String(this.opts.maxTipSpacing)} is not a size (px, 'auto' or '<n>em'); no cap is applied`);
          }
          return Infinity;
        },
        labelSize: () => this.theme.labelSize,
        maxViewWidth: () => this.opts.maxViewWidth,
        treeWidth: () => this.opts.treeWidth,
        alignLabels: () => this.opts.alignLabels,
        W: () => this.W,
        H: () => this.H,
        tree: () => this.tree,
        L: () => this.L,
        columnsWidth: () => columnsFixed(this.columns).fixed,
        fillColumns: () => columnsFixed(this.columns).fills,
        hasColumns: () => this.columns.length > 0,
      },
      { placeColumns: (left, fillW) => layoutColumns(this.columns, left, fillW) },
    );
  }

  private viewEvents(): ViewEvents {
    return {
      changed: (step) => {
        if (!step) this.afterViewChange();
        else {
          this.hit.invalidate();
          this.dirty = true;
          this.emitViewport();
          this.overlay.scheduleList();
        }
      },
      needFrame: () => this.schedule(),
      moving: () => this.noteInput(),
    };
  }

  private overviewHost(): OverviewHost {
    return live<OverviewHost>(
      {
        layout: () => this.opts.layout,
        enabled: () => this.overviewReserved,
        W: () => this.W,
        H: () => this.H,
        dpr: () => this.dpr,
        view: () => this.vs.view,
        area: () => this.vs.area,
        tree: () => this.tree,
        L: () => this.L,
        theme: () => this.theme,
        classOf: () => this.classOf,
        colours: () => this.colours,
        hlRanks: () => this.hlRanks,
        measure: () => this.measurer,
        seen: () => this.seen,
      },
      {
        formatLabel: (id) => this.opts.formatLabel(id),
        noteInput: () => this.noteInput(),
        cancelAnim: () => this.vs.cancelAnim(),
        setViewport: (v) => this.vs.setViewport(v),
        zoomAtWorld: (fx, fy, wx, wy) => this.vs.zoomAtWorld(fx, fy, wx, wy),
      },
    );
  }

  private inputHost(): InputHost {
    return live<InputHost>(
      {
        layout: () => this.opts.layout,
        area: () => this.vs.area,
        view: () => this.vs.view,
        tree: () => this.tree,
        L: () => this.L,
        activeNode: () => this.activeNode,
        hovering: () => this.hoverNode >= 0,
      },
      {
        noteInput: () => this.noteInput(),
        cancelAnim: () => this.vs.cancelAnim(),
        setViewport: (v) => this.vs.setViewport(v),
        zoomBy: (fx, fy, px, py) => this.vs.zoomBy(fx, fy, px, py),
        fit: (animate) => this.fit(animate),
        zoomToRow: (row, animate) => this.zoomToRow(row, animate),
        setCursor: (c) => {
          this.root.style.cursor = c;
        },
        pick: (x, y) => {
          this.renderNow();
          this.ensureHit();
          return this.queryHit(x, y);
        },
        click: (h, clientX, clientY) => {
          this.activeNode = -1;
          this.topDirty = true;
          this.schedule();
          this.emitNode('click', makeNodeEvent(this.tree, h.node, h.kind, 'pointer', clientX, clientY, h.run, this.L.collapsed));
        },
        hover: (p) => {
          this.pendingHover = p;
          if (p) this.schedule();
          else this.dropHover();
        },
        dropHover: () => this.dropHover(),
        setActive: (node) => this.setActive(node),
        activate: (node) => {
          if (this.activeNode < 0) this.activeNode = node;
          const p = { x: 0, y: 0 };
          this.renderNow();
          const tree = this.tree; // after renderNow: it may have picked up a new snapshot
          this.proj.nodeXY(node, p);
          const r = this.root.getBoundingClientRect();
          const kind = tree.childCount[node] === 0 ? 'tip' : this.L.collapsed?.[node] === 1 ? 'summary' : 'node';
          this.emitNode('click', makeNodeEvent(tree, node, kind, 'keyboard', r.left + p.x, r.top + p.y, undefined, this.L.collapsed));
        },
      },
    );
  }

  /** The projection reads the tree and layout arrays of the moment it was built: rebuild it whenever either is replaced, so position
   *  queries between that and the next render (locateNode, nodeBounds, focus) do not read the old arrays. */
  private rebuildProj(): void {
    if (this.T) this.proj = projectionFor(this.tree, this.L, this.T);
  }

  /** Pick up a new snapshot when the source changed (rows arrived or were dropped). Everything derived from the rows is rebuilt:
   *  layouts, hit index, label reserve. Per-node state keyed by row (classOf, activeNode, hover) is reset, ranks (highlights,
   *  columns) stay valid because they are ranks of the full tree. */
  private syncSource(): void {
    const v = this.source.version;
    if (v === this.srcVersion || this.destroyed) return;
    this.srcVersion = v;
    this.tree = this.source.snapshot();
    this.applyCollapsed(); // the mask first: the layout reads it
    this.layouts.clear();
    this.L = this.layoutFor(this.opts.branchLengths);
    this.rebuildProj();
    this.hit = new HitIndex();
    this.applyClades();
    this.resolveHighlights(); // tips that were not loaded when the ids were passed may be now (and the dim state follows)
    this.activeNode = -1;
    this.clearHover();
    this.vs.resetLabelReserve();
    this.sceneVersion++;
    this.minPxHint = 0;
    this.events.emit('sourcechange', { version: v });
  }

  /** One past the largest node id: the node count of the full tree, for a partial source too (`TreeSource.nodeCount`). Whether an id below
   *  it is loaded is the source's business, and a node that is not loaded yet is no error. */
  private nodeLimit(): number {
    return this.source.nodeCount;
  }

  /** The entries whose node is a node of this tree; the others are dropped with a warning (see `warnUnknownNodes`). */
  private knownNodes<T>(where: string, items: readonly T[], node: (x: T) => unknown): T[] {
    const n = this.nodeLimit();
    if (items.every((x) => isNodeOf(n, node(x)))) return items as T[];
    warnUnknownNodes(
      where,
      items.map(node).filter((k) => !isNodeOf(n, k)),
      n,
    );
    return items.filter((x) => isNodeOf(n, node(x)));
  }

  /** False, with a warning, when `id` is not a node of this tree. */
  private knownNode(where: string, id: number): boolean {
    const n = this.nodeLimit();
    if (isNodeOf(n, id)) return true;
    warnUnknownNodes(where, [id], n);
    return false;
  }

  /** Row of the snapshot for a node id of the public API (preorder id of the full tree), -1 when that node is not loaded. */
  private rowOf(node: number): number {
    return this.tree.globalId === null ? (node >= 0 && node < this.tree.nodeCount ? node : -1) : this.tree.toLocal(node);
  }

  /** Node id of the public API for a row of the snapshot. */
  private idOf(row: number): number {
    return this.tree.globalId === null ? row : this.tree.globalId[row];
  }

  /** The node, or the collapsed clade that hides it (node ids of the public API). */
  private shownNode(id: number): number {
    const row = this.rowOf(id);
    return row >= 0 && this.L.hidden?.[row] ? this.idOf(this.L.rowNode![this.L.rowStart[row]]) : id;
  }

  // ================================================================= public API

  // ---- events

  /** Listen to an event; returns the function that removes the listener. See `ViewerEventMap` for the events and `ListenOptions`
   *  for default actions. */
  on<K extends ViewerEventType>(type: K, listener: Listener<K>, opts?: ListenOptions): () => void {
    return this.events.on(type, listener, opts);
  }
  once<K extends ViewerEventType>(type: K, listener: Listener<K>, opts?: ListenOptions): () => void {
    return this.events.on(type, listener, { ...opts, once: true });
  }
  off<K extends ViewerEventType>(type: K, listener: Listener<K>): void {
    this.events.off(type, listener);
  }

  private emitNode(type: 'click' | 'hover', e: NodeEvent | null): void {
    if (!this.events.has(type)) return;
    this.events.emit(type, e ? toTreeEvent(e, this.source) : (null as never));
  }

  // ---- controls

  /** Add a control: its element goes to its corner of the control layer (or to its `target`), then `setViewer(this)` is called.
   *  Adding a control twice does nothing; a control that another viewer holds is first removed from it (a control has one viewer). */
  addControl(control: Control): void {
    if (this.destroyed || this.controls.includes(control)) return;
    const owner = OWNER.get(control);
    if (owner && owner !== this) owner.removeControl(control);
    OWNER.set(control, this);
    const box = control.target ?? this.cornerBox(control.position ?? 'top-left');
    if (control.target) control.element.dataset.phyloUi = '';
    // the layer itself lets events through to the tree, so a control catches its own unless it set pointer-events itself (a layer
    // over the whole tree sets 'none' to let clicks through)
    else if (!control.element.style.pointerEvents) control.element.style.pointerEvents = 'auto';
    box.appendChild(control.element);
    this.controls.push(control);
    control.setViewer(this);
  }

  /** Remove a control: `setViewer(null)`, then its element is taken out of the page. */
  removeControl(control: Control): void {
    const k = this.controls.indexOf(control);
    if (k < 0) return;
    this.controls.splice(k, 1);
    if (OWNER.get(control) !== this) return; // moved to another viewer meanwhile: leave it there
    OWNER.delete(control);
    control.setViewer(null);
    control.element.remove();
  }

  getControls(): readonly Control[] {
    return this.controls.slice();
  }

  private cornerBox(pos: ControlPosition): HTMLElement {
    if (pos === 'custom') return this.uiLayer;
    let box = this.corners.get(pos);
    if (!box) {
      const [v, h] = pos.split('-');
      // flex column, pointer events only on the controls themselves; the stylesheet adds the gaps
      // the right corners keep clear of a strip along the right edge (the overview sets --phylo-inset-right while it shows one)
      const side = h === 'right' ? 'right:var(--phylo-inset-right,0px)' : 'left:0';
      box = mk('div', `position:absolute;${v}:0;${side};display:flex;flex-direction:column;align-items:${h === 'left' ? 'flex-start' : 'flex-end'}`);
      box.className = `phylo-controls phylo-controls--${pos}`;
      // keep the boxes in a fixed DOM order (reading order: top left, top right, bottom left, bottom right)
      const after = CORNERS.slice(CORNERS.indexOf(pos as (typeof CORNERS)[number]) + 1)
        .map((c) => this.corners.get(c))
        .find((b) => b);
      this.uiLayer.insertBefore(box, after ?? null);
      this.corners.set(pos, box);
    }
    return box;
  }

  // ---- replacing the tree

  /**
   * Show another tree (or source) in this viewer: the canvases, controls, listeners, options and theme overrides stay, the layout, hit
   * index, clade colours, highlights, column data and the keyboard cursor are rebuilt for the new tree, and `treechange` is emitted.
   * The new tree's first frame is drawn with the new clades and highlights: pass them here rather than after, so no frame shows the old
   * colours on the new tree. The previous source is not destroyed (it is the caller's). See `SetTreeOptions` for the view.
   * @param tree a tree in memory, or a `TreeSource`
   */
  setTree(tree: TreeData | TreeSource, o: SetTreeOptions = {}): void {
    if (this.destroyed) return;
    const before = this.tree;
    const beforeL = this.L;
    let map = o.map ?? null;
    if (map && map.length !== before.nodeCount) {
      console.warn(
        `TreeViewer.setTree: the map has ${map.length} entries but the tree it replaces has ${before.nodeCount} nodes; ignored, the view is fitted`,
      );
      map = null;
      o = { ...o, view: 'fit' };
    }
    const oldView = { ...this.vs.view };
    const wasFitted = this.vs.fitted;
    const oldClades = this.clades;
    const oldCollapsed = this.collapsedNodes;
    const oldHl = this.hlIds;
    const oldSelected = this.selected;
    const hadHover = this.hoverNode >= 0;

    // ---- swap the source
    this.unsubscribe();
    this.detail.destroy();
    this.source = isTreeSource(tree) ? tree : new InMemorySource(tree);
    this.srcVersion = this.source.version;
    this.tree = this.source.snapshot();
    this.unsubscribe = this.source.subscribe(() => {
      this.syncSource();
      this.invalidate();
    });
    this.detail = new DetailLoader(this.source, () => this.invalidate());
    this.vs.cancelAnim();
    this.vs.resetLabelReserve();
    this.input.endGesture(); // a drag started on the old tree would go on moving the new one

    // ---- what is keyed by node or rank
    const rm = (n: number) => (map ? (n >= 0 && n < map.length ? map[n] : -1) : n);
    // the collapsed clades first: the layout of the new tree reads them
    if (o.collapsed) this.storeCollapsed(this.knownNodes('setTree collapsed', o.collapsed, (n) => n));
    else if (map) this.storeCollapsed(oldCollapsed.map(rm).filter((n) => n >= 0));
    this.applyCollapsed();
    this.layouts.clear();
    this.L = this.layoutFor(this.opts.branchLengths);
    this.rebuildProj();
    this.hit = new HitIndex();
    const cladesChanged = o.clades
      ? this.storeClades(this.knownNodes('setTree clades', o.clades, (c) => c.node))
      : map
        ? this.storeClades(oldClades.map((c) => ({ ...c, node: rm(c.node) })).filter((c) => c.node >= 0))
        : false;
    this.hlIds = this.highlightsAfterSetTree(o.highlighted, oldHl, map ? rm : null);
    const hlChanged = this.hlIds.length !== oldHl.length || this.hlIds.some((id, i) => id !== oldHl[i]);
    this.applyClades();
    this.resolveHighlights(); // also drops the dim prefix, which is as long as the old tree
    if (this.columns.length) {
      this.columns = updateColumns(
        this.tree,
        [],
        this.columns.map((c) => c.spec),
        this.theme,
      ).columns;
    }
    this.activeNode = -1;
    this.selected = this.selectionAfterSetTree(oldSelected, map, rm);
    this.storeMarked(this.marksAfterSetTree(map, rm));
    this.pendingHover = null;
    this.clearHover();
    this.root.style.cursor = 'grab';
    this.overlay.clear(true);
    this.overlay.scheduleList();
    this.minPxHint = 0;
    this.sceneVersion++;

    // ---- the view
    let kept: Viewport | null = null;
    const want = o.view ?? (map ? 'keep' : 'fit');
    if (want === 'keep' && !wasFitted && before.globalId === null && this.tree.globalId === null) {
      const after = this.tree;
      const m = map;
      // up[i]: the nearest node at or above i that the map keeps (built once, in one preorder pass, only if the deep pass runs)
      let up: Int32Array | null = null;
      // tipIndices of a label in the old and the new tree, kept so a repeated label is looked up once
      const dupLists = new Map<string, [ArrayLike<number>, ArrayLike<number>]>();
      const target = (r: number, deep: boolean, out: TipTarget): boolean => {
        let node = before.tipNode[r];
        if (node < 0) return false;
        if (m) {
          // the tip, or what it became (a collapsed clade is one tip, an expanded tip is a clade); with `deep`, what it is part of
          if (deep) {
            if (!up) {
              up = new Int32Array(before.nodeCount);
              for (let i = 0; i < up.length; i++) {
                const q = i < m.length ? m[i] : -1;
                up[i] = q >= 0 && q < after.nodeCount ? i : before.parent[i] >= 0 ? up[before.parent[i]] : -1;
              }
            }
            node = up[node];
            if (node < 0) return false;
          }
          const q = node < m.length ? m[node] : -1;
          if (q < 0 || q >= after.nodeCount) return false;
          out.lo = after.leafStart[q];
          out.hi = after.leafEnd[q];
          out.node = q;
          return true;
        }
        // a label several tips carry: the k-th tip with it before is the k-th after
        const label = before.tipLabels[r];
        let q: number;
        if (before.tipIndices && after.tipIndices) {
          let lists = dupLists.get(label);
          if (!lists) {
            lists = [before.tipIndices(label), after.tipIndices(label)];
            dupLists.set(label, lists);
          }
          let k = 0;
          while (k < lists[0].length && lists[0][k] !== node) k++;
          if (k >= lists[1].length) return false;
          q = lists[1][k];
        } else {
          q = after.tipIndex(label);
          if (q < 0) return false;
        }
        out.lo = after.tipRank[q];
        out.hi = out.lo + 1;
        out.node = q;
        return true;
      };
      kept = keptViewport({
        layout: this.opts.layout,
        view: oldView,
        before,
        beforeL,
        after,
        afterL: this.L,
        fixedRows: !!this.opts.rowHeight,
        target,
      });
    }
    if (kept) {
      // the area first: the new tree's label reserve and columns decide the plot width the window is clamped against. Clamp here too:
      // setViewport skips a window equal to the current one, which was valid for the old tree only.
      this.vs.computeArea();
      this.vs.setViewport(this.vs.clampView(kept));
    } else this.fit(false);
    this.hit.invalidate();
    this.invalidate(true);
    this.events.emit('treechange', { map });
    if (cladesChanged) this.events.emit('cladeschange', this.getClades());
    if (hlChanged) this.events.emit('highlightchange', this.hlIds.slice());
    this.emitSelectionSince(oldSelected);
    if (hadHover) this.emitNode('hover', null);
  }

  // ---- state

  /** The element the viewer appended to its target (class phylo-viewer): the tree element and the control layer. */
  get element(): HTMLDivElement {
    return this.container;
  }
  /** The tree element (role="tree", focusable; the canvases and labels). */
  get treeElement(): HTMLDivElement {
    return this.root;
  }
  /** Give keyboard focus to the tree. */
  focus(): void {
    this.root.focus({ preventScroll: true });
  }
  /** The tree source the viewer reads (an `InMemorySource` around a `tree` passed in). */
  getSource(): TreeSource {
    return this.source;
  }
  /** The rows currently loaded (for an in-memory tree: the whole tree). Replaced, not mutated, when a partial source loads more. */
  getTree(): TreeSnapshot {
    return this.tree;
  }
  /** Node id (preorder id of the full tree) of the first tip with this label, or -1 when there is none or it is not loaded. Labels need not
   *  be unique: `tipNodes` gives every tip with the label. */
  tipNode(tipId: string): number {
    const row = this.tree.tipIndex(tipId);
    if (row < 0) return -1;
    return this.tree.globalId === null ? row : this.tree.globalId[row];
  }
  /** Node ids of every loaded tip with this label, in preorder (empty when there is none). */
  tipNodes(tipId: string): number[] {
    const t = this.tree;
    const out: number[] = [];
    this.eachTipRow(tipId, (row) => out.push(t.globalId === null ? row : t.globalId[row]));
    return out;
  }
  /** The rows of the loaded tips with this label: all of them when the tree has `tipIndices`, else the one `tipIndex` finds. */
  private eachTipRow(label: string, fn: (row: number) => void): void {
    const t = this.tree;
    const first = t.tipIndex(label);
    if (first < 0) return;
    const all = t.tipIndices?.(label);
    if (!all) return fn(first);
    for (let k = 0; k < all.length; k++) fn(all[k]);
  }
  /** The theme in force: `FALLBACK_THEME`, then the CSS custom properties (see theme.ts), then the overrides of `setTheme`. */
  getTheme(): Readonly<TreeTheme> {
    return this.theme;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }

  get layout(): Layout {
    return this.L;
  }
  get options(): Readonly<ViewerOptions> {
    return this.opts;
  }
  get size(): { width: number; height: number } {
    return { width: this.W, height: this.H };
  }

  /** Apply options. Keys that are undefined or `Object.is`-equal to the current value (functions by identity) are ignored, and a call
   *  that changes nothing returns without invalidating, so a caller may pass its whole option set on every render. */
  setOptions(patch: Partial<ViewerOptions>): void {
    const o = this.opts;
    checkThemeObserver(patch.themeObserver);
    const p: Partial<ViewerOptions> = {};
    let any = false;
    for (const k of Object.keys(patch) as (keyof ViewerOptions)[]) {
      const v = patch[k];
      if (v === undefined || Object.is(v, o[k])) continue;
      (p as Record<string, unknown>)[k] = v;
      any = true;
    }
    if (!any) return;
    const changed = Object.keys(p) as (keyof ViewerOptions)[];
    const lengthsChanged = p.branchLengths !== undefined && p.branchLengths !== o.branchLengths;
    const layoutChanged = p.layout !== undefined && p.layout !== o.layout;
    const refit = lengthsChanged || layoutChanged || refitsView(p, o);
    // the pooled label elements take their text (formatLabel, and for collapsed clades cladeLabel and formatCollapsedLabel) and link
    // (tipHref) when they are created, so a change of any rebuilds them
    const labelsChanged = (['tipHref', 'formatLabel', 'cladeLabel', 'formatCollapsedLabel'] as const).some(
      (k) => p[k] !== undefined && p[k] !== o[k],
    );
    this.opts = { ...o, ...p };
    if (layoutChanged || lengthsChanged) this.minPxHint = 0;
    if (p.dprCap !== undefined && p.dprCap !== o.dprCap) this.setSize(this.W, this.H);
    if (p.themeObserver !== undefined) {
      this.watchTheme();
      if (o.themeObserver === 'none') this.refreshTheme(); // nothing watched the page meanwhile
    }
    if (p.radialMaxNodes !== undefined || p.summaryNotice !== undefined || p.interactionLOD !== undefined) this.minPxHint = 0;
    if (p.ariaLabel) this.root.setAttribute('aria-label', p.ariaLabel);
    // the fan first: the layout of the other branch lengths is then made with the new fan, and the transform carries it too
    const fanRefit = this.applyFanOption(p);
    if (lengthsChanged) {
      this.L = this.layoutFor(this.opts.branchLengths);
      this.rebuildProj();
      this.hit.invalidate();
    }
    if (labelsChanged) this.overlay.clear(true);
    if (fanRefit || refit) this.refitAfterOptions(p, layoutChanged || lengthsChanged);
    else if (p.maxTipSpacing !== undefined || p.maxViewWidth !== undefined) this.reclampView();
    this.sceneVersion++;
    this.invalidate();
    this.events.emit('optionschange', { options: this.opts, changed });
  }

  /** `setOptions` changed `radialOpening` or `radialRotation` (in `p`, already in `this.opts`): every cached layout gets the new fan (its
   *  trig cache is rebuilt on the next use) and the last frame's transform and projection follow. True when the view is to be refitted
   *  (the radial layout is shown). */
  private applyFanOption(p: Partial<ViewerOptions>): boolean {
    if (p.radialOpening === undefined && p.radialRotation === undefined) return false;
    const fan = radialFan(this.opts.radialOpening, this.opts.radialRotation);
    for (const L of this.layouts.values()) setLayoutFan(L, fan);
    if (this.T) this.T = makeTransform(this.opts.layout, this.W, this.H, this.vs.view, this.vs.area, this.L.rows, this.L.fan);
    this.rebuildProj();
    this.hit.invalidate();
    this.minPxHint = 0;
    return this.opts.layout === 'radial';
  }

  /** The view after `setOptions` changed something that refits. The keyboard cursor and the selection stay (node ids do not change with
   *  the layout): after a `switched` layout or branch lengths the view goes to the selection, else it is fitted as before (a zoomed view is
   *  only clamped to the new limits), and the cursor is announced again. */
  private refitAfterOptions(p: Partial<ViewerOptions>, switched: boolean): void {
    if (!(switched && this.frameSelection()) && (this.vs.fitted || switched || p.rowHeight !== undefined || p.treeWidth !== undefined))
      this.fit(false);
    else this.reclampView(); // a zoomed view keeps its window within the limits, which are relative to the fit (radial: alignLabels moves it)
    if (switched && this.activeNode >= 0) this.overlay.announce(this.describe(this.activeNode));
  }

  /** Set the theme overrides: these fields over the theme read from CSS custom properties, over `FALLBACK_THEME` (a field left out,
   *  or undefined, is the CSS or fallback value; the overrides of an earlier call are replaced, not merged: see `updateTheme`). No-op when the resulting theme equals the current one (`categorical` element-wise),
   *  so a theme rebuilt per render costs nothing. */
  setTheme(t: Partial<TreeTheme>): void {
    this.themeOverrides = { ...stripUndefined(t) };
    this.applyTheme(this.composeTheme());
  }

  /** Merge these fields into the current overrides (what `setTheme` replaced): one control can set the font size and another the
   *  branch width. A field that is `undefined` is dropped from the overrides, so it goes back to the CSS or fallback value. */
  updateTheme(patch: Partial<TreeTheme>): void {
    const next: Partial<TreeTheme> = { ...this.themeOverrides };
    for (const k of Object.keys(patch) as (keyof TreeTheme)[]) {
      if (patch[k] === undefined) delete next[k];
      else (next as Record<string, unknown>)[k] = Array.isArray(patch[k]) ? (patch[k] as unknown[]).slice() : patch[k];
    }
    this.themeOverrides = next;
    this.applyTheme(this.composeTheme());
  }

  /** Read the theme's CSS custom properties again (after a stylesheet or class change that the viewer cannot see). The viewer does
   *  this itself when it is created and when the colour scheme preference changes. */
  refreshTheme(): void {
    if (this.destroyed) return;
    this.cssTheme = themeFromCss(this.host, false);
    this.applyTheme(this.composeTheme());
  }

  /** `FALLBACK_THEME`, the CSS properties, the overrides. `dark`, when neither `--phylo-dark` nor an override says, follows the merged
   *  background (so `setTheme({ background: '#0f172a' })` is a dark theme); a translucent background says nothing. */
  private composeTheme(): TreeTheme {
    const t = { ...FALLBACK_THEME, ...this.cssTheme, ...this.themeOverrides };
    if (this.cssTheme.dark === undefined && this.themeOverrides.dark === undefined) t.dark = deriveDark(t.background) ?? t.dark;
    return t;
  }

  private onScheme = () => this.refreshTheme();
  private docRaf = 0;
  /** Mutations of <html> come in bursts (class and attribute writes): one refresh per frame. */
  private onDocMutation = () => {
    if (this.docRaf) return;
    this.docRaf = requestAnimationFrame(() => {
      this.docRaf = 0;
      this.refreshTheme();
    });
  };

  /** Start or stop what re-reads the CSS theme, per the `themeObserver` option (also when it changes). */
  private watchTheme(): void {
    this.schemeQuery?.removeEventListener?.('change', this.onScheme);
    this.schemeQuery = null;
    this.docObserver?.disconnect();
    this.docObserver = null;
    if (this.docRaf) cancelAnimationFrame(this.docRaf);
    this.docRaf = 0;
    if (this.destroyed) return;
    const mode = this.opts.themeObserver;
    checkThemeObserver(mode);
    if (mode === 'none') return;
    if (typeof matchMedia === 'function') {
      this.schemeQuery = matchMedia('(prefers-color-scheme: dark)');
      this.schemeQuery.addEventListener?.('change', this.onScheme);
    }
    if (mode === 'document' && typeof MutationObserver === 'function') {
      this.docObserver = new MutationObserver(this.onDocMutation);
      this.docObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    }
  }

  /** Put the theme in force on the root as custom properties, so the DOM inside it (controls, popups) matches the canvas also when the
   *  theme came from `setTheme` rather than CSS. The viewer reads CSS from its target, never from its root, so this cannot feed back. */
  private syncCssVars(): void {
    const s = this.container.style;
    const t = this.theme;
    for (const k of ['background', 'foreground', 'muted', 'branch', 'highlight', 'summary', 'fontFamily', 'labelFontStyle'] as const)
      s.setProperty(THEME_CSS_VARS[k], t[k]);
  }

  private mainContext(): CanvasRenderingContext2D {
    const cc = { alpha: this.canvasAlpha, willReadFrequently: this.opts.softwareCanvas } as CanvasRenderingContext2DSettings;
    return this.canvas.getContext('2d', cc)!;
  }

  private applyTheme(next: TreeTheme): void {
    if (themeEquals(next, this.theme)) return;
    const prevLabelSize = this.theme.labelSize;
    this.theme = next;
    this.columns = recolourColumns(this.tree, this.columns, next); // residue tokens: the alignment bitmaps hold the colours
    // an opaque canvas cannot show the page through a transparent background (it clears to black): change canvas when that changes
    const alpha = !isOpaque(next.background);
    if (alpha !== this.canvasAlpha) {
      this.canvasAlpha = alpha;
      const old = this.canvas;
      this.canvas = old.cloneNode(false) as HTMLCanvasElement; // same style, attributes and size
      this.canvas.width = old.width;
      this.canvas.height = old.height;
      old.replaceWith(this.canvas);
      old.width = old.height = 0; // release its backing store
      this.ctx = this.mainContext();
    }
    this.syncCssVars();
    // font-relative sizes (rowHeight, maxTipSpacing) follow the label size
    if (next.labelSize !== prevLabelSize) {
      const o = this.opts;
      if (typeof o.rowHeight === 'string' && this.vs.fitted) this.fit(false);
      else this.reclampView();
    }
    this.sceneVersion++;
    this.overlay.clear(true);
    this.invalidate(true);
    this.events.emit('themechange', this.theme);
  }

  /** The view again within the zoom limits (they follow options and the label size). */
  private reclampView(): void {
    if (this.W <= 0 || this.vs.fitted) return;
    this.vs.computeArea();
    const c = this.vs.clampView(this.vs.view);
    if (!viewportEquals(c, this.vs.view, 1e-12)) this.vs.view = c;
  }

  /** Colour clades: each entry colours the branches, summaries, markers and tip labels of the clade below `node`. Where clades nest
   *  the innermost wins, whatever the order; for the same node the later entry wins. No-op for the same entries in the same order. */
  setClades(clades: CladeColour[]): void {
    if (!this.storeClades(this.knownNodes('setClades', clades, (c) => c.node))) return;
    this.applyClades();
    this.sceneVersion++;
    this.invalidate();
    this.events.emit('cladeschange', this.getClades());
  }

  /** Keep the list (copied); false when it equals the current one. */
  private storeClades(clades: CladeColour[]): boolean {
    const key = clades.map((c) => c.node + ':' + c.colour + ':' + (c.label ?? '')).join('|');
    if (key === this.cladeKey) return false;
    this.cladeKey = key;
    this.clades = clades.map((c) => ({ ...c }));
    return true;
  }

  getClades(): CladeColour[] {
    return this.clades.map((c) => ({ ...c }));
  }

  /** Colour classes per row from the clade list (node ids of the full tree). Clades that are not part of the snapshot are skipped. */
  private applyClades(): void {
    const clades = this.clades;
    if (!clades.length) {
      this.classOf = null;
      this.colours = [''];
      return;
    }
    const cls = new Uint8Array(this.tree.nodeCount);
    const colours = [''];
    // filled in preorder (an ancestor's row comes before its descendants'), so an inner clade paints over the one around it; the
    // sort is stable, so for the same node the later entry wins
    const placed = clades
      .map((c) => ({ c, r: this.rowOf(c.node) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r);
    for (const { c, r } of placed) {
      let k = colours.indexOf(c.colour);
      if (k < 0) {
        k = Math.min(255, colours.push(c.colour) - 1);
      }
      cls.fill(k, r, this.tree.subtreeEnd[r]);
    }
    this.classOf = cls;
    this.colours = colours;
  }

  /** Collapse these clades in the view: each is drawn as one triangle on ONE row of its own (the rows of its tips are freed), at the clade's
   *  place in the tree, its depth ending at its deepest tip (so a dated tree keeps its axis), and is never opened by the level of detail.
   *  `nodeIds` are the preorder ids of the full tree, the same ids as everywhere in the API: colours, highlights, events and `zoomToNode`
   *  keep speaking them, and the tree is not changed. Ids of tips are ignored, ids that are not nodes of the tree are ignored with a warning,
   *  and a clade inside a collapsed one is hidden by it. A click or hover on a collapsed clade reports `kind: 'summary'`, `node` = the clade and
   *  `collapsed: true`. The window keeps its scale and the clades in it; a view that fits the whole tree is fitted again. The hover is
   *  reset; the keyboard cursor and the selection stay, and one that a collapsed clade now hides moves to that clade. No-op for the same
   *  ids in the same order. A partially loaded source cannot collapse clades.
   *  Collapsing only draws less: `focusTip` on a tip inside a collapsed clade focuses the clade, columns draw nothing on its row. */
  setCollapsed(nodeIds: number[]): void {
    if (!this.storeCollapsed(this.knownNodes('setCollapsed', nodeIds, (n) => n))) return;
    this.relayoutCollapsed();
  }

  private storeCollapsed(nodes: number[]): boolean {
    const last = this.collapsedNodes;
    if (nodes.length === last.length && nodes.every((n, i) => n === last[i])) return false;
    this.collapsedNodes = nodes.slice();
    return true;
  }

  /** The mask of `collapsedNodes` by row of the snapshot (the layout reads it): internal nodes only, none for a partially loaded tree. */
  private applyCollapsed(): void {
    const t = this.tree;
    let mask: Uint8Array | null = null;
    if (t.rollup === null && t.stub === null)
      for (const n of this.collapsedNodes) {
        const r = this.rowOf(n);
        if (r < 0 || t.childCount[r] === 0) continue;
        mask ??= new Uint8Array(t.nodeCount);
        mask[r] = 1;
      }
    this.collapsedMask = mask;
  }

  /** The collapsed set changed: new layout, and the window carried over to it. */
  private relayoutCollapsed(): void {
    const before = this.L;
    this.applyCollapsed();
    this.layouts.clear();
    this.L = this.layoutFor(this.opts.branchLengths);
    if (before.collapsed === null && this.L.collapsed === null) {
      this.rebuildProj();
      return; // nothing collapsed before or after (e.g. only tips passed)
    }
    const vs = this.vs;
    const rect = this.opts.layout === 'rectangular';
    const v = { ...vs.view };
    const hidden = this.L.hidden;
    if (this.activeNode >= 0 && hidden?.[this.activeNode]) this.activeNode = this.L.rowNode![this.L.rowStart[this.activeNode]];
    const wasSelected = this.selected;
    if (this.selected >= 0) this.selected = this.shownNode(this.selected);
    this.pendingHover = null;
    this.clearHover();
    this.hit.invalidate();
    this.minPxHint = 0;
    this.sceneVersion++;
    if (vs.fitted) this.fit(false);
    else if (rect) {
      // same scale (rows in view) around the place the centre was at: the same clade stays in the middle
      const h = v.y1 - v.y0;
      const yc = remapRow((v.y0 + v.y1) / 2, before, this.L);
      vs.setViewport({ ...v, y0: yc - h / 2, y1: yc + h / 2 });
    } else {
      // the angle of the window's centre follows its row; the scale and the radius stay
      const cx = (v.x0 + v.x1) / 2,
        cy = (v.y0 + v.y1) / 2;
      const rho = Math.hypot(cx, cy);
      if (rho > 1e-6) {
        const th2 = fanAngle(this.L.fan, this.L.rows, remapRow(fanRow(before.fan, before.rows, Math.atan2(cy, cx)), before, this.L));
        const nx = rho * Math.cos(th2),
          ny = rho * Math.sin(th2);
        vs.setViewport({ x0: nx - (cx - v.x0), x1: nx + (v.x1 - cx), y0: ny - (cy - v.y0), y1: ny + (v.y1 - cy) });
      }
    }
    // the transform of the last frame counts rows too (the radial angle step): positions asked before the next frame use the new ones
    if (this.T) this.T = makeTransform(this.opts.layout, this.W, this.H, vs.view, vs.area, this.L.rows, this.L.fan);
    this.rebuildProj();
    this.hit.invalidate();
    this.invalidate(true);
    this.overlay.scheduleList();
    this.emitSelectionSince(wasSelected);
  }

  /** Highlight tips: a string highlights every tip with that label (labels need not be unique), a number the tip with that node id. Unknown
   *  labels are ignored; a number that is not a node, or is an internal node, is ignored with a warning. No-op when the entries equal
   *  (element-wise, in order) the last ones passed; the array is copied, so mutating it later cannot hide a change. */
  setHighlighted(tips: readonly TipRef[]): void {
    const last = this.hlIds;
    if (tips.length === last.length && tips.every((id, i) => id === last[i])) return;
    this.hlIds = tips.slice();
    this.checkHighlighted('setHighlighted', this.hlIds);
    this.resolveHighlights();
    this.sceneVersion++;
    this.invalidate();
    this.events.emit('highlightchange', this.hlIds.slice());
  }

  /** The ranks of the loaded tips among `hlIds`: `hlRanks`, `hl`, and the dim prefix (dropped, built again by the next dimming frame). With
   *  a partial source a match whose rows are not loaded has no rank yet, so its clade counts as holding no match (and dims) until it loads. */
  private resolveHighlights(): void {
    const N = this.tree.tipCount;
    const t = this.tree;
    const ranks: number[] = [];
    const add = (row: number) => {
      if (t.childCount[row] === 0 && t.tipRank[row] >= 0) ranks.push(t.tipRank[row]);
    };
    for (const id of this.hlIds) {
      if (typeof id === 'string') this.eachTipRow(id, add);
      else if (Number.isInteger(id)) {
        const row = this.rowOf(id);
        if (row >= 0) add(row);
      }
    }
    const sorted = Int32Array.from(ranks).sort(); // a typed array sorts numerically, and much faster than an array with a comparator
    let n = 0;
    for (let k = 0; k < sorted.length; k++) if (k === 0 || sorted[k] !== sorted[k - 1]) sorted[n++] = sorted[k];
    this.hlRanks = sorted.slice(0, n);
    if (n) {
      this.hl = new Uint8Array(N);
      for (let k = 0; k < n; k++) this.hl[this.hlRanks[k]] = 1;
    } else this.hl = null;
    this.hlPrefix = null;
  }

  /** The dim prefix for a frame, built when first needed; null without highlights. */
  private dimPrefix(): Int32Array | null {
    const hl = this.hl;
    if (!hl) return null;
    if (!this.hlPrefix) {
      const pre = new Int32Array(hl.length + 1);
      for (let r = 0; r < hl.length; r++) pre[r + 1] = pre[r] + hl[r];
      this.hlPrefix = pre;
    }
    return this.hlPrefix;
  }

  /** The highlight list of the new tree in `setTree`: the one passed (checked), else the old one with labels kept and node ids sent through
   *  `rm` (tips that are gone dropped; without a map, `rm` null, kept as they are). */
  private highlightsAfterSetTree(passed: TipRef[] | undefined, old: TipRef[], rm: ((n: number) => number) | null): TipRef[] {
    if (passed) {
      const ids = passed.slice();
      this.checkHighlighted('setTree highlighted', ids);
      return ids;
    }
    if (!rm || !old.some((x) => typeof x === 'number')) return old;
    const out: TipRef[] = [];
    for (const x of old) {
      if (typeof x !== 'number') out.push(x);
      else if (Number.isInteger(x) && rm(x) >= 0) out.push(rm(x));
    }
    return out;
  }

  /** The selection of the new tree in `setTree`: the old one sent through `rm` (gone: none; inside a clade collapsed now: the clade).
   *  Without a map the new tree's ids name other nodes, so it is dropped. */
  private selectionAfterSetTree(old: number, map: Int32Array | null, rm: (n: number) => number): number {
    const sel = map && old >= 0 ? rm(old) : -1;
    return sel >= 0 && isNodeOf(this.nodeLimit(), sel) ? this.shownNode(sel) : -1;
  }

  /** The marks of the new tree in `setTree`: the old ones sent through `rm` (removed ones dropped); without a map, none. */
  private marksAfterSetTree(map: Int32Array | null, rm: (n: number) => number): number[] {
    if (!map) return [];
    const limit = this.nodeLimit();
    return this.marked.map(rm).filter((n) => n >= 0 && isNodeOf(limit, n));
  }

  /** Warn about the entries of a highlight list that are neither a label nor a tip: numbers that are not nodes, and internal nodes that are
   *  loaded. They stay in the list (`getHighlighted` gives back what was set) and highlight nothing. */
  private checkHighlighted(where: string, ids: readonly TipRef[]): void {
    const limit = this.nodeLimit();
    let bad: unknown[] | null = null;
    let inner: number[] | null = null;
    for (const id of ids) {
      if (typeof id === 'string') continue;
      if (!isNodeOf(limit, id)) (bad ??= []).push(id);
      else {
        const row = this.rowOf(id);
        if (row >= 0 && this.tree.childCount[row] > 0) (inner ??= []).push(id);
      }
    }
    if (bad) warnUnknownNodes(where, bad, limit);
    if (inner) {
      const more = inner.length > 5 ? ` and ${inner.length - 5} more` : '';
      console.warn(
        `gbif-phylo: ${where}: ${inner.slice(0, 5).join(', ')}${more} ${inner.length === 1 ? 'is an internal node' : 'are internal nodes'}, ` +
          'not tips (a number highlights the tip with that node id, a string every tip with that label); ignored',
      );
    }
  }

  /** What was last passed to `setHighlighted` (labels and node ids, unknown ones included). */
  getHighlighted(): TipRef[] {
    return this.hlIds.slice();
  }

  /** Select a node (a node id, any tip or internal node), or nothing with null. The selected node gets a ring (theme `selectionColour`,
   *  `selectionWidth`, `selectionRadius`); a click selects its node by default (`preventDefault()` in a `click` listener stops it). The
   *  selection is kept across layout, branch-length and theme changes, across `setTree` through its `map` (dropped without one) and across
   *  collapsing: a node inside a collapsed clade selects the clade. A switch of layout or branch lengths centres the new view on the
   *  selected tip, or frames the selected clade, instead of fitting. A number that is not a node is ignored with a warning. Emits
   *  `selectionchange` when the selection changed. */
  setSelected(node: number | null): void {
    if (node === null || node === undefined) return this.select(-1);
    if (this.knownNode('setSelected', node)) this.select(this.shownNode(node));
  }

  /** The selected node's id, null when nothing is selected. */
  getSelected(): number | null {
    return this.selected < 0 ? null : this.selected;
  }

  private select(id: number): void {
    if (id === this.selected) return;
    this.selected = id;
    this.topDirty = true;
    this.schedule();
    this.emitSelection();
  }

  private emitSelection(): void {
    this.events.emit('selectionchange', { node: this.selected < 0 ? null : this.selected });
  }

  /** `selectionchange` when the selection is no longer `old`. */
  private emitSelectionSince(old: number): void {
    if (this.selected !== old) this.emitSelection();
  }

  /** Mark nodes (node ids, tips or clades) with a ring of their own (theme `markColour`, `markWidth`, `markRadius`, `markDash`), until
   *  `setMarked([])`: the pending pick of a two-step action such as a swap, which stays visible while the pointer looks for the second.
   *  The rings follow the nodes through pans, zooms and layout switches; a node inside a collapsed clade is marked on the clade.
   *  Kept across `setTree` through its `map`, dropped without one. Numbers that are not nodes are ignored with a warning. */
  setMarked(nodes: readonly number[]): void {
    const known = this.knownNodes('setMarked', nodes, (n) => n);
    if (known.length === this.marked.length && known.every((n, i) => n === this.marked[i])) return;
    this.storeMarked(known.slice());
    this.topDirty = true;
    this.schedule();
  }

  /** The marked nodes, as given to `setMarked` (unknown ids left out). */
  getMarked(): number[] {
    return this.marked.slice();
  }

  private storeMarked(nodes: number[]): void {
    this.marked = nodes;
    if (this.markRows.length !== nodes.length) this.markRows = new Int32Array(nodes.length);
  }

  /** After a switch of layout or branch lengths: the view centred on the selected tip at a readable size (as `focusTip`), or framing the
   *  selected clade (as `zoomToNode`), worked out from the new layout's fit view. False when nothing is selected, or its row is not loaded. */
  private frameSelection(): boolean {
    const row = this.selected >= 0 ? this.rowOf(this.selected) : -1;
    if (row < 0) return false;
    const vs = this.vs;
    vs.cancelAnim();
    vs.computeArea();
    vs.view = vs.fitViewport(); // the targets keep the current scale where they can: the new layout's fit, not the old layout's window
    vs.fitted = true;
    const target = this.tree.childCount[row] === 0 ? vs.focusViewport(row) : vs.cladeViewport(row);
    if (viewportEquals(target, vs.view)) this.fit(false);
    else vs.setViewport(target);
    return true;
  }

  /** Only the columns whose spec changed are compiled again (see `updateColumns`); `values` is compared by reference. No-op when nothing changed. */
  setColumns(cols: Column[]): void {
    const had = columnsFixed(this.columns);
    const next = updateColumns(this.tree, this.columns, cols, this.theme);
    if (next.same) return;
    this.columns = next.columns;
    const now = columnsFixed(this.columns);
    const changed = now.fixed !== had.fixed || now.fills !== had.fills;
    if (changed && this.vs.fitted) this.fit(false);
    this.hit.invalidate();
    this.invalidate();
  }

  getViewport(): Viewport {
    return { ...this.vs.view };
  }

  setViewport(v: Viewport, animate = false): void {
    this.vs.setViewport(v, animate);
  }

  /** The window `fit()` would go to, without moving: the whole tree and the columns in the container as it is now (a copy). */
  fitViewport(): Viewport {
    this.vs.computeArea();
    return { ...this.vs.fitViewport() };
  }

  /** The view as an image (the canvas only: DOM controls, overlays and label anchors are not in it): what `render` draws now, drawn again into an offscreen canvas with the same code (the visible canvas is not
   *  read), without the selection, hover and keyboard rings. `type` is an image MIME type (default 'image/png'); `scale` the backing pixels per CSS
   *  pixel (default the canvas's own, `devicePixelRatio` capped by `dprCap`), so the image is `width * scale` by `height * scale`;
   *  `background` a CSS colour, or null for a transparent image (default: the theme's background). Rejects when the canvas cannot
   *  make the image, and with `RangeError` over 16384 px a side or 2^26 px in all. A browser that cannot encode `type` gives a PNG:
   *  check `blob.type`. Lines drawn one device pixel wide (dense radial trees) are `1 / scale` CSS px, so fainter above the screen's scale. */
  toBlob(opts: { type?: string; scale?: number; background?: string | null } = {}): Promise<Blob> {
    if (this.destroyed) return Promise.reject(new Error('toBlob: the viewer is destroyed'));
    const scale = opts.scale ?? this.effScale();
    if (!(scale > 0) || !Number.isFinite(scale)) return Promise.reject(new RangeError('toBlob: scale must be a positive number'));
    const w = Math.round(this.W * scale),
      h = Math.round(this.H * scale);
    if (w > MAX_EXPORT_PX || h > MAX_EXPORT_PX || w * h > MAX_EXPORT_AREA)
      return Promise.reject(
        new RangeError(`toBlob: ${w} x ${h} px is over the limit (${MAX_EXPORT_PX} px a side, ${MAX_EXPORT_AREA} px in all); lower the scale`),
      );
    this.renderNow(); // the list, projection and transform of the current view
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const background = opts.background === undefined ? this.theme.background : opts.background;
    // opaque like the screen's canvas when the background is: Chromium draws text on an opaque canvas with subpixel antialiasing
    // (where the system's font settings ask for it) and on one with alpha in greyscale, so the image would differ from the screen
    const ctx = canvas.getContext('2d', { alpha: background === null || !isOpaque(background) });
    if (!ctx) return Promise.reject(new Error('toBlob: no 2D context'));
    this.paint(ctx, scale, new LabelList(), background);
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => {
        canvas.width = canvas.height = 0; // release the backing store
        if (b) resolve(b);
        else reject(new Error('toBlob: the canvas produced no image'));
      }, opts.type ?? 'image/png');
    });
  }

  /** Fit the whole tree (and the columns) into the container. */
  fit(animate = true): void {
    this.vs.fit(animate);
  }

  /** Zoom by factors fx, fy (>1 zooms in) keeping the layout point under (px, py) fixed. */
  zoomBy(fx: number, fy: number, px: number, py: number): void {
    this.vs.zoomBy(fx, fy, px, py);
  }

  /** Bring the tip of this rank into view at a readable size. A tip inside a collapsed clade is not drawn: the clade is brought into view
   *  instead (nothing is expanded). */
  focusTip(rank: number, animate = false): void {
    if (rank < 0 || rank >= this.tree.tipCount) return;
    let node = this.tree.tipNode[rank];
    if (node < 0) return; // the tip's row is not loaded
    if (this.L.rowNode && this.L.rowOfRank) node = this.L.rowNode[this.L.rowOfRank[rank]]; // inside a collapsed clade: the clade
    this.activeNode = -1;
    this.vs.setViewport(this.vs.focusViewport(node), animate);
  }

  zoomToNode(id: number, animate = false): void {
    if (!this.knownNode('zoomToNode', id)) return;
    let row = this.rowOf(id);
    if (row < 0) return;
    if (this.L.hidden?.[row]) row = this.L.rowNode![this.L.rowStart[row]]; // inside a collapsed clade: frame the clade
    this.zoomToRow(row, animate);
  }

  /** The label of a collapsed clade (row of the snapshot): `formatCollapsedLabel` of its name and size. */
  private cladeText(row: number): string {
    const t = this.tree;
    return this.opts.formatCollapsedLabel(cladeName(t, row, this.opts), t.leafEnd[row] - t.leafStart[row]);
  }

  /** zoomToNode for a row of the snapshot (a hit's node), which with a partial source is not the node id of the public API. */
  private zoomToRow(row: number, animate: boolean): void {
    this.vs.setViewport(this.vs.cladeViewport(row), animate);
  }

  /** Where a click would land on node i (client px), or null when the node is not drawn / not in view. */
  locateNode(id: number): { x: number; y: number } | null {
    if (!this.knownNode('locateNode', id)) return null;
    this.renderNow();
    const i = this.rowOf(id);
    if (i < 0) return null;
    const e = this.findInList(i);
    const isTip = this.tree.childCount[i] === 0;
    if (e < 0 && !isTip) return null;
    if (this.L.hidden?.[i]) return null; // inside a collapsed clade: not drawn
    const p = { x: 0, y: 0 };
    this.proj.nodeXY(i, p);
    const m = isTip ? 0 : 1; // a tip row at the very edge of the fit view still counts as in view
    if (p.x < this.T.clipL + m || p.y < this.T.clipT + m || p.x > this.T.clipR - m || p.y > this.T.clipB - m) return null;
    const r = this.root.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }

  /** Where node `id` is under the current view, in px relative to the viewer element, without drawing a frame (so it is cheap enough
   *  for a `frame` or `viewchange` listener); null when the node is not loaded, there is no frame yet, or it lies outside the plot area.
   *  Unlike `locateNode`, an internal node that the level of detail summarised still gets its position. A node inside a clade the app
   *  collapsed (`setCollapsed`) has none: null. */
  nodePosition(id: number): { x: number; y: number } | null {
    const i = this.rowOf(id);
    if (i < 0 || !this.T || !this.proj || this.L.hidden?.[i]) return null;
    const p = { x: 0, y: 0 };
    this.proj.nodeXY(i, p);
    const T = this.T;
    if (p.x < T.clipL - 0.5 || p.y < T.clipT - 0.5 || p.x > T.clipR + 0.5 || p.y > T.clipB + 0.5) return null;
    return p;
  }

  /** Drawn extent of the clade below node i (client px), clipped to the plot area; null when not visible. */
  nodeBounds(id: number): { x: number; y: number; width: number; height: number } | null {
    if (!this.knownNode('nodeBounds', id)) return null;
    this.renderNow();
    const i = this.rowOf(id);
    if (i < 0 || this.L.hidden?.[i]) return null;
    const T = this.T;
    let x0: number, y0: number, x1: number, y1: number;
    const isTip = this.tree.childCount[i] === 0;
    if (isTip) {
      const p = { x: 0, y: 0 };
      this.proj.nodeXY(i, p);
      x0 = p.x - 5;
      x1 = p.x + 5;
      y0 = p.y - 5;
      y1 = p.y + 5;
    } else if (T.kind === 'rectangular') {
      x0 = T.ox + this.L.X[i] * T.kx;
      x1 = T.ox + this.L.XMAX[i] * T.kx;
      y0 = T.oy + this.L.rowStart[i] * T.ky;
      y1 = T.oy + this.L.rowEnd[i] * T.ky;
    } else {
      const bb = new Float64Array(4);
      const fa = this.L.fan.start;
      sectorBBox(T.cx, T.cy, this.L.X[i] * T.k, this.L.XMAX[i] * T.k, fa + this.L.rowStart[i] * T.da, fa + this.L.rowEnd[i] * T.da, bb);
      x0 = bb[0];
      y0 = bb[1];
      x1 = bb[2];
      y1 = bb[3];
    }
    x0 = Math.max(T.clipL, x0);
    y0 = Math.max(T.clipT, y0);
    x1 = Math.min(T.clipR, x1);
    y1 = Math.min(T.clipB, y1);
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    const r = this.root.getBoundingClientRect();
    return { x: r.left + x0, y: r.top + y0, width: x1 - x0, height: y1 - y0 };
  }

  columnCell(colId: string, rank: number): { x: number; y: number; width: number; height: number } | null {
    this.renderNow();
    const c = this.columns.find((k) => k.spec.id === colId);
    if (!c) return null;
    const rc = cellRect(c, rank, this.T, this.L.rowOfRank, this.L.rankOfRow);
    if (!rc) return null;
    const r = this.root.getBoundingClientRect();
    return { x: r.left + rc.x, y: r.top + rc.y, width: rc.width, height: rc.height };
  }

  /** Hit-test a point in container px (what a click there would target). */
  hitTest(x: number, y: number): Hit | null {
    this.renderNow();
    this.ensureHit();
    return this.queryHit(x, y);
  }

  getStats(): FrameStats & {
    layoutMs: number;
    hitBuildMs: number;
    avgFrameMs: number;
    maxFrameMs: number;
    listLength: number;
    hitItems: number;
    hitEntries: number;
    kx: number;
    ky: number;
  } {
    return {
      ...this.stats,
      layoutMs: this.L.layoutMs,
      hitBuildMs: this.hit.builtMs,
      avgFrameMs: this.msN ? this.msSum / this.msN : 0,
      maxFrameMs: this.msMax,
      listLength: this.list.count,
      hitItems: this.hit.items,
      hitEntries: this.hit.entries,
      kx: this.T?.kx ?? 0,
      ky: this.T?.ky ?? 0,
    };
  }
  resetFrameTimes(): void {
    this.msSum = 0;
    this.msN = 0;
    this.msMax = 0;
  }

  /** Draw synchronously if something changed (used before introspection and by benchmarks). */
  renderNow(): void {
    if (this.destroyed) return;
    this.settle();
    if (this.dirty) this.render();
    if (this.topDirty) this.drawTop();
  }

  /** If the last frame was drawn in reduced (interaction) quality, redraw it at full quality now. Hit-testing, locate and
   *  bounds call this first, so a click always hits what a full-quality frame shows, never the reduced list. */
  private settle(): void {
    if (!this.reducedFrame && !this.interacting) return;
    this.interacting = false;
    if (this.refineTimer) {
      clearTimeout(this.refineTimer);
      this.refineTimer = 0;
    }
    if (this.reducedFrame) this.dirty = true;
  }

  /** Called by every input that moves the view (wheel, drag, pinch, overview, animation steps). */
  private noteInput(): void {
    if (this.opts.interactionLOD === false) return;
    this.interacting = true;
    if (this.refineTimer) clearTimeout(this.refineTimer);
    this.refineTimer = window.setTimeout(() => {
      this.refineTimer = 0;
      if (this.destroyed) return;
      this.interacting = false;
      if (this.reducedFrame) this.dirty = true;
      this.schedule();
    }, this.opts.refineMs);
  }

  /** Whether this frame is drawn reduced: only while the view moves, and with 'auto' only when the full-quality frames are slow. */
  private reduceWhileMoving(): boolean {
    const mode = this.opts.interactionLOD;
    return this.interacting && (mode === true || (mode === 'auto' && this.fullMs > AUTO_LOD_MS));
  }

  /** Fold the JS time of a full-quality frame into fullMs (weight 1/2 on the newest). The first full frame carries one-off costs (JIT,
   *  first measurements) and is skipped; the second seeds the average. */
  private measureFull(ms: number): void {
    if (this.fullFrames++ === 0) return;
    this.fullMs = this.fullMs > 0 ? this.fullMs * 0.5 + ms * 0.5 : ms;
  }

  /** Force a full redraw n times and return the mean JS time per frame (benchmark helper). */
  benchmark(n: number): { meanMs: number; minMs: number; maxMs: number; cutMs: number; drawMs: number } {
    let sum = 0,
      min = Infinity,
      max = 0,
      cut = 0,
      draw = 0;
    for (let k = 0; k < n; k++) {
      this.dirty = true;
      this.render();
      sum += this.stats.frameMs;
      cut += this.stats.cutMs;
      draw += this.stats.drawMs;
      min = Math.min(min, this.stats.frameMs);
      max = Math.max(max, this.stats.frameMs);
    }
    return { meanMs: sum / n, minMs: min, maxMs: max, cutMs: cut / n, drawMs: draw / n };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.events.emit('destroy', undefined);
    this.destroyed = true; // from here on isDestroyed() is true, so controls do not act on the viewer while they are removed
    for (const c of this.controls.slice().reverse()) this.removeControl(c);
    this.events.clear();
    INTERNALS.delete(this);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.overlay.destroy();
    if (this.refineTimer) clearTimeout(this.refineTimer);
    this.ro?.disconnect();
    this.ro = null;
    (document as Document & { fonts?: FontFaceSet }).fonts?.removeEventListener?.('loadingdone', this.onFonts);
    this.schemeQuery?.removeEventListener?.('change', this.onScheme);
    this.docObserver?.disconnect();
    this.docObserver = null;
    if (this.docRaf) cancelAnimationFrame(this.docRaf);
    this.docRaf = 0;
    this.input.destroy();
    this.uiLayer.removeEventListener('wheel', this.onUiWheel);
    this.container.remove();
    // release the backing stores
    for (const c of [this.canvas, this.top]) {
      c.width = 0;
      c.height = 0;
    }
    this.columns = [];
    this.layouts.clear();
    this.unsubscribe();
    this.detail.destroy();
  }

  // ================================================================= layout, size

  private layoutFor(lengths: boolean): Layout {
    let L = this.layouts.get(lengths);
    if (!L) {
      if (this.layouts.size >= 2) this.layouts.delete([...this.layouts.keys()][0]);
      L = computeLayout(this.tree, lengths, this.collapsedMask);
      setLayoutFan(L, radialFan(this.opts.radialOpening, this.opts.radialRotation));
      this.layouts.set(lengths, L);
    }
    return L;
  }

  private measure(): void {
    const w = Math.max(1, this.host.clientWidth),
      h = Math.max(1, this.host.clientHeight);
    this.setSize(w, h);
  }

  private setSize(w: number, h: number): void {
    if (w === this.W && h === this.H && this.effScale() === this.dpr) return;
    const keep = this.vs.beforeResize();
    const resized = w !== this.W || h !== this.H;
    this.W = w;
    this.H = h;
    this.dpr = this.effScale();
    for (const c of [this.canvas, this.top]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
    }
    this.vs.afterResize(keep);
    this.sceneVersion++;
    this.hit.invalidate();
    this.invalidate();
    if (resized) this.events.emit('resize', { width: w, height: h });
  }

  // ================================================================= view changes

  private afterViewChange(): void {
    this.hit.invalidate();
    this.invalidate();
    this.overlay.scheduleList();
    this.emitViewport();
  }

  private emitViewport(): void {
    const view = this.vs.view;
    if (this.lastEmitted && viewportEquals(this.lastEmitted, view, 1e-12)) return;
    this.lastEmitted = { ...view };
    if (this.events.has('viewchange')) this.events.emit('viewchange', { ...view });
  }

  // ================================================================= frame loop

  invalidate(fonts = false): void {
    if (this.destroyed) return;
    this.dirty = true;
    this.topDirty = true;
    if (fonts) this.overlay.clear(true);
    this.schedule();
  }

  private schedule(): void {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame((now) => {
      this.raf = 0;
      if (this.destroyed) return;
      this.frameNow = now;
      if (this.vs.animating) this.vs.stepAnim(now);
      if (this.dirty) this.render();
      if (this.pendingHover && !this.interacting) this.doHover();
      if (this.topDirty) this.drawTop();
      this.frameNow = NaN;
      if (this.vs.animating) this.schedule();
    });
  }

  /** Canvas backing pixels per CSS pixel: the device pixel ratio, capped by the dprCap option. */
  private effScale(): number {
    const d = window.devicePixelRatio || 1;
    const cap = this.opts.dprCap;
    return cap > 0 && cap < d ? cap : d;
  }

  private ensureDpr(): void {
    if (this.effScale() !== this.dpr) this.setSize(this.W, this.H);
  }

  private fitCut(base: number, budget: number, summaries: boolean, useHint: boolean): { res: CutResult; minPx: number; retries: number } {
    const r = searchCut(this.proj, this.classOf, this.list, this.seen, {
      lod: this.opts.lod,
      base,
      budget,
      summaries,
      hint: useHint ? this.minPxHint : 0,
    });
    if (useHint) this.minPxHint = r.minPx;
    return r;
  }

  private render(): void {
    this.dirty = false;
    const t0 = performance.now();
    this.syncSource();
    this.ensureDpr();
    const { W, H, opts, tree, L } = this;
    const dpr = this.dpr;
    const rect = opts.layout === 'rectangular';
    if (!rect) ensureTrig(L);
    const vs = this.vs;
    vs.computeArea();
    this.T = makeTransform(opts.layout, W, H, vs.view, vs.area, L.rows, L.fan);
    this.proj = projectionFor(tree, L, this.T);
    const T = this.T;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const reduced = this.reduceWhileMoving();

    // ---- cut
    const tc = performance.now();
    const baseMinPx = Math.max(1, opts.minCladePx);
    let budget = opts.lod ? Math.max(500, opts.drawBudget) : 600000;
    if (opts.lod && !rect && Number.isFinite(opts.radialMaxNodes)) budget = Math.max(100, Math.min(budget, opts.radialMaxNodes));
    let base = baseMinPx;
    if (reduced) {
      budget = Math.max(500, Math.floor(budget / 4));
      if (this.lastFullDrawn > HEAVY_PRIMS) base = baseMinPx * REDUCED_MINPX;
    }
    const cutRes = this.fitCut(base, budget, opts.showSummaries, !reduced);
    const { minPx, retries } = cutRes;
    const res = cutRes.res;
    const cutMs = performance.now() - tc;
    this.hit.invalidate();
    if (!reduced) this.lastFullDrawn = this.list.count;

    // ---- draw
    const td = performance.now();
    // a background that is not opaque (transparent, rgba) would otherwise show the frames before this one
    if (this.canvasAlpha) ctx.clearRect(0, 0, W, H);
    this.paint(ctx, dpr, this.labels, this.theme.background);
    const drawMs = performance.now() - td;
    // the DOM overlay (label anchors) and the notice follow full-quality frames only; a reduced frame is replaced within refineMs
    if (!reduced) {
      this.overlay.update(this.labels, tree, opts, this.theme, T.kind);
      this.updateNotice(!rect && opts.summaryNotice && opts.lod && res.forced > 0, res.forced);
    } else this.overlay.follow(this.labels, T.kind); // the focus outline must move with the canvas
    this.reducedFrame = reduced;
    if (!reduced && tree.stub !== null) this.detail.request(tree, this.list, T, L, rect, vs.fitted, this.srcVersion);
    if (this.hoverNode >= 0 || this.activeNode >= 0 || this.selected >= 0 || this.topHad) this.topDirty = true;

    const frameMs = performance.now() - t0;
    const st = this.stats;
    st.frameMs = frameMs;
    st.cutMs = cutMs;
    st.drawMs = drawMs;
    st.visited = res.visited;
    st.drawn = this.list.count;
    st.summaries = res.summaries;
    st.tips = res.tips;
    st.labels = this.labels.count;
    st.minPxUsed = minPx;
    st.budgetRetries = retries;
    st.budgetHit = minPx > base || res.overflow;
    st.truncated = res.overflow;
    st.frames++;
    st.budget = budget;
    st.forced = res.forced;
    st.summaryTips = res.summaryTips;
    st.mergedTips = res.mergedTips;
    st.reduced = reduced;
    st.scale = dpr;
    if (!reduced) this.measureFull(frameMs);
    this.msSum += frameMs;
    this.msN++;
    if (frameMs > this.msMax) this.msMax = frameMs;
    this.events.emit('frame', st);
    if (!this.readyEmitted) {
      this.readyEmitted = true;
      this.events.emit('ready', { layoutMs: this.L.layoutMs, tips: this.source.tipCount });
    }
  }

  /** Draw the current cut (list, projection T) on `ctx` at `scale` backing pixels per CSS pixel: the background (none for null), the
   *  tree, the labels (into `labels`), the columns and the axis. The frame and `toBlob` both go through here. */
  private paint(ctx: CanvasRenderingContext2D, scale: number, labels: LabelList, background: string | null): void {
    const { W, H, opts, tree, T, vs } = this;
    const rect = opts.layout === 'rectangular';
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (background !== null) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, W, H);
    }
    const bands = opts.highlightStyle !== 'dim';
    const dimming = opts.highlightStyle !== 'band';
    const S: Scene = {
      proj: this.proj,
      list: this.list,
      theme: this.theme,
      colours: this.colours,
      classOf: this.classOf,
      highlight: bands ? this.hl : null,
      hlRanks: bands ? this.hlRanks : NO_RANKS,
      hlPrefix: dimming ? this.dimPrefix() : null,
      density: opts.labelDensity,
      alignLabels: opts.alignLabels,
      labelRoom: vs.radialLabelRoom(),
      format: opts.formatLabel,
      cladeText: (row) => this.cladeText(row),
      nodeLabels: opts.nodeLabels,
      formatNode: opts.formatNodeLabel,
      scale,
      thin: !rect && this.list.count >= THIN_PRIMS,
      measure: this.measurer,
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, rect ? T.clipT - 6 : 0, rect ? T.clipR : W, rect ? T.clipB - T.clipT + 12 : H);
    ctx.clip();
    if (opts.axis) drawRings(ctx, S, opts.radialRings); // radial only; with the scale bar, their one label without an opening
    drawHighlights(ctx, S, rect ? T.clipR + (columnsWidth(this.columns) || 0) : W);
    drawBody(ctx, S, this.theme.branchWidth);
    drawLeaders(ctx, S);
    drawMarkers(ctx, S);
    drawNodeLabels(ctx, S);
    drawLabels(ctx, S, labels);
    ctx.restore();
    if (rect) {
      const barC = this.theme.categorical[1] ?? this.theme.highlight;
      drawColumns(ctx, this.columns, tree, T, this.theme, T.area.ay - 8, barC, { alignStyle: opts.alignStyle, rankOfRow: this.L.rankOfRow });
      if (opts.axis) drawAxis(ctx, S, vs.view.x0, vs.view.x1);
    } else if (opts.axis) drawScaleBar(ctx, S);
  }

  private updateNotice(show: boolean, n: number): void {
    const el = this.notice;
    if (!show) {
      if (this.noticeShown) {
        el.style.display = 'none';
        this.noticeShown = false;
        this.noticeText = '';
      }
      return;
    }
    const text = `${n.toLocaleString('en')} clade${n === 1 ? '' : 's'} summarised, raise the limit in Library options`;
    if (text !== this.noticeText) {
      el.textContent = text;
      this.noticeText = text;
    }
    if (!this.noticeShown) {
      el.style.display = 'block';
      this.noticeShown = true;
    }
  }

  /** The rings of the marked nodes (`setMarked`), at their rows of the snapshot now (a hidden node at its collapsed clade). */
  private drawMarks(c: CanvasRenderingContext2D, proj: LayoutProjection): void {
    const rows = this.markRows;
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i++) rows[i] = this.rowOf(this.shownNode(this.marked[i]));
    drawMarkRings(c, proj, rows, this.theme);
  }

  /** The path to the root (option `hoverPath`) of the hovered node, else of the keyboard cursor: one path at a time. */
  private drawHoverPath(c: CanvasRenderingContext2D, proj: LayoutProjection): void {
    if (this.opts.hoverPath) drawRootPath(c, proj, this.hoverNode >= 0 ? this.hoverNode : this.activeNode, this.theme);
  }

  /** The marks, selection, hover and keyboard rings, and the path to the root of the hovered node (else of the keyboard cursor; under the
   *  rings), live on their own canvas so they never trigger a tree redraw. While a ring grows or fades (`hoverAnimation`), this canvas
   *  alone is redrawn every frame. */
  private topHad = false;
  private drawTop(): void {
    this.topDirty = false;
    const sel = this.selected >= 0 ? this.rowOf(this.selected) : -1;
    this.topHad = this.hoverNode >= 0 || this.activeNode >= 0 || sel >= 0 || this.marked.length > 0;
    const c = this.topCtx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.W, this.H);
    if (!this.T) return;
    const proj = this.proj;
    this.drawHoverPath(c, proj);
    this.drawMarks(c, proj);
    if (sel >= 0) drawSelectionRing(c, proj, sel, this.theme);
    if (this.drawRings(c, proj, sel)) {
      this.topDirty = true; // a ring is still changing: draw the next step
      this.schedule();
    }
    if (this.activeNode >= 0) this.drawCursorBox(c);
  }

  /** How long a ring takes to grow in: the theme's `hoverRingDuration` with `hoverAnimation`, 0 (at once) without it or when the user
   *  prefers reduced motion. */
  private ringMs(): number {
    if (!this.opts.hoverAnimation) return 0;
    if (this.motionQuery === undefined) this.motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    return this.motionQuery?.matches ? 0 : this.theme.hoverRingDuration;
  }

  /** The hover ring (growing in), the hover ring it replaced (fading out) and the keyboard cursor's ring (growing in when the cursor moves),
   *  in `highlight`. Returns whether one of them is still changing. */
  private drawRings(c: CanvasRenderingContext2D, proj: LayoutProjection, sel: number): boolean {
    const th = this.theme;
    const ms = this.ringMs();
    const now = this.frameNow;
    const hin = this.hoverIn,
      out = this.hoverOut;
    const shown = this.hoverNode >= 0 && this.hoverRun < 0 && this.hoverNode !== this.activeNode && this.hoverNode !== sel;
    // the pointer moved on: the old ring fades out. A ring hidden while its node is still hovered (it became the selection, as a click
    // does by default, or the keyboard cursor) goes at once, so it never fades over the ring that takes its place
    const prev = hin.node;
    if (prev >= 0 && prev !== this.hoverNode && ms > 0) out.fadeFrom(hin);
    hin.to(shown ? this.hoverNode : -1, this.hoverKind === 'summary' ? 1.5 : 1);
    this.cursorIn.to(this.activeNode, 1);
    const fading = this.fadeRing(c, proj, ms, now);
    const growing = this.growRing(c, proj, hin, th.hoverRingRadius * hin.scale, th.hoverRingWidth, ms, now);
    return this.growRing(c, proj, this.cursorIn, CURSOR_RING_RADIUS, CURSOR_RING_WIDTH, ms, now) || growing || fading;
  }

  /** A ring growing in: radius and opacity eased from 0. Returns whether it is still growing. */
  private growRing(
    c: CanvasRenderingContext2D,
    proj: LayoutProjection,
    ring: RingAnim,
    radius: number,
    width: number,
    ms: number,
    now: number,
  ): boolean {
    if (ring.node < 0) return false;
    const e = easeOut(ring.progress(now, ms));
    this.strokeRing(c, proj, ring.node, radius * e, width, e);
    return e < 1;
  }

  /** The hover ring left behind, fading out at the size it had reached. Returns whether it is still fading. */
  private fadeRing(c: CanvasRenderingContext2D, proj: LayoutProjection, ms: number, now: number): boolean {
    const out = this.hoverOut;
    if (out.node < 0) return false;
    const t = out.progress(now, ms);
    const th = this.theme;
    this.strokeRing(c, proj, out.node, th.hoverRingRadius * out.scale * out.peak, th.hoverRingWidth, out.peak * (1 - easeOut(t)));
    if (t < 1) return true;
    out.clear();
    return false;
  }

  private strokeRing(c: CanvasRenderingContext2D, proj: LayoutProjection, node: number, radius: number, width: number, alpha: number): void {
    if (!(radius > 0) || !(alpha > 0)) return;
    if (alpha < 1) c.globalAlpha = alpha;
    drawRing(c, proj, node, radius, this.theme.highlight, width);
    if (alpha < 1) c.globalAlpha = 1;
  }

  /** Rectangular: the box of the keyboard cursor's clade, from its node to the right edge. */
  private drawCursorBox(c: CanvasRenderingContext2D): void {
    const T = this.T;
    if (T.kind !== 'rectangular') return;
    const node = this.activeNode;
    const p = { x: 0, y: 0 };
    this.proj.nodeXY(node, p);
    c.strokeStyle = this.theme.highlight;
    c.globalAlpha = 0.5;
    c.lineWidth = 1;
    const ky = T.ky;
    const y0 = T.oy + this.L.rowStart[node] * ky,
      y1 = T.oy + this.L.rowEnd[node] * ky;
    if (y1 - y0 > 3 && this.tree.childCount[node] > 0)
      c.strokeRect(p.x, Math.max(T.clipT, y0), Math.max(4, T.clipR - p.x - 4), Math.min(T.clipB, y1) - Math.max(T.clipT, y0));
    c.globalAlpha = 1;
  }

  // ================================================================= hit-testing, hover

  private ensureHit(): void {
    if (!this.hit.valid) this.hit.build(this.list, this.proj);
  }

  private queryHit(x: number, y: number): Hit | null {
    // a label under the pointer (its text box; radial, turned along its ray) is a tip hit
    const L = this.labels;
    const k = L.at(x, y, this.T.kind === 'rectangular');
    if (k >= 0) return L.rank[k] >= 0 ? { node: this.tree.tipNode[L.rank[k]], kind: 'tip' } : { node: -L.rank[k] - 1, kind: 'summary' }; // a collapsed clade's label is the clade
    return this.hit.query(x, y, this.proj);
  }

  private findInList(node: number): number {
    const a = this.list.node;
    let lo = 0,
      hi = this.list.count - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (a[m] < node) lo = m + 1;
      else if (a[m] > node) hi = m - 1;
      else return m;
    }
    return -1;
  }

  private doHover(): void {
    const p = this.pendingHover;
    this.pendingHover = null;
    if (!p || this.input.gesturing) return;
    this.renderNow();
    this.ensureHit();
    const h = this.queryHit(p.x, p.y);
    const node = h ? h.node : -1;
    const r = this.root.getBoundingClientRect();
    const run = h?.run ? h.run.first : -1;
    if (node === this.hoverNode && (h?.kind ?? '') === this.hoverKind && run === this.hoverRun) return;
    this.hoverNode = node;
    this.hoverRun = run;
    this.hoverKind = h ? h.kind : '';
    this.root.style.cursor = h ? 'pointer' : 'grab';
    this.topDirty = true;
    this.emitNode('hover', h ? makeNodeEvent(this.tree, h.node, h.kind, 'pointer', r.left + p.x, r.top + p.y, h.run, this.L.collapsed) : null);
  }

  /** Clear the hover (the pointer left, or a drag started). */
  private clearHover(): void {
    this.hoverIn.clear(); // the pointer left, or the tree changed under it: no ring fades out
    this.hoverOut.clear();
    this.hoverNode = -1;
    this.hoverKind = '';
    this.hoverRun = -1;
  }

  private dropHover(): void {
    if (this.hoverNode >= 0) {
      this.clearHover();
      this.topDirty = true;
      this.emitNode('hover', null);
      this.schedule();
    }
  }

  // ================================================================= keyboard cursor, focus

  /** What the live region says for the cursor on row `node`. */
  private describe(node: number): string {
    const tip = this.tree.childCount[node] === 0;
    const name = cladeName(this.tree, node, this.opts);
    const tips = `${(this.tree.leafEnd[node] - this.tree.leafStart[node]).toLocaleString('en')} tips`;
    const col = this.L.collapsed?.[node] === 1 ? ', collapsed' : '';
    return (tip ? (name ?? 'Unnamed tip') : name ? `${name}, ${tips}` : `Clade of ${tips}`) + col;
  }

  private setActive(node: number, announce = true): void {
    this.activeNode = node;
    const target = this.vs.visibleViewport(node);
    if (target) this.vs.setViewport(target);
    this.topDirty = true;
    this.renderNow();
    if (announce && node >= 0) {
      const tip = this.tree.childCount[node] === 0;
      this.overlay.announce(this.describe(node));
      // move DOM focus with the cursor when it sits on a label anchor
      if (tip && this.root.contains(document.activeElement) && document.activeElement !== this.root)
        this.overlay.focusAnchor(this.tree.tipRank[node]);
    }
    this.schedule();
  }
}
