// Public types of the viewer core. No React: `TreeData` is the structural subset of @gbif-phylo/io's `TreeModel` that the core
// reads, so any tree model with preorder ids and leaf-contiguous subtree ranges can be shown.
//
// Option or theme? `ViewerOptions` is what is shown and how the viewer behaves: layout, which elements appear, density and
// level-of-detail thresholds, functions (`formatLabel`, `tipHref`), performance knobs. `TreeTheme` is how things look: colours,
// sizes and widths in px, opacities, font family and style, all settable as `--phylo-*`. Put a new setting by that test; the rule and
// the exceptions are in docs/api.md ("Theme or option").

import { defaultFormatCollapsedLabel, type CladeLabelFn } from './clade-name.ts';
import { RECT_MAX_VIEW_W } from './constants.ts';
import type { FontRelative, TreeWidth } from './sizes.ts';
import { defaultFormatNodeLabel, type NodeLabelKind, type NodeLabelsOption } from './node-label.ts';
import { RESIDUE_THEME_KEYS, type Alphabet } from './residues.ts';

export interface TreeData {
  readonly nodeCount: number;
  readonly tipCount: number;
  readonly parent: Int32Array; // parent[i] < i
  readonly firstChild: Int32Array; // -1 for tips
  readonly nextSibling: Int32Array;
  readonly childCount: Int32Array;
  readonly subtreeEnd: Int32Array; // subtree of i is the index range [i, subtreeEnd[i])
  readonly length: Float64Array; // NaN when missing
  /** Support by node index (NaN for none), as `TreeModel.support` has it. Optional: `nodeLabels: 'support'` reads it when present and the
   *  numeric prefix of the internal label otherwise (a partial source has only the labels). */
  readonly support?: Float64Array;
  readonly leafStart: Int32Array; // descendant tips of i are the rank range [leafStart[i], leafEnd[i])
  readonly leafEnd: Int32Array;
  readonly tipNode: Int32Array; // rank -> node index
  readonly tipRank: Int32Array; // node index -> rank, -1 for internal nodes
  readonly tipLabels: string[]; // by rank
  readonly labels: string[]; // by node index
  readonly hasLengths: boolean;
  heights(): Int32Array;
  tipIndex(label: string): number; // label -> node index of the first tip with it, -1 if absent
  /** Node indexes of every tip with this label (tip labels need not be unique). Optional: without it a label names only the tip `tipIndex`
   *  finds. `TreeModel` has it. */
  tipIndices?(label: string): ArrayLike<number>;
}

/** A tip as the API takes it: a string is a tip LABEL (every tip that carries it), a number a NODE id (that one tip). Labels are the
 *  lookup key into your own data and need not be unique; node ids are (see "Naming nodes" in docs/api.md). */
export type TipRef = string | number;

/** Rollups of a partially loaded tree, one value per snapshot row (all rows, stubs and loaded). The layout takes X, XMAX and ROW
 *  from them instead of from its own passes, because a stub row has no descendants to derive them from. */
export interface RollupData {
  readonly cumLength: Float64Array; // distance from the root, clamped lengths, before normalisation
  readonly maxCum: Float64Array; // largest cumLength in the subtree (XMAX source)
  readonly depth: Int32Array;
  readonly maxDepth: Int32Array; // deepest tip below; cladogram X = 1 - (maxDepth - depth) / maxDepth[0]
  readonly row: Float64Array; // layout row (y) of the node
}

/** What the renderer reads each frame: the tree as typed arrays over the rows that are currently loaded, in preorder, plus the
 *  fields that only a partially loaded tree needs. The in-memory snapshot is a plain TreeData with all three of them null.
 *  `nodeCount` is the number of ROWS of this snapshot (array length); ids in the arrays (parent, subtreeEnd, tipNode) are row
 *  indexes; `tipCount`, `leafStart`, `leafEnd` and `tipRank` are ranks of the FULL tree. */
