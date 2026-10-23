# API reference: `@gbif-phylo/viewer` and `<TreeView>`

One or two lines per entry; the detail is in the source comments, linked per section. Types are in [`src/types.ts`](../src/types.ts) unless
said otherwise.

| Import                          | What                                                                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@gbif-phylo/viewer`            | everything below: `TreeViewer`, controls, overlays, column and theme types. One ES module per source file and no side effects, so a bundler keeps only what you import (`scripts/check-packages.mjs` checks this)                   |
| `@gbif-phylo/viewer/browser`    | the same as one self-contained, minified ES module (`dist/browser/viewer.js`) for pages without a build step: load it with an import map or by URL. It includes every control                                                       |
| `@gbif-phylo/viewer/viewer.css` | styles of the viewer's DOM: controls, popups, legend, search, notice. Load it once                                                                                                                                                  |
| `@gbif-phylo/viewer/gbif.css`   | optional: GBIF design tokens mapped to the `--phylo-*` properties                                                                                                                                                                   |
| `@gbif-phylo/react`             | `<TreeView>` ([below](#treeview))                                                                                                                                                                                                   |
| `@gbif-phylo/io`                | `parseNewick`, `parseNexus`, `toNewick`, `toNexus`, `TreeModel` (a `TreeData`), and for BEAST / NHX annotations (`{ annotations: true }`, `tree.annotations`) `Annotations` and `supportFrom`; `@gbif-phylo/io/browser` as one file |

## Quick start

```ts
import '@gbif-phylo/viewer/viewer.css';
import { parseNewick } from '@gbif-phylo/io';
import { TreeViewer, defaultControls, Tooltip } from '@gbif-phylo/viewer';

