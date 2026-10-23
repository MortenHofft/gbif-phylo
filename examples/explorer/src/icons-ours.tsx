// Icons drawn for this repository (not Reactree's: those are in icons.tsx under their own notice), in the same style: 14x14,
// round-capped strokes in `currentColor`. Apache-2.0 with the rest of the example.

import React from 'react';

const s = { stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

/** Show only this clade: a clade (the triangle) lifted out of a larger frame. */
export const IconSubtree = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M1.5 4.5v-3h3M9.5 1.5h3v3M12.5 9.5v3h-3M4.5 12.5h-3v-3" {...s} strokeWidth="1.3" />
    <path d="M4.5 7h2.5M7 7l2.5-2v4z" {...s} strokeWidth="1.2" />
  </svg>
);
/** Up one level: an arrow up out of a branch. */
export const IconUpLevel = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M7 12.5V2.5M3.5 6L7 2.5 10.5 6" {...s} strokeWidth="1.5" />
    <path d="M4 12.5h6" {...s} strokeWidth="1.3" />
  </svg>
);
/** Back: an arrow turning back. */
export const IconBack = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M5 3.5L2 6.5l3 3" {...s} strokeWidth="1.5" />
    <path d="M2.5 6.5h5.5a3.5 3.5 0 0 1 0 7H6" {...s} strokeWidth="1.5" />
  </svg>
);
/** Reset: back to the start, an arrow turning back to a bar. */
export const IconReset = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M2 2.5v9" {...s} strokeWidth="1.5" />
    <path d="M7.5 4L5 6.5 7.5 9" {...s} strokeWidth="1.5" />
    <path d="M5.5 6.5h3a3 3 0 0 1 0 6H7.5" {...s} strokeWidth="1.5" />
  </svg>
);
/** Collapse by support: a fork whose weak branches fold into one stem. */
export const IconSupport = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M1.5 7H5M5 7L8 3.5h4.5M5 7l3 3.5h4.5" {...s} strokeWidth="1.4" />
    <path d="M9.5 6.5v1M11.5 6.5v1" {...s} strokeWidth="1.2" />
  </svg>
);
/** Node information. */
export const IconInfo = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <circle cx="7" cy="7" r="5.5" {...s} strokeWidth="1.3" />
    <path d="M7 6.2v3.3M7 4.3v.1" {...s} strokeWidth="1.5" />
  </svg>
);
/** Overview: the whole tree in small with the window box. */
export const IconOverview = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" {...s} strokeWidth="1.3" />
    <path d="M3.5 4.5h3M3.5 7h4M3.5 9.5h2.5" {...s} strokeWidth="1.1" />
    <rect x="7.5" y="5" width="3.5" height="4.5" rx="0.8" {...s} strokeWidth="1.1" />
  </svg>
);
/** Legend: swatches with a line of text each. */
export const IconLegend = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <circle cx="3.2" cy="4" r="1.3" {...s} strokeWidth="1.2" />
    <circle cx="3.2" cy="10" r="1.3" {...s} strokeWidth="1.2" />
    <path d="M6.5 4h6M6.5 10h6" {...s} strokeWidth="1.4" />
  </svg>
);
/** Percent: support shown as 95 instead of 0.95. */
export const IconPercent = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M11.5 2.5l-9 9" {...s} strokeWidth="1.4" />
    <circle cx="3.9" cy="3.9" r="1.6" {...s} strokeWidth="1.3" />
    <circle cx="10.1" cy="10.1" r="1.6" {...s} strokeWidth="1.3" />
  </svg>
);
/** Highlight style: a marker over a line of text. */
export const IconHighlight = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M2 11.5h10" {...s} strokeWidth="1.3" />
    <path d="M4 9.5l.6-2.4 5-4.6 1.9 1.9-4.6 5z" {...s} strokeWidth="1.3" />
  </svg>
);
/** Ladderise: bars of growing length. Ascending puts the short bar (the smallest clade) at the top; descending is the same icon mirrored vertically. */
export const IconLadderBy = ({ descending = false }: { descending?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d={descending ? 'M2 3h10M2 7h6M2 11h3' : 'M2 3h3M2 7h6M2 11h10'} {...s} strokeWidth="1.6" />
  </svg>
);
/** Fit to view: four corners, the geometry of the viewer's built-in fit control (its `ICONS.fit`, which the viewer does not export). */
export const IconFit = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" {...s} strokeWidth="1.6" />
  </svg>
);
/** Overview of the largest clades: a tree whose branches end in collapsed clades (triangles). */
export const IconClades = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M1.5 7h2M3.5 3v8M3.5 3h3M3.5 11h3M3.5 7h3" {...s} strokeWidth="1.3" />
    <path d="M6.5 3l6-1.5v3zM6.5 7l5-1.2v2.4zM6.5 11l6-1.5v3z" {...s} strokeWidth="1.1" />
  </svg>
);