export interface TreeSnapshot extends TreeData {
  /** 1 = the row stands for a clade whose rows are not loaded: drawn as a triangle from its rollups, never descended into
   *  (subtreeEnd[i] = i + 1, childCount[i] > 0 so it is not taken for a tip). null = no stubs (in memory). */
  readonly stub: Uint8Array | null;
  /** row -> preorder id in the full tree, what the public API and NodeEvent.node speak. null = identity. */
  readonly globalId: Int32Array | null;
  readonly rollup: RollupData | null;
  /** row of a global id, or -1 when that node is not part of the snapshot */
  toLocal(globalId: number): number;
}

export type LayoutKind = 'rectangular' | 'radial';

/** Visible window in layout coordinates. Rectangular: x in [0,1] (root to tips), y in rows (0..rows; a row is a tip, or a clade collapsed
 *  with `setCollapsed`, so without collapsed clades y is the tip rank). Radial: world units where the root is (0,0) and the outermost tip
 *  circle has radius 1. */
export interface Viewport {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Residue colours of alignment columns, each optional: a field left out is the default for a light or a dark theme (`TreeTheme.dark`).
 *  Protein colours are per group, nucleotide colours per base (U is drawn like T). CSS: `--phylo-residue-hydrophobic`, `-positive`,
 *  `-negative`, `-polar`, `-aromatic`, `-glycine`, `-proline`, `--phylo-residue-a`, `-c`, `-g`, `-t`, `--phylo-residue-other`.
 *  Values must be #rgb, #rrggbb or rgb()/rgba() (anything else is replaced by the default). `residueColours(theme, alphabet)` gives the
 *  table that is drawn, `residueGroups(alphabet)` the groups for a legend. */
export interface ResidueTheme {
  residueHydrophobic?: string; // A I L M F W V C
  residuePositive?: string; // K R
  residueNegative?: string; // E D
  residuePolar?: string; // N Q S T (and U, selenocysteine)
  residueAromatic?: string; // H Y
  residueGlycine?: string; // G
  residueProline?: string; // P
  residueA?: string; // nucleotides
  residueC?: string;
  residueG?: string;
  residueT?: string; // T and U
  residueOther?: string; // any other character, in either alphabet
}

/** The canvas theme: colours, font and the sizes and opacities of what is drawn. Every field can be set as a CSS custom property
 *  (`--phylo-<field name in kebab case>`, see THEME_CSS_VARS in theme.ts), with `setTheme`, or both (setTheme wins). */
export interface TreeTheme extends ResidueTheme {
  /** The background is dark. Informational, for apps and custom controls; the drawing code reads it only to choose the default residue
   *  colours of alignment columns (light or dark, see ResidueTheme). From `--phylo-dark`, or
   *  derived from the background's luminance when the theme comes from CSS. */
  dark: boolean;
  background: string;
  foreground: string; // labels, axis text
  muted: string; // axis lines, gridlines, headers
  branch: string;
  highlight: string; // hover and keyboard rings, marks (`markColour` unset), highlight bands, focus ring
  /** Colour of summaries (collapsed clades and the triangles, fans and bands of the level of detail) without a clade colour: their
   *  background at `summaryOpacity` and their stripes at `summaryStripeOpacity`. */
  summary: string;
  fontFamily: string;
  /** Style of tip labels, `--phylo-label-font-style`: 'italic' (scientific names) or 'normal'. */
  labelFontStyle: 'normal' | 'italic';
  /** Colours for categories (clade colours picked by an app, column bars use the second). */
  categorical: string[];
  /** Branch line width, CSS px. */
  branchWidth: number;
  /** Line width of branches in a coloured clade (at least branchWidth). */
  cladeBranchWidth: number;
  /** Largest radius of a tip dot (it shrinks with the row height), CSS px. */
  tipRadius: number;
  /** Side of the square marker on internal nodes big enough to click, CSS px. */
  nodeMarkerSize: number;
  /** Opacity of the background fill of summaries: the faint shape that says "more tree here". */
  summaryOpacity: number;
  /** Opacity of the hairline stripes over a summary's background (see api.md, "Summaries"). */
  summaryStripeOpacity: number;
  /** The least distance between two stripes of a summary, CSS px, at least 1 (smaller values are taken as 1). A summary without room for
   *  two stripes gets their mean tone at this spacing instead. */
  summaryStripeGap: number;
  markerOpacity: number; // tip dots and node markers
  highlightOpacity: number; // the band behind a highlighted tip
  /** Opacity of what is outside the highlighted set when `highlightStyle` is 'dim' or 'both': branches, tips, labels and summaries. */
  dimOpacity: number;
  /** Largest tip label size (labels shrink with the row height, down to 8 px), CSS px. */
  labelSize: number;
  /** Largest size of node labels (`nodeLabels`; they shrink with the row height, down to 8 px), CSS px. */
  nodeLabelSize: number;
  /** Colours of node labels: support values (and what a `nodeLabels` function returns) and branch lengths. '' = `muted`. */
  supportColour: string;
  lengthColour: string;
  axisFontSize: number;
  /** The radial scale rings (option `radialRings`), in `muted`: line width (CSS px) and opacity of 'lines', and the opacity of the
   *  shaded bands of 'stripes'. Their labels use `axisFontSize`. */
  ringWidth: number;
  ringOpacity: number;
  ringStripeOpacity: number;
  /** Leader lines of aligned labels (`alignLabels`): colour ('' = `muted`), dash pattern as CSS px separated by spaces or commas ('' or
   *  'none' = solid), width (CSS px) and opacity (multiplied by `dimOpacity` for a dimmed tip). */
  leaderColour: string;
  leaderDash: string;
  leaderWidth: number;
  leaderOpacity: number;
  /** Alignment columns: empty px between neighbouring sequences (rows at least 4 px tall); blocks always keep a quarter of the row free. */
  alignRowGap: number;
  /** The ring around the selected node (`setSelected`): colour ('' = `foreground`), line width and radius (CSS px). It is drawn on a halo of
   *  `background`, so it stands out over branches. A width of 0 draws no ring. */
  selectionColour: string;
  selectionWidth: number;
  selectionRadius: number;
  /** The rings of the marked nodes (`setMarked`, the pending pick of a two-step action): colour ('' = `highlight`), line width, radius
   *  (CSS px) and dash pattern (CSS px separated by spaces or commas, '' or 'none' = solid). Drawn on a solid halo of `background`, outside
   *  the selection ring. A width of 0 draws no ring. */
  markColour: string;
  markWidth: number;
  markRadius: number;
  markDash: string;
  /** The path from the hovered node (or, with nothing hovered, the keyboard cursor) up to the root, option `hoverPath`: colour ('' =
   *  `highlight`) and line width (CSS px, 0 = no path). Drawn on the overlay canvas under the rings, at full strength over a dimmed tree. */
  hoverPathColour: string;
  hoverPathWidth: number;
  /** The hover ring, in `highlight`: radius and line width (CSS px; a collapsed clade's ring is 1.5 times the radius) and, with the
   *  option `hoverAnimation`, how long it takes to grow in (and the ring left behind to fade out), in ms. 0 ms = no animation. */
  hoverRingRadius: number;
  hoverRingWidth: number;
  hoverRingDuration: number;
}

export const FALLBACK_THEME: TreeTheme = {
  dark: false,
  background: '#ffffff',
  foreground: '#162d3d',
  muted: '#6b7c8a',
  branch: '#44576a',
  highlight: '#4c9b45',
  summary: '#9aa7b3',
  fontFamily: 'system-ui, sans-serif',
  labelFontStyle: 'italic',
  categorical: ['#684393', '#5b7ac8', '#c0399c', '#e8845b', '#4aa8d8'],
  branchWidth: 1.3,
  cladeBranchWidth: 2,
  tipRadius: 3.2,
  nodeMarkerSize: 4,
  summaryOpacity: 0.25,
  summaryStripeOpacity: 0.5,
  summaryStripeGap: 2,
  markerOpacity: 0.85,
  highlightOpacity: 0.16,
  dimOpacity: 0.25,
  labelSize: 13,
  nodeLabelSize: 10,
  supportColour: '',
  lengthColour: '',
  axisFontSize: 10,
  ringWidth: 1,
  ringOpacity: 0.3,
  ringStripeOpacity: 0.08,
  leaderColour: '',
  leaderDash: '1 3',
  leaderWidth: 1,
  leaderOpacity: 0.7,
  alignRowGap: 0,
  selectionColour: '',
  selectionWidth: 2.5,
  selectionRadius: 7,
  markColour: '',
  markWidth: 2,
  markRadius: 11,
  markDash: '3 2',
  hoverPathColour: '',
  hoverPathWidth: 2,
  hoverRingRadius: 6,
  hoverRingWidth: 2,
  hoverRingDuration: 150,
};

/** Field-by-field equality of two themes (`categorical` element-wise), so a theme rebuilt with the same values counts as unchanged. */
export function themeEquals(a: TreeTheme, b: TreeTheme): boolean {
  if (a === b) return true;
  for (const k of Object.keys(FALLBACK_THEME) as (keyof TreeTheme)[]) {
    if (k === 'categorical') continue;
    if (a[k] !== b[k]) return false;
  }
  for (const k of RESIDUE_THEME_KEYS) if (a[k] !== b[k]) return false;
  if (a.categorical.length !== b.categorical.length) return false;
  for (let i = 0; i < a.categorical.length; i++) if (a.categorical[i] !== b.categorical[i]) return false;
  return true;
}

/** A copy of `o` (array values copied too) without its undefined values, so spreading it over defaults never puts an undefined in. */
export function stripUndefined<T extends object>(o: T): Partial<T> {
  const r: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    const v = o[k];
    if (v !== undefined) r[k] = (Array.isArray(v) ? v.slice() : v) as T[keyof T]; // arrays (`categorical`) are copied: no aliasing with the caller's
  }
  return r;
}

