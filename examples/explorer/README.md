# Example: the tree explorer

The styled showcase of `@gbif-phylo`, and the counterpart of the [playground](../playground): the playground is the low-level API demo (every
option and theme token in a panel); this is what an application built on the library looks like when it is styled, with toolbars, tools,
a node menu, panels and an export menu around `<TreeView>`. The drawing, the events and the views come from the viewer, the edits and the
views of the tree from `@gbif-phylo/tree-ops`. It is also the seed of a drop-in widget. Its look started from
[Reactree](https://github.com/vaaloo/reactreejs) (reactreejs 1.0.3), and most icons in `src/icons.tsx` are Reactree's, used under its MIT
licence; the newer controls have icons drawn for this repository in `src/icons-ours.tsx`.

```
npm run dev -w examples/explorer    # http://127.0.0.1:5309 (?tree=<id> from src/trees.ts, ?theme=dark)
```

The browser check is `tests/browser/scripts/check-explorer.mjs`; it drives every control and reads the result back from the viewer (headless
Chromium).

| File | What |
|---|---|
| [`src/Explorer.tsx`](src/Explorer.tsx) | the component: toolbars, tools, node menu, panels, `<TreeView>` |
| [`src/explorer.css`](src/explorer.css) | the look as `--ex-*` custom properties, mapped onto the viewer's `--phylo-*` theme (light and dark) |
| [`src/icons.tsx`](src/icons.tsx) | Reactree's SVG icons, copied under its MIT licence (notice in the file) |
| [`src/icons-ours.tsx`](src/icons-ours.tsx) | icons drawn for this repository, in the same style (14 px, `currentColor`) |
| [`src/trees.ts`](src/trees.ts), [`src/trees.json`](src/trees.json) | the trees: the playground's catalogue (`../shared/catalogue.json`, shared) plus this example's `extras` and `overrides` |

## What the explorer demonstrates

Each control and the API behind it.

| Control | API |
|---|---|
| **Tree picker**: every tree of the playground's catalogue (19, in its four groups) and two of our own, from 6 tips to 2.4 million | `catalogue.json` shared with the playground; `fetchText` of `examples/shared/data.ts` (gzip by content, a `remote` URL when `/data/<path>` is not served: the 1.5M and 2.4M OTL trees) |
| **Click (no tool)**: the node menu | `<TreeView nodeMenu>`: the core `NodeMenu`, with items for what was clicked. Internal node: Info, Collapse, Show only, Reroot here, Flip, Swap with…, Colour…, Copy Newick. Collapsed clade (a click on its branch, or Enter; a click on its triangle expands it, see the drill-down below): Expand, Info, Show only, Colour…. Tip: Info, Reroot here, Swap with…, Colour…. Root: Info, Flip, Colour…. One line per item, no descriptions; styled as the inspector (the same panel, header and close button, `.phylo-node-menu*` classes in `explorer.css`). Its close button, a click outside and Escape close it. Enter on the keyboard cursor opens it too. Opening it selects the node, so the selection ring stays on it while the pointer is in the menu. The hover box says "Click for actions" |
| **Selection**: a click selects the tip or clade (a ring), Info opens the inspector on it; both stay across Layout and Phylo/Clado switches, which centre the view on the selection | `<TreeView selected onSelectionChange>` (the viewer's `setSelected`, a click selecting by default); a tool's click calls `preventDefault()` so it selects nothing |
| **Tools** (Reroot, Flip, Swap, Color): a click acts at once | `onNodeClick` / `onTipClick` (with `preventDefault()`: no selection), and `nodeMenu` returns `null` while a tool is active, so the menu stays out of the way. *Swap with…* in the menu starts Swap with the node picked, and a toast says to click a sibling branch. Swap's first pick keeps a dashed ring (`<TreeView marked>`, the viewer's `setMarked`) until the second click or Escape |
| **Show only**, **Back**, **Up one level** | tree-ops `focusOn`, `focusBack`, `focusUp`, `showFocus`. A navigation, not an edit: not in Undo; an edit carries the focus over with `remapFocus` |
| **Overview: 50 clades** (drill-down, [#57](https://github.com/MortenHofft/gbif-phylo/issues/57)): the clade shown in about 50 rows, its largest clades open and the rest collapsed. Shown when the clade shown has more than 50 tips | tree-ops `mergeAutoCollapse(tree, collapsed, { root, maxRows: 50 })`: the clades collapsed inside the clade shown are replaced by `autoCollapse`'s overview, the others kept; the result goes to the `collapsed` prop. Rows are counted on the tree before collapse by support |
| **Click a collapsed clade**: expand it in place; **Show only** in its menu: jump into it | The open question of #57 (expand or jump on a click) is settled here as: a click on the triangle expands, and the menu (a click on the clade's branch, or Enter on the keyboard cursor) offers Show only. Expand (the click or the menu item) is `mergeAutoCollapse(tree, collapsed, { root: clade, maxRows: 20 })`: the clade opens with its own overview of about 20 rows, and a clade whose children don't fit gets one row per child. Show only is `focusOn` plus `mergeAutoCollapse(..., { root: clade, maxRows: 50 })`, with the clade itself kept in the collapsed set, so Back (`focusBack`) and Up one level walk out to the view as it was. The click calls `preventDefault()` (`expandsOnClick` in `Explorer.tsx`: a pointer click with `kind: 'summary'` and `collapsed: true`), so neither the menu nor the selection follows; the hover box says "Click to expand" |
| **Collapse** a clade, **Expand all** | the `collapsed` prop (`viewer.setCollapsed`, a view in the viewer: the tree is not changed and ids are the full tree's) |
| **Collapse by support** with a threshold (shown only for a tree with support values) | tree-ops `collapseBySupport(tree, x, { keep })`, a view over the focused tree; `keep` is the clades collapsed by hand, so they stay collapsed, and so do the coloured clades; `extend: true` on a dated tree keeps it ultrametric (the time axis does not change). Composed with the focus by `composeMaps` / `invertMap`, as in `examples/react` |
| Width, Height (Size in circular) | `useViewport(useTreeViewer(ref))`: the scale shown is the fitted window (`fitViewport()`) over the viewport in force, so the sliders follow a wheel zoom; moving one calls `setViewport` with the fitted window divided by the scale |
| Font size, branch width | the `theme` prop (`labelSize`, `branchWidth`) |
| Rectangular / circular, phylogram / cladogram | the `layout` and `branchLengths` props |
| Truncate / Full names | `options.formatLabel` (28 characters and an ellipsis above 30, Reactree's rule) |
| **Search** (⌘F, count, ↑ ↓, Enter) | the `highlighted` prop for the matches and `focus` to centre the current one. A regular expression over the tip labels; every match is highlighted and counted |
| **Highlight style** (band / dim / both) | `options.highlightStyle`; `dim` is the default here (what does not match fades to `--phylo-dim-opacity`, the columns stay at full strength) |
| Midpoint, **Ladderize ↑ ↓ and by tips / depth / height** (one segmented group: ascending, descending, type) | tree-ops `midpointRoot`, `ladderise(t, { order, by })` |
| Reroot, Flip, Swap, Undo (⌘Z) | tree-ops `reroot`, `rotate`, `swap`; a history of trees, each edit a function returning a new tree. Colours, collapsed clades and the focus follow the tips (`followClades`, `remapFocus`) and the view stays (`treeMap`, the op's node map) |
| **Undo** (⌘Z) within a memory budget, **Reset** | tree-ops `treeBytes`: the trees kept between the one as published and the current one stay within `undoBudget` (64 MiB; `?undo-budget=<bytes>` on this page), the oldest dropped first. A tree larger than the budget has Reset only, with a note saying why. Reset and Undo keep the view through the edits' inverse maps (`invertMap`, `composeMaps`) |
| Color mode, 12 swatches, Erase, Clear all; **Colour…** in the menu | the `clades` prop (the innermost clade's colour wins). No label is set, so the legend names a clade by its node |
| **Bootstrap / Length / No labels**, **As percent** | `options.nodeLabels` (`'support'` reads `tree.support`, `'length'`) and `options.formatNodeLabel` (0.95 as 95; a support above 1 is left alone). The Carangaria MCC tree keeps its support as `[&posterior=…]`: `trees.json` sets `supportKey` and `trees.ts` parses it with `{ annotations: true }` and copies `supportFrom(tree, 'posterior')` into `tree.support` |
| **Align** (leaf labels in one column, or on one circle in the circular layout, with leader lines) | `options.alignLabels`; the leaders are `--phylo-leader-*` theme tokens |
| **Overview**, **Legend** | the viewer's `OverviewControl` and `Legend` controls from `defaultControls({ overview, legend })`; their look follows `--phylo-surface` and `--phylo-border`. The legend names the coloured clades |
| **Alignment** track and legend | an `alignment` column with `width: 'fill'` (the rest of the width) and `options.treeWidth: '40%'` while it is shown; the legend says how many tips have a sequence (exact label match) and draws its swatches from `residueColours` / `residueGroups` of the theme in force (`useTreeTheme`), so it matches the canvas |
| **Export**: PNG at 1×, 2×, 4×; Newick; NEXUS | `viewer.toBlob({ scale })` (the theme's background, the pane's grey, as on screen); `toNewick` / `toNexus` from `@gbif-phylo/io` |
| Tooltips ("Click for actions", "Set as root", "Paint Red", "1/2 Select first branch") | the `tooltip` prop rendering our own content, with `tooltipBare` so the viewer's box adds no chrome |
| Dark mode (`data-theme="dark"` on `<html>`) | the `--phylo-*` properties change with it; `options.themeObserver: 'document'` watches `class` and `data-theme` on `<html>` |
| Popover corners | one radius, `--ex-popover-radius`, for the toolbar menus, the inspector, the node menu, the colour palette, the search, the hover box and the toast; what sits inside one (menu items, close buttons) takes `calc(var(--ex-popover-radius) * 0.6)` |
| Pane background | `--phylo-background: var(--ex-surface-10)`: an opaque canvas in the pane's grey; no dotted grid. `dark` is derived from it |
| Hover ring that grows in (Reactree's) | `options.hoverAnimation` (on by default) and the theme's `--phylo-hover-ring-duration`; off when the system asks for reduced motion |
| Resize handle | the pane's height; the viewer follows its container |

### Large trees

Nothing is switched off on a large tree. Search highlights every match: on the 2.4 million tips of OTL the label scan takes about 0.1 s
and highlighting a million matches about 0.05 s plus a frame of under 30 ms (headless, `docs/design/highlight-cost.md`). Measurements of the whole-tree actions are in the CHANGELOG entry for #54.

## Notes

- **Where the look differs from Reactree.** The look is kept as its own tokens (`--ex-*`), not GBIF's, so that it stays recognisably this
  example's. The viewer still takes every colour from CSS custom properties. The palette and export menu sit inside the component, not
  portalled to `<body>`.
- **No vector export.** The viewer draws on a canvas, so the menu has PNG, Newick and NEXUS, not SVG or PDF.
- **Labels only where they fit.** The viewer shows labels only where they fit (`labelDensity`), so a 135-tip tree at the fitted view has none
  until you zoom in or raise Height ([#24](https://github.com/MortenHofft/gbif-phylo/issues/24)).
- **Undo** is a history of trees owned by this component, bounded by memory ([#44](https://github.com/MortenHofft/gbif-phylo/issues/44)): about 45 to 60 steps of a 10k-tip tree, two of the 190k-tip GTDB tree, Reset only from about a million tips (figures in [docs/design/undo-memory.md](../../docs/design/undo-memory.md)). Views are not in it: Show only, collapsing and collapse by support. Undo keeps the clade shown (it follows the tips through the inverse map).
- **Colour… is a palette, not a submenu.** `NodeMenuItem` is a flat list (`id`, `label`, `hint`, `disabled`, `onSelect`), so *Colour…* opens the
  explorer's own palette for that one clade, at the click, with focus in it.
- **Copy Newick** uses `navigator.clipboard`; without it (an insecure page) a hidden textarea and `execCommand('copy')`, and if that fails the Newick is downloaded as `clade.nwk`.
- **Toolbar width.** Two rows down to about 1250 px; narrower, a row scrolls sideways (Overview and Legend are icon-only).
