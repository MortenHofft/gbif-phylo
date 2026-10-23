// tree-ops: operations a user applies to a phylogenetic tree (reroot, midpoint root, ladderise, rotate, swap/reorder, collapse, prune,
// subtree), a clade focus with back / up one level (focus.ts), and an overview of the largest clades (auto-collapse.ts). Pure functions: input untouched, a new tree out. No rendering, React or DOM; see ../README.md.
export type { OpResult, TreeArrays, TreeInput } from './types.ts';
export { reroot, midpointRoot, type RerootOptions, type MidpointInfo } from './rooting.ts';
export { ladderise, reorder, rotate, swap, type LadderiseOptions } from './order.ts';
export { collapseBySupport, collapseShortBranches, type CollapseEdgesOptions, type KeepNodes } from './collapse.ts';
export { collapseClades, prune, subtree, type CollapseOptions, type CladeDepth } from './subset.ts';
export { autoCollapse, mergeAutoCollapse, type AutoCollapseOptions } from './auto-collapse.ts';
export { splitInternalLabel } from './labels.ts';
export { treeBytes } from './bytes.ts';
export { NO_FOCUS, canGoBack, canGoUp, focusBack, focusOn, focusUp, focusedNode, remapFocus, showFocus, type Focus } from './focus.ts';
export { followClade, followClades, invertMap, composeMaps, type FollowOptions, type Followed, type FollowedClade } from './follow.ts';