export interface CladeColour {
  node: number; // node id (preorder id of the full tree)
  colour: string;
  /** Name for a legend; without it the legend uses the clade's name (see Legend's cladeLabel), or 'Clade of N tips'. */
  label?: string;
}

export type ColumnKind = 'bar' | 'text' | 'alignment' | 'custom';

interface ColumnBase {
  id: string;
  header: string;
  /** CSS px, or 'fill': the column takes the width left after the tree and the fixed columns (shared equally between fill columns,
   *  at least 40 px). An alignment is scaled to fit its width. See the `treeWidth` option. */
  width: number | 'fill';
}

/** A built-in column: log-scaled bars, text, or aligned sequences (residue colours or blocks, see the align* options). */
export interface BuiltinColumn extends ColumnBase {
  kind: 'bar' | 'text' | 'alignment';
  /** By tip label. Compared BY REFERENCE when the columns are set again (a deep compare of millions of entries costs as much as
   *  recompiling): pass the same object while the data is unchanged, a new object when it changed. Do not mutate it in place. The same
   *  goes for the Column object itself: an object that is passed again is taken as unchanged, so replace it, never mutate it. */
  values: Record<string, number | string>;
  /** By node id, for values that belong to one tip rather than to a label (tip labels need not be unique, and `values` gives every tip with
   *  a label the same value). Wins over `values` for its tips. Compared by reference, like `values`. */
  nodeValues?: ReadonlyMap<number, number | string>;
  /** Alignment columns: the colour scheme. `'auto'` (default) picks nucleotide when more than 90% of a sample of the residues are
   *  A, C, G, T, U or N (see `detectAlphabet`), protein otherwise. Colours are the `residue*` theme tokens. */
  alphabet?: Alphabet;
}

