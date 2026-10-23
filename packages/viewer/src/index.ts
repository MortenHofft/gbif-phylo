// Public surface of @gbif-phylo/viewer (no framework). Controls, overlays and column renderers have their own modules, re-exported here;
// a bundler keeps only what an app imports (the package has no side effects except its CSS files).
export { TreeViewer, type TreeViewerInit, type SetTreeOptions } from './viewer.ts';
export { type TreeEvent, type ViewerEventMap, type ViewerEventType, type Listener, type ListenOptions } from './events.ts';
export { computeLayout, type Layout } from './layout.ts';
export * from './types.ts';
export { type FontRelative, type TreeWidth } from './sizes.ts';
export { cut, searchCut, newCutResult, DrawList, Seen, type CutParams, type CutResult } from './lod.ts';
export { projectionFor, RectProjection, RadialProjection, type LayoutProjection } from './projection.ts';
export { HitIndex } from './hit.ts';
export { InMemorySource, isTreeSource, type TreeSource, type EnsureOptions } from './source.ts';
export { BaseControl, makeButton, type Control, type ControlOptions, type ControlPosition } from './control.ts';
export * from './controls/index.ts';
export * from './overlays/index.ts';
export { cladeName, internalName, namedDescendants, defaultFormatCollapsedLabel, type CladeLabelFn, type NamedDescendant } from './clade-name.ts';
export { internalSupport, defaultFormatNodeLabel, type NodeLabelFn, type NodeLabelsOption, type NodeLabelKind } from './node-label.ts';
export { themeFromCss, THEME_CSS_VARS } from './theme.ts';
export { residueColours, residueGroups, detectAlphabet, type Alphabet, type ResolvedAlphabet, type ResidueGroup } from './residues.ts';