const viewer = new TreeViewer({
  target: document.getElementById('tree')!, // give it a size; the viewer fills it and follows its size
  tree: parseNewick(text),
  controls: [...defaultControls({ search: true, overview: true }), new Tooltip()],
});
viewer.on('click', (e) => console.log(e.isTip ? e.tipId : `${e.tipCount} tips`));
```

Without a bundler, map the two packages to their single-file builds in an import map and load `viewer.css` with a `<link>`; the code is
the same (see [`examples/no-build`](../../../examples/no-build)). The framework-free example ([`examples/vanilla`](../../../examples/vanilla)) shows every part: controls in corners and outside the
viewer, a control of its own, a custom popup, the node menu, a custom column, a dark theme and an event log.

## Naming nodes

**Nodes are numbers: the preorder ids of the tree the viewer holds** (`0` is the root; for a partial source, ids of the full tree). The
same number is `setClades({ node })`, `setCollapsed`, `zoomToNode`, `locateNode`, `nodePosition`, `nodeBounds`, the events' `node`, and in
`<TreeView>` the `clades[].node` and `collapsed` props and the handle's methods. It is the index tree-ops' `map` and `TreeModel` use, so an
id from a click can be passed straight back. **Tips can also be named by label** (`highlighted`, `focus`, `focusTip`, `locateTip`, column
`values`): labels are the lookup key into your own data. Anything else where a node is expected (a string such as `'n12'` or `'12'`, a
fraction, a negative id, or an id past the last node of the full tree, `nodeCount`) is ignored with a `console.warn`, not silently;
`nodePosition`, meant to be called on every frame, just returns `null`. The ids and names in your own trees (tip and node labels,
accession numbers, GBIF keys) are labels, not node ids.

**Tip labels are lookup keys, not identities** (#18). A tree may carry the same label on several tips (several sequences of one species,
labels made for display, collapsed clades named by size), and every tip is kept. Where the API takes a tip, a **string is a label** and a
**number is a node id**: `setHighlighted(['Homo_sapiens'])` highlights every tip with that label, `setHighlighted([7])` tip 7 alone. A
lookup that returns one tip (`tipNode`, `<TreeView>`'s `focus`, `focusTip`, `locateTip`, `columnCell`) takes the first tip with the label in
preorder; `focus` and `focusTip` warn (`console.warn`) when the label is on several tips, so pass the node id to reach another one.
`tipNodes(label)` lists them all. Column `values` keyed by label give every tip with the label the same value; for values that belong to one
tip, key them by node id in `nodeValues`. The built-in `Search` lists each matching tip (with '2 of 3' when its label is on several) and
focuses and highlights the chosen one by node id. `@gbif-phylo/io` reports the labels that more than one tip carries
(`tree.duplicateTipLabels()`), so an app can warn about them after parsing; `TreeData.tipIndices(label)` is how the viewer finds every tip
of a label (a `TreeData` without it names only the tip `tipIndex` returns). Labels stay the join key to your data (GBIF taxa, where many
tips can map to one taxon), so nothing here requires them to be unique.

## TreeViewer ([`src/viewer.ts`](../src/viewer.ts))

```ts
new TreeViewer({ target, tree | source, options?, theme?, columns?, controls? }: TreeViewerInit)
```

Creates its DOM (canvases, label layer, control layer, notice, screen-reader list) inside `target`, sizes itself to `target` with a
ResizeObserver and draws on demand with `requestAnimationFrame`. A `tree` (`TreeData`) is wrapped in an `InMemorySource`; a `source` is used
as it is. `options` go over `DEFAULT_OPTIONS`; `theme` over the CSS theme ([Theme](#theme)); `controls` are added in order (none by default).

Properties

| Member                             | Meaning                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `element`                          | what the viewer added to `target` (class `phylo-viewer`): the tree element and, beside it, the control layer                   |
| `treeElement` / `root`             | the tree element: `role="tree"`, focusable, the canvases, labels and screen-reader list. Controls and popups are not inside it |
| `options: Readonly<ViewerOptions>` | the options in force                                                                                                           |
| `size: {width, height}`            | container size in CSS px                                                                                                       |
| `layout: Layout`                   | the current layout arrays (`X`, `ROW`, `XMAX`, `LAST`, `layoutMs`, ...), `layout.ts`                                           |
| `stats: FrameStats`                | the stats of the last frame, mutated in place (see `getStats` for a copy)                                                      |

State: setters (each is a no-op for input equal to the current one) and getters

| Method                                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setOptions(patch)`                                | change options (undefined and unchanged values are ignored). Refits for `layout`, `branchLengths`, `rowHeight` or `treeWidth`, except that a switch of `layout` or `branchLengths` with a node selected centres the new view on the selected tip at a readable size, or frames the selected clade (the keyboard cursor and the selection stay, and the cursor is announced again); a new `maxTipSpacing` or `maxViewWidth` clamps a zoomed view; for `axis` only while the view is still fitted. A change of `tipHref` or `formatLabel` rebuilds the DOM label anchors. Emits `optionschange`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `setTheme(overrides)`                              | theme fields over the CSS theme; REPLACES the overrides of an earlier call (`setTheme({})` clears them). Emits `themechange`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `updateTheme(patch)`                               | MERGES the fields into the current overrides (a field that is `undefined` is dropped, so it goes back to the CSS value). For controls that each own one token, such as a font-size slider and a branch-width slider. Emits `themechange`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `refreshTheme()`                                   | read the `--phylo-*` custom properties again (the viewer does this itself when created, and on what the `themeObserver` option watches)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `getTheme()`                                       | the theme in force                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `setClades(clades: CladeColour[])` / `getClades()` | colour clades: `{node, colour, label?}`, `node` is the preorder id (full tree); where clades nest the innermost wins (for the same node, the later entry); nodes not loaded are skipped. Emits `cladeschange`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `setTree(tree \| source, opts?)`                   | show another tree without re-creating the viewer: canvases, controls, listeners, options and theme overrides stay; layout, hit index, column data, clade classes and highlights are rebuilt, the keyboard cursor and hover are reset, the selection follows `map` (dropped without one, or when its node is removed). `opts`: `map` (old node -> new node, as tree-ops returns it, -1 removed), `view` (`'keep'` frames the tips that were in view through `map`, or by tip label without one (the k-th tip of a repeated label goes to the k-th in the new tree, and one with no k-th is left out), at the same scale: rectangular by rank, radial by angle; `'fit'` shows the whole tree; default `'keep'` with a `map`, else `'fit'`; a fitted view stays fitted, and `'keep'` fits when no tip in view survives (a tip that is gone counts as the nearest ancestor that survived, e.g. a collapsed clade, unless that is the whole tree) or the source is partial), `clades`, `highlighted` (by default the labels stay and node ids go through `map`), `collapsed` (applied with the new tree, so no frame draws the old colours on it; default: `clades` and `collapsed` sent through `map` when there is one, `highlighted` unchanged since tip labels follow the tips). The old source is not destroyed. Emits `treechange` |
| `setHighlighted(tips)` / `getHighlighted()`        | highlight tips: a label (string) highlights every tip with it, a node id (number) that tip ([Tip labels](#naming-nodes)); unknown labels are ignored, a number that is not a node or is an internal node is ignored with a warning; `getHighlighted` returns what was set. How they show is the `highlightStyle` option: a row band, ring and bold label (`'band'`), dimming everything else (`'dim'`) or both. Overview ticks in every style. Emits `highlightchange`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `setSelected(node \| null)` / `getSelected()`     | select a node (a node id: tip or clade), or nothing with `null`; `getSelected` gives the id or `null`. The selected node gets a ring on the overlay canvas (theme `selectionColour`, `selectionWidth`, `selectionRadius`). A click (or Enter on the keyboard cursor) selects its node by default: a `click` listener's `preventDefault()` stops it, a run of small siblings selects nothing, a click on empty space changes nothing. The selection stays across layout, branch-length and theme changes (a switch of layout or branch lengths centres the view on it, see `setOptions`), `setTree` (through `map`) and collapsing (a node inside a collapsed clade selects the clade). A number that is not a node is ignored with a warning. Emits `selectionchange` |
| `setMarked(nodes)` / `getMarked()` | mark nodes (node ids, tips or clades) with a ring of their own (theme `markColour`, `markWidth`, `markRadius`, `markDash`: dashed, outside the selection ring) until `setMarked([])`: the pending pick of a two-step action such as a swap, so it stays visible while the pointer looks for the second (the hover ring still shows the candidate). The rings follow the nodes through pans, zooms and layout switches; a node inside a collapsed clade is marked on the clade. Kept across `setTree` through `map`, dropped without one. Numbers that are not nodes are ignored with a warning; `getMarked` gives the ids in force. No-op for the same ids |
| `setCollapsed(nodeIds)`                            | collapse these clades in the view (see "Collapsed clades" below). `nodeIds` are preorder ids of the tree the viewer shows, the same ids as `setClades` and the events. Each clade is drawn as one triangle on ONE row (its tips' rows are freed), never opened, and the tree is not changed. Ids of tips are ignored, ids that are not nodes are ignored with a warning; a clade inside a collapsed one is hidden by it. No-op for the same ids in the same order. The window keeps its scale, and a fitted view is fitted again. A partially loaded source cannot collapse clades                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `setColumns(columns: Column[])`                    | aligned per-tip columns (rectangular layout only); only changed columns are recompiled (`values`, `nodeValues` and `renderer` by reference, ids unique)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `getSource()` / `getTree()`                        | the tree source, and the rows loaded now (a `TreeSnapshot`; for an in-memory tree the whole tree)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `tipNode(tipId)` / `tipNodes(tipId)`               | node id of the first tip with this label in preorder, -1 when unknown or not loaded / the node ids of every loaded tip with it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Navigation and view

| Method                                              | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getViewport()` / `setViewport(v, animate = false)` | the visible window in layout coordinates (`Viewport`); `setViewport` clamps it to the limits; a window equal to the current one changes nothing, so `setViewport(getViewport())` no longer stops a running animation (a controlled `viewport` prop echoing the view does not stop `fit(true)`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fitViewport()`                                     | the window `fit()` would go to (a copy), without moving: for controls that set the view relative to the fitted one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `fit(animate = true)`                               | fit the whole tree and columns into the container                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `toBlob({ type?, scale?, background? })`            | `Promise<Blob>`: the current view as an image, drawn into an offscreen canvas with the same code as the frame (the visible canvas is not read; hover and keyboard rings are left out). `type` defaults to `'image/png'`; `scale` is canvas pixels per CSS pixel (default the canvas's own: `devicePixelRatio` capped by `dprCap`), so the image is `width * scale` by `height * scale` (rejects with `RangeError` over 16384 px); `background` is a CSS colour, `null` for a transparent image, default the theme's background (an opaque background gives an opaque canvas, as on screen, so text is antialiased the same way). Not in the image: DOM controls, overlays and label anchors; with a partial source the current cut is exported. An unsupported `type` gives a PNG (check `blob.type`). Rejects over 2^26 px in all. Lines one device pixel wide (dense radial trees) and alignment smoothing follow `scale`, so they look fainter than on screen above the screen's scale |
| `zoomBy(fx, fy, px, py)`                            | zoom by factors (>1 zooms in) keeping container point (px, py) fixed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `focusTip(rank, animate = false)`                   | bring the tip of leaf rank `rank` into view (rows at least 26 px); ignored when its row is not loaded. A tip inside a collapsed clade is not drawn: the clade is brought into view and stays collapsed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `zoomToNode(id, animate = false)`                   | show the clade below node `id` (preorder id of the full tree)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Where things are

| Method                    | Meaning                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nodePosition(id)`        | position of node `id` in px relative to the viewer element under the current view, or `null` outside the plot or inside a collapsed clade. Draws nothing, so it is cheap enough for a `frame` listener (what `Overlay` uses) |
| `locateNode(id)`          | client-px position where a click on node `id` lands, or `null`. Draws a settled full-quality frame first; an internal node must be drawn (not inside a summary), a node inside a collapsed clade has none                    |
| `nodeBounds(id)`          | client-px box of the clade below `id`, clipped to the plot area, or `null` (also for a node inside a collapsed clade)                                                                                                        |
| `columnCell(colId, rank)` | client-px box of a column cell, or `null` (also for a tip inside a collapsed clade)                                                                                                                                          |
| `hitTest(x, y)`           | what a click at container-px (x, y) would target: a `Hit` or `null`                                                                                                                                                          |

Controls ([below](#controls))

| Method             | Meaning                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addControl(c)`    | place `c.element` in its corner of the control layer (or in `c.target`), then call `c.setViewer(viewer)`; adding twice does nothing. A control has one viewer: one that another viewer holds is removed from it first |
| `removeControl(c)` | `c.setViewer(null)`, then remove its element                                                                                                                                                                          |
| `getControls()`    | the controls added, in order                                                                                                                                                                                          |

Events: `on`, `once`, `off` ([below](#events)).

Stats, frame control and lifetime

| Method                        | Meaning                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `getStats()`                  | copy of `stats` plus `layoutMs, hitBuildMs, avgFrameMs, maxFrameMs, listLength, hitItems, hitEntries, kx, ky` (does not draw) |
| `resetFrameTimes()`           | reset the average and maximum frame time counters                                                                             |
| `renderNow()`                 | draw synchronously if something changed                                                                                       |
| `invalidate(fonts = false)`   | schedule a redraw; `fonts = true` also clears the label overlay                                                               |
| `benchmark(n)`                | force `n` full redraws; returns mean, min and max JS ms per frame and mean cut and draw ms                                    |
| `focus()`                     | give keyboard focus to the tree                                                                                               |
| `destroy()` / `isDestroyed()` | emit `destroy`, remove the controls, cancel the frame loop, remove listeners, observers and DOM                               |

## Events ([`src/events.ts`](../src/events.ts))

`viewer.on(type, listener, { asDefault?, once? })` returns the function that removes the listener; `once(type, listener)` and
`off(type, listener)` as usual. Listeners run in the order they were added; one that throws is reported (`reportError`) and the rest run.

| Event             | Payload              | When                                                                                                                                                             |
| ----------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `click`           | `TreeEvent`          | a click (pointer) or Enter (keyboard) on a tip, a node marker, a collapsed clade or a branch                                                                     |
| `hover`           | `TreeEvent \| null`  | the pointer moved onto another target; `null` when it left every target                                                                                          |
| `viewchange`      | `Viewport`           | the visible window changed (pan, zoom, fit, resize, animation step); equality-guarded                                                                            |
| `frame`           | `FrameStats`         | after every drawn frame (the viewer's own object, reused)                                                                                                        |
| `optionschange`   | `{options, changed}` | `setOptions` changed something                                                                                                                                   |
| `themechange`     | `TreeTheme`          | the theme in force changed                                                                                                                                       |
| `cladeschange`    | `CladeColour[]`      | `setClades` changed the colours                                                                                                                                  |
| `highlightchange` | `(string \| number)[]` | `setHighlighted` changed the tips (what it was given: labels and node ids)                                                                                                                                |
| `selectionchange` | `{node}`             | the selected node changed (`setSelected`, a click, or the viewer moving it: to a collapsed clade around it, through `setTree`); `node` is `null` for none |
| `resize`          | `{width, height}`    | the container was resized                                                                                                                                        |
| `sourcechange`    | `{version}`          | the rows of a partial source changed                                                                                                                             |
| `treechange`      | `{map}`              | `setTree` replaced the tree (`map` is null without one); `Search`, `Legend`, `NodeMenu` and `Tooltip` listen, a listener of yours that keeps node ids should too |
| `ready`           | `{layoutMs, tips}`   | the first frame was drawn                                                                                                                                        |
| `destroy`         | none                 | `destroy()` ran                                                                                                                                                  |

**Default actions.** A listener added with `{ asDefault: true }` runs after the ordinary listeners, and only when none of them called
`e.preventDefault()`. The built-in `Tooltip` (hover) and `NodeMenu` (click) listen this way, so an app replaces them for one event by
preventing the default:

```ts
viewer.on('click', (e) => {
  if (!e.isTip) return;
  e.preventDefault(); // no node menu for tips: show our own popup instead
  card.setPosition({ node: e.node });
});
```

`TreeEvent` (`NodeEvent` plus ids and helpers)

| Field                                  | Meaning                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node`                                 | node id: a number, the preorder id (in the FULL tree for a partial source); see [Naming nodes](#naming-nodes)                                     |
| `isTip`, `tipId`                       | tip or not; the tip's label when it is loaded                                                                                                    |
| `kind`                                 | `'tip'`, `'node'` (internal node marker), `'summary'` (a collapsed clade, a clade the level of detail summarised, or a run) or `'branch'`        |
| `collapsed`                            | `true` for a clade the app collapsed with `setCollapsed`: `kind` is `'summary'` and `node` the clade's id (never a made-up tip)                  |
| `tipStart`, `tipEnd`, `tipCount`       | descendant tips are the leaf-rank range `[tipStart, tipEnd)`                                                                                     |
| `tipIds()`                             | the loaded tip labels in the range (a slice, allocated per call)                                                                                 |
| `tipLabels()`                          | the same through the source (a promise), also for clades whose labels are not loaded                                                             |
| `clientX`, `clientY`                   | pointer position (for the keyboard: the node's position)                                                                                         |
| `via`                                  | `'pointer'` or `'keyboard'`                                                                                                                      |
| `run?`                                 | set for a run of small siblings drawn as one slice: `node` is their parent, the range is only the run's, `{clades, single}` counts what it holds |
| `preventDefault()`, `defaultPrevented` | skip the default actions for this event                                                                                                          |

## Controls ([`src/control.ts`](../src/control.ts), [`src/controls/`](../src/controls))

A control is any object with `element: HTMLElement`, optional `position` (`'top-left'` default, `'top-right'`, `'bottom-left'`,
`'bottom-right'`, or `'custom'`: put in the control layer as it is, positioned by itself), optional `target` (an element of the page: the
control lives there instead of on the viewer) and `setViewer(viewer | null)`. `addControl` gives a control's element `pointer-events:
auto` unless the element already has an inline `pointer-events`: a control that lays something over the whole tree (labels, say) sets
`none` so clicks reach the tree. Pointer and key events inside the control layer never reach the tree; the wheel over a control zooms the tree, and over the overview zooms about the tree point under the pointer (the overview handles its own wheel), except inside an element marked `data-phylo-scroll` (a list that
scrolls itself, as the legend and the search suggestions are).

`BaseControl` is the base class of the built-ins: `new BaseControl(name, { position, target, className }, element?)` gives the element the
classes `phylo-control phylo-<name>` (and `phylo-control--external` with a target); override `attach(viewer)` and `detach()`, and register
listeners with `this.listen(viewer.on(...))` and `this.domListen(el, type, fn)` so they are removed with the control. `makeButton(label,
icon)` makes a `.phylo-button`.

```ts
class TipsInView extends BaseControl {
  constructor() {
    super('in-view', { position: 'bottom-left' });
  }
  protected attach(v: TreeViewer) {
    const update = () => {
      const { y0, y1 } = v.getViewport();
      this.element.textContent = `${Math.round(y1 - y0)} tips in view`;
    };
    this.listen(v.on('viewchange', update));
    update();
  }
}
viewer.addControl(new TipsInView());
```

Built-in controls (each in its own module; options extend `{ position, target, className }`)

| Control           | Default position | Options                                                                                                                         | What it does                                                                                                                                                                                                                                                                                                                        |
| ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Zoom`            | top-left         | `factor` (1.6), `zoomInIcon`, `zoomOutIcon`                                                                                     | zoom about the centre: rows only in the rectangular layout, both axes in the radial one                                                                                                                                                                                                                                             |
| `Fit`             | top-left         | `icon`, `label`                                                                                                                 | `fit(true)`                                                                                                                                                                                                                                                                                                                         |
| `LayoutToggle`    | top-left         | `icons`, `labels` (per layout)                                                                                                  | one pressed button per layout; follows `optionschange`                                                                                                                                                                                                                                                                              |
| `Search`          | top-right        | `placeholder`, `maxResults` (8), `highlight` (false), `onSelect(tipId, viewer, node)`, `icon`                                         | find tips by label (prefix matches first, case-insensitive on the displayed label), keyboard list; focuses the chosen tip. When more tips match than it lists, the list ends with '8 of 1,234 matches', and a polite live region (`status`) announces the count. `find(viewer, query)` returns `{ ranks, total }`: the tip ranks it would list and how many tips match in all |
| `Legend`          | bottom-right     | `title`, `items` (`{colour, label, detail?, node?}[]` instead of the clade colours), `cladeLabel` (overrides the viewer option) | the clade colours with their names; click to zoom to a clade; hidden while empty; follows `formatLabel` and `cladeLabel` changes. A clade is named by its `setClades` label, else by its node's name and tip count (`Chelodina ott1 (12 tips)`; see Naming clades), else `Clade of 12 tips` (`Unnamed tip` for a tip with no label) |
| `OverviewControl` | custom           |                                                                                                                                 | the whole tree in small with the window box (a strip right of the rectangular plot, which leaves room for it; a disc in radial)                                                                                                                                                                                                     |

`defaultControls({ zoom, fit, layoutToggle, search, legend, overview })` returns the usual set: zoom and fit on, the others off; each key is
`true`, `false` or that control's options. `ICONS` holds the default icons (16 px SVG in `currentColor`).

## Overlays and popups ([`src/overlays/`](../src/overlays))

All three are controls with position `'custom'`: add them with `addControl`.

| Class      | Options                                                                                                                                                                     | What it does                                                                                                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Overlay`  | `element`, `positioning` (`'top-left'`; vertical-horizontal, e.g. `'bottom-center'`), `offset` (`[x, y]`), `keepInside` (true), `anchor`                                    | an element of yours pinned to `{node}`, `{tipId}` or `{x, y}` (`setPosition(anchor)`, `null` hides it); placed after every frame through `nodePosition`, hidden while the anchor is out of view. `setPositioning`, `getPosition`, `update()`                       |
| `Tooltip`  | `render(e, viewer)` returning a node, a string or null; `offset` (`[14, 14]`); `bare` (content only: no padding, background, border or shadow, class `phylo-tooltip--bare`) | hover box near the pointer (default content: `defaultTooltip`); a default action of `hover`                                                                                                                                                                        |
| `NodeMenu` | `items(e, viewer)` returning `NodeMenuItem[]` or null; `title(e, viewer)` | actions for the clicked tip or clade at the click, under a header with the title, a close button and a line (`.phylo-node-menu__head`, `__title`, `__close`); keyboard (focus on the first item when opened by Enter, arrows, Escape, Tab out; the close button is for the pointer and out of the tab order), closes on its close button, a press outside, a view change or a choice; a default action of `click`. Opening it selects the node (`setSelected`), so the selection ring stays on it while the pointer is in the menu; the selection stays after it closes. `setItems`, `isOpen`, `close(refocusTree)` |

`NodeMenuItem`: `{ id, label, hint?, disabled?, onSelect(e) }`.

## Columns

```ts
type Column = BuiltinColumn | CustomColumn;
BuiltinColumn: { id, kind: 'bar' | 'text' | 'alignment', header, width: number | 'fill', values: Record<tipLabel, number | string>, nodeValues?: ReadonlyMap<nodeId, number | string>, alphabet?: 'auto' | 'protein' | 'nucleotide' }
CustomColumn:  { id, kind: 'custom', header, width: number | 'fill', values: Record<tipLabel, V>, nodeValues?: ReadonlyMap<nodeId, V>, renderer: ColumnRenderer<V, D> }
```

`width` is CSS px, or `'fill'`: the column takes the width left after the tree area and the fixed columns (several fill columns share it
equally; never under 40 px). An alignment is scaled to its width, so a `'fill'` alignment shows all its columns of residues in whatever room
the tree split leaves (see `treeWidth`). Columns are rectangular-only, so `treeWidth` and `'fill'` do nothing in the radial layout.

`values` go to every tip with the label (tip labels need not be unique). `nodeValues` are by node id, for values that belong to one tip; they win
over `values` for their tips. `values`, `nodeValues` (and `renderer`) are compared by reference when columns are set again: pass the same
object while the data is unchanged and a new one when it changed; never mutate in place. Built-in kinds: log-scaled bars (binned per pixel row below 1.5 px per row), text (tinted bands
below 9 px), alignments (residue colours or ETE-style blocks, see `alignStyle` and the theme's `alignRowGap`).

An alignment column has two colour schemes, chosen by its `alphabet`: `'protein'` (Clustal-like groups) and `'nucleotide'` (A, C, G, T/U each
their own colour). `'auto'`, the default, takes `'nucleotide'` when more than 90% of a sample of the residues (the first 400 non-gap
residues of each sequence, up to 2000 in all; at most 20,000 characters are scanned per sequence) are A, C, G, T, U or N, otherwise `'protein'`. Changing `alphabet` recompiles the column.
The colours are theme tokens (`residue*`, below). `residueColours(theme, alphabet)` returns the table the column is drawn from, and
`residueGroups(alphabet)` the groups with their labels, so an app can draw a legend that cannot go stale:

```ts
import { residueColours, residueGroups, detectAlphabet } from '@gbif-phylo/viewer';
const alphabet = detectAlphabet(Object.values(values)); // 'protein' | 'nucleotide', as 'auto' decides
const colours = residueColours(viewer.getTheme(), alphabet); // { A: '#...', C: ..., ..., Z: ..., other: '#...' }
const legend = residueGroups(alphabet).map((g) => ({ label: g.label, colour: colours[g.residues[0]] }));
```

A `ColumnRenderer` draws a custom column:

| Member                                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare({ values, nodeValues, tipLabels, tipNodes, tipCount })` | runs when the values or the renderer change; return whatever is fast to draw, typically arrays by tip rank. `tipNodes` is the node id by rank (-1 not loaded); a tip's value is `nodeValues.get(tipNodes[r])`, else `values[tipLabels[r]]`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `draw(ctx, frame, data)`                   | runs per frame, the canvas clipped to the column, transform in CSS px. `frame`: `x, width, top, bottom`, visible ranks `r0..r1` (inclusive), rank r at `y = oy + r * rowHeight`, `theme`, `rankOfRow`. Draw all visible ranks in this call; below 1 px per row draw a summary. With collapsed clades the call is made once per stretch of consecutive visible ranks, with `oy` shifted so the formula still holds; the rows of collapsed clades are in no call (blank). `rankOfRow` (row -> first rank, or null) is informational |
| `hasCell?(data, rank)`                     | which ranks have a cell (for `columnCell`); default: a value exists for the tip. Asked of ranks, never of a collapsed clade                                                                                                                                                                                                                                                                                                                                                                                                       |

The viewer draws the header. A renderer that throws is reported once and the frame goes on. See the heat strip in
[`examples/vanilla/src/main.ts`](../../../examples/vanilla/src/main.ts).

## Theme or option

Every setting is one or the other, by this rule:

- **Theme** (`TreeTheme`): how things look. Colours, sizes and widths in px, opacities, font family and style. Each is a `--phylo-*` custom
  property too, so a stylesheet themes the viewer (light/dark, GBIF tokens) without JavaScript.
- **Options** (`ViewerOptions`): what is shown and how the viewer behaves. Layout, which elements appear, density and level-of-detail
  thresholds, functions (`formatLabel`, `tipHref`), performance knobs.

Test for a new setting: would a designer set it in CSS, or does it change what is drawn or how the viewer works? A switch that adds or removes
an element is an option; the colour, size and font of that element are theme. Settings added by other work follow the same rule, for example
a switch for a kind of label or highlight (option) and the colours and opacities that go with it (theme). Summaries follow it: `showSummaries` says whether they are drawn (option), their colour, opacities and stripe gap are theme.

Exceptions to the rule:

| Setting                                   | Lives in | Why                                                                                                                                                                                                                |
| ----------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dark`                                    | theme    | derived from the background; informational for apps, and used by the drawing code only to choose light or dark residue defaults                                                                                    |
| `rowHeight`, `maxTipSpacing`, `treeWidth` | option   | sizes, but they set the layout and the zoom limits (how many tips fit, how far one can zoom, where the columns start), not how something is painted. They are in px, or follow the theme's `labelSize` (`'1.85em'`) |

Hard cases that follow the rule: `alignStyle` is an option (residues or blocks change what is drawn) while its colours and `alignRowGap` (an inset inside a row) are theme; `minCladePx` is an option (a level-of-detail threshold); `ariaLabel` is an option (text for assistive technology); `categorical` is theme (a comma list of colours in CSS).

Known gaps: some looks are still constants in the drawing code, neither theme nor option. They are `NODE_LABEL_GAP_PX` (3, support to its node, at least the marker's half size plus 1), `NODE_LABEL_PAD_PX` (3, free space each side of a node label within its branch), `NODE_LABEL_LIFT_PX` (2, branch line to the text's baseline) and `NODE_LABEL_MIN_SEG_PX` (10, a branch shorter than this gets no label) in `draw.ts`, `LABEL_GAP_PX` (8, tip or aligned column to the label text) and `LEADER_END_GAP_PX` (3, a leader stops this far before its label) in `draw.ts`, the column header font (`columns.ts`), the font size of text columns (`columns.ts`) and the keyboard cursor's ring (`CURSOR_RING_RADIUS` 10 and `CURSOR_RING_WIDTH` 2.5, in `highlight`, in `viewer.ts`). Moving them to theme tokens is open work. The audit above covers the `ViewerOptions` and `TreeTheme` fields, not these constants.

## Theme ([`src/theme.ts`](../src/theme.ts))

The theme in force is `FALLBACK_THEME`, then the `--phylo-*` custom properties set on the target or any ancestor, then `setTheme`'s
overrides (`updateTheme` merges into them). The viewer re-reads the custom properties when it is created and, per the `themeObserver`
option, when `prefers-color-scheme` changes (`'media'`, the default) and also when `class` or `data-theme` on `<html>` changes
(`'document'`, a `MutationObserver`, disconnected by `destroy()`); `'none'` leaves it to `refreshTheme()`. The viewer writes the colours and font in force back on its root, so the controls and popups (styled by `viewer.css` with the same
properties) follow a theme from JavaScript too. A dark mode is a set of custom properties:

```css
.dark {
  --phylo-background: #0f172a;
  --phylo-foreground: #e2e8f0;
  --phylo-muted: #94a3b8;
  --phylo-branch: #cbd5e1;
  --phylo-summary: #64748b;
  --phylo-highlight: #7dd87f;
  --phylo-surface: #1e293b;
}
```

`TreeTheme` (canvas). The CSS property is `--phylo-` plus the field in kebab case (`THEME_CSS_VARS`); numbers may carry `px`.

| Field                                                                                                                             | CSS property                                                                                           | Default                                                                                                                                                                                | Meaning                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `background`, `foreground`, `muted`                                                                                               | `--phylo-background`, ...                                                                              | `#ffffff`, `#162d3d`, `#6b7c8a`                                                                                                                                                        | canvas (may be `transparent` or translucent: the page shows through; the canvas is opaque, which is faster, whenever this colour is), labels and axis text, axis lines and headers    |
| `branch`, `highlight`, `summary`                                                                                                  | `--phylo-branch`, ...                                                                                  | `#44576a`, `#4c9b45`, `#9aa7b3`                                                                                                                                                        | branches, hover and keyboard rings, hover path and focus, collapsed clades                                                                                                                                     |
| `fontFamily`                                                                                                                      | `--phylo-font-family`                                                                                  | `system-ui, sans-serif`                                                                                                                                                                | labels and axis                                                                                                                                                                       |
| `labelFontStyle`                                                                                                                  | `--phylo-label-font-style`                                                                             | `italic`                                                                                                                                                                               | `italic` or `normal` (`oblique` reads as italic, case ignored): tip labels on the canvas and in the DOM (tooltip, node menu, search list)                                             |
| `alignRowGap`                                                                                                                     | `--phylo-align-row-gap`                                                                                | 0                                                                                                                                                                                      | alignment columns: empty px between sequences (rows at least 4 px tall); blocks keep at least a quarter of the row free                                                               |
| `selectionColour`, `selectionWidth`, `selectionRadius` | `--phylo-selection-colour`, `-width`, `-radius` | `''` (= `foreground`), 2.5, 7 | the ring of the selected node (`setSelected`): colour, line width (px, 0 = no ring) and radius (px), drawn over a halo of `background` 2 px wider |
| `markColour`, `markWidth`, `markRadius`, `markDash` | `--phylo-mark-colour`, `-width`, `-radius`, `-dash` | `''` (= `highlight`), 2, 11, `'3 2'` | the rings of the marked nodes (`setMarked`): colour, line width (px, 0 = no ring), radius (px) and dash pattern (px separated by spaces or commas, `''` or `'none'` = solid), drawn over a solid halo of `background` 2 px wider |
| `hoverPathColour`, `hoverPathWidth` | `--phylo-hover-path-colour`, `-width` | `''` (= `highlight`), 2 | the path from the hovered node (else the keyboard cursor) to the root, option `hoverPath`: colour and line width (px, 0 = no path). Drawn on the overlay canvas under the rings, at full strength over a dimmed tree |
| `hoverRingRadius`, `hoverRingWidth`, `hoverRingDuration` | `--phylo-hover-ring-radius`, `-width`, `-duration` | 6, 2, 150 | the hover ring, in `highlight`: radius (px; 1.5 times it for a collapsed clade) and line width (px), and, with the option `hoverAnimation`, the time in ms it takes to grow in (and for the ring it replaced to fade out). 0 ms = no animation |
| `categorical`                                                                                                                     | `--phylo-categorical` (comma list)                                                                     | 5 colours                                                                                                                                                                              | palette for categories; the second colours bar columns                                                                                                                                |
| `branchWidth`, `cladeBranchWidth`                                                                                                 | `--phylo-branch-width`, ...                                                                            | 1.3, 2                                                                                                                                                                                 | line widths (px)                                                                                                                                                                      |
| `tipRadius`, `nodeMarkerSize`                                                                                                     | `--phylo-tip-radius`, ...                                                                              | 3.2, 4                                                                                                                                                                                 | largest tip dot radius, node marker side (px)                                                                                                                                         |
| `summaryOpacity`, `markerOpacity`, `highlightOpacity`                                                                             | `--phylo-summary-opacity`, ...                                                                         | 0.25, 0.85, 0.16                                                                                                                                                                       | summary background (see "Summaries"), markers, highlight band                                                                                                                         |
| `summaryStripeOpacity`, `summaryStripeGap`                                                                                        | `--phylo-summary-stripe-opacity`, `-gap`                                                               | 0.5, 2                                                                                                                                                                                 | the stripes over a summary's background: their opacity, the least distance between two stripes (px, at least 1)                                                                       |
| `dimOpacity`                                                                                                                      | `--phylo-dim-opacity`                                                                                  | 0.25                                                                                                                                                                                   | what `highlightStyle: 'dim'` or `'both'` draws outside the highlighted set (branches, tip dots, labels, summaries); multiplies a summary's own opacity                                |
| `leaderColour`, `leaderDash`, `leaderWidth`, `leaderOpacity`                                                                      | `--phylo-leader-colour`, `-dash`, `-width`, `-opacity`                                                 | `''` (= `muted`), `1 3`, 1, 0.7                                                                                                                                                        | leader lines of aligned labels: colour, dash pattern (px, separated by spaces or commas; `''` or `none` = solid), width (px), opacity (times `dimOpacity` for a dimmed tip)           |
| `labelSize`, `axisFontSize`                                                                                                       | `--phylo-label-size`, ...                                                                              | 13, 10                                                                                                                                                                                 | largest label size (labels shrink with the rows, down to 8), axis text (px)                                                                                                           |
| `ringWidth`, `ringOpacity`, `ringStripeOpacity` | `--phylo-ring-width`, `-opacity`, `--phylo-ring-stripe-opacity` | 1, 0.3, 0.08 | the radial scale rings (option `radialRings`), in `muted`: line width (px) and opacity of `'lines'`, opacity of the shaded bands of `'stripes'`; their labels use `axisFontSize` |
| `nodeLabelSize`, `supportColour`, `lengthColour`                                                                                  | `--phylo-node-label-size`, `-support-colour`, `-length-colour`                                         | 10, `''` (= `muted`), `''` (= `muted`)                                                                                                                                                 | node labels (`nodeLabels`): largest size (they shrink with the rows, down to 8; px), colour of support values (and of what a `nodeLabels` function returns), colour of branch lengths |
| `dark`                                                                                                                            | `--phylo-dark`                                                                                         | from the background's luminance (an opaque background; a translucent one leaves it `false`), also after `setTheme({ background })`, unless `--phylo-dark` or `setTheme({ dark })` says | the background is dark: for apps and custom controls; the drawing code reads it only to pick the default residue colours (below)                                                      |
| `residueHydrophobic`, `residuePositive`, `residueNegative`, `residuePolar`, `residueAromatic`, `residueGlycine`, `residueProline` | `--phylo-residue-hydrophobic`, `-positive`, `-negative`, `-polar`, `-aromatic`, `-glycine`, `-proline` | light and dark sets (below)                                                                                                                                                            | protein residues of alignment columns by group: AILMFWVC, KR, ED, NQSTU, HY, G, P                                                                                                     |
| `residueA`, `residueC`, `residueG`, `residueT`                                                                                    | `--phylo-residue-a`, `-c`, `-g`, `-t`                                                                  | light and dark sets (below)                                                                                                                                                            | nucleotides of alignment columns; U is drawn like T                                                                                                                                   |
| `residueOther`                                                                                                                    | `--phylo-residue-other`                                                                                | light and dark sets (below)                                                                                                                                                            | any other residue character, in either scheme (gaps are not drawn)                                                                                                                    |

The residue tokens are optional: a token that is not set is the default for the theme's `dark` (light: the Clustal-like protein colours the viewer
always had, and A `#2f9e44`, C `#2f6fd6`, G `#c27a00`, T/U `#d63b3b`; dark: lighter variants, each at least 3:1 against `#0f172a`, see
`defaultResidueColour` in `src/residues.ts`). A value is read the way the browser reads a CSS colour (drawn on a 1x1 canvas and read back: names, `hsl()`, `oklch()`, `color-mix()`
and `#rgba` all work; without a canvas, as in tests, only `#rgb`, `#rrggbb` and `rgb()`/`rgba()`). The alpha is dropped, because the
alignment bitmap is opaque. A value that is not a colour, or is fully transparent, is replaced by the default with one console warning
per value. `residueColours` returns each colour as the `#rrggbb` that is drawn, so the returned table is always what is drawn; results
are cached per string, so a theme change resolves a colour once. Why groups for protein but bases for nucleotides: A, C, G and T are residues in both alphabets, so
a token per letter would have to choose one meaning; the protein scheme colours seven groups, so seven tokens cover its twenty letters.
Setting a token repaints the alignment columns (their bitmap holds the colours); the other columns are not recompiled.

DOM only (`viewer.css`): `--phylo-surface` (control and popup background), `--phylo-surface-hover`, `--phylo-border`, `--phylo-radius`,
`--phylo-control-radius`, `--phylo-control-size`, `--phylo-shadow`, `--phylo-popup-shadow`, `--phylo-gap`, `--phylo-font-size`,
`--phylo-transition`. Class names to style: `.phylo-viewer`, `.phylo-controls--<corner>`, `.phylo-control`, `.phylo-<control name>`,
`.phylo-button`, `.phylo-bar`, `.phylo-tooltip`, `.phylo-node-menu`, `.phylo-legend`, `.phylo-search`, `.phylo-overview`, `.phylo-notice`.

`themeFromCss(element)` returns the fields set as custom properties there; `themeEquals(a, b)` compares two themes.

## ViewerOptions

`ViewerOptions` in `types.ts`; default in the second column.

| Option            | Default                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `layout`          | `'rectangular'`          | `'rectangular'` or `'radial'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `branchLengths`   | `true`                   | phylogram (true) or cladogram; a tree without lengths is drawn as a cladogram either way                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `lod`             | `true`                   | viewport level of detail: collapse small clades into summaries, dedupe sub-pixel primitives                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `drawBudget`      | `20000`                  | most primitives per frame; the collapse threshold is raised until the cut fits (min 500; LOD off: 600,000)                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `showSummaries`   | `true`                   | draw collapsed clades as triangles (otherwise only their branch)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `labelDensity`    | `'normal'`               | `'sparse'`, `'normal'` or `'dense'`: minimum tip pitch for a label: 16, 11, 8 px at the default 13 px `labelSize`, scaled with the theme's `labelSize` (`labelMinPx` in `sizes.ts`)                                                                                                                                                                                                                                                                                                                                                              |
| `alignLabels`     | `false`                  | phylogram: every tip label starts in one column right of the farthest tip (radial: on one circle just outside the outermost tip), with a dotted leader line from each tip to it (see "Aligned labels"). No effect in a cladogram or without branch lengths                                                                                                                                                                                                                                                                                       |
| `hoverPath`       | `true`                   | hovering a tip, clade or collapsed clade (a run of small siblings: their parent) also highlights its path to the root, every branch and connector on the way (theme `hoverPathColour`, `hoverPathWidth`). With nothing hovered, the keyboard cursor's path is shown; one path at a time. The path is the loaded rows (a partial tree always has a loaded node's ancestors). Redrawn on the overlay canvas only: the walk is O(depth), with corners under a pixel merged and stretches out of view skipped |
| `hoverAnimation`  | `true`                   | the hover ring grows into existence, radius and opacity from 0 with an ease-out, over the theme's `hoverRingDuration` (150 ms); moving to another node fades the old ring out over the same time, and the pointer leaving the tree removes it at once. The keyboard cursor's ring grows the same way when the cursor moves; the selection ring and the marks are not animated. Only the overlay canvas is redrawn, one frame per step, and no frame is asked for once the rings have settled. When the user prefers reduced motion (`prefers-reduced-motion: reduce`, read each time a ring is drawn) the rings are drawn at full size at once, as with `false` |
| `nodeLabels`      | `'none'`                 | labels on internal nodes (`'length'`: and tips), drawn by the viewer: `'support'`, `'length'` or `(node, tree) => string \| number \| null` (see "Node labels")                                                                                                                                                                                                                                                                                                                                                                                                         |
| `formatNodeLabel` | `defaultFormatNodeLabel` | `(value, kind: 'support' \| 'length') => string`, the text of a number shown by `nodeLabels`: support to 2 decimals (`0.95`, `100`), lengths to 3 significant digits. Show 0.95 as 95 with `(v, kind) => kind === 'support' && v <= 1 ? String(Math.round(v * 100)) : String(v)`                                                                                                                                                                                                                                                                 |
| `highlightStyle`  | `'band'`                 | how `setHighlighted` shows its tips: `'band'` (row band, ring, bold label), `'dim'` (everything outside the set is drawn at the theme's `dimOpacity`, the matches look normal) or `'both'`. See below                                                                                                                                                                                                                                                                                                                                            |
| `rowHeight`       | `null`                   | fixed height per tip row at fit (rectangular): px, `'<n>em'` (n times the theme's `labelSize`) or `'auto'` (1.85 em), rounded to whole px; `null` fits all tips into the height                                                                                                                                                                                                                                                                                                                                                                                        |
| `maxTipSpacing`   | `'auto'`                 | the most space between neighbouring tips when zooming in: a row's height (rectangular) or the arc between tips on the outer circle (radial). Same forms as `rowHeight`; `'auto'` is 1.85 em, 24 px at the default 13 px label size. See "Zoom limits"                                                                                                                                                                                                                                                                                           |
| `maxViewWidth`    | `1.6`                    | rectangular: the widest x window in tree widths. Raise it to let the tree get narrower than 62% of the plot. See "Zoom limits"                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `treeWidth`       | `'auto'`                 | rectangular: width of the tree area against the columns: `'auto'`, px, or `'<n>%'`. See "Tree and columns"                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `axis`            | `true`                   | scale bar (radial) or time/length axis (rectangular)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `minCladePx`      | `3`                      | collapse clades less than this many px tall (radial: their arc at the tips), however short their branches (the base threshold of the cut)                                                                                                                                                                                                                                                                                                                                                                                                        |
| `alignStyle`      | `'residues'`             | alignment columns: coloured cells, or `'blocks'` (grey gap-free stretches joined by a line)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `formatLabel`     | underscores to spaces    | `(tipId) => string`, the displayed tip label                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cladeLabel`      | `null`                   | `(node, tree) => string \| null`, the name of an internal node (`node`: preorder id in the full tree; `tree`: the snapshot, label at `tree.labels[tree.toLocal(node)]`); null = none. See Naming clades                                                                                                                                                                                                                                                                                                                                          |
| `formatCollapsedLabel` | `defaultFormatCollapsedLabel` | `(name, tips) => string`, the label of a collapsed clade: `name` is its name by the rule of Naming clades (null for none), `tips` its number of tips. The default gives `Firmicutes · 12,345 tips`, or `12,345 tips` without a name. Also what the screen-reader list says for it (followed by `, collapsed`) |
| `tipHref`         | `null`                   | `(tipId) => url`; makes visible labels real links (`<a href data-tip-id>`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ariaLabel`       | `'Phylogenetic tree'`    | label of the root element                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `softwareCanvas`  | `false`                  | create the 2D contexts with `willReadFrequently` (CPU-backed canvas); read at construction only                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `themeObserver`   | `'media'`                | what makes the viewer re-read the `--phylo-*` custom properties: `'media'` a change of `prefers-color-scheme`; `'document'` that plus a change of `class` or `data-theme` on `document.documentElement` (dark mode switched by the page); `'none'` nothing, call `refreshTheme()` yourself. Changeable with `setOptions` (back from `'none'` it refreshes at once); another value throws `RangeError`. `'document'` reacts once per animation frame and does not see dark mode set on `<body>` or by `style` on `<html>` (call `refreshTheme()`) |
| `dprCap`          | `2`                      | cap on canvas pixels per CSS px (`Infinity` = native); hit-testing and events use CSS px                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `radialOpening`   | `0.05`                   | radial only: the share of the circle left empty between the last and the first tip, 0 (a closed circle) to 0.99; the tips are spread over `(1 - radialOpening) * 360` degrees, each in the middle of its slot. 0.5 is a half circle; the fit frames what the fan covers                                                                                                                                                                                                                                                                          |
| `radialRotation`  | `90`                     | radial only: where the middle of the opening sits, degrees clockwise from 3 o'clock; 90 is the bottom, so the tips run clockwise from just left of the bottom over the top to just right of it. `radialOpening: 0, radialRotation: 0` is the whole circle from 3 o'clock                                                                                                                                                                                                                                                                         |
| `radialRings` | `'none'` | radial with branch lengths and `axis` on only (the scale bar is the rings' label where the opening cannot hold one): `'lines'` draws circles about the root behind the tree at the scale bar's step (so the bar is one band wide; zooming in subdivides them to the next 1, 2 or 5 x 10^n, zooming out merges them), `'stripes'` shades every other band between them instead. On a dated tree (ultrametric) they count back from the tips (age 0), otherwise out from the root. With an opening, each ring is labelled with its distance or age along the middle of the opening where the gap is wide enough. Only the arcs crossing the viewport are drawn. Theme `ringWidth`, `ringOpacity`, `ringStripeOpacity` |
| `radialMaxNodes`  | `2000`                   | radial only: most primitives per frame; small clades become fans (`Infinity` = only `drawBudget`)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `interactionLOD`  | `'auto'`                 | reduced frames (a quarter of the budget, coarser collapse) while wheeling, pinching, dragging or animating. `'auto'`: only when full-quality frames get slow (their JS time, smoothed, above 12 ms), so a fast tree keeps full detail; `true`: always; `false`: never |
| `refineMs`        | `120`                    | ms without input before the full-quality frame after a gesture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `summaryNotice`   | `true`                   | radial: corner notice when the cut-off summarises clades the normal threshold would show                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The overview is a control (`OverviewControl`), not an option.

### Summaries

Every summary has one look: the triangles, fans and bands (of polytomies and of runs of small siblings) that the level of detail draws, and
the clades an app collapsed (`setCollapsed`). It is a faint background fill of the whole shape with hairline stripes over it, in the
direction the hidden branches would run, so a summary reads as one shape, "more tree here", and not as branches.

- **Background:** one fill per summary in `summary` (or the clade's colour) at `summaryOpacity`, drawn first.
- **Stripes:** 1 px lines in the same colour at `summaryStripeOpacity`, over the background. The line width is not a token: the stripes are
  hairlines, thinner than any branch, so they read as a texture.
- **Rectangular:** horizontal stripes, from the triangle's sloping side (the band's left edge) to its outer edge, about one per hidden tip row
  (the row pitch at the current zoom) and never closer than `summaryStripeGap` px. Only the visible rows are generated.
- **Radial:** stripes along the rays from the root through the wedge, spaced by angle, one per hidden tip and never closer than `summaryStripeGap` px along the
  arc at the outer radius (closer toward the apex, where the rays converge). A fan's rays form one grid over its whole angular extent, so panning
  moves the rays and never re-spaces them; only the rays at visible angles (the window the cut uses, also when it wraps through angle 0) are drawn.
  Beyond 256 visible rays the fan draws every 2nd, 4th, ... ray of the same grid (the step is a power of two, so it changes only when the visible
  part doubles or halves). A fan's ray starts where it meets the fan's side, a polytomy's ring segment's at its inner arc.
- **No room for stripes: their tone.** A summary with room for fewer than two stripes (under two gaps tall, or wide along the arc, or with fewer
  than two hidden tips) gets, over its background, a second fill at the stripes' mean tone instead: alpha `summaryStripeOpacity / pitch`, 1 px
  lines every `pitch` px, the distance they would have (one per hidden tip, at least the gap). So does a summary whose stripes would be more than eight gaps apart (a few hidden tips over a tall triangle, such as a
  collapsed clade in a zoomed-in row; or a radial fan thinned that far): stripes that far apart are bands, not a texture; its tone uses that distance, so zooming across the limit does not change its darkness. The level of detail
  summarises clades smaller than `minCladePx`, so a summary is at most about `minCladePx` px tall (bands of polytomies and of runs excepted): with
  the default 3 px most summaries get the tone, and a `minCladePx` of 12 or more (or a draw budget that raises the threshold) gives most of them
  stripes. The explorer sets 14 on trees over 1,500 tips.
- **Darkness.** The background sets the shape's tone; the stripes add `summaryStripeOpacity` over `1 / pitch` of it, so a summary is darkest
  where its stripes are densest (at the least gap, or toward a fan's apex) and the tone fill matches the stripes it stands in for. With the defaults
  (0.25, 0.5, 2 px) a striped or toned summary averages about 0.44 of its colour (computed from the opacities, not measured), lighter than the old solid fill at 0.6.
- **Colour and dimming.** A clade colour (`setClades`) tints both the background and the stripes. Dimming (`highlightStyle: 'dim'` or `'both'`)
  multiplies both opacities by `dimOpacity`; a summary holding a highlighted tip keeps full strength.
- **Gap.** `summaryStripeGap` below 1 is taken as 1.
- **Hit-testing, labels and the overview.** The summary's area is hit as before, and a collapsed clade keeps its label right of its shape.
  The overview strip draws the same look; its summaries are small, so most get the tone.
- **Cost.** The stripes of a frame are collected into one reused buffer (one group per summary) and stroked per summary in batches of 256, no allocation per
  node; the summaries that get the tone are listed in a second reused buffer and filled again. Their number is bounded by the summaries' height over the gap
  (rectangular: only the visible rows) and by 256 per fan (radial). `tests/browser/bench/stripes-bench.mjs` measures the frame time.

### Collapsed clades

`setCollapsed(nodeIds)` (React: the `collapsed` prop) collapses clades **in the view**, on the tree the viewer is given. Nothing is edited: node
ids stay the ids of that tree everywhere, so colours (`setClades`), highlights, events, `zoomToNode` and `nodePosition` need no translation, and
a new tree is not needed (so the window is not reset, which `setTree` also avoids with `treeMap`). What it does, by part:

- **Rows.** A collapsed clade has one row for all its tips (the rows of the others move up), so the viewport's `y` is in _rows_, not tip ranks:
  the same thing while nothing is collapsed. `focusTip`, the keyboard cursor, the overview, the columns and the highlight bands go through the
  rank/row tables of the layout (`Layout.rowOfRank`, `rankOfRow`; see internals.md, "Collapsed clades").
- **Drawing.** The clade is the usual summary: a triangle (rectangular) or fan (radial) from its node to its deepest tip, never opened and not
  merged into a run of small siblings, whatever the zoom and `showSummaries`. Its depth ends at the clade's tips, so a dated tree stays dated and the
  axis keeps "time before tips". It has the look of any summary (see "Summaries"), with the clade's colour, and is dimmed like any summary.
- **Label.** Rectangular and radial: `formatCollapsedLabel` of the clade's name (`cladeLabel`, else the node's label without its support,
  through `formatLabel`) and its tips, by default "Name · N tips" or "N tips", at the end of the triangle (in the aligned column with `alignLabels`). It is canvas text only (no DOM anchor); a click on it is a click
  on the clade.
- **Events.** A click or hover on the triangle or its label is `kind: 'summary'`, `node` = the clade, `collapsed: true`, `tipStart`/`tipEnd` its
  tips in the tree. The keyboard cursor can stand on it (Down and Up step over rows; Right does not enter it). A cursor or selection on a node that
  the clade now hides moves to the clade (and stays there when it is expanded again).
- **Columns.** The row of a collapsed clade is **blank** in every column (a clade has no value of its own, and the first tip's would mislead).
  The rows of the other tips move with them. `columnCell` of a hidden tip is `null`.
- **Hidden tips.** `focusTip(rank)` of a tip inside a collapsed clade focuses the clade and leaves it collapsed (the app decides whether to
  expand it). A highlight on a hidden tip is banded on the clade's row, and does not dim the clade. `locateNode`, `nodePosition` and
  `nodeBounds` of a node inside a collapsed clade are `null`.
- **The window** keeps its scale (rows in view) around the place its centre had, a fitted view is fitted again, and a radial window keeps its
  radius and turns with its centre. Collapsing does not touch the tree, so `setTree`'s `treeMap` is not involved.
- **Not supported:** a partially loaded source (stub rows); the collapsed set is ignored there.
- **Collapse by support or a clade shown alone** are different trees (tree-ops `collapseBySupport`, `showFocus`), so node ids shift and the app maps colours and collapsed ids through the operation's map. Pass the collapsed nodes as `collapseBySupport(t, x, { keep })` so the operation does not contract them.

### Zoom limits

`maxTipSpacing` replaces the old fixed limits (500 px per row, 20,000 times the fit scale in radial), which stay only as hard ceilings. The
radial one never stops before neighbouring tips are 50 px apart (`RADIAL_MAX_TIP_PX`): on a tree of more than about a million tips,
20,000 times the fit left the tips closer than a label, so a polytomy of tips stayed a slice however far you zoomed in (#76).
Every way of zooming in goes through `clampView`, so the wheel, pinch, buttons, keyboard, the overview, `setViewport`, `focusTip` and
`zoomToNode` all stop at it.

- **Default.** `'auto'` is 1.85 times the theme's `labelSize`, rounded to a whole CSS px (24 px at the default 13, 37 at 20): room for a label line, an alignment row and some padding, the way a
  spreadsheet row is. It follows `--phylo-label-size` without any JavaScript. Whole px keep the rows at the cap on one pixel grid, so branches, ticks and labels are equally crisp in every row (at 28.6 px they alternate between grid offsets at a device pixel ratio of 1); the same rounding applies to a font-relative `rowHeight`. The factor and the 20-24 px of a spreadsheet row are an
  estimate by the owner (issue #38), not a measurement. Give px for a fixed value, `'<n>em'` for another multiple, `Infinity` to keep only the hard ceilings.
  A value that is not a size (0, `'30px'`) logs one warning and applies no cap.
- **Never below the fit.** The limit is `max(fit, cap)`: a 6-tip tree that fits at 100 px per row stays at that and can only be zoomed
  out. `rowHeight` is the fit then, so the cap does not apply below it.
- **Radial.** The cap is the arc between neighbouring tips on the outer circle (the measure `focusTip` uses), so the scale stops at
  `cap * tipCount / (2 PI)` px per unit radius. Because a small tree reaches that at once (a 60-tip tree is already at 28 px apart at the
  fit), zoom is always allowed up to 50 times the fit scale (`RADIAL_GEOMETRIC_ZOOM`, a chosen value, not measured), so short branches near
  the root can be pulled apart; a large tree is limited by the tip cap only.
- **The x axis is not capped** (`RECT_MAX_ZOOM_X`, 5e6 px per tree width): zooming x stretches branch lengths, which helps with very short
  branches.
- **Font-relative minimums.** The label thresholds of `labelDensity` and the least row height `focusTip` brings a tip to (26 px, never more than the cap) are
  the old values at the default 13 px `labelSize` and scale with it (the label thresholds never go below 8 px, the smallest label font), so labels, focus and maximum zoom stay consistent when the font changes.
  `focusTip` and `zoomToNode` in the radial layout use `min(24 scaled with labelSize, maxTipSpacing)` as the wanted tip pitch.

`maxViewWidth` is the widest x window in tree widths (default 1.6, at least 1). The wheel zooms rows only; Shift or Ctrl and the wheel
zooms along x.

### Tree and columns

`treeWidth` fixes the width of the tree area, which holds the branches and the tip labels (the labels take up to 40% of it). `'auto'`
is the old behaviour: the columns keep their widths and the tree takes the rest. A number is px, `'<n>%'` is a share of the container
minus the overview strip; the least is 120 px and the most leaves the fixed columns and 40 px per fill column on screen. The columns then sit right of it, and `'fill'` columns share what is left. With `'auto'` and a
`'fill'` column the tree and the fill columns split what the fixed columns leave, half each, but the tree keeps at least 240 px (if the fixed columns leave that much). The fit, hit-testing, the label overlay, the overview and
the column positions all follow this one split. Not done (issue #39): a draggable divider, and letting the label column truncate with an
ellipsis and a tooltip; wide labels are still capped by the 40% reserve.

```ts
new TreeViewer({
  target,
  tree,
  options: { treeWidth: '30%', maxViewWidth: 6 },
  columns: [{ id: 'aln', kind: 'alignment', header: 'Alignment', width: 'fill', values }],
});
```

### Aligned labels

`alignLabels: true` puts the tip labels of a rectangular phylogram in one column: the text starts 8 px right of the farthest tip (a collapsed
clade's triangle ends at its deepest tip, so it never reaches farther), and a dotted leader line runs from each tip, or from the end of a
collapsed clade's triangle, to 3 px before its label. The leaders are drawn
below the tip dots, for the tips that get a label (same density rule, cap and culling as the labels), from the column leftward so the dash
pattern lines up, and a dimmed tip's leader is dimmed with it. Label hit areas and the DOM anchors (`tipHref`, screen readers) follow the labels.

The column is **pinned**: zoomed in on x so far that the farthest tip is right of the plot area, the column stays at the area's right edge (where
the farthest tip is at the fit view), so the labels stay readable. The branches of the tips beyond it run on under the label text (they are not
clipped), and such a tip gets no leader.

**Radial** (#52): the labels start on one circle, 8 px outside the outermost tip, each still turned along the ray of its tip and upright on the
left half; the leaders run along the rays from the tips (or the ends of collapsed clades' triangles) to 3 px before the circle, with the same
tokens, density rule, cap and dimming. With a radial opening (`radialOpening`, `radialRotation`) the circle is the fan's arc. Label hit areas
(radial labels are hit along their ray, aligned or not), the DOM anchors and `toBlob` follow. The fit keeps room for the text outside the
circle on every side: the label reserve of the rectangular layout (from the longest tip label, 70 to 190 px), at most 20% of the smaller
container side, so the circle is smaller with `alignLabels` on, and switching it refits a fitted view. A label longer than that room is still
cut off at the edge of the view at the fit. The zoom limits are relative to that fit, so switching it in a zoomed view keeps the window but
clamps it to the new limits.

The circle is **pinned** too: zoomed in so far that the furthest visible radius (from the root to the plot's farthest corner) less that label
room is inside the outermost tip, the labels start at that radius instead. Decision for #52: one circle, clamped to the furthest visible radius
(less the room for the text, else no label would show), was picked over pinning each label to where its own ray leaves the view (labels would
no longer share a circle) and over the largest circle inside the view (it jumps when the root leaves the view, and is useless when the root is
at an edge). The clamp is continuous, so zooming never makes the labels jump. Its limit: zoomed in around the root, the circle only crosses the
view near its corners, so labels towards the middle of the edges are out of view, as they are unpinned at a slightly smaller zoom. As in the
rectangular layout, the branches of the tips beyond the circle run on under the text and such a tip gets no leader; the density rule uses the
arc between tips on the pinned circle.

`leaderColour` must be a valid CSS colour or empty (empty = `muted`); anything else is drawn as the canvas reads it (an invalid value keeps the
previous stroke colour). `leaderDash` as a CSS custom property: only `none` (not an empty value, which the viewer ignores) gives a solid line;
with `setTheme`, `''` or `'none'` both do.

### Label anchors and focus

Every drawn tip label has a transparent DOM anchor over it (an `<a>` with `tipHref`, else a `role="treeitem"` span) for links, keyboard focus and screen readers. Its focus ring (2 px, `theme.highlight`) is drawn by the viewer on the anchor itself, so two rules keep it honest:

- **Keyboard focus only, in CSS.** The rings are rules in `viewer.css` (`.phylo-tree [data-tip-id]:focus-visible` and `.phylo-tree:focus-visible`, 2 px `var(--phylo-highlight)`), not inline styles, so they follow the browser's live `:focus-visible` state (a key press after a click turns the ring on) and the theme; `@supports not selector(:focus-visible)` falls back to `:focus`. They need `viewer.css`, like the controls and popups. Without it there is no ring, so load it. A press on the canvas moves focus to the tree and the ring on the anchor goes with it.
- **Focus survives a rebuild.** A change of theme font, `labelSize` or link mode, or `document.fonts` loading, rebuilds the anchors; focus moves to the anchor of the same tip.
- **It follows its label.** The focused anchor is moved with every frame, including the reduced frames drawn while a drag, wheel or pinch is in progress (`interactionLOD`; the other anchors wait for the full frame after `refineMs`). When its label is no longer drawn (out of view, or folded into a summary) the anchor is parked at `translate(-9999px, 0)`, so no ring is left behind, and keeps DOM focus until it moves. Decision for #62: the ring used to stay at the old place during interaction because only full frames updated the anchors.

### Node labels

`nodeLabels` draws a text on each internal node that is in the frame's draw list, and with `'length'` on each tip too. It is its own loop over the draw list (after the markers,
before the tip labels), so a frame pays for the entries of the list, not for the nodes of the tree, and a 2M-tip tree costs what its draw
list costs (at most 600 labels, 300 radial).

- **What.** `'support'` is the node's support: `tree.support[row]` when the tree has one (a `TreeModel`, a tree-ops result, anything with
  the optional `TreeData.support` array), else the number at the start of the node's label (`95`, `0.98`, or the `98` of `98:Name`; a name gives
  none). A partial source (`TreeSource` with stubs) has the labels only if it loads them, so `'support'` is the label there. `'length'`
  is `tree.length` of the node (none when missing). A function `(node, tree)` returns the text, a number (it goes through `formatNodeLabel` as
  a support value) or null; `node` is the preorder id in the full tree, as for `cladeLabel`, and `tree` is the snapshot. A value that is not
  finite (NaN, Infinity) gives no label. Numbers go through `formatNodeLabel(value, 'support' | 'length')`; a string from a function is
  drawn as it is. A function's text is placed like support (right-aligned at the node), never along the branch: use `'length'` for lengths.
- **Where.** Support (and a function's text) is right-aligned just left of the node, above its branch, clear of the node marker
  (`max(3, nodeMarkerSize / 2 + 1)` px). Length is centred on the branch, above the line: in the rectangular layout on the visible part of
  the horizontal segment, in the radial layout along the branch, turned to read upright on the left half like tip labels. The root has no
  branch, so no label. In a cladogram (`branchLengths: false`) a length is still the node's real length, centred on the segment that is drawn.
- **Tips.** With `'length'` a drawn tip gets its branch length by the same rule as an internal node: centred on the visible part of its
  branch, above the line (radial: along it), only when the text and the padding fit; the padding also clears the tip dot
  (`max(3, nodeMarkerSize / 2 + 1, tipRadius + 1)` px). The tip label is right of the tip, so the branch is
  free; with aligned labels the branch ends at the tip, and the leader to the label column is not part of it. Tips are labelled only
  when tip rows are far enough apart for tip labels (below), and after the internal nodes, so a crowded view spends the label cap on the
  internal branches first. Support and a function's text are for internal nodes only. A tip that stands for a clade collapsed in the
  data (tree-ops `collapseClades` with `extend`) is a tip, so its lengthened branch shows its length.
- **Level of detail.** Only expanded internal nodes and tips of the draw list get a label (the one exception: a length, rectangular, on the stem of a node pushed out of view to the right, see below): none inside a summary (triangle, fan or slice) or a clade the
  app collapsed (`setCollapsed`; the clade itself shows its stem's label). A label needs room. Rectangular: tip
  rows at least `LABEL_MIN_PX[labelDensity]` apart (16, 11 or 8 px), and the text, with `max(3, nodeMarkerSize / 2 + 1)` px each side
  (so it never touches the node marker), fits the visible part of the horizontal segment. This is the one rule for a length at every zoom,
  also for a node pushed out of view to the right: its stem is a stub in the draw list and still gets the label while the text fits what
  can be seen of it. A clade cut by size has no label while its node is within the plot or the 8 px just beyond it (it is still a summary there); it gets its stem's length only from the cut's stub state onward. Radial: the node's arc (radius times the angle its tips span) at least that long (for a tip, the angle of one tip row at the middle of its branch, where the label sits, so tips near the centre, packed closer, get none), and the text fits the branch. A label that
  does not fit is left out; nothing is shrunk or moved.
- **Dimming.** With `highlightStyle` `'dim'` or `'both'`, the label of a dimmed node is drawn at `dimOpacity`, as its branch is.
- **Looks.** `nodeLabelSize`, `supportColour`, `lengthColour` (theme, `--phylo-*`; `''` = `muted`). Labels are not DOM and are not hit-tested.
- **Support that is not in the labels.** A BEAST MCC tree keeps its posterior in `[&posterior=0.98]`, which `@gbif-phylo/io` reads with
  `{ annotations: true }`. Copy it to where `tree.support` is, and `'support'` shows it:

  ```ts
  tree.support.set(supportFrom(tree, 'posterior')); // Float64Array by node, NaN where there is none
  viewer.setOptions({ nodeLabels: 'support' });
  ```

  Or leave `tree.support` alone and use the function form, which the viewer's `node` id indexes directly (for an in-memory tree it is the node's
  index in your `TreeModel`; for a tree-ops result, map it first):
  `nodeLabels: (node) => post[node]` with `post = supportFrom(tree, 'posterior')`.

### Dimming highlights

With `highlightStyle: 'dim'` (or `'both'`), `setHighlighted` dims what is not highlighted instead of (or as well as) banding what is. The dim
state is a prefix sum over tip ranks, so a frame reads two entries per drawn primitive and allocates nothing.

- A clade is dimmed only when **none** of its tips is highlighted. A clade with some highlighted tips (a mixed clade, the path from the root to
  a match, a collapsed triangle or slice that holds a match) is drawn at full strength; its unmatched tips, branches and labels inside are dimmed
  on their own. A connector (the vertical bar of a node) takes the state of its node, so it is not dimmed when any tip below it matches.
- Dimmed: branches, tip dots, node markers, node labels, collapsed-clade triangles, fans and slices, tip labels and the labels of collapsed clades.
- In `'dim'` the matches are not banded, ringed, bold or recoloured; in `'both'` they are.
- Columns are **not** dimmed. Their cells carry data (colours, bars, alignments) that the person reads next to the label, and a custom
  `ColumnRenderer` has no row state to dim with; the row of a dimmed tip still shows its full-strength column.
- No highlights means no dimming. The overview and its ticks are unchanged.
- Draw order: lit entries are drawn first, then the dimmed ones, so where a dimmed stroke meets a lit one at a junction the dimmed stroke is on top.
- The state is a prefix sum of highlighted tips by tip rank, built on the first dimming frame after the highlights change (never in `'band'`
  mode); a clade is lit when its tip range holds at least one. With a partial source the ids are resolved again when rows arrive, but a match
  whose rows are not loaded yet has no rank, so its stub clade is dimmed until it loads.

## Other types

`Hit` (`hitTest`): `{ node (a row; for a run, the parent), kind, run?: {first, last} }`.

`FrameStats` (all numbers unless noted): `frameMs` JS time of the frame (cut and draw, not raster), `cutMs`, `drawMs`, `visited` nodes looked at by the cut,
`drawn` primitives in the draw list, `summaries`, `tips`, `labels`, `minPxUsed` effective collapse threshold, `budgetRetries` passes beyond the
first, `budgetHit` / `truncated` (booleans: the threshold was raised / even the highest one overflowed), `frames` total, `budget` in force this frame,
`forced` summary fans the base threshold would have expanded, `summaryTips` tips inside drawn summaries, `mergedTips` tips of primitives not emitted
because they share pixel cells, `reduced` (boolean: an interaction frame), `scale` canvas pixels per CSS px.

`Viewport {x0, x1, y0, y1}`: rectangular: x in 0..1 root to tips, y in tip rows; radial: world units, root at the origin, outermost tip circle
radius 1. `CladeColour {node, colour, label?}`.

### TreeData, TreeSnapshot, TreeSource

Detail and the invariants: [`types.ts`](../src/types.ts), [`source.ts`](../src/source.ts), and "Invariants" and "Add a TreeSource" in
[internals.md](internals.md).

- `TreeData`: the tree as typed arrays in preorder: `nodeCount, tipCount, parent, firstChild, nextSibling, childCount, subtreeEnd, length` (NaN when
  missing), `leafStart, leafEnd` (tip rank range), `tipNode, tipRank, tipLabels, labels, hasLengths`, optional `support` (by node, NaN for none; `nodeLabels: 'support'` reads it), `heights()`, `tipIndex(label)` (the first tip with the label), optional `tipIndices(label)` (every tip with it). `@gbif-phylo/io`'s
  `TreeModel` satisfies it.
- `TreeSnapshot extends TreeData`: what the viewer reads each frame, over the rows currently loaded. Adds `stub` (1 = a clade whose rows are
  not loaded), `globalId` (row to preorder id of the full tree), `rollup` (`cumLength, maxCum, depth, maxDepth, row` per row), `toLocal(globalId)`.
  All three are null for an in-memory tree.
- `TreeSource`: `nodeCount`, `tipCount`, `hasLengths` (of the full tree), `version`, `subscribe(listener)` returning an unsubscribe,
  `snapshot()`, `ensureClade(globalId, {signal, priority})`, optional `openCost(globalId)`, `tipLabels(r0, r1)` (async), `destroy()`.
  `InMemorySource` is the version-0 implementation; `isTreeSource(x)` tells the two apart.

## `<TreeView>`

`@gbif-phylo/react` ([`TreeView.tsx`](../../react/src/TreeView.tsx)); load `@gbif-phylo/viewer/viewer.css` as well. The identity rules of the
props (what counts as changed) are in the JSDoc of `TreeViewProps` and in [internals.md](internals.md#react-identity).

Props (all optional, but one of `tree` / `source` is needed):

| Prop                                                                             | Meaning                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tree`, `source`                                                                 | one of the two: a `TreeData` or a `TreeSource`; `source` wins. A new one goes to the same viewer (`setTree`): the view is fitted, or kept with `treeMap`. Switching between `tree` and `source` re-creates the viewer          |
| `treeMap`                                                                        | `Int32Array`, the `map` of the operation that produced the new `tree` (old node -> new node, -1 removed): the viewport stays on the same tips. Pass it in the same render as the new `tree`; without it a new `tree` is fitted |
| `layout`, `branchLengths`                                                        | as the options of the same name (defaults `'rectangular'`, `true`). Like the `options` fields, applied when the prop changes: a layout chosen with the `LayoutToggle` control stays until the prop changes                     |
| `clades`                                                                         | `{node, colour, label?}[]`: `node` is a node id (a number, [Naming nodes](#naming-nodes))                                                                                                                                                                                 |
| `highlighted`                                                                    | tips to highlight: labels (every tip with the label) and node ids (that tip)                                                                                                                                                                                                        |
| `collapsed`                                                                      | node ids (numbers) of the clades to collapse: the same ids as `clades` and the events, the tree is not changed (see `setCollapsed`)                                                                                          |
| `columns`                                                                        | `Column[]`, built-in or custom; replace a column and its `values` when the data changes, never mutate them; ids unique                                                                                                         |
| `controls`                                                                       | `Control[]` (default `defaultControls()`: zoom and fit; `[]` for none); compared by identity, so create them once (`useMemo`)                                                                                                  |
| `viewport`                                                                       | controlled `Viewport`; omit for uncontrolled                                                                                                                                                                                   |
| `theme`                                                                          | `Partial<TreeTheme>` over the CSS theme                                                                                                                                                                                        |
| `tipHref`                                                                        | `(tipId) => url` or `null`                                                                                                                                                                                                     |
| `selected`, `onSelectionChange`                                                  | the selected node (a node id, or `null`; see `setSelected`), applied when the prop changes (as `layout`); left out, the viewer keeps its own. `onSelectionChange(node)` reports every change, a click's included: keep the prop in step with it |
| `marked` | `number[]`: nodes marked with a ring of their own (see `setMarked`), compared element-wise; left out or `[]`, none |
| `focus`                                                                          | `{tipId, seq}`: centre that tip (a label: its first tip, with a warning when several carry it; or a node id); acts when `seq` changes                                                                                                                                                                       |
| `options`                                                                        | any `ViewerOptions` field except `layout`, `branchLengths`, `tipHref`; a key that is absent or `undefined` is the default; `softwareCanvas` re-creates the viewer                                                              |
| `tooltip`                                                                        | `true` (default tooltip), `false`, or `(e) => ReactNode` (rendered into the viewer's tooltip box)                                                                                                                              |
| `tooltipBare`                                                                    | the tooltip box without its chrome (the `bare` option of `Tooltip`), for a `tooltip` function whose content has its own                                                                                                        |
| `nodeMenu`                                                                       | `(e) => NodeMenuItem[] \| null`: the actions of the node menu for the clicked tip or clade                                                                                                                                     |
| `width`, `height`, `className`, `style`                                          | the wrapper's size (default 100%) and styling                                                                                                                                                                                  |
| `onNodeClick`, `onTipClick`, `onHover`, `onViewportChange`, `onFrame`, `onReady` | callbacks; `onReady({layoutMs, tips})` fires two animation frames after creation                                                                                                                                               |

`TreeNodeEvent` is `TreeEvent`. `TreeViewHandle` (via `ref`): `fit()`, `focusTip(tipId)`, `zoomToNode(node)`, `getViewport()`,
`setViewport(v)`, `locateTip(tipId)`, `locateNode(node)`, `nodeBounds(node)`, `columnCell(colId, tipId)`, `getStats()`, `benchmark(n)`,
`renderer()` (the underlying `TreeViewer` or `null`, for everything else: events, controls). `node` is a node id (a number); `tipId` a tip
label (its first tip; `focusTip` warns when several tips carry it) or a node id of a tip, translated to its node and leaf rank. An unknown tip label is ignored or returns `null`; an id that is not a node, or is an internal node, also warns in `focusTip`.

Hooks ([`hooks.ts`](../../react/src/hooks.ts), more in the [package README](../../react/README.md#hooks)): `useTreeViewer(ref)` is the
`TreeViewer` behind the handle as React state (`null` until mounted, a new value when the viewer is re-created); `useViewport(viewer)` and
`useTreeTheme(viewer)` are the viewport and the theme in force, following `viewchange` and `themechange`; `useTreeEvent(viewer, type,
handler, opts?)` listens to any viewer event for the viewer's lifetime. They use only the viewer's public API and events.

## Naming clades

One rule names an internal node in the legend, the node menu's default title, the default tooltip's detail line and the keyboard cursor's announcement:
the name is the `cladeLabel` option's result, or by default the node's label without its support value (`95:Chelodina_ott1` gives `Chelodina_ott1`,
`98.0:c__Nitrososphaeria` gives `c__Nitrososphaeria`, `95` gives no name); it goes through `formatLabel`; with no name the places say `Clade of N tips`.
A tip is named by its own label through `formatLabel`. Return null from `cladeLabel` to hide a synthetic name (OTL's `mrcaott…`) or return a name looked up elsewhere.

Exported helpers:

| Export         | Signature                                                                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internalName` | `(label: string) => string`: the label without its support value, `''` if it was only a support. The same rule as `splitInternalLabel(label).name` in `@gbif-phylo/io` (a test compares them) |
| `cladeName`    | `(tree: TreeSnapshot, row: number, opts: { formatLabel, cladeLabel? }) => string \| null`: the display name of the snapshot row `row`; passes `cladeLabel` the full-tree id of the node       |
| `CladeLabelFn` | `(node: number, tree: TreeSnapshot) => string \| null \| undefined`                                                                                                                           |
| `namedDescendants` | `(tree: TreeSnapshot, row: number, opts: { formatLabel, cladeLabel? }, limits?: { max = 5, maxVisits = 2000 }) => { names: { node, name, tips }[], more: boolean }`: the highest named descendants of a clade, to summarise a collapsed one. The shallowest internal nodes below it with a name by `cladeName` (so `cladeLabel` hides synthetic names and support values are none), breadth-first, not looking below a named node; it stops after `max` names or `maxVisits` nodes, so a huge clade costs no more than a small one, and `more` says it stopped early (or met rows of a partial source that are not loaded). `node` is the full-tree id. Get `tree` from `viewer.getTree()` and the row with `tree.toLocal(node)` |
| `defaultFormatCollapsedLabel` | `(name: string \| null, tips: number) => string`: the default `formatCollapsedLabel`, `Firmicutes · 12,345 tips` or `12,345 tips` |