/** A column drawn by your own renderer. `values` (by tip label, any type) and `nodeValues` (by node id) are compared by reference as for
 *  the built-in kinds, and so is `renderer`. */
export interface CustomColumn<V = unknown, D = unknown> extends ColumnBase {
  kind: 'custom';
  values: Record<string, V>;
  nodeValues?: ReadonlyMap<number, V>;
  renderer: ColumnRenderer<V, D>;
}

export type Column = BuiltinColumn | CustomColumn;

/** What a custom column's `prepare` gets: the values by tip label (and by node id, `null` when the column has none) and the tips of the
 *  tree, by rank (the row order): their labels and their node ids (-1 for a tip whose row is not loaded). A tip's value is
 *  `nodeValues.get(tipNodes[rank])` if there is one, else `values[tipLabels[rank]]`. */
export interface ColumnSource<V = unknown> {
  readonly values: Record<string, V>;
  readonly nodeValues: ReadonlyMap<number, V> | null;
  readonly tipLabels: readonly string[];
  readonly tipNodes: ArrayLike<number>;
  readonly tipCount: number;
}

/** Where to draw, for one frame. Rank (row) r spans y = oy + r * rowHeight .. oy + (r + 1) * rowHeight in CSS px; ranks r0..r1 (inclusive)
 *  are in view. rowHeight is below 1 px when many rows share a pixel row: draw a summary then, not every row.
 *
 *  Collapsed clades (`setCollapsed`) free rows, so a row is then no longer a rank. The contract above still holds: `draw` is called once per
 *  stretch of consecutive visible ranks (once when nothing is collapsed), with `r0`/`r1` the ranks of the stretch and `oy` shifted so that
 *  the same formula gives each tip's row. The rows of collapsed clades are in no call, so they stay blank. `rankOfRow` (row -> first rank, length
 *  rows + 1, or null while nothing is collapsed) is there for a renderer that wants to know; it is not needed. */
export interface ColumnFrame {
  readonly x: number;
  readonly width: number;
  readonly top: number;
  readonly bottom: number;
  readonly r0: number;
  readonly r1: number;
  readonly oy: number;
  readonly rowHeight: number;
  /** Row -> first tip rank (length: number of rows + 1), or null when every row is the tip of that rank. */
  readonly rankOfRow: Int32Array | null;
  readonly theme: TreeTheme;
}

/** Draws a custom column. `prepare` runs when the column's values (or renderer) change: turn the values into whatever is fast to draw,
 *  typically arrays by tip rank. `draw` runs once per frame with the canvas clipped to the column and its transform in CSS px: draw
 *  rows r0..r1 there (one call per frame, not per cell, so keep allocation out of the row loop). */
export interface ColumnRenderer<V = unknown, D = unknown> {
  prepare(src: ColumnSource<V>): D;
  draw(ctx: CanvasRenderingContext2D, frame: ColumnFrame, data: D): void;
  /** Whether rank r has a cell (for `columnCell`); default: a value exists for its tip. Asked of ranks, never of a collapsed clade. */
  hasCell?(data: D, rank: number): boolean;
}

export type LabelDensity = 'sparse' | 'normal' | 'dense';

/** How `setHighlighted` shows its tips: 'band' = a band, a ring and a bold label; 'dim' = everything outside the highlighted set is drawn
 *  at the theme's `dimOpacity`; 'both' = both. */
export type HighlightStyle = 'band' | 'dim' | 'both';

/** Scale rings of the radial layout (option `radialRings`): none, circles, or every other band between them shaded. */
export type RadialRings = 'none' | 'lines' | 'stripes';

/** What is shown and how the viewer behaves (see the header: looks are `TreeTheme`). */
export interface ViewerOptions {
  layout: LayoutKind;
  branchLengths: boolean;
  lod: boolean; // viewport level of detail: collapse small clades into summaries, dedupe sub-pixel primitives
  drawBudget: number; // max drawn tree primitives per frame; LOD thresholds are raised until the cut fits
  showSummaries: boolean; // draw collapsed clades as triangles (otherwise only their branch is drawn)
  labelDensity: LabelDensity;
  /** Phylogram: draw every tip label in one column right of the farthest tip (radial: on one circle just outside the outermost tip),
   *  with a leader line (theme `leaderColour`, `leaderDash`, `leaderWidth`, `leaderOpacity`) from each tip to it. No effect in a cladogram
   *  (the tips already end at one x or radius) or in a tree without branch lengths. */
  alignLabels: boolean;
  /** Hovering a tip, clade or summary also highlights its path to the root (every branch and connector on the way); with nothing
   *  hovered, the keyboard cursor's path is shown. How it looks is the theme's `hoverPathColour` and `hoverPathWidth`. */
  hoverPath: boolean;
  /** The hover ring grows into existence (radius and opacity from 0, eased out) over the theme's `hoverRingDuration` and the ring left
   *  behind fades out; the keyboard cursor's ring grows the same way when the cursor moves. Only the overlay canvas is redrawn, and only
   *  while a ring is still changing. Skipped when the user prefers reduced motion (`prefers-reduced-motion: reduce`). */
  hoverAnimation: boolean;
  /**
   * Labels on internal nodes, drawn by the viewer from the draw list: 'support' (the number at the start of the node's label, left of the
   * node, above its branch), 'length' (the node's branch length, centred on the branch; along it in the radial layout; tips get one too), or a function
   * `(node, tree)` returning the text or a number (null = none), placed and coloured like support; `node` is the preorder id in the full
   * tree, as in `cladeLabel`. Only drawn internal nodes (and, for 'length', drawn tips) get one (never one inside a collapsed clade), and only where the branch is long
   * enough for the text and rows (rectangular) or arcs (radial) are at least `labelDensity` apart. Colours and size: `supportColour`,
   * `lengthColour`, `nodeLabelSize`.
   */
  nodeLabels: NodeLabelsOption;
  /** Text of a number shown by `nodeLabels` ('support', 'length', or a number a function returned): `(value, 'support')` 0.95 or 95. */
  formatNodeLabel: (value: number, kind: NodeLabelKind) => string;
  /** How highlighted tips (`setHighlighted`) stand out: bands, or dimming what is not highlighted (see `HighlightStyle`). */
  highlightStyle: HighlightStyle;
  /** Fixed height per tip row at the fit view (rectangular): px, `'<n>em'` (n times the theme's `labelSize`), or `'auto'` (1.85 em). em values are rounded to whole px.
   *  null = fit all tips into the height. */
  rowHeight: FontRelative | null;
  /** The most space between two neighbouring tips when zooming in: a row's height in px (rectangular) or the arc between tips on the
   *  outer circle (radial). px, `'<n>em'` (n times `labelSize`, so it follows `--phylo-label-size`) or `'auto'` (1.85 em, 24 px at
   *  the default size: a label line, an alignment row and padding). `Infinity` = no cap beyond the hard ceilings (500 px per row, radial
   *  20000 times the fit scale, or tips 50 px apart where that is deeper). The view is never forced below the fit: a small tree that fits at 100 px per row stays there and can only
   *  zoom out. The x axis (rectangular) is not capped by this: zooming x stretches branch lengths and stays up to 5e6 px per unit. */
  maxTipSpacing: FontRelative;
  /** Rectangular: the widest x window, in tree widths (default 1.6: the tree can shrink to about 62% of the plot width). Raise it to
   *  zoom the tree out further, e.g. next to wide columns. Values below 1 are taken as 1. */
  maxViewWidth: number;
  /** Rectangular: the width of the tree area (branches and labels) against the columns right of it. `'auto'` (default): the columns keep
   *  their widths and the tree takes the rest (with `'fill'` columns the tree and they split what the fixed columns leave, half each).
   *  A number is px, `'<n>%'` a share of the width (container minus the overview strip); the columns, `'fill'` ones first, get the rest.
   *  At least 120 px. */
  treeWidth: TreeWidth;
  axis: boolean; // scale bar / time axis
  minCladePx: number; // collapse clades less than this many pixels tall (radial: arc at the tips); branch lengths do not count
  /** Alignment columns: 'residues' = coloured cells (one pixel per residue, as before); 'blocks' = ETE-style grey blocks for the
   *  stretches without gaps joined by a thin line (rows at least 1.5 px tall, otherwise residues). */
  alignStyle: 'residues' | 'blocks';
  formatLabel: (tipId: string) => string;
  /**
   * What names an internal node, for the legend, the node menu title, the default tooltip and the keyboard announcement: `(node, tree)`
   * returns the node's name or null for none (the places then say 'Clade of N tips'). `node` is the preorder id in the full tree.
   * The name goes through `formatLabel`. null = the node's label without its support value. Hide synthetic names or look names up here.
   */
  cladeLabel: CladeLabelFn | null;
  /**
   * The label of a collapsed clade (`setCollapsed`), drawn at the end of its triangle and read out in the screen reader list:
   * `(name, tips)`, with `name` the clade's name as `cladeLabel` and `formatLabel` give it (null for none) and `tips` its number of tips.
   * Default `defaultFormatCollapsedLabel`: 'Firmicutes · 12,345 tips', or '12,345 tips' without a name.
   */
  formatCollapsedLabel: (name: string | null, tips: number) => string;
  tipHref: ((tipId: string) => string) | null;
  ariaLabel: string;
  /** Create the 2D contexts with willReadFrequently (CPU-backed canvas). Read at construction only. */
  softwareCanvas: boolean;
  /** Cap on the canvas backing-store pixel ratio (device pixels per CSS pixel): the canvas is min(devicePixelRatio, dprCap)
   *  times the CSS size. Infinity = native. Hit-testing, overlay and events always use CSS pixels. */
  dprCap: number;
  /** What makes the viewer read the `--phylo-*` custom properties again: 'media' (default) a change of `prefers-color-scheme`;
   *  'document' that and a change of the `class` or `data-theme` attribute of `document.documentElement` (sites that switch dark
   *  mode that way); 'none' nothing (call `refreshTheme()` yourself). */
  themeObserver: 'media' | 'document' | 'none';
  /** Radial layout only: the share of the circle left empty between the last and the first tip, from 0 (the tips close the circle)
   *  to below 1 (clamped to 0.99). The tips are spread over `(1 - radialOpening) * 360` degrees; 0.5 is a half circle. Default 0.05, so
   *  the two ends of the tip order do not look like neighbours. A layout option, not a theme token: it moves the tips. */
  radialOpening: number;
  /** Radial layout only: where the middle of the opening sits, in degrees clockwise from 3 o'clock (the positive x axis). Default 90:
   *  the opening at the bottom, so the tips run clockwise from just left of the bottom over the top to just right of it, and a half
   *  circle is an arch open at the bottom. With `radialOpening: 0` and `radialRotation: 0` the angles are those of a full circle from
   *  3 o'clock, as before the options existed. */
  radialRotation: number;
  /** Radial layout with branch lengths and `axis` on only (the scale bar labels the rings): circles about the root behind the tree, at the scale bar's step (so the bar is one band
   *  wide; zooming in subdivides them, zooming out merges them). On a dated tree (ultrametric) they count back from the tips, which are
   *  age 0, otherwise out from the root. 'lines' draws the circles, 'stripes' shades every other band between them (theme `ringWidth`,
   *  `ringOpacity`, `ringStripeOpacity`, colour `muted`). With an opening (`radialOpening`), each ring is labelled with its distance or
   *  age along the middle of the opening where there is room. Default 'none'. */
  radialRings: RadialRings;
  /** Radial layout only: most primitives (expanded nodes, tips, summary fans) drawn per frame. When the viewport holds more,
   *  the collapse threshold is raised until it fits, so small clades become fans. Infinity = only `drawBudget` applies. */
  radialMaxNodes: number;
  /** Reduced frames while the view moves (wheel, pinch, drag, animation): a quarter of the budget (min 500) and a coarser collapse
   *  threshold, then one full-quality frame after `refineMs` without input. Hit-testing always settles to a full-quality frame first.
   *  `'auto'` (default): full quality while moving, reduced only when the full-quality frames get slow (their JS time, smoothed over
   *  the last few, above 12 ms); `true`: always reduced while moving; `false`: never. */
  interactionLOD: boolean | 'auto';
  refineMs: number;
  /** Small notice in the canvas corner when the radial cut-off is summarising clades the normal threshold would show. */
  summaryNotice: boolean;
}

export const DEFAULT_OPTIONS: ViewerOptions = {
  layout: 'rectangular',
  branchLengths: true,
  lod: true,
  drawBudget: 20000,
  showSummaries: true,
  labelDensity: 'normal',
  alignLabels: false,
  hoverPath: true,
  hoverAnimation: true,
  nodeLabels: 'none',
  formatNodeLabel: defaultFormatNodeLabel,
  highlightStyle: 'band',
  rowHeight: null,
  maxTipSpacing: 'auto',
  maxViewWidth: RECT_MAX_VIEW_W,
  treeWidth: 'auto',
  axis: true,
  minCladePx: 3,
  alignStyle: 'residues',
  formatLabel: (s) => s.replace(/_/g, ' '),
  cladeLabel: null,
  formatCollapsedLabel: defaultFormatCollapsedLabel,
  tipHref: null,
  ariaLabel: 'Phylogenetic tree',
  softwareCanvas: false,
  dprCap: 2,
  themeObserver: 'media',
  radialOpening: 0.05,
  radialRotation: 90,
  radialRings: 'none',
  radialMaxNodes: 2000,
  interactionLOD: 'auto',
  refineMs: 120,
  summaryNotice: true,
};

export type HitKind = 'tip' | 'node' | 'summary' | 'branch';
export interface Hit {
  node: number; // a run: the parent of its members
  kind: HitKind;
  run?: { first: number; last: number }; // a run of small siblings drawn as one slice: first and last member (node indices)
}

export interface NodeEvent {
  node: number; // node index (tip: the tip's node); with a partial source the preorder id in the FULL tree
  isTip: boolean;
  tipId: string | null; // the tip's label when isTip and the label is loaded
  kind: HitKind;
  tipStart: number; // descendant tips are the rank range [tipStart, tipEnd)
  tipEnd: number;
  clientX: number;
  clientY: number;
  via: 'pointer' | 'keyboard';
  /** The node is a clade the app collapsed with `setCollapsed` (`kind` is then 'summary' and `node` the clade's id), not one the level
   *  of detail summarised. */
  collapsed: boolean;
  /** Set for a run of small siblings drawn as one slice (kind 'summary'): `node` is then their parent, but the tip range is only
   *  the run's, [tipStart, tipEnd), and these are what it holds: clades (with two or more tips) and single tips. */
  run?: { clades: number; single: number };
}

export interface FrameStats {
  frameMs: number; // JS time of the last render() call (cut + draw; raster happens after)
  cutMs: number;
  drawMs: number;
  visited: number; // nodes looked at by the cut
  drawn: number; // primitives in the draw list (expanded nodes, tips, summaries)
  summaries: number;
  tips: number;
  labels: number;
  minPxUsed: number; // effective collapse threshold after the budget rule
  budgetRetries: number; // how many times the threshold had to be raised to fit the budget
  budgetHit: boolean;
  truncated: boolean; // even the highest threshold overflowed (list was cut)
  frames: number; // total frames rendered so far
  budget: number; // primitive budget in force for this frame (radial: the cut-off; reduced while interacting)
  forced: number; // summary fans that the normal threshold would have expanded (clades summarised because of the budget)
  summaryTips: number; // tips inside the drawn summaries
  mergedTips: number; // tips of primitives not emitted because they land on the same pixel cells as an earlier one
  reduced: boolean; // this frame was drawn in reduced (interaction) quality
  scale: number; // canvas backing pixels per CSS pixel (after the dprCap)
}
