// Browser check of the explorer (examples/explorer; start it with `npm run dev` there, which serves on port 5309).
//   node tests/browser/scripts/check-explorer.mjs [--port 5309] [--url <page URL, default http://127.0.0.1:<port>/>]
// Every toolbar control is driven as a user would (clicks, the keyboard, the sliders) and its effect read back from the viewer
// (window.__explorer() returns the TreeViewer): Width / Height zoom the window and follow a wheel zoom, font and branch width reach the theme, layout and
// tree type the options, truncation the label format; search counts, highlights, steps and the highlight style; with no tool a
// click opens the node menu (each kind of node: tip, clade, collapsed clade from its branch, root; Escape closes it; a plain click collapses nothing; a
// click on a collapsed clade's triangle expands it)
// and Collapse, Expand and Info are its items; the tip Info is on stays selected across Layout and Phylo/Clado switches (#61); the node the menu is for keeps its ring with the pointer in the menu, and Swap marks its first pick until the second click or Escape (#65); colour, erase and the innermost-colour-wins order; reroot, flip, swap
// (siblings and not), midpoint, ladderise (by tips, depth, height) and undo (button and Ctrl+Z); undo within a memory budget
// (?undo-budget: the oldest step dropped first, Reset only for a tree larger than the budget, #44); show only a clade, Up one level
// and Back; collapse by support with a clade the user collapsed kept; export (PNG at 1x, 2x and 4x, Newick and NEXUS downloads);
// the opaque background (the pane's grey, no dotted grid) leaves no trace of earlier frames; the page font is a system-ui stack and the
// inspector's numbers are monospace; Export stays in view at 1024 px; the innermost clade colour wins whatever the order;
// node labels (support, length, support as percent); aligned labels (one x for the label anchors, a click on one opens the menu; in
// radial one distance from the root, toBlob equal to the screen); the alignment track (a 'fill' column) and its legend; the overview and legend controls; one action colour (--ex-primary) for active toggles, active tools and the hover box, in light and dark, and --ex-hover-tip for the box alone (#74); dark mode reaches
// the canvas; the resize handle; one tree from each group of the playground's catalogue, a large one included; the drill-down on GTDB 190k
// (#57: Overview: 50 clades, a click expands a collapsed clade in place, Show only jumps into one, Back returns).
/* global __v, __order, __tipAt, __clade, __inView, __stem -- helpers the page gets from HELPERS below, used inside page.evaluate */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromiumPath } from './chromium.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { PNG } = require('pngjs');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1]]] : a), []));
const port = Number(args.port || 5309);
const url = args.url || `http://127.0.0.1:${port}/`;
let failures = 0;
const ok = (c, m) => {
  console.log((c ? '  ok   ' : '  FAIL ') + m);
  if (!c) failures++;
};

const browser = await chromium.launch({ executablePath: chromiumPath(), headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
page.setDefaultTimeout(8000);
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  console.log('CONSOLE.ERROR', m.text().slice(0, 300));
  failures++;
});
page.on('pageerror', (e) => {
  console.log('PAGEERR', e.message);
  failures++;
});

// in-page helpers: the viewer, the tip order, where to click a tip or the first visible clade of a size
const HELPERS = () => {
  const v = () => window.__explorer();
  window.__v = v;
  window.__order = () => v().getTree().tipLabels.join(',');
  window.__tipAt = (label) => {
    const t = v().getTree();
    const r = t.tipLabels.indexOf(label);
    return r < 0 ? null : v().locateNode(t.tipNode[r]);
  };
  window.__clade = (lo, hi, skip = 0) => {
    const t = v().getTree();
    for (let i = 1; i < t.nodeCount; i++) {
      const c = t.leafEnd[i] - t.leafStart[i];
      if (v().layout.collapsed?.[i]) continue; // a collapsed clade is not a clade to collapse
      if (t.firstChild[i] >= 0 && c >= lo && c <= hi && skip-- <= 0) {
        const q = v().locateNode(i);
        if (q) return { node: i, tips: c, x: q.x, y: q.y };
      }
    }
    return null;
  };
  // a point on the branch into node n (rectangular): a click there is a 'branch' hit, which opens the menu of a collapsed clade
  window.__stem = (n) => {
    const t = v().getTree();
    const q = v().locateNode(n);
    const p = v().locateNode(t.parent[n]);
    return q && p ? { x: q.x - Math.min(4, (q.x - p.x) / 2), y: q.y } : null;
  };
};
const open = async (tree, extra = '') => {
  await page.goto(`${url}?tree=${tree}${extra}`);
  await page.waitForSelector('.ex-outer canvas', { timeout: 60000 });
  await page.waitForFunction(() => typeof window.__explorer === 'function' && window.__explorer() !== null);
  await page.evaluate(HELPERS);
  await page.waitForTimeout(400);
};
const ev = (fn, arg) => page.evaluate(fn, arg);
const click = async (p) => {
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
};
const btn = (text) => page.locator('.ex-outer button', { hasText: text }).first();
const toast = async () => ((await page.locator('.ex-toast').count()) ? page.locator('.ex-toast').innerText() : '');
// the viewer's node menu (the export menu has role=menu too)
const menu = page.locator('.phylo-node-menu[role=menu]');
const menuItems = async () => (await menu.locator('.phylo-node-menu__item').allInnerTexts()).map((t) => t.split('\n')[0]);
const openMenu = async (p) => {
  await page.mouse.click(p.x, p.y);
  await menu.waitFor({ timeout: 3000 });
};
const act = async (id) => {
  await menu.locator(`[data-action="${id}"]`).click();
  await page.waitForTimeout(250);
};
/** How many of 16 points on the circle of the theme radius `token` around node `n` (or the page point `n`) are inked on the overlay canvas
 *  (the rings' canvas): 12 or more is a ring. */
const ringHits = (n, token) =>
  ev(
    ([n, token]) => {
      const v = __v();
      const p = typeof n === 'number' ? v.locateNode(n) : n;
      if (!p) return 0;
      const top = v.treeElement.querySelectorAll('canvas')[1];
      const r = top.getBoundingClientRect();
      const k = top.width / r.width;
      const rad = v.getTheme()[token];
      const data = top.getContext('2d').getImageData(0, 0, top.width, top.height).data;
      let hits = 0;
      for (let a = 0; a < 16; a++) {
        const x = Math.round((p.x - r.left + rad * Math.cos((a * Math.PI) / 8)) * k);
        const y = Math.round((p.y - r.top + rad * Math.sin((a * Math.PI) / 8)) * k);
        if (data[(y * top.width + x) * 4 + 3] > 100) hits++;
      }
      return hits;
    },
    [n, token],
  );
/** Collapse the clade at p through the node menu, as a user does. */
const collapseAt = async (p) => {
  await openMenu(p);
  await act('collapse');
};

// ---------------------------------------------------------------- Carangaria (135 tips, dated)
// the axis label is canvas text: remember the last axis title drawn
await page.addInitScript(() => {
  const ft = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
    if (/^(time before tips|distance from root)/.test(String(text))) window.__axis = String(text);
    // node labels are the only text drawn with the 'bottom' baseline in the rectangular layout (the radial scale bar has it too)
    if (this.textBaseline === 'bottom') {
      (window.__nodeTexts ??= []).push(String(text));
      (window.__nodeTextAt ??= []).push({ text: String(text), x: rest[0], y: rest[1], align: this.textAlign });
    }
    return ft.call(this, text, ...rest);
  };
});

console.log('Carangaria MCC: view settings');
await open('rich-fish-carangaria-135');
ok((await page.locator('.ex-row').count()) === 2, 'two toolbar rows');
const span = () =>
  ev(() => {
    const p = __v().getViewport();
    return { w: p.x1 - p.x0, h: p.y1 - p.y0 };
  });
const fit = await span();
await page.locator('input[aria-label=Width]').fill('2');
await page.locator('input[aria-label=Height]').fill('2');
await page.waitForTimeout(150);
const z = await span();
ok(
  Math.abs(z.w / fit.w - 0.5) < 0.02 && Math.abs(z.h / fit.h - 0.5) < 0.02,
  `Width / Height 2× halve the window (${(z.w / fit.w).toFixed(3)}, ${(z.h / fit.h).toFixed(3)})`,
);
await page.locator('.ex-slider-val').nth(0).click();
await page.locator('.ex-slider-val').nth(1).click();
await page.waitForTimeout(150);
const back = await span();
ok(Math.abs(back.w - fit.w) < 1e-6 && Math.abs(back.h - fit.h) < 1e-6, 'clicking the values resets to the fitted window');
await page.locator('input[aria-label="Font size"]').fill('2');
await page.locator('input[aria-label="Branch width"]').fill('3');
await page.waitForTimeout(150);
const th = await ev(() => __v().getTheme());
ok(th.labelSize === 23 && th.branchWidth === 3, `font and branch width reach the theme (${th.labelSize}, ${th.branchWidth})`);
ok(th.supportColour !== '' && th.supportColour === th.lengthColour, `light: support and length labels share one colour (${th.supportColour})`);
{
  // one variable, --ex-node-label, sets both (#70)
  await ev(() => {
    document.documentElement.style.setProperty('--ex-node-label', 'rgb(1, 2, 3)');
    __v().refreshTheme();
  });
  await page.waitForTimeout(250);
  const t = await ev(() => __v().getTheme());
  ok(
    t.supportColour === t.lengthColour && /1, ?2, ?3|#010203/.test(t.supportColour),
    `--ex-node-label sets both label colours (${t.supportColour}, ${t.lengthColour})`,
  );
  await ev(() => {
    document.documentElement.style.removeProperty('--ex-node-label');
    __v().refreshTheme();
  });
  await page.waitForTimeout(250);
}
await page.locator('button[title=Circular]').click();
await page.waitForTimeout(150);
ok((await ev(() => __v().options.layout)) === 'radial', 'Circular: radial layout');
ok(
  (await page.locator('input[aria-label=Height]').count()) === 0 && (await page.locator('.ex-slider-label', { hasText: 'Size' }).count()) === 1,
  'radial: Size slider, no Height',
);
await page.locator('button[title=Rectangular]').click();
await page.locator('button[title^=Cladogram]').click();
await page.waitForTimeout(150);
ok((await ev(() => __v().options.layout)) === 'rectangular' && (await ev(() => __v().options.branchLengths)) === false, 'Rectangular, Cladogram');
await page.locator('button[title^=Phylogram]').click();
const longest = await ev(() =>
  __v()
    .getTree()
    .tipLabels.reduce((a, b) => (b.length > a.length ? b : a)),
);
ok((await ev((l) => __v().options.formatLabel(l), longest)).endsWith('…'), 'Truncate (on by default) shortens long names');
await btn('Truncate').click();
ok((await ev((l) => __v().options.formatLabel(l), longest)) === longest.replace(/_/g, ' '), 'Full names: the whole name');

console.log('opaque background, typography');
const paneBg = await ev(() => {
  const cs = getComputedStyle(document.querySelector('.ex-pane'));
  return { colour: cs.backgroundColor, image: cs.backgroundImage };
});
ok(paneBg.image === 'none', `no dot pattern on the pane (background-image: ${paneBg.image})`);
const themeBg = await ev(() => {
  const p = document.createElement('i');
  p.style.color = __v().getTheme().background;
  document.body.append(p);
  const c = getComputedStyle(p).color;
  p.remove();
  return c;
});
ok(themeBg === paneBg.colour && !/rgba|transparent/.test(themeBg), `the canvas background is the pane's grey, opaque (${themeBg})`);
ok(
  (await ev(() => getComputedStyle(document.querySelector('.ex-pane')).getPropertyValue('--phylo-dark'))) === '',
  'light: no --phylo-dark set by hand',
);
ok(
  await ev(
    () =>
      /system-ui/.test(getComputedStyle(document.body).fontFamily) &&
      /system-ui/.test(getComputedStyle(document.querySelector('.ex-outer')).fontFamily),
  ),
  'the page font is a system-ui stack',
);
ok(/system-ui/.test(await ev(() => __v().getTheme().fontFamily)), 'and so is the tree labels font (--phylo-font-family)');
// painted pixels (what differs from the background, the first pixel) after fitting, after zooming in and panning, and after fitting
// again: with frames drawn over each other the count grows
const painted = () =>
  ev(() => {
    __v().renderNow();
    const c = __v().treeElement.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 4; i < d.length; i += 4) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 6) n++;
    return n / (c.width * c.height); // the drawn share of the canvas
  });
const opaqueShare = () =>
  ev(() => {
    const c = __v().treeElement.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n / (c.width * c.height);
  });
await page.locator('.ex-btn[title="Fit tree"]').click();
await page.waitForTimeout(200);
const p0 = await painted();
const box = await page.locator('.phylo-tree').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -300);
await page.waitForTimeout(300);
{
  // the Width / Height sliders follow a zoom made on the tree itself (#31): they show the window against the fitted one
  const want = await ev(() => {
    const f = __v().fitViewport();
    const p = __v().getViewport();
    return { h: (f.x1 - f.x0) / (p.x1 - p.x0), v: (f.y1 - f.y0) / (p.y1 - p.y0) };
  });
  const shown = async (i) => parseFloat(await page.locator('.ex-slider-val').nth(i).innerText());
  const [sh, sv] = [await shown(0), await shown(1)];
  ok(
    Math.max(want.h, want.v) > 1.2 && Math.abs(sh - want.h) < 0.051 && Math.abs(sv - want.v) < 0.051,
    `Width / Height follow a wheel zoom (${sh}×, ${sv}× for a window ${want.h.toFixed(2)}× and ${want.v.toFixed(2)}× the fitted one)`,
  );
}
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 - 150, box.y + box.height / 2 - 100, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(300);
await page.locator('.ex-btn[title="Fit tree"]').click();
await page.waitForTimeout(300);
const p1 = await painted();
ok(p0 > 0 && p0 < 0.5, `the canvas is the background where nothing is drawn (${(p0 * 100).toFixed(1)}% drawn)`);
ok((await opaqueShare()) === 1, 'the canvas is opaque');
ok(Math.abs(p1 - p0) < 0.002, `no trace of earlier frames (${(p0 * 100).toFixed(2)}% painted before zoom and pan, ${(p1 * 100).toFixed(2)}% after)`);
// switching to a transparent background and back at run time (the viewer changes canvas)
// setTheme replaces the page's overrides (font, branch width): pass the theme in force, only the background changed
const themeNow = await ev(() => __v().getTheme());
await ev((t) => __v().setTheme({ ...t, background: 'transparent' }), themeNow);
const pClear = await ev(() => {
  __v().renderNow();
  const c = __v().treeElement.querySelector('canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n / (c.width * c.height);
});
await ev((t) => __v().setTheme(t), themeNow);
const pBack = await painted();
ok(
  pClear < 0.5 && Math.abs(pBack - p0) < 0.002 && (await opaqueShare()) === 1,
  `transparent background at run time, then opaque again (${(pClear * 100).toFixed(1)}% painted, ${(pBack * 100).toFixed(2)}% drawn)`,
);
// the renderer outlives edits now, so the theme set by hand above would stay: give the page's own overrides back (the font size slider
// sets them again)
await page.locator('input[aria-label="Font size"]').fill('1.5');
await page.locator('input[aria-label="Font size"]').fill('2');
await page.waitForTimeout(150);

console.log('search');
// how much the main canvas differs from its background colour: dimming what does not match removes most of it
const ink = () =>
  ev(() => {
    const c = __v().treeElement.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 4; i < d.length; i += 4) n += Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]);
    return n;
  });
const inkBefore = await ink();
await page.locator('button[aria-label="Search tips"]').click();
await page.keyboard.type('bothus');
await page.waitForTimeout(200);
ok((await ev(() => __v().options.highlightStyle)) === 'dim', 'search uses the dim highlight style');
const inkDim = await ink();
ok(inkDim < inkBefore * 0.6, `the tips that do not match are dimmed (canvas ink ${inkBefore} → ${inkDim})`);
ok((await page.locator('.ex-search-count').innerText()) === '1 / 2', 'two matches, the first current');
ok((await ev(() => __v().getHighlighted().length)) === 2, 'matches highlighted');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
ok((await page.locator('.ex-search-count').innerText()) === '2 / 2', 'Enter: next match');
const cur = await ev(() => __v().getHighlighted()[1]); // a node id: the matches are tips, not labels
const vp = await ev(() => __v().getViewport());
const rank = await ev((n) => __v().getTree().tipRank[n], cur);
ok(rank >= vp.y0 && rank <= vp.y1, 'the current match is in view');
await page.keyboard.press('Escape');
ok(
  (await page.locator('.ex-search').count()) === 0 && (await ev(() => __v().getHighlighted().length)) === 0,
  'Escape closes the search and clears the highlight',
);
await page.locator('.ex-btn[title="Fit tree"]').click();
await page.waitForTimeout(300);
ok(Math.abs((await ink()) - inkBefore) < inkBefore * 0.05, 'and the tree is back at full strength after the search');

console.log('node menu, inspector, collapse, expand');
const tip0 = await ev(() => __v().getTree().tipLabels[3]);
await page.locator('input[aria-label=Height]').fill('4');
await page.waitForTimeout(200);
await page.locator('.ex-btn[title="Fit tree"]').click();
await page.locator('.ex-slider-val').nth(1).click();
await page.waitForTimeout(200);
// the hover box says what a click does
await page.mouse.move(...Object.values(await ev((l) => __tipAt(l), tip0)));
await page.waitForTimeout(250);
ok((await page.locator('.phylo-tooltip').innerText()).includes('Click for actions'), 'the hover box says "Click for actions"');
// a tip: Info, Reroot here, Swap with…, Colour…
await openMenu(await ev((l) => __tipAt(l), tip0));
ok((await menuItems()).join('|') === 'Info|Reroot here|Swap with…|Colour…', `a tip's menu: ${(await menuItems()).join(' | ')}`);
await act('info');
ok(
  (await page.locator('.ex-info-name').count()) === 1 && (await page.locator('.ex-info-name').innerText()) === tip0.replace(/_/g, ' '),
  'Info opens the inspector',
);
ok((await page.locator('.ex-info-rows dt', { hasText: 'Root distance' }).count()) === 1, 'inspector: root distance');
const infoFonts = await ev(() => [...document.querySelectorAll('.ex-info-rows dd')].map((d) => getComputedStyle(d).fontFamily));
ok(
  infoFonts.length >= 2 && infoFonts.every((f) => /ui-monospace|monospace/.test(f)),
  `the inspector's numbers are monospace (${infoFonts.length} values)`,
);
ok(/system-ui/.test(await ev(() => getComputedStyle(document.querySelector('.ex-info-rows dt')).fontFamily)), 'and its labels are the page font');
ok(
  await ev(() =>
    [...document.querySelectorAll('.ex-info, .ex-outer .ex-row')].every((el) =>
      [...el.querySelectorAll('*')].every((n) => Number(getComputedStyle(n).fontWeight) < 700),
    ),
  ),
  'nothing in the inspector or toolbar is bolder than 600',
);
// the selection (#61): the tip Info was opened on is selected, and it stays across Layout and Phylo/Clado switches, centred in view with its ring
{
  const id = await ev((l) => __v().tipNode(l), tip0);
  ok((await ev(() => __v().getSelected())) === id, "the clicked tip is the viewer's selection");
  // the ring: some pixel of the overlay canvas on the circle of selectionRadius around the tip
  const ring = () =>
    ev((n) => {
      const v = __v();
      const p = v.locateNode(n);
      if (!p) return { inView: false, ring: false };
      const top = v.treeElement.querySelectorAll('canvas')[1];
      const r = top.getBoundingClientRect();
      const k = top.width / r.width;
      const rad = v.getTheme().selectionRadius;
      const data = top.getContext('2d').getImageData(0, 0, top.width, top.height).data;
      let hits = 0;
      for (let a = 0; a < 16; a++) {
        const x = Math.round((p.x - r.left + rad * Math.cos((a * Math.PI) / 8)) * k);
        const y = Math.round((p.y - r.top + rad * Math.sin((a * Math.PI) / 8)) * k);
        if (data[(y * top.width + x) * 4 + 3] > 100) hits++;
      }
      const pane = v.treeElement.getBoundingClientRect();
      return { inView: true, ring: hits >= 12, dx: (p.x - pane.left) / pane.width, dy: (p.y - pane.top) / pane.height };
    }, id);
  const keeps = async (what) => {
    await page.waitForTimeout(300);
    const r = await ring();
    const name = (await page.locator('.ex-info-name').count()) ? await page.locator('.ex-info-name').innerText() : '';
    ok(
      (await ev(() => __v().getSelected())) === id && name === tip0.replace(/_/g, ' ') && r.inView && r.ring,
      `${what}: the inspector still shows the tip, which is in view (at ${r.dx?.toFixed(2)}, ${r.dy?.toFixed(2)} of the pane) with its ring`,
    );
  };
  await keeps('selected');
  await page.locator('button[title=Circular]').click();
  await keeps('Circular');
  const c = await ring();
  ok(Math.abs(c.dx - 0.5) < 0.05 && Math.abs(c.dy - 0.5) < 0.05, 'Circular: the view is centred on the selected tip');
  await page.locator('button[title=Rectangular]').click();
  await keeps('back to Rectangular');
  await page.locator('button[title^=Cladogram]').click();
  await keeps('Cladogram');
  await page.locator('button[title^=Phylogram]').click();
  await keeps('back to Phylogram');
  await page.locator('.ex-btn[title="Fit tree"]').click();
  await page.waitForTimeout(200);
}
await page.locator('.ex-info-head button').click();
await ev(() => __v().setSelected(null));
ok((await page.locator('.ex-info').count()) === 0, 'closing the inspector');
// a clade: Info, Collapse, Show only, Reroot here, Flip, Swap with…, Colour…, Copy Newick
const rows = () => ev(() => __v().layout.rows);
const before = await rows();
const tips = await ev(() => __v().getTree().tipCount);
const c1 = await ev(() => __clade(4, 10));
await openMenu(c1);
ok(
  (await menuItems()).join('|') === 'Info|Collapse|Show only|Reroot here|Flip|Swap with…|Colour…|Copy Newick',
  `a clade's menu: ${(await menuItems()).join(' | ')}`,
);
ok((await rows()) === before, 'a plain click on a clade collapses nothing (it opens the menu)');
// one line per item, no descriptions; a header with the name, a close button and a line under it (#68)
ok(
  (await menu.locator('.phylo-node-menu__hint').count()) === 0 &&
    (await menu.locator('.phylo-node-menu__item').allInnerTexts()).every((t) => !t.trim().includes('\n')),
  'the menu items are single lines, with no descriptions',
);
{
  const head = await ev(() => {
    const h = document.querySelector('.phylo-node-menu__head');
    const s = getComputedStyle(h);
    return {
      title: h.querySelector('.phylo-node-menu__title')?.textContent,
      close: h.querySelectorAll('.phylo-node-menu__close').length,
      line: s.borderBottomWidth,
    };
  });
  ok(
    head.title === `Clade, ${c1.tips} tips` && head.close === 1 && head.line === '1px',
    `the menu header: name, close button, a line under it (${JSON.stringify(head)})`,
  );
}
// the node the menu is for keeps a ring while the pointer is in the menu (#65): it is selected, and the selection ring stays
{
  const item = await menu.locator('.phylo-node-menu__item').nth(2).boundingBox();
  await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2, { steps: 4 });
  await page.waitForTimeout(250);
  const hits = await ringHits(c1.node, 'selectionRadius');
  ok(
    (await menu.count()) === 1 && (await ev(() => __v().getSelected())) === c1.node && hits >= 12,
    `with the pointer in the menu, the clade it is for keeps its ring (${hits} of 16 points)`,
  );
}
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
ok((await menu.count()) === 0 && (await rows()) === before, 'Escape closes the menu');
await openMenu(c1);
await menu.locator('.phylo-node-menu__close').click();
await page.waitForTimeout(150);
ok(
  (await menu.count()) === 0 && (await rows()) === before && (await page.locator('.ex-info').count()) === 0,
  'the close button closes the menu, and does nothing else',
);
await openMenu(c1);
await page.mouse.click(8, 8);
await page.waitForTimeout(150);
ok((await menu.count()) === 0 && (await rows()) === before, 'a click outside closes the menu');
// the keyboard: the tree's cursor and Enter open the same menu
await page.locator('.phylo-tree').focus();
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.waitForTimeout(200);
ok((await menu.count()) === 1 && (await menuItems()).includes('Info'), 'Enter on the keyboard cursor opens the node menu');
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
// collapsing is the viewer's: the tree is the same object with the same tips, and the collapsed clade is one row
await collapseAt(c1);
const after = await rows();
ok(after === before - c1.tips + 1, `Collapse in the menu collapses the clade (${before} → ${after} rows)`);
ok((await ev(() => __v().getTree().tipCount)) === tips, 'and the tree still has all its tips');
ok((await btn('Expand all').count()) === 1 && (await page.locator('.ex-expand .ex-count').innerText()) === '1', 'Expand all appears with the count');
const tri = await ev((n) => {
  const b = __v().nodeBounds(n);
  return b ? { x: b.x + b.width * 0.8, y: b.y + b.height / 2 } : null;
}, c1.node);
ok(tri !== null, 'the collapsed clade is one triangle with the id of the clade');
// a click on the triangle expands it (drill-down, #57): no menu; a clade this small opens whole
await click(tri);
ok((await menu.count()) === 0 && (await rows()) === before && (await btn('Expand all').count()) === 0, 'a click on a collapsed clade expands it');
await collapseAt(c1);
// a collapsed clade's menu, from a click on its branch: Expand, Info, Show only, Colour…
await openMenu(await ev((n) => __stem(n), c1.node));
ok((await menuItems()).join('|') === 'Expand|Info|Show only|Colour…', `a collapsed clade's menu: ${(await menuItems()).join(' | ')}`);
await act('expand');
ok((await rows()) === before && (await btn('Expand all').count()) === 0, 'Expand in the menu opens it again');
await collapseAt(await ev(() => __clade(4, 10)));
await collapseAt(await ev(() => __clade(4, 10, 3)));
await collapseAt(await ev(() => __clade(2, 2)));
await collapseAt(await ev(() => __clade(2, 2, 2)));
const labs = await ev(() => __v().getTree().tipLabels);
ok(new Set(labs).size === labs.length && labs.length === tips, 'four collapsed clades: no tip label is made up, tip labels are still unique');
ok((await rows()) < before - 4, `four collapsed clades are four rows (${await rows()} of ${before})`);
await btn('Expand all').click();
await page.waitForTimeout(150);
ok((await rows()) === before, 'Expand all');
// the root: Info, Flip, Colour… (no Reroot, no Swap)
await openMenu(
  await ev(() => {
    const q = __v().locateNode(0);
    return { x: q.x, y: q.y };
  }),
);
ok((await menuItems()).join('|') === 'Info|Flip|Colour…', `the root's menu: ${(await menuItems()).join(' | ')}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
// Swap with… starts Swap mode with this node picked: the next click is the second branch
{
  const pr = await ev(() => {
    const t = __v().getTree();
    for (let i = 1; i < t.nodeCount; i++)
      if (t.childCount[i] === 2) {
        const a = t.firstChild[i];
        const b = t.nextSibling[a];
        const qa = __v().locateNode(a);
        const qb = __v().locateNode(b);
        if (qa && qb)
          return [
            { x: qa.x, y: qa.y, node: a },
            { x: qb.x, y: qb.y, node: b },
          ];
      }
    return null;
  });
  const o = await ev(() => __order());
  await openMenu(pr[0]);
  await act('swap');
  ok(
    (await page.locator('.ex-tool.active', { hasText: 'Swap' }).count()) === 1 && (await page.locator('.ex-steps .done').count()) === 1,
    'Swap with… starts Swap mode with step 1 done',
  );
  ok((await toast()).includes('click a sibling'), `and says what to do next, which the item no longer does (${await toast()})`);
  // the first pick keeps its mark (#65) while the pointer goes to the second, whose hover ring shows too
  await page.mouse.move(pr[1].x, pr[1].y, { steps: 6 });
  await page.waitForTimeout(250);
  const marked = await ringHits(pr[0].node, 'markRadius');
  ok(
    JSON.stringify(await ev(() => __v().getMarked())) === JSON.stringify([pr[0].node]) && marked >= 12,
    `Swap: the first pick is marked while the pointer is on the second (${marked} of 16 points)`,
  );
  await click(pr[1]);
  await page.waitForTimeout(200);
  ok((await ev(() => __order())) !== o && (await menu.count()) === 0, 'the next click swaps the two siblings, and no menu opens in a mode');
  const left = await ringHits({ x: pr[0].x, y: pr[0].y }, 'markRadius');
  ok((await ev(() => __v().getMarked().length)) === 0 && left < 4, `and the mark is cleared (${left} of 16 points inked)`);
  await page.keyboard.press('Escape');
  await btn('Undo').click();
  await page.waitForTimeout(200);
  ok((await ev(() => __order())) === o, 'Undo');
}
// Colour… offers the palette for this clade
await openMenu(await ev(() => __clade(4, 10)));
await act('colour');
ok((await page.locator('.ex-palette[aria-label="Colour this clade"] .ex-swatch').count()) === 12, 'Colour… opens a palette of 12 swatches');
await page.locator('.ex-palette button[aria-label=Violet]').click();
ok(
  (await ev(() => __v().getClades().length)) === 1 && (await page.locator('.ex-palette').count()) === 0,
  'a swatch colours the clade and closes the palette',
);
await openMenu(await ev(() => __clade(4, 10)));
await act('colour');
await page.locator('.ex-palette .ex-erase').click();
ok((await ev(() => __v().getClades().length)) === 0, 'Erase in it removes the colour');
// Copy Newick
await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
await openMenu(await ev(() => __clade(4, 10)));
await act('copy');
{
  const copied = await ev(() => navigator.clipboard.readText());
  ok(copied.startsWith('(') && copied.trim().endsWith(';'), `Copy Newick puts the clade's Newick on the clipboard (${copied.length} characters)`);
  ok((await toast()).startsWith('Copied'), 'and says so');
}
await ev(() => __v().fit(false));
await page.waitForTimeout(200);

// the tree is dated and the triangle ends at the clade's tips, so the axis keeps its title ("time before tips", the viewer reads the
// tree as it is; collapsing a copy with tree-ops collapseClades flipped it to "distance from root" without { extend }, issue #19)
{
  const axis = () => ev(() => window.__axis);
  ok(/^time before tips/.test(await axis()), `dated tree: axis "${await axis()}"`);
  await ev(() => (window.__axis = null)); // a stale title must not pass
  // zoomed in on y: collapsing keeps the window's scale (it used to re-create the viewer and fit again)
  await page.locator('input[aria-label=Height]').fill('3');
  await page.waitForTimeout(150);
  const z0 = await span();
  await collapseAt(await ev(() => __clade(4, 10)));
  await page.waitForTimeout(200);
  ok((await rows()) < before, 'a clade is collapsed');
  const z1 = await span();
  ok(
    Math.abs(z1.h - z0.h) < 1e-9 && Math.abs(z1.w - z0.w) < 1e-9,
    `collapsing does not reset the zoom (${z0.h.toFixed(1)} rows in view before, ${z1.h.toFixed(1)} after)`,
  );
  ok(/^time before tips/.test(await axis()), `after a collapse the axis stays: "${await axis()}"`);
  await btn('Expand all').click();
  await page.locator('.ex-slider-val').nth(1).click();
  await page.waitForTimeout(150);
}

console.log('colour');
await btn('Color').click();
ok((await page.locator('.ex-palette .ex-swatch').count()) === 12, 'palette with 12 swatches');
await page.locator('button[aria-label=Pink]').click();
const big = await ev(() => __clade(20, 40));
await click(big);
await page.locator('button[aria-label=Teal]').click();
const small = await ev(
  ({ lo, hi }) => {
    const t = __v().getTree();
    for (let i = lo + 1; i < hi; i++) {
      const c = t.leafEnd[i] - t.leafStart[i];
      if (t.firstChild[i] >= 0 && c >= 3) {
        const q = __v().locateNode(i);
        if (q) return { node: i, x: q.x, y: q.y };
      }
    }
    return null;
  },
  { lo: big.node, hi: await ev((n) => __v().getTree().subtreeEnd[n], big.node) },
);
await click(small);
let cl = await ev(() => __v().getClades());
ok(cl.length === 2 && cl[0].node === big.node && cl[1].node === small.node, 'two nested clades coloured');
// which colour the canvas shows just right of the inner clade's node (its branches): pixels near teal versus near pink
const inner = () =>
  ev((p) => {
    const c = __v().treeElement.querySelector('canvas');
    const b = c.getBoundingClientRect();
    const k = c.width / b.width;
    const d = c
      .getContext('2d')
      .getImageData(Math.round((p.x - b.left) * k), Math.round((p.y - b.top - 6) * k), Math.round(10 * k), Math.round(12 * k)).data;
    const near = (i, [r, g, bb]) => Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - bb) < 90 && d[i + 3] > 200;
    let teal = 0;
    let pink = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (near(i, [20, 184, 166])) teal++;
      if (near(i, [236, 72, 153])) pink++;
    }
    return { teal, pink };
  }, small);
let px = await inner();
ok(px.teal > 0 && px.teal > px.pink, `the inner colour shows (teal ${px.teal}, pink ${px.pink})`);
await page.locator('.ex-erase').click();
await click(small);
cl = await ev(() => __v().getClades());
ok(cl.length === 1 && cl[0].node === big.node, 'Erase removes a clade colour');
// the other order: outer clade painted after the inner one, and still the innermost wins (the viewer, not the order)
await click(big);
await page.locator('button[aria-label=Teal]').click();
await click(small);
await page.locator('button[aria-label=Pink]').click();
await click(big);
cl = await ev(() => __v().getClades());
ok(cl.length === 2 && cl[0].node === small.node && cl[1].node === big.node, 'inner clade first, outer last');
px = await inner();
ok(px.teal > 0 && px.teal > px.pink, `the innermost colour still wins (teal ${px.teal}, pink ${px.pink})`);
await page.locator('.ex-erase').click();
await click(small);
await page.locator('.ex-outer').press('Escape');
ok((await page.locator('.ex-palette').count()) === 0, 'Escape leaves colour mode');
ok((await page.locator('.ex-color .ex-count').innerText()) === '1', 'Color shows the count');

console.log('tree operations');
// the earlier steps moved the view and an edit keeps it now: start from the whole tree
await page.locator('.ex-btn[title="Fit tree"]').click();
await page.waitForTimeout(200);
const o0 = await ev(() => __order());
await btn('Reroot').click();
const rt = await ev(() => __v().getTree().tipLabels[5]);
await click(await ev((l) => __tipAt(l), rt));
await page.waitForTimeout(200);
ok((await ev(() => __order())) !== o0 && (await btn('Undo').count()) === 1, 'reroot on a tip changes the tree, Undo appears');
await page.locator('.ex-outer').press('Escape');
await btn('Undo').click();
await page.waitForTimeout(200);
ok((await ev(() => __order())) === o0 && (await btn('Undo').count()) === 0, 'Undo restores the tree');
ok((await ev(() => __v().getClades().length)) === 1, 'and the colour');
await btn('Flip').click();
const f = await ev(() => __clade(2, 6));
await click(f);
await page.waitForTimeout(200);
const o1 = await ev(() => __order());
ok(o1 !== o0, 'Flip reverses a clade');
await page.keyboard.press('Escape');
await page.locator('.phylo-tree').focus();
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
ok((await ev(() => __order())) === o0, 'Ctrl+Z undoes');
// a new tree keeps the renderer and the view: zoom into a clade, Flip a clade inside it, and the same tips are in view; Undo returns to the same view
console.log('a new tree keeps the view');
const zoomed = await ev(() => {
  const t = __v().getTree();
  let big = null;
  for (let i = 1; i < t.nodeCount; i++) {
    const c = t.leafEnd[i] - t.leafStart[i];
    if (t.firstChild[i] >= 0 && c >= 30 && c <= 60) {
      big = i;
      break;
    }
  }
  window.__viewer = __v();
  window.__inView = () => {
    const t = __v().getTree();
    const w = __v().getViewport();
    return t.tipLabels
      .filter((_, r) => r + 0.5 >= w.y0 && r + 0.5 <= w.y1)
      .sort()
      .join(',');
  };
  __v().zoomToNode(big, false);
  return big !== null;
});
await page.waitForTimeout(300);
ok(zoomed, 'zoomed into a clade of 30 to 60 tips');
const vw0 = await ev(() => __v().getViewport());
const seen0 = await ev(() => __inView());
ok(
  vw0.y1 - vw0.y0 < 100 && seen0.split(',').length >= 30,
  `the view is a part of the tree (${vw0.y0.toFixed(1)} to ${vw0.y1.toFixed(1)}, ${seen0.split(',').length} tips)`,
);
const orderZ = await ev(() => __order());
await btn('Flip').click();
await click(await ev(() => __clade(4, 12)));
await page.waitForTimeout(300);
ok((await ev(() => __order())) !== orderZ, 'Flip reversed a clade inside the view');
ok(await ev(() => __v() === window.__viewer && !__v().isDestroyed()), 'the edit went to the same renderer (no new one)');
ok((await ev(() => __inView())) === seen0, 'the same tips are still in view after the Flip');
const vw1 = await ev(() => __v().getViewport());
ok(Math.abs(vw1.y1 - vw1.y0 - (vw0.y1 - vw0.y0)) < 1e-6, 'at the same scale');
await page.keyboard.press('Escape');
await btn('Undo').click();
await page.waitForTimeout(300);
const vw2 = await ev(() => __v().getViewport());
ok(
  (await ev(() => __order())) === orderZ && ['x0', 'x1', 'y0', 'y1'].every((k) => Math.abs(vw2[k] - vw0[k]) < 1e-6),
  'Undo returns the tree and the same view',
);
ok(await ev(() => __v() === window.__viewer), 'and still the same renderer');
await page.locator('.ex-btn[title="Fit tree"]').click();
await page.waitForTimeout(200);
// swap: the two children of a binary node, then two tips that are not siblings
const pair = await ev(() => {
  const t = __v().getTree();
  for (let i = 1; i < t.nodeCount; i++)
    if (t.childCount[i] === 2) {
      const a = t.firstChild[i];
      const b = t.nextSibling[a];
      const qa = __v().locateNode(a);
      const qb = __v().locateNode(b);
      if (qa && qb) return [qa, qb];
    }
  return null;
});
await btn('Swap').click();
await click(pair[0]);
ok((await page.locator('.ex-steps .done').count()) === 1, 'Swap: step 1 done');
await click(pair[1]);
await page.waitForTimeout(200);
ok((await ev(() => __order())) !== o0, 'Swap of two siblings');
const tl = await ev(() => __v().getTree().tipLabels);
await click(await ev((l) => __tipAt(l), tl[0]));
await click(await ev((l) => __tipAt(l), tl[tl.length - 1]));
ok((await toast()).includes('sibling'), 'Swap of non-siblings is refused with a message');
await click(await ev((l) => __tipAt(l), tl[0]));
ok((await ev(() => __v().getMarked().length)) === 1, 'Swap tool: the first pick is marked');
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
ok((await ev(() => __v().getMarked().length)) === 0, 'Escape leaves Swap and clears the mark');
await btn('Midpoint').click();
ok((await toast()).includes('nothing to change'), 'Midpoint on a dated tree: nothing to change');
const o2 = await ev(() => __order());
await page.locator('button[title^="Ladderize descending"]').click();
await page.waitForTimeout(150);
const o3 = await ev(() => __order());
await page.locator('button[title^="Ladderize ascending"]').click();
await page.waitForTimeout(150);
ok(o3 !== o2 && (await ev(() => __order())) !== o3, 'Ladderize both ways');

console.log('export');
await btn('Export').click();
ok(
  (await page.locator('.ex-menu button').allInnerTexts()).map((s) => s.split('\n')[0]).join(',') === 'PNG 1×,PNG 2×,PNG 4×,Newick,NEXUS',
  'menu: PNG 1×, 2×, 4×, Newick, NEXUS',
);
const pngSize = await ev(() => ({ w: __v().size.width, h: __v().size.height }));
const download = async (label) => {
  if ((await page.locator('.ex-menu').count()) === 0) await btn('Export').click();
  const dl = page.waitForEvent('download');
  await page.locator('.ex-menu button', { hasText: label }).click();
  const d = await dl;
  return { name: d.suggestedFilename(), data: Buffer.concat(await (await d.createReadStream()).toArray()) };
};
const png1 = await download('PNG 1×');
ok(png1.name === 'phylotree.png' && png1.data.subarray(1, 4).toString() === 'PNG', 'PNG 1× download');
const img = PNG.sync.read(png1.data);
ok(img.data[3] === 255, 'the PNG is opaque');
ok(
  `rgb(${img.data[0]}, ${img.data[1]}, ${img.data[2]})` === paneBg.colour,
  `the PNG's background is the pane's grey, with no background passed to toBlob (${img.data[0]}, ${img.data[1]}, ${img.data[2]})`,
);
ok(img.width === Math.round(pngSize.w) && img.height === Math.round(pngSize.h), `PNG 1× is the view's CSS size (${img.width} x ${img.height})`);
const p2 = await download('PNG 2×');
const img2 = PNG.sync.read(p2.data);
ok(
  p2.name === 'phylotree@2x.png' && img2.width === img.width * 2 && img2.height === img.height * 2,
  `PNG 2× is double the size (${img2.width} x ${img2.height} against ${img.width} x ${img.height})`,
);
const p4 = await download('PNG 4×');
const img4 = PNG.sync.read(p4.data);
ok(img4.width === img.width * 4 && img4.height === img.height * 4, `PNG 4× is four times the size (${img4.width} x ${img4.height})`);
const screenVsBlob = () =>
  ev(async () => {
    // the export equals the screen: the visible canvas against toBlob (the theme's background by default) at the canvas scale, pixel by pixel
    const v = __v();
    v.renderNow();
    const screen = v.treeElement.querySelector('canvas');
    const bm = await createImageBitmap(await v.toBlob());
    const read = (src) => {
      const c = document.createElement('canvas');
      c.width = screen.width;
      c.height = screen.height;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(src, 0, 0);
      return x.getImageData(0, 0, c.width, c.height).data;
    };
    const A = read(screen),
      B = read(bm);
    let diff = 0,
      painted = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (Math.abs(A[i] - A[0]) + Math.abs(A[i + 1] - A[1]) + Math.abs(A[i + 2] - A[2]) > 6) painted++;
      if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) + Math.abs(A[i + 3] - B[i + 3]) > 2) diff++;
    }
    return { w: bm.width === screen.width && bm.height === screen.height, diff, painted };
  });
const same = await screenVsBlob();
ok(
  same.w && same.painted > 500 && same.diff === 0,
  `toBlob at the canvas scale equals the screen (${same.painted} painted pixels, ${same.diff} differ)`,
);
const exp2 = await ev(async () => {
  const b = await __v().toBlob({ scale: 2, background: null });
  const bm = await createImageBitmap(b);
  const c = document.createElement('canvas');
  c.width = bm.width;
  c.height = bm.height;
  const x = c.getContext('2d');
  x.drawImage(bm, 0, 0);
  const d = x.getImageData(0, 0, 1, 1).data;
  return { type: b.type, w: bm.width, h: bm.height, corner: d[3], W: __v().size.width, H: __v().size.height };
});
ok(exp2.type === 'image/png' && exp2.w === exp2.W * 2 && exp2.h === exp2.H * 2, `toBlob({ scale: 2 }) is twice the CSS size (${exp2.w} x ${exp2.h})`);
ok(exp2.corner === 0, 'toBlob({ background: null }) is still transparent');
ok(
  await ev(() => {
    const el = document.querySelector('.phylo-tooltip');
    const cs = getComputedStyle(el);
    return el.classList.contains('phylo-tooltip--bare') && cs.paddingTop === '0px' && cs.boxShadow === 'none' && cs.borderTopStyle === 'none';
  }),
  'the tooltip box is bare (tooltipBare): no padding, border or shadow, and no CSS override in the example',
);
const nwk = (await download('Newick')).data.toString();
ok(nwk.startsWith('(') && nwk.trim().endsWith(';') && nwk.includes(tl[0]), 'Newick download of the current tree');
const nexDl = await download('NEXUS');
const nex = nexDl.data.toString();
ok(
  nexDl.name === 'phylotree.nex' && nex.startsWith('#NEXUS') && nex.includes('TRANSLATE') && nex.includes(`NTAX=${tl.length};`),
  'NEXUS download: taxa block, translate table and tree',
);

console.log('dark mode, resize');
const fg = await ev(() => __v().getTheme().branch);
await page.locator('.theme-toggle').click();
await page.waitForTimeout(200);
const fg2 = await ev(() => __v().getTheme().branch);
ok(fg2 !== fg, `dark mode reaches the canvas (branches ${fg} → ${fg2})`);
ok(await ev(() => __v().getTheme().dark === true), 'dark is derived from the opaque dark background (no --phylo-dark by hand)');
{
  const t = await ev(() => __v().getTheme());
  ok(t.supportColour !== '' && t.supportColour === t.lengthColour, `dark: support and length labels share one colour (${t.supportColour})`);
}
const h0 = (await page.locator('.ex-pane').boundingBox()).height;
const g = await page.locator('.ex-resize').boundingBox();
await page.mouse.move(g.x + g.width / 2, g.y + 7);
await page.mouse.down();
await page.mouse.move(g.x + g.width / 2, g.y + 107, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(300);
ok(Math.abs((await page.locator('.ex-pane').boundingBox()).height - h0 - 100) < 2, 'the resize handle makes the pane taller');
ok(Math.abs((await ev(() => __v().size.height)) - h0 - 100) < 2, 'and the viewer follows');

// ---------------------------------------------------------------- support values, node labels
// the viewer draws them on the canvas (the `nodeLabels` option): read the node label texts of a fresh frame off fillText
console.log('node labels');
const drawn = async () => {
  await ev(() => {
    window.__nodeTexts = [];
    window.__nodeTextAt = [];
    __v().invalidate();
    __v().renderNow();
  });
  return ev(() => window.__nodeTexts);
};
await open('edge-internal-support');
await btn('No labels').click();
await page.waitForTimeout(200);
ok((await ev(() => __v().options.nodeLabels)) === 'support', "Bootstrap sets nodeLabels to 'support' (no control of our own any more)");
let labels = await drawn();
ok(labels.includes('100') && labels.includes('0.95'), `Bootstrap: support values drawn (${labels.join(' ')})`);
ok(labels.length === 2, 'only the two numeric support values; node_EF and the root get none');
await btn('Bootstrap').click();
await page.waitForTimeout(200);
ok((await ev(() => __v().options.nodeLabels)) === 'length', 'Length sets nodeLabels to length');
labels = await drawn();
ok(labels.includes('0.3') && labels.includes('0.4') && labels.includes('0.1'), `Length: branch lengths drawn (${labels.join(' ')})`);
await btn('Length').click();
await page.waitForTimeout(200);
ok((await drawn()).length === 0 && (await ev(() => __v().options.nodeLabels)) === 'none', 'No labels');
// lengths on the HCV tree: every label is the length of a node, and the long tip branches have theirs (#66)
await open('rich-hcv-19');
for (let k = 0; k < 3 && (await ev(() => __v().options.nodeLabels)) !== 'length'; k++) {
  await page.locator('.ex-labels').click(); // None, (Bootstrap if the tree has support), Length
  await page.waitForTimeout(150);
}
labels = await drawn();
const hcvLengths = await ev(() => {
  const t = __v().getTree();
  const out = [];
  for (let i = 1; i < t.nodeCount; i++) if (!Number.isNaN(t.length[i])) out.push(String(Number(t.length[i].toPrecision(3))));
  return out;
});
ok(
  labels.length > 0 && labels.every((l) => hcvLengths.includes(l)),
  `HCV: ${labels.length} branch lengths drawn, each the length of a node (${labels.slice(0, 6).join(' ')} ...)`,
);
// the long tip branches at the fitted view: one label each, centred on the branch (the visible part of it) within 1 px
for (const name of ['HCV-2k GB BID-G1242', 'PTR3874']) {
  const r = await ev((name) => {
    const v = __v();
    const t = v.getTree();
    let i = 1;
    while (i < t.nodeCount && !(t.firstChild[i] < 0 && t.tipLabels[t.tipRank[i]].replace(/_/g, ' ').startsWith(name))) i++;
    if (i === t.nodeCount) return null;
    const p = v.nodePosition(i),
      q = v.nodePosition(t.parent[i]);
    const text = String(Number(t.length[i].toPrecision(3)));
    const mine = window.__nodeTextAt.filter((l) => l.text === text && l.align === 'center' && Math.abs(l.y - p.y) < 6);
    return { text, mid: (p.x + q.x) / 2, xs: mine.map((l) => l.x) };
  }, name);
  ok(
    r && r.xs.length === 1 && Math.abs(r.xs[0] - r.mid) <= 1,
    `HCV: the tip branch of ${name} shows its length ${r?.text}, centred (${r?.xs.map((x) => x.toFixed(1)).join(',')} vs ${r?.mid.toFixed(1)})`,
  );
}
// hcvZoomed in on x the short branches get room for their text, so more labels are drawn
await ev(() => {
  const v = __v();
  v.setViewport({ ...v.getViewport(), x1: 0.12 });
});
await page.waitForTimeout(300);
const hcvZoomed = await drawn();
ok(
  hcvZoomed.length > labels.length && hcvZoomed.every((l) => hcvLengths.includes(l)),
  `HCV zoomed in: ${hcvZoomed.length} labels (${labels.length} before)`,
);
// the export includes the node labels: toBlob equals the screen, labels and all (the same check as above, with labels on)
const sameLabelled = await screenVsBlob();
ok(
  hcvZoomed.length > 0 && sameLabelled.w && sameLabelled.painted > 500 && sameLabelled.diff === 0,
  `node labels on: toBlob equals the screen (${hcvZoomed.length} labels, ${sameLabelled.painted} painted pixels, ${sameLabelled.diff} differ)`,
);
// posterior on the BEAST MCC tree: the labels hold no support, the posterior is in [&posterior=...] (io annotations, supportFrom)
await open('rich-fish-carangaria-135');
ok((await drawn()).length === 0, 'Carangaria: no node labels by default');
await page.locator('.ex-labels').click();
await page.waitForTimeout(150);
ok((await page.locator('.ex-labels').innerText()).includes('Bootstrap'), 'the button offers Bootstrap on a tree whose support is an annotation');
// 135 tips in one view are under the density threshold: show the top of the tree
await ev(() => {
  const v = __v();
  const vp = v.getViewport();
  v.setViewport({ ...vp, y0: 0, y1: 18 });
});
await page.waitForTimeout(300);
labels = await drawn();
const nums = labels.map(Number);
ok(nums.length > 3 && nums.every((x) => x >= 0 && x <= 1), `Carangaria: posterior drawn (${labels.slice(0, 8).join(' ')} ...)`);
ok(labels.includes('1') && labels.some((l) => /^0\.\d{1,2}$/.test(l)), 'both 1 and a fraction rounded to 2 decimals');
// far zoomed out the labels would collide: none below the density threshold
await ev(() => __v().fit(false));
await page.waitForTimeout(200);
ok((await drawn()).length === 0, 'Carangaria at the fitted view: rows closer than the density threshold, no node labels');
await page.locator('.ex-outer').press('Control+f');
await page.waitForTimeout(100);
ok(
  (await page.locator('.ex-search input').count()) === 1 && (await ev(() => document.activeElement?.closest('.ex-search') !== null)),
  'Ctrl+F opens the search',
);

// ---------------------------------------------------------------- length labels sit on their branch (#53)
console.log('length labels on the branch');
await open('rich-fish-carangaria-135');
for (let k = 0; k < 3 && !(await page.locator('.ex-labels').innerText()).includes('Length'); k++) await page.locator('.ex-labels').click();
ok((await page.locator('.ex-labels').innerText()).includes('Length'), 'lengths on');
// every drawn length is centred on the visible part of its own horizontal branch (the viewer's clip), at two zooms
const lengthLabelsOff = async (vp) =>
  ev(async (vp) => {
    const v = __v();
    const seen = [];
    const ft = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (t, x, y, ...r) {
      if (this.textBaseline === 'bottom' && this.textAlign === 'center') seen.push({ t: String(t), x, y });
      return ft.call(this, t, x, y, ...r);
    };
    v.setViewport({ ...v.getViewport(), ...vp });
    await new Promise((r) => setTimeout(r, 400));
    CanvasRenderingContext2D.prototype.fillText = ft;
    const tree = v.getTree();
    const { proj } = v;
    const p = { x: 0, y: 0 },
      q = { x: 0, y: 0 };
    const off = [];
    for (const l of seen) {
      let best = Infinity;
      for (let i = 1; i < tree.nodeCount; i++) {
        if (String(Number(tree.length[i].toPrecision(3))) !== l.t) continue; // tips too (#66)
        proj.nodeXY(i, p);
        proj.parentXY(i, q);
        if (Math.abs(p.y - 2 - l.y) > 1) continue;
        const mid = (Math.max(q.x, proj.T.clipL) + Math.min(p.x, proj.T.clipR)) / 2;
        best = Math.min(best, Math.abs(mid - l.x));
      }
      if (!(best <= 1)) off.push(`${l.t}@${Math.round(l.x)} (${best})`);
    }
    return { n: seen.length, off };
  }, vp);
for (const [name, vp] of [
  ['top of the tree', { x0: 0, x1: 1, y0: 0, y1: 18 }],
  ['x zoomed in 2.5x on the right', { x0: 0.6, x1: 1, y0: 20, y1: 38 }],
  ['x zoomed in 1.7x on the left (long stems end past the plot)', { x0: 0, x1: 0.6, y0: 0, y1: 18 }],
]) {
  const r = await lengthLabelsOff(vp);
  ok(
    r.n >= 5 && r.off.length === 0,
    `length labels centred on their visible branch, ${name}: ${r.n} drawn, off by more than 1 px: ${r.off.join(' ') || 'none'}`,
  );
}

// ---------------------------------------------------------------- swap inside a polytomy
console.log('swap in a polytomy');
await open('edge-polytomy');
const tipOrder = () => ev(() => __order().split(','));
ok((await tipOrder()).slice(0, 5).join('') === 'ABCDE', 'the 5-way polytomy starts as A B C D E');
await btn('Swap').click();
await click(await ev(() => __tipAt('A')));
await click(await ev(() => __tipAt('D')));
await page.waitForTimeout(200);
const swapped = await tipOrder();
ok(swapped.slice(0, 5).join('') === 'DBCAE', 'Swap of A and D in the polytomy moves only those two');
ok(swapped.slice(5).join() === 'F,G,H,I,J', 'the rest of the tree is unchanged');
await page.keyboard.press('Escape');
await page.locator('.phylo-tree').focus();
await page.keyboard.press('Control+z');
await page.waitForTimeout(200);
ok((await tipOrder()).slice(0, 5).join('') === 'ABCDE', 'Ctrl+Z undoes the swap');

// ---------------------------------------------------------------- aligned labels
console.log('aligned labels');
await open('rich-hcv-19');
const alignBtn = page.locator('.ex-outer button', { hasText: /^\s*Align\s*$/ }); // not 'Alignment'
const anchorXs = () =>
  ev(() => [...document.querySelectorAll('.phylo-tree [data-tip-id]')].map((a) => Math.round(a.getBoundingClientRect().left * 10) / 10));
await page.waitForTimeout(300);
const ragged = await anchorXs();
ok(
  ragged.length > 5 && new Set(ragged).size > 3,
  `labels follow their tips by default (${ragged.length} anchors, ${new Set(ragged).size} different x)`,
);
ok((await alignBtn.isEnabled()) && (await ev(() => __v().options.alignLabels)) === false, 'the Align button is enabled, off by default');
await alignBtn.click();
await page.waitForTimeout(400);
const aligned = await anchorXs();
ok(aligned.length > 5 && new Set(aligned).size === 1, `Align: the label anchors share one x (${aligned.length} anchors at ${aligned[0]})`);
ok(
  (await ev(() => __v().options.alignLabels)) === true && (await alignBtn.getAttribute('aria-pressed')) === 'true',
  'Align sets the option and shows as pressed',
);
const sameAligned = await screenVsBlob();
ok(
  sameAligned.w && sameAligned.painted > 500 && sameAligned.diff === 0,
  `Align on: toBlob equals the screen, leaders included (${sameAligned.painted} painted pixels, ${sameAligned.diff} differ)`,
);
const lab = await page.evaluate(() => {
  const a = document.querySelector('.phylo-tree [data-tip-id]');
  const r = a.getBoundingClientRect();
  return { id: a.dataset.tipId, x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await openMenu({ x: lab.x, y: lab.y });
await act('info');
ok(
  (await page.locator('.ex-info-name').count()) === 1 && (await page.locator('.ex-info-name').innerText()) === lab.id.replace(/_/g, ' '),
  'clicking an aligned label opens the node menu of its tip (Info shows the inspector)',
);
await page.locator('.ex-info-head button').click();
await alignBtn.click();
await page.waitForTimeout(300);
ok(new Set(await anchorXs()).size > 3, 'Align off: the labels follow their tips again');

// ---------------------------------------------------------------- summaries
console.log('summaries');
await open('syn-yule-10000');
await page.waitForTimeout(1500);
// one look for every summary (#85): no Stripes toggle, the background and stripes are always drawn
ok((await page.locator('.ex-outer button', { hasText: /^\s*Stripes\s*$/ }).count()) === 0, 'no Stripes toggle');
ok((await ev(() => __v().options.minCladePx)) === 14, 'a big tree: smallest clade 14 px, so the summaries are tall enough to carry stripes');
// count the stripe segments of a frame: lineTo calls while the stroke style is the summary colour, on the viewer's context
const stripeCount = (colour) =>
  ev((colour) => {
    const v = __v();
    v.setTheme({ ...v.getTheme(), summary: colour });
    const ctx = v.ctx;
    const orig = { stroke: ctx.stroke, lineTo: ctx.lineTo };
    let n = 0;
    ctx.lineTo = function (...a) {
      if (this.strokeStyle === colour) n++;
      return orig.lineTo.apply(this, a);
    };
    v.invalidate();
    v.renderNow();
    ctx.lineTo = orig.lineTo;
    return n;
  }, colour);
const withStripes = await stripeCount('#ff0000');
ok(withStripes > 20, `the frame draws stripe segments in the summary colour (${withStripes})`);
await ev(() => __v().setTheme({}));

// ---------------------------------------------------------------- alignment
console.log('alignment');
await open('rich-hcv-19');
await btn('Alignment').click();
await page.waitForTimeout(300);
const cell = await ev(() => __v().columnCell('alignment', 0));
ok(cell !== null && cell.width > 100, 'the alignment column is drawn');
ok((await page.locator('.ex-legend').innerText()).includes('18 of 19 tips matched'), 'legend says how many tips have a sequence');
ok(
  await ev(() => {
    const h = document.querySelector('.ex-hint').getBoundingClientRect();
    const r = document.querySelector('.ex-legend').getBoundingClientRect();
    return h.bottom <= r.top || h.top >= r.bottom || h.right <= r.left || h.left >= r.right;
  }),
  'the hint does not overlap the alignment legend (#69)',
);
// the legend is the canvas's own table: in dark mode, every swatch is a colour the cells are drawn in (and the cells use no other)
if ((await ev(() => document.documentElement.dataset.theme)) !== 'dark') {
  await page.locator('.theme-toggle').click();
  await page.waitForTimeout(300);
}
const swatches = await ev(() => [...document.querySelectorAll('.ex-legend-dot')].map((d) => getComputedStyle(d).backgroundColor));
ok(swatches.length === 4 && new Set(swatches).size === 4, `the nucleotide legend has four distinct swatches (${swatches.join(' ')})`);
ok(swatches[0] === 'rgb(74, 222, 128)', 'in dark mode they are the dark defaults (A is #4ade80)');
const cellColours = await ev(() => {
  const v = __v();
  const c = v.treeElement.querySelector('canvas');
  const b = c.getBoundingClientRect();
  const k = c.width / b.width;
  const seen = new Set();
  for (let r = 0; r < 6; r++) {
    const cell = v.columnCell('alignment', r);
    if (!cell) continue;
    for (let i = 0; i < 80; i++) {
      const x = Math.round((cell.x + ((i + 0.5) / 80) * cell.width - b.left) * k);
      const y = Math.round((cell.y + cell.height / 2 - b.top) * k);
      const d = c.getContext('2d').getImageData(x, y, 1, 1).data;
      if (d[3] === 255) seen.add(`rgb(${d[0]}, ${d[1]}, ${d[2]})`);
    }
  }
  return [...seen];
});
ok(
  swatches.every((s) => cellColours.includes(s)),
  `each legend swatch is the pixel colour of a residue cell (cells: ${cellColours.join(' ')})`,
);
await btn('Alignment').click();
await page.waitForTimeout(200);
ok((await ev(() => __v().columnCell('alignment', 0))) === null && (await page.locator('.ex-legend').count()) === 0, 'Alignment off');

// ---------------------------------------------------------------- show only a clade, Up one level, Back
console.log('show only this clade, Up one level, Back');
await open('rich-fish-carangaria-135');
const tipCount = () => ev(() => __v().getTree().tipCount);
const whole = await tipCount();
ok((await btn('Up one level').count()) === 0, 'no Up / Back while the whole tree is shown');
const c60 = await ev(() => __clade(20, 60));
await openMenu(c60);
await act('subtree');
ok((await tipCount()) === c60.tips, `Show only this clade shows its ${c60.tips} tips (${await tipCount()})`);
ok((await page.locator('.ex-chip').innerText()).includes(`${c60.tips} tips`), 'and a chip says which clade');
ok((await btn('Back').isEnabled()) && (await btn('Up one level').isEnabled()), 'Back and Up one level are enabled');
await page.waitForTimeout(300);
const rootPos = await ev(() => {
  const q = __v().locateNode(0);
  return { x: q.x, y: q.y };
});
await openMenu(rootPos);
ok(
  (await menuItems()).slice(0, 2).join('|') === 'Up one level|Back',
  `the root of the clade shown leads out of it: ${(await menuItems()).join(' | ')}`,
);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
await btn('Up one level').click();
await page.waitForTimeout(300);
const up = await tipCount();
ok(up > c60.tips, `Up one level shows the clade that contains it (${up} tips)`);
await btn('Back').click();
await page.waitForTimeout(300);
ok((await tipCount()) === c60.tips, 'Back returns to the clade');
await btn('Back').click();
await page.waitForTimeout(300);
ok((await tipCount()) === whole && (await btn('Up one level').count()) === 0, 'Back again returns to the whole tree');
// an edit keeps the clade shown: Flip a clade inside it
await openMenu(await ev(() => __clade(20, 60)));
await act('subtree');
await page.waitForTimeout(300);
const nested = await ev(() => __clade(3, 8));
await openMenu(nested);
await act('flip');
await page.waitForTimeout(300);
ok((await tipCount()) === c60.tips && (await btn('Undo').count()) === 1, 'Flip inside the clade shown keeps it shown');
await btn('Undo').click();
await page.waitForTimeout(300);
ok((await tipCount()) === c60.tips, 'and so does Undo');

// the crash path: the hover box is rendered with the last hover event, which held a node id of the tree shown before the change.
// Hover, then Show only / Up / Back with colours, a collapsed clade, collapse by support and the pointer moving over the new tree
// (any page error or console.error fails the run, see the handlers at the top)
console.log('Show only, Up, Back with hover, colours, collapse and support: no page errors');
{
  const errorsBefore = failures;
  await open('rich-fish-carangaria-135');
  await btn('Color').click();
  await page.locator('button[aria-label=Teal]').click();
  await click(await ev(() => __clade(20, 40)));
  await page.locator('.ex-outer').press('Escape');
  await collapseAt(await ev(() => __clade(4, 10)));
  await page.locator('button[aria-label="Collapse by support"]').click();
  await page.waitForTimeout(300);
  for (const co of [false, true]) {
    const c = await ev((co) => {
      const v = __v();
      const t = v.getTree();
      for (let i = 1; i < t.nodeCount; i++)
        if (t.firstChild[i] >= 0 && t.leafEnd[i] - t.leafStart[i] >= 3 && !!v.layout.collapsed?.[i] === co) {
          const q = v.locateNode(i);
          if (q) return co ? __stem(i) : q; // a click on a collapsed clade's triangle expands it; its branch opens the menu
        }
      return null;
    }, co);
    if (!c) continue;
    await page.mouse.move(c.x, c.y);
    await page.waitForTimeout(150);
    await openMenu(c);
    await act('subtree');
    for (const step of [null, 'Up one level', 'Back', 'Back']) {
      if (step) await btn(step).click();
      for (let k = 0; k < 6; k++) await page.mouse.move(300 + k * 90, 300 + k * 20);
      await page.waitForTimeout(250);
    }
  }
  ok(failures === errorsBefore, 'no page error or console.error during Show only, Up and Back');
}

// the tooltip function was called on every render with the last hover event, also after the tree had changed and the box was hidden
console.log('a visible tooltip while the tree changes: no page errors');
{
  const errorsBefore = failures;
  await open('rich-fish-carangaria-135');
  const lastTip = () =>
    ev(() => {
      const v = __v();
      const t = v.getTree();
      const q = v.locateNode(t.tipNode[t.tipCount - 1]);
      return { x: q.x, y: q.y };
    });
  const hoverUntilTooltip = async (p) => {
    await page.mouse.move(p.x - 30, p.y);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await page.waitForSelector('.phylo-tooltip:not([hidden])', { timeout: 3000 });
  };
  // the keyboard changes the tree while the pointer stays on the tip, so the tooltip is still showing when it does
  const pressOnButton = async (selector) => {
    await ev((sel) => document.querySelector(sel).focus(), selector);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
  };
  await hoverUntilTooltip(await lastTip());
  ok((await page.locator('.phylo-tooltip').innerText()).includes('Click for actions'), 'the tooltip of the last tip is showing');
  await pressOnButton('button[aria-label="Collapse by support"]'); // it crashed with 'replace' of undefined
  ok((await ev(() => __v().getTree().nodeCount)) > 0, 'collapse by support with the tooltip showing');
  await pressOnButton('button[aria-label="Collapse by support"]');
  const c = await ev(() => __clade(20, 60));
  await page.mouse.move(c.x, c.y);
  await openMenu(c);
  await act('subtree');
  await page.waitForTimeout(300);
  const inClade = await ev(() => {
    const v = __v();
    const t = v.getTree();
    const q = v.locateNode(t.tipNode[2]);
    return { x: q.x, y: q.y };
  });
  await hoverUntilTooltip(inClade);
  await pressOnButton('.ex-group[aria-label="Clade shown"] button:last-child'); // Up one level, with the tooltip showing
  await hoverUntilTooltip(await lastTip().catch(() => inClade)).catch(() => {});
  await pressOnButton('.ex-group[aria-label="Clade shown"] button:first-child'); // Back
  ok(failures === errorsBefore, 'no page error or console.error with the tooltip showing during collapse by support, Up and Back');
}

// Reroot inside a clade shown alone would split it: the menu leaves it out, the tool says why, and the view is kept
console.log('reroot inside a clade shown alone');
{
  await open('rich-fish-carangaria-135');
  const c = await ev(() => __clade(20, 60));
  await openMenu(c);
  await act('subtree');
  await page.waitForTimeout(400);
  const inner = await ev(() => __clade(3, 8));
  await openMenu(inner);
  ok(!(await menuItems()).includes('Reroot here'), `no Reroot here for a node strictly inside the clade shown (${(await menuItems()).join(' | ')})`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await btn('Reroot').click();
  await click(inner);
  ok(
    (await toast()).includes('would split it') && (await tipCount()) === c.tips,
    'the Reroot tool says why it does nothing, and the clade stays shown',
  );
  await page.keyboard.press('Escape');
  // the root of the clade shown may be rooted on
  await openMenu(
    await ev(() => {
      const q = __v().locateNode(0);
      return { x: q.x, y: q.y };
    }),
  );
  ok((await menuItems()).includes('Reroot here'), 'the root of the clade shown still offers Reroot here');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  // Undo does not undo navigation: Flip inside the clade, Back to the whole tree, Undo: still the whole tree
  await openMenu(await ev(() => __clade(3, 8)));
  await act('flip');
  await page.waitForTimeout(300);
  await btn('Back').click();
  await page.waitForTimeout(300);
  const wholeTips = await tipCount();
  await btn('Undo').click();
  await page.waitForTimeout(400);
  ok((await tipCount()) === wholeTips && wholeTips > c.tips, `Undo leaves the navigation alone (the whole tree stays shown, ${wholeTips} tips)`);
}

// Colour… opens its palette where the click was and moves focus into it
console.log('Colour… palette');
{
  await open('rich-fish-carangaria-135');
  const c = await ev(() => __clade(4, 10));
  await openMenu(c);
  await act('colour');
  const pal = await page.locator('.ex-palette--near').boundingBox();
  const out = await page.locator('.ex-outer').boundingBox();
  ok(
    Math.abs(pal.x - Math.min(c.x, out.x + out.width - 262)) < 30 && pal.y > c.y - 40 - 0 && pal.y < c.y + 80,
    `the palette is near the click (palette ${Math.round(pal.x)},${Math.round(pal.y)}; click ${Math.round(c.x)},${Math.round(c.y)})`,
  );
  ok(await ev(() => document.activeElement?.closest('.ex-palette') !== null), 'focus is inside the palette');
  await page.keyboard.press('Escape');
  ok((await page.locator('.ex-palette').count()) === 0, 'Escape closes it');
}

// Copy Newick without the clipboard API: the fallback copies, or the Newick is offered as a file; never an unhandled error
console.log('Copy Newick without navigator.clipboard');
{
  await open('rich-fish-carangaria-135');
  await ev(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
  await openMenu(await ev(() => __clade(4, 10)));
  const dl = page.waitForEvent('download', { timeout: 2500 }).catch(() => null);
  // what has the focus when the fallback runs (execCommand('copy') is called with it): the element that must get it back
  await ev(() => {
    const exec = document.execCommand.bind(document);
    document.execCommand = (...a) => {
      const el = document.activeElement;
      window.__focusBefore = el && el.tagName === 'TEXTAREA' ? window.__lastNonTextarea : el;
      return exec(...a);
    };
    document.addEventListener('focusin', (e) => e.target.tagName !== 'TEXTAREA' && (window.__lastNonTextarea = e.target), true);
  });
  await act('copy');
  await page.waitForTimeout(500);
  const t = await toast();
  ok(t.startsWith('Copied') || (t.includes('downloaded') && (await dl) !== null), `without the clipboard API: "${t}"`);
  const back = await ev(() => ({
    same: window.__focusBefore === document.activeElement,
    tag: document.activeElement?.tagName,
    had: window.__focusBefore?.tagName,
  }));
  ok(back.same && back.tag !== 'BODY', `the keyboard focus returns to the element that had it (${back.had})`);
}

// every popover has the one corner rounding of --ex-popover-radius, and what is inside one a smaller one from it (#68); the node menu
// is styled as the inspector: the same panel and header
console.log('one popover radius, the node menu styled as the inspector');
{
  await open('rich-fish-carangaria-135');
  const radius = (sel) => ev((q) => (document.querySelector(q) ? getComputedStyle(document.querySelector(q)).borderTopLeftRadius : null), sel);
  const r = {};
  const items = {};
  const c = await ev(() => __clade(4, 10));
  await page.mouse.move(c.x, c.y, { steps: 3 });
  await page.locator('.ex-tip').waitFor({ timeout: 3000 });
  r['hover box'] = await radius('.ex-tip');
  await openMenu(c);
  await act('info');
  await openMenu(c);
  r.inspector = await radius('.ex-info');
  r['node menu'] = await radius('.phylo-node-menu');
  items['node menu item'] = await radius('.phylo-node-menu__item');
  items['node menu close'] = await radius('.phylo-node-menu__close');
  items['inspector close'] = await radius('.ex-info-head button');
  const look = await ev(() => {
    const pick = (q, props) => {
      const s = getComputedStyle(document.querySelector(q));
      return props.map((k) => s[k]).join(' ; ');
    };
    const panel = ['backgroundColor', 'borderTopColor', 'borderTopWidth', 'boxShadow'];
    const head = ['paddingTop', 'paddingLeft', 'borderBottomWidth', 'borderBottomColor'];
    const title = ['fontFamily', 'fontSize', 'fontWeight', 'color'];
    return {
      panel: [pick('.ex-info', panel), pick('.phylo-node-menu', panel)],
      head: [pick('.ex-info-head', head), pick('.phylo-node-menu__head', head)],
      title: [pick('.ex-info-name', title), pick('.phylo-node-menu__title', title)],
    };
  });
  for (const [k, [a, b]] of Object.entries(look)) ok(a === b, `the node menu's ${k} looks like the inspector's (${b})`);
  // a different radius reaches every popover open now
  await ev(() => document.documentElement.style.setProperty('--ex-popover-radius', '4px'));
  const changed = [await radius('.ex-info'), await radius('.phylo-node-menu'), await radius('.phylo-node-menu__item')];
  await ev(() => document.documentElement.style.removeProperty('--ex-popover-radius'));
  ok(changed.join(',') === '4px,4px,2.4px', `--ex-popover-radius changes the popovers and their items (${changed.join(', ')})`);
  await page.keyboard.press('Escape'); // the menu, and the inspector with it
  await page.waitForTimeout(150);
  if (await page.locator('.ex-info').count()) await page.locator('.ex-info-head button').click();
  await openMenu(c);
  await act('colour');
  r.palette = await radius('.ex-palette');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await openMenu(c);
  await act('copy');
  await page.locator('.ex-toast').waitFor({ timeout: 3000 });
  r.toast = await radius('.ex-toast');
  await page.locator('.ex-export button').first().click();
  await page.locator('.ex-menu').waitFor({ timeout: 3000 });
  r['toolbar menu'] = await radius('.ex-menu');
  items['toolbar menu item'] = await radius('.ex-menu button');
  await page.locator('.ex-export button').first().click();
  await page.locator('button[aria-label="Search tips"]').click();
  await page.locator('.ex-search').waitFor({ timeout: 3000 });
  r.search = await radius('.ex-search');
  items['search close'] = await radius('.ex-search-close');
  await page.keyboard.press('Escape');
  const one = new Set(Object.values(r));
  ok(one.size === 1 && !one.has(null) && !one.has('0px'), `one radius for every popover (${JSON.stringify(r)})`);
  const inner = new Set(Object.values(items));
  ok(
    inner.size === 1 && parseFloat([...inner][0]) < parseFloat([...one][0]) && parseFloat([...inner][0]) > 0,
    `a smaller one for what is inside them (${JSON.stringify(items)})`,
  );
}

// the toolbar keeps its two rows at 1280, 1024 and 600 px (below that it scrolls sideways)
console.log('toolbar rows');
for (const w of [1280, 1024, 600]) {
  await page.setViewportSize({ width: w, height: 860 });
  await open('rich-fish-carangaria-135');
  await page.waitForTimeout(200);
  const rows = await page.locator('.ex-row').evaluateAll((rs) => rs.map((r) => Math.round(r.getBoundingClientRect().height)));
  ok(rows.length === 2 && rows.every((h) => h < 50), `${w} px: two single-line rows (${rows.join(', ')} px)`);
  // Export and Search stay in view whatever the row scrolls; a row that overflows says so (data-end on the scroller, a fade)
  const vis = await ev(() =>
    ['.ex-export button', 'button[aria-label="Search tips"]'].map((q) => {
      const r = document.querySelector(q).getBoundingClientRect();
      const o = document.querySelector('.ex-outer').getBoundingClientRect();
      return r.width > 0 && r.left >= o.left && r.right <= o.right;
    }),
  );
  ok(vis[0] && vis[1], `${w} px: Export and Search are inside the toolbar`);
  const row1 = await ev(() => {
    const r = document.querySelector('.ex-row');
    return { over: r.scrollWidth > r.clientWidth + 1, end: r.hasAttribute('data-end'), start: r.hasAttribute('data-start') };
  });
  ok(row1.over === row1.end && !row1.start, `${w} px: the View row ${row1.over ? 'overflows and shows the fade' : 'fits, no fade'}`);
  await btn('Export').click();
  ok(
    (await page.locator('.ex-menu').count()) === 1 && (await page.locator('.ex-menu button').first().isVisible()),
    `${w} px: Export is clickable and opens its menu`,
  );
  await btn('Export').click();
}
await page.setViewportSize({ width: 1024, height: 860 });
await open('rich-fish-carangaria-135');
await page
  .locator('.ex-row')
  .first()
  .evaluate((r) => (r.scrollLeft = 0));
// the row is scrolled to its end: the start fades, Export is still where it was
const exportX = await ev(() => document.querySelector('.ex-export button').getBoundingClientRect().left);
await page
  .locator('.ex-row')
  .first()
  .evaluate((r) => (r.scrollLeft = r.scrollWidth));
await page.waitForTimeout(150);
ok(
  (await ev(() => document.querySelector('.ex-row').hasAttribute('data-start'))) &&
    !(await ev(() => document.querySelector('.ex-row').hasAttribute('data-end'))) &&
    Math.abs((await ev(() => document.querySelector('.ex-export button').getBoundingClientRect().left)) - exportX) < 1,
  '1024 px: scrolled to its end the row fades at the start and Export has not moved',
);
await page.mouse.click(
  ...Object.values(
    await ev(() => {
      const r = document.querySelector('.ex-export button').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }),
  ),
);
ok((await page.locator('.ex-menu').count()) === 1, '1024 px: a real click on Export (after scrolling) opens the menu');
await page.keyboard.press('Escape');
await page.setViewportSize({ width: 1280, height: 860 });

// Tab through the View row at 600 px: a focused control is scrolled clear of the pinned Search / Export group, inside the row
console.log('keyboard focus in the scrolling toolbar');
await page.setViewportSize({ width: 600, height: 860 });
await open('rich-fish-carangaria-135');
await page.locator('.ex-row').first().locator('button, input').first().focus();
const hidden = [];
let visited = 0;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(60);
  const st = await ev(() => {
    const a = document.activeElement;
    const row = document.querySelector('.ex-row');
    if (!a || !row.contains(a) || a.closest('.ex-pinned')) return null;
    const r = a.getBoundingClientRect(),
      p = document.querySelector('.ex-pinned').getBoundingClientRect(),
      w = row.getBoundingClientRect();
    const label = a.getAttribute('aria-label') || a.title || a.textContent;
    return {
      label,
      geo: [r.left, r.right, p.left, p.right, w.left, w.right],
      clash: r.left < p.right && r.right > p.left,
      outside: r.left < w.left - 0.5 || r.right > w.right + 0.5,
    };
  });
  if (st === null) break;
  visited++;
  if (st.clash || st.outside) hidden.push(st.label + JSON.stringify(st.geo));
  await page.keyboard.press('Tab');
}
ok(
  visited >= 8 && hidden.length === 0,
  `600 px: Tab through the View row keeps every control clear of Search and Export (${visited} controls${hidden.length ? ', hidden: ' + hidden.join(', ') : ''})`,
);
await page.setViewportSize({ width: 1280, height: 860 });

// ---------------------------------------------------------------- collapse by support
console.log('collapse by support');
await open('rich-fish-carangaria-135');
const nodeCount = () => ev(() => __v().getTree().nodeCount);
const collapsedTips = () =>
  ev(() => {
    const t = __v().getTree();
    const out = [];
    for (let i = 1; i < t.nodeCount; i++) if (__v().layout.collapsed?.[i]) out.push(t.leafEnd[i] - t.leafStart[i]);
    return out;
  });
const n0 = await nodeCount();
// a clade whose own support is BELOW the threshold used below, so it is contracted unless it is kept (a clade with high support
// would survive with or without `keep`)
const weak = (lo, hi, skip = 0) =>
  ev(
    ([lo, hi, skip]) => {
      const v = __v();
      const t = v.getTree();
      const sup = window.__explorerTree().support; // the page's tree: the viewer's snapshot has no support
      for (let i = 1; i < t.nodeCount; i++) {
        const c = t.leafEnd[i] - t.leafStart[i];
        if (!v.layout.collapsed?.[i] && t.firstChild[i] >= 0 && c >= lo && c <= hi && sup[i] < 0.9 && skip-- <= 0) {
          const q = v.locateNode(i);
          if (q) return { node: i, tips: c, support: sup[i], x: q.x, y: q.y };
        }
      }
      return null;
    },
    [lo, hi, skip],
  );
const keepMe = await weak(2, 12);
ok(keepMe !== null && keepMe.support < 0.9, `the clade collapsed by hand has support ${keepMe?.support} (below the threshold)`);
await collapseAt(keepMe);
const rowsKept = await ev(() => __v().layout.rows);
ok((await collapsedTips()).join() === String(keepMe.tips), 'a clade collapsed by hand');
ok(
  (await page.locator('button[aria-label="Collapse by support"]').isEnabled()) &&
    (await page.locator('input[aria-label="Minimum support"]').count()) === 0,
  'Collapse by support is available on a tree with posterior support',
);
// a coloured clade below the threshold must stay a node too
await btn('Color').click();
await page.locator('button[aria-label=Teal]').click();
const colMe = await weak(2, 12, 1);
await click(colMe);
await page.locator('.ex-outer').press('Escape');
ok((await ev(() => __v().getClades().length)) === 1, `a clade of ${colMe.tips} tips coloured (support ${colMe.support})`);
// a selected clade that collapse by support contracts: the selection moves to the clade that holds it, and the inspector stays open (#61)
const selMe = await weak(2, 12, 2);
await openMenu(selMe);
await act('info');
ok((await page.locator('.ex-info').count()) === 1 && (await ev(() => __v().getSelected())) === selMe.node, 'a weak clade selected, Info open');
// the bootstrap value is styled like the other values of the inspector (#70)
{
  const ddStyles = await ev(() =>
    [...document.querySelectorAll('.ex-info-rows dd')].map((d) => {
      const c = getComputedStyle(d);
      return { dt: d.previousElementSibling.textContent, colour: c.color, font: c.fontFamily, weight: c.fontWeight };
    }),
  );
  const boot = ddStyles.find((d) => d.dt === 'Bootstrap');
  ok(boot !== undefined && ddStyles.length >= 2, `the inspector of a clade shows Bootstrap (${ddStyles.map((d) => d.dt).join(', ')})`);
  ok(
    boot !== undefined && ddStyles.every((d) => d.colour === boot.colour && d.font === boot.font && d.weight === boot.weight),
    `and its value has the colour, font and weight of the others (${boot && boot.colour})`,
  );
}
await page.locator('button[aria-label="Collapse by support"]').click();
await page.waitForTimeout(300);
const thr = page.locator('input[aria-label="Minimum support"]');
ok((await thr.inputValue()) === '0.7', 'the threshold starts at 0.7 on a 0 to 1 support scale');
await thr.fill('0.99');
await page.waitForTimeout(400);
const n1 = await nodeCount();
ok(n1 < n0, `a threshold of 0.99 contracts branches (${n0} → ${n1} nodes)`);
ok((await page.locator('.ex-support-n').innerText()).includes('collapsed'), `the count: ${await page.locator('.ex-support-n').innerText()}`);
ok(
  (await collapsedTips()).join() === String(keepMe.tips),
  `the clade collapsed by hand is still collapsed, with its ${keepMe.tips} tips, and a node of its own`,
);
ok((await ev(() => __v().getClades().length)) === 1, 'the coloured clade below the threshold is not contracted away');
{
  const sel = await ev(() => __v().getSelected());
  ok(
    (await page.locator('.ex-info').count()) === 1 && sel !== null && sel < (await nodeCount()),
    `the selected clade was contracted: the inspector stays open on the clade that holds it (node ${sel})`,
  );
  await page.locator('.ex-info-head button').click();
}
// a dated tree stays dated: the contracted lengths go to the children, so the axis keeps "time before tips" and every tip stays at 0
ok(
  await ev(() => {
    const t = __v().getTree();
    const d = new Float64Array(t.nodeCount); // distance from the root, preorder
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 1; i < t.nodeCount; i++) {
      d[i] = d[t.parent[i]] + (t.length[i] || 0);
      if (t.firstChild[i] < 0) {
        lo = Math.min(lo, d[i]);
        hi = Math.max(hi, d[i]);
      }
    }
    return hi - lo <= 1e-3 * hi;
  }),
  'collapse by support keeps the dated tree ultrametric (every tip at the same distance from the root)',
);
await thr.fill('0.5');
await page.waitForTimeout(400);
const n2 = await nodeCount();
ok(n2 > n1 && n2 <= n0, `a lower threshold brings branches back (${n1} → ${n2})`);
await page.locator('button[aria-label="Collapse by support"]').click();
await page.waitForTimeout(400);
ok(
  (await nodeCount()) === n0 && (await ev(() => __v().layout.rows)) === rowsKept,
  'switched off: the tree as it was, and the hand-collapsed clade still collapsed',
);
ok((await page.locator('input[aria-label="Minimum support"]').count()) === 0, 'the threshold hides with it');
await open('rich-hcv-19');
ok(
  (await page.locator('button[aria-label="Collapse by support"]').count()) === 0 && (await page.locator('.ex-support').count()) === 0,
  'a tree without support: the Collapse by support control is not in the DOM',
);
await open('rich-fish-carangaria-135');
ok(
  (await page.locator('.ex-support').count()) === 1 && (await page.locator('button[aria-label="Collapse by support"]').isEnabled()) === true,
  'a tree with support: the control is back',
);

// every synthetic tree of the catalogue carries support (#55): Bootstrap draws values, and collapse by support at the default
// threshold (0.7, or 70 on a 0 to 100 scale) contracts branches
console.log('support on every synthetic tree');
{
  const catalogue = JSON.parse(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/shared/catalogue.json'), 'utf8'),
  );
  const synthetic = Object.keys(catalogue.synthetic);
  ok(synthetic.length >= 4, `the synthetic trees: ${synthetic.join(', ')}`);
  for (const id of synthetic) {
    await open(id);
    for (let k = 0; k < 3 && (await ev(() => __v().options.nodeLabels)) !== 'support'; k++) {
      await page.locator('.ex-labels').click(); // None, Bootstrap (the tree has support), Length
      await page.waitForTimeout(150);
    }
    // labels need room: frame a clade of a few dozen tips, then stretch x (Shift + wheel) until a branch is long enough for one
    const at = await ev(() => {
      const t = __v().getTree();
      for (let i = 1; i < t.nodeCount; i++) {
        const c = t.leafEnd[i] - t.leafStart[i];
        if (t.firstChild[i] >= 0 && c >= 12 && c <= 40) {
          __v().zoomToNode(i);
          return __v().locateNode(i);
        }
      }
      return null;
    });
    let texts = await drawn();
    for (let k = 0; at && k < 30 && texts.length === 0; k++) {
      await ev(({ x, y }) => {
        const wheel = { deltaY: -300, shiftKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true };
        document.querySelector('.ex-outer canvas').dispatchEvent(new WheelEvent('wheel', wheel));
      }, at);
      texts = await drawn();
    }
    const hi = id.endsWith('-bootstrap') ? 100 : 1;
    ok(
      texts.length > 0 && texts.every((s) => Number(s) >= 0 && Number(s) <= hi),
      `${id}: Bootstrap draws support values (${texts.slice(0, 6).join(' ')})`,
    );
    const n0 = await nodeCount();
    await page.locator('button[aria-label="Collapse by support"]').click();
    await page.waitForFunction((n) => __v().getTree().nodeCount < n, n0, { timeout: 30000 }).catch(() => {});
    const thr = await page.locator('input[aria-label="Minimum support"]').inputValue();
    const n1 = await nodeCount();
    ok(thr === (hi === 1 ? '0.7' : '70') && n1 < n0, `${id}: collapse by support below ${thr} changes the tree (${n0} → ${n1} nodes)`);
  }
}

// ---------------------------------------------------------------- ladderise by tips / depth / height
console.log('ladderise by');
await open('rich-fish-carangaria-135');
const sel = page.locator('select[aria-label="Ladderize by"]');
ok((await sel.locator('option').allInnerTexts()).join() === 'tips,depth,height', 'Ladderize by: tips, depth, height');
// one segmented group: ascending, descending and the "by" select, with no icon in front of the select
ok(
  (await page.locator('.ex-group:has(button[title^="Ladderize ascending"])').evaluate((g) => {
    const kids = [...g.children].map((c) => c.tagName + (c.querySelector('svg') ? '+svg' : ''));
    return kids.join() === 'BUTTON+svg,BUTTON+svg,LABEL' && g.querySelector('select[aria-label="Ladderize by"]') !== null;
  })) === true,
  'Ladderize: ascending, descending and the type select are one .ex-group, the select without an icon',
);
await sel.selectOption('tips');
const firstClade = () =>
  ev(() => {
    const t = __v().getTree();
    let n = t.tipNode[0]; // the clade under the root that holds the first tip
    while (t.parent[n] > 0) n = t.parent[n];
    return t.leafEnd[n] - t.leafStart[n];
  });
await page.locator('button[title^="Ladderize descending by"]').click();
await page.waitForTimeout(250);
const bigFirst = await firstClade();
await page.locator('button[title^="Ladderize ascending by"]').click();
await page.waitForTimeout(250);
const smallFirst = await firstClade();
ok(smallFirst < bigFirst, `ascending puts a smaller top-level clade first than descending (${smallFirst} < ${bigFirst})`);
await btn('Undo').click();
await btn('Undo').click();
await page.waitForTimeout(250);
const base = await ev(() => __order());
const by = {};
for (const k of ['tips', 'depth', 'height']) {
  await sel.selectOption(k);
  await page.locator('button[title^="Ladderize ascending by"]').click();
  await page.waitForTimeout(250);
  by[k] = await ev(() => __order());
  await btn('Undo').click();
  await page.waitForTimeout(250);
}
ok(by.tips !== base && by.depth !== base && by.height !== base, 'each measure re-orders the tips');
ok(new Set(Object.values(by)).size >= 2, 'and they do not all give the same order');
ok((await ev(() => __order())) === base, 'Undo each time');
ok(
  (await page.locator('button[title="Ladderize descending by height — largest clades at top"]').count()) === 1,
  'the button titles say which measure',
);
await open('edge-internal-support');
ok((await page.locator('select[aria-label="Ladderize by"] option[value=height]').isEnabled()) === true, 'height is on offer for a tree with lengths');
// a tree without branch lengths (a Newick of our own, served in place of a small catalogue file): no "height" option, no phylogram
await page.route('**/data/rich/edge-cases/duplicate-tip-labels.nwk', (r) => r.fulfill({ contentType: 'text/plain', body: '((a,b),(c,(d,e)));' }));
await open('edge-duplicate-labels');
ok(!(await ev(() => window.__explorerTree().hasLengths)), 'the stand-in tree has no branch lengths');
ok((await sel.locator('option').allInnerTexts()).join() === 'tips,depth', 'no branch lengths: Ladderize by offers tips and depth only');
ok((await page.locator('button[aria-label="Collapse by support"]').count()) === 0, 'a tree without lengths nor support: no Collapse by support');
await page.unroute('**/data/rich/edge-cases/duplicate-tip-labels.nwk');

// ---------------------------------------------------------------- highlight style
console.log('highlight style');
await open('rich-fish-carangaria-135');
await page.locator('button[aria-label="Search tips"]').click();
await page.keyboard.type('bothus');
await page.waitForTimeout(200);
const hs = page.locator('select[aria-label="Highlight style"]');
ok((await hs.inputValue()) === 'dim', 'highlight style starts as dim');
for (const k of ['band', 'both', 'dim']) {
  await hs.selectOption(k);
  await page.waitForTimeout(150);
  ok((await ev(() => __v().options.highlightStyle)) === k, `highlight style ${k} reaches the viewer`);
}
await page.keyboard.press('Escape');

// ---------------------------------------------------------------- support as percent
console.log('support as percent');
await open('edge-internal-support');
const drawnNow = async () => {
  await ev(() => {
    window.__nodeTexts = [];
    __v().invalidate();
    __v().renderNow();
  });
  return ev(() => window.__nodeTexts);
};
ok((await page.locator('button[aria-label="Support as percent"]').count()) === 0, 'As percent shows only with support labels on');
await page.locator('.ex-labels').click();
await page.waitForTimeout(200);
ok((await drawnNow()).includes('0.95'), 'support 0.95 by default');
await page.locator('button[aria-label="Support as percent"]').click();
await page.waitForTimeout(200);
{
  const t = await drawnNow();
  ok(t.includes('95') && t.includes('100') && !t.includes('0.95'), `as percent: ${t.join(' ')}`);
}

// ---------------------------------------------------------------- Align in radial
console.log('Align in radial');
await open('rich-hcv-19');
await page.locator('button[title=Circular]').click();
await page.waitForTimeout(200);
{
  const al = page.locator('.ex-outer button', { hasText: /^\s*Align\s*$/ });
  // the distances from the root of the label anchors (their translate is the label's place, the vertical centre at half their height)
  const anchorRadii = () =>
    ev(() => {
      const T = __v().T;
      return [...document.querySelectorAll('.phylo-tree [data-tip-id]')]
        .filter((a) => a.style.display !== 'none' && !a.style.transform.includes('-9999px'))
        .map((a) => {
          const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(a.style.transform);
          return Math.round(Math.hypot(Number(m[1]) - T.cx, Number(m[2]) + parseFloat(a.style.height) / 2 - T.cy));
        });
    });
  ok(await al.isEnabled(), 'Align is enabled in the circular layout (#52)');
  const ragged = await anchorRadii();
  ok(ragged.length > 5 && new Set(ragged).size > 3, `circular: the label anchors follow their tips (${new Set(ragged).size} distances)`);
  await al.click();
  await page.waitForTimeout(400);
  const radii = await anchorRadii();
  ok(
    radii.length > 5 && new Set(radii).size === 1 && (await al.getAttribute('aria-pressed')) === 'true',
    `Align in circular: the label anchors are at one distance from the root (${radii.length} anchors at ${radii[0]} px)`,
  );
  const sameRadial = await screenVsBlob();
  ok(
    sameRadial.w && sameRadial.painted > 500 && sameRadial.diff === 0,
    `Align in circular: toBlob equals the screen, leaders included (${sameRadial.painted} painted pixels, ${sameRadial.diff} differ)`,
  );
  await al.click();
  await page.waitForTimeout(300);
  ok(new Set(await anchorRadii()).size > 3, 'Align off: the circular labels follow their tips again');
  await page.locator('button[title=Rectangular]').click();
  await page.waitForTimeout(200);
}

// ---------------------------------------------------------------- overview and legend
console.log('overview and legend');
await open('rich-fish-carangaria-135');
const tog = (t) => page.locator(`.ex-outer button[aria-label="${t}"]`);
ok((await page.locator('.phylo-overview').count()) === 0, 'no overview at first');
await tog('Overview').click();
await page.waitForTimeout(300);
ok((await page.locator('.phylo-overview').count()) === 1, 'Overview shows the viewer’s overview control');
await tog('Overview').click();
await page.waitForTimeout(200);
ok((await page.locator('.phylo-overview').count()) === 0, 'and hides it');
ok((await page.locator('.phylo-legend:visible').count()) === 0, 'the legend is hidden while no clade is coloured');
await btn('Color').click();
await page.locator('button[aria-label=Teal]').click();
await click(await ev(() => __clade(20, 40)));
await page.keyboard.press('Escape');
await page.locator('.ex-outer').press('Escape');
await page.waitForTimeout(300);
ok((await page.locator('.phylo-legend:visible').count()) === 1, 'the legend shows the coloured clade');
ok(
  /\(\d+ tips\)|Clade of/.test(await page.locator('.phylo-legend').innerText()),
  `named by its clade: ${(await page.locator('.phylo-legend').innerText()).replace(/\n/g, ' / ')}`,
);
// the "Scroll to zoom" hint never overlaps a legend (#69): the viewer's clade legend, in either layout, and the alignment strip
const hintClear = () =>
  ev(() => {
    const h = document.querySelector('.ex-hint')?.getBoundingClientRect();
    if (!h) return true; // not drawn: nothing overlaps
    return ['.phylo-legend', '.ex-legend'].every((sel) => {
      const e = document.querySelector(sel);
      if (!e || e.hidden || getComputedStyle(e).display === 'none') return true;
      const r = e.getBoundingClientRect();
      return h.right <= r.left || h.left >= r.right || h.bottom <= r.top || h.top >= r.bottom;
    });
  });
ok(await hintClear(), 'the hint does not overlap the clade legend (rectangular)');
await page.locator('button[title=Circular]').click();
await page.waitForTimeout(300);
ok(
  (await page.locator('.phylo-legend:visible').count()) === 1 && (await page.locator('.ex-hint').count()) === 1,
  'radial keeps its hint, with the legend shown',
);
ok(await hintClear(), 'the hint does not overlap the clade legend (radial)');
await page.locator('button[title=Rectangular]').click();
await page.waitForTimeout(300);
await tog('Legend').click();
await page.waitForTimeout(200);
ok((await page.locator('.phylo-legend:visible').count()) === 0, 'Legend off hides it');
ok((await page.locator('.ex-hint').count()) === 1 && (await hintClear()), 'and the rectangular hint is back');

// the hint goes once the user zooms or pans, and stays gone (#69)
console.log('the hint goes after the first zoom or pan');
await open('rich-hcv-19');
ok((await page.locator('.ex-hint').count()) === 1, 'the hint is shown at first');
{
  const b = await ev(() => document.querySelector('.ex-pane').getBoundingClientRect().toJSON());
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(150);
  ok((await page.locator('.ex-hint').count()) === 1, 'a click does not remove it');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(200);
  ok((await page.locator('.ex-hint').count()) === 0, 'a wheel turn removes it');
  await page.locator('button[title=Circular]').click();
  await page.waitForTimeout(200);
  ok((await page.locator('.ex-hint').count()) === 0, 'and a new layout does not bring it back');
}
await open('rich-hcv-19');
{
  const b = await ev(() => document.querySelector('.ex-pane').getBoundingClientRect().toJSON());
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 40, b.y + b.height / 2 + 10, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  ok((await page.locator('.ex-hint').count()) === 0, 'a drag removes it');
}
await open('rich-hcv-19');
{
  const b = await ev(() => document.querySelector('.ex-pane').getBoundingClientRect().toJSON());
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2 + 1);
  await page.mouse.up();
  await page.waitForTimeout(100);
  ok((await page.locator('.ex-hint').count()) === 1, 'a jittery click does not remove it');
  await page.locator('.phylo-tree').focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  ok((await page.locator('.ex-hint').count()) === 1, 'an arrow key (it moves the active node) does not');
  await page.keyboard.press('+');
  await page.waitForTimeout(150);
  ok((await page.locator('.ex-hint').count()) === 0, 'the zoom key removes it');
}

// ---------------------------------------------------------------- the alignment fills the width
console.log('alignment column fills the width');
await open('rich-hcv-19');
await btn('Alignment').click();
await page.waitForTimeout(400);
{
  // columnCell is in page coordinates: compare with the viewer's box
  const o = await ev(() => {
    const r = __v().treeElement.getBoundingClientRect();
    return { left: r.left, right: r.right, w: r.width, tw: __v().options.treeWidth, cell: __v().columnCell('alignment', 0) };
  });
  ok(o.tw === '40%', `the tree is given 40% of the width (treeWidth ${o.tw})`);
  ok(
    o.cell.x - o.left > o.w * 0.35 && o.cell.x - o.left < o.w * 0.6 && Math.abs(o.cell.x + o.cell.width - o.right) < 20,
    `the 'fill' column takes the rest (${Math.round(o.cell.x - o.left)} to ${Math.round(o.cell.x + o.cell.width - o.left)} of ${Math.round(o.w)})`,
  );
}

// ---------------------------------------------------------------- the playground's catalogue
console.log('search: a label on several tips (#18)');
await open('edge-duplicate-labels');
// record the ranks the explorer asks the viewer to focus (on 9 tips the whole tree is in view, so the viewport cannot tell)
await ev(() => {
  const v = __v();
  const focusTip = v.focusTip.bind(v);
  window.__focused = [];
  v.focusTip = (r, a) => (window.__focused.push(r), focusTip(r, a));
});
await page.locator('button[aria-label="Search tips"]').click();
await page.keyboard.type('homo');
await page.waitForTimeout(250);
ok((await page.locator('.ex-search-count').innerText()) === '1 / 3', 'Homo_sapiens is on three tips: three matches');
const hlDup = await ev(() => [...__v().hlRanks]);
ok(JSON.stringify(hlDup) === '[0,1,3]', `all three tips are highlighted (ranks ${JSON.stringify(hlDup)})`);
for (const k of [2, 3, 1]) {
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  ok((await page.locator('.ex-search-count').innerText()) === `${k} / 3`, `Enter: match ${k} of 3`);
}
const focused = await ev(() => window.__focused.filter((r, i, a) => i === 0 || r !== a[i - 1]));
ok(JSON.stringify(focused.slice(-4)) === '[0,1,3,0]', `each step focuses the next of the three tips (ranks ${JSON.stringify(focused)})`);
await page.keyboard.press('Escape');

console.log('one action colour (#74)');
{
  await open('rich-fish-carangaria-135');
  const tog = (t) => page.locator(`.ex-outer button[aria-label="${t}"]`);
  // a CSS colour as the browser computes it, to compare with computed styles
  const computed = (c) =>
    ev((c) => {
      const s = document.createElement('span');
      s.style.color = c;
      document.body.append(s);
      const v = getComputedStyle(s).color;
      s.remove();
      return v;
    }, c);
  const colourOf = (loc, prop = 'color') => loc.evaluate((e, prop) => getComputedStyle(e)[prop], prop);
  const label = page.locator('.ex-labels');
  // the toggles and the label button in each of their on states, the tools when active and the hover box
  const states = async () => {
    const text = {};
    for (const t of ['Overview', 'Legend']) {
      if (!(await tog(t).evaluate((e) => e.classList.contains('active')))) await tog(t).click();
      await page.mouse.move(5, 5);
      await page.waitForTimeout(250); // the buttons' colours have a transition
      text[t] = await colourOf(tog(t));
    }
    if (!(await btn('Truncate').evaluate((e) => e.classList.contains('active')))) await btn('Truncate').click();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(250);
    text.Truncate = await colourOf(btn('Truncate'));
    for (let k = 0; k < 3; k++) {
      const name = (await label.innerText()).trim().split('\n').pop();
      text[`labels ${name}`] = (await label.evaluate((e) => e.classList.contains('active'))) ? await colourOf(label) : 'inactive';
      await label.click();
      await page.mouse.move(5, 5);
      await page.waitForTimeout(250);
    }
    const background = {};
    for (const t of ['Reroot', 'Flip', 'Swap']) {
      await page.locator('.ex-tool', { hasText: t }).click();
      await page.mouse.move(5, 5);
      await page.waitForTimeout(200);
      background[t] = await colourOf(page.locator('.ex-tool.active'), 'backgroundColor');
      await page.locator('.ex-outer').press('Escape');
      await page.waitForTimeout(100);
    }
    await page.mouse.move(...Object.values(await ev((l) => __tipAt(l), await ev(() => __v().getTree().tipLabels[3]))));
    await page.locator('.ex-tip--menu').waitFor({ timeout: 3000 });
    await page.waitForTimeout(250);
    text['hover box'] = await colourOf(page.locator('.ex-tip--menu'));
    await page.mouse.move(5, 5);
    return { text, background };
  };
  for (let pass = 0; pass < 2; pass++) {
    const theme = (await ev(() => document.documentElement.dataset.theme)) || 'light';
    const primary = await computed('var(--ex-primary)');
    const { text, background } = await states();
    ok(text['labels No labels'] === 'inactive', `${theme}: "No labels" looks inactive`);
    delete text['labels No labels'];
    const off = Object.entries(text).filter(([, c]) => c !== primary);
    ok(
      Object.keys(text).length >= 6 && off.length === 0,
      `${theme}: active toggles, the label button and the hover box have the text colour --ex-primary (${primary})${off.length ? `, not ${JSON.stringify(off)}` : ''}`,
    );
    ok(
      Object.values(background).every((c) => c === primary),
      `${theme}: Reroot, Flip and Swap, active, have the background --ex-primary (${JSON.stringify(background)})`,
    );
    // a theme sets the hover box's own variable: only the box changes
    await ev(() => document.documentElement.style.setProperty('--ex-hover-tip', 'rgb(200, 30, 30)'));
    const themed = await states();
    await ev(() => document.documentElement.style.removeProperty('--ex-hover-tip'));
    ok(themed.text['hover box'] === 'rgb(200, 30, 30)', `${theme}: --ex-hover-tip colours the hover box (${themed.text['hover box']})`);
    delete themed.text['hover box'];
    delete themed.text['labels No labels'];
    ok(
      Object.values(themed.text).every((c) => c === primary) && Object.values(themed.background).every((c) => c === primary),
      `${theme}: and nothing else`,
    );
    await page.locator('.theme-toggle').click();
    await page.waitForTimeout(300);
  }
}

console.log('undo within a memory budget (#44)');
{
  // tree-ops treeBytes of the current tree (the model, not the viewer's snapshot), the same count as packages/tree-ops/src/bytes.ts
  // (keep the two in step): its typed arrays, and 8 bytes per element of its plain arrays
  const bytes = () =>
    ev(() => {
      let b = 0;
      for (const a of Object.values(window.__explorerTree())) b += ArrayBuffer.isView(a) ? a.byteLength : Array.isArray(a) ? a.length * 8 : 0;
      return b;
    });
  const lad = (dir) =>
    page
      .locator(`button[title^="Ladderize ${dir}"]`)
      .click()
      .then(() => page.waitForTimeout(250));
  const note = () => page.locator('.ex-undo-note');
  await open('rich-fish-carangaria-135');
  const b = await bytes();
  // room for two trees between the one as published and the current one: four edits drop the first
  await open('rich-fish-carangaria-135', `&undo-budget=${Math.round(b * 2.5)}`);
  const o = [await ev(() => __order())];
  for (const dir of ['descending', 'ascending', 'descending', 'ascending']) {
    await lad(dir);
    o.push(await ev(() => __order()));
  }
  ok(
    o.every((x, i) => i === 0 || x !== o[i - 1]),
    'four edits, each changes the tree',
  );
  ok((await btn('Undo').count()) === 1 && (await btn('Reset').count()) === 1 && (await note().count()) === 0, 'Undo and Reset are offered');
  await btn('Undo').click();
  await page.waitForTimeout(200);
  ok((await ev(() => __order())) === o[3], 'Undo goes back one edit');
  await btn('Undo').click();
  await page.waitForTimeout(200);
  ok((await ev(() => __order())) === o[2], 'and another');
  ok(
    (await btn('Undo').count()) === 0 && (await btn('Reset').count()) === 1 && /dropped/.test(await note().innerText()),
    `the oldest step was dropped: Undo stops there, Reset stays, a note says why ("${(await note().count()) ? await note().innerText() : ''}")`,
  );
  await page.locator('.phylo-tree').focus();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  ok((await ev(() => __order())) === o[2], 'Ctrl+Z does nothing there');
  await btn('Reset').click();
  await page.waitForTimeout(200);
  ok((await ev(() => __order())) === o[0] && (await btn('Reset').count()) === 0, 'Reset goes back to the tree as published');
  // a tree larger than the budget: Reset only, with a note
  await open('rich-fish-carangaria-135', `&undo-budget=${Math.floor(b / 2)}`);
  await lad('descending');
  await lad('ascending');
  ok(
    (await ev(() => __order())) === o[2] &&
      (await btn('Undo').count()) === 0 &&
      (await btn('Reset').count()) === 1 &&
      /too large/.test(await note().innerText()),
    `a tree larger than the budget: Reset only ("${(await note().count()) ? await note().innerText() : ''}")`,
  );
  await page.locator('.phylo-tree').focus();
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  ok((await ev(() => __order())) === o[2], 'and Ctrl+Z does nothing');
  await btn('Reset').click();
  await page.waitForTimeout(200);
  ok((await ev(() => __order())) === o[0] && (await btn('Reset').count()) === 0, 'Reset goes back to the tree as published');
}

console.log('every tree of the playground catalogue, one from each group');
const here = path.dirname(fileURLToPath(import.meta.url));
const catalogue = JSON.parse(fs.readFileSync(path.join(here, '../../../examples/shared/catalogue.json'), 'utf8'));
await open('edge-internal-support');
{
  const groups = await page
    .locator('.page-head select optgroup')
    .evaluateAll((gs) => gs.map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.value)]));
  const ids = new Set(groups.flatMap((g) => g[1]));
  const wanted = Object.values(catalogue).flatMap((g) => Object.keys(g));
  ok(
    wanted.length === 21 && wanted.every((id) => ids.has(id)),
    `the picker lists all ${wanted.length} trees of the playground catalogue (${ids.size} in all)`,
  );
  ok(
    ['edge-polytomy', 'otl-1k'].every((id) => ids.has(id)),
    'and the explorer’s own extras',
  );
  ok(
    Object.keys(catalogue).every((g) => groups.some((x) => x[0] === g)),
    `grouped as the playground: ${groups.map((g) => g[0]).join(' | ')}`,
  );
  const remote = await page.locator('.page-head select option[value="otl-2m-full"]').count();
  ok(remote === 1, 'the 2.4M-tip tree with a remote URL is on offer');
}
// Drill-down (#57) on a large tree: Overview collapses to about 50 rows, a click on a collapsed clade expands it in place (its children
// in, with an overview of about 20 rows inside), Show only in its menu jumps into it with an overview there, and Back returns
const drillDown = async (tips) => {
  const collapsedNodes = () =>
    ev(() => {
      const t = __v().getTree();
      const out = [];
      for (let i = 1; i < t.nodeCount; i++) if (__v().layout.collapsed?.[i]) out.push(i);
      return out;
    });
  const largest = (skip) =>
    ev(
      ([skip]) => {
        const t = __v().getTree();
        const ids = [];
        for (let i = 1; i < t.nodeCount; i++) if (__v().layout.collapsed?.[i]) ids.push(i);
        ids.sort((a, b) => t.leafEnd[b] - t.leafStart[b] - (t.leafEnd[a] - t.leafStart[a]));
        const n = ids.filter((i) => !skip.includes(i))[0];
        const b = __v().nodeBounds(n);
        return { node: n, end: t.subtreeEnd[n], tips: t.leafEnd[n] - t.leafStart[n], tri: { x: b.x + b.width * 0.8, y: b.y + b.height / 2 } };
      },
      [skip],
    );
  await btn('Overview: 50 clades').click();
  await page.waitForTimeout(400);
  const r0 = await rows();
  const c0 = await collapsedNodes();
  ok(r0 <= 50 && r0 >= 40 && (await tipCount()) === tips, `Overview: ${r0} rows (at most 50), ${c0.length} collapsed clades, all ${tips} tips kept`);
  const big = await largest([]);
  await page.mouse.move(big.tri.x, big.tri.y);
  await page.waitForTimeout(300);
  ok((await page.locator('.ex-tip--menu').innerText()).startsWith('Click to expand'), 'the hover box on a collapsed clade says a click expands it');
  await click(big.tri);
  const r1 = await rows();
  const c1 = await collapsedNodes();
  // every child of the clade is drawn now, open or collapsed
  const kids = await ev((n) => {
    const t = __v().getTree();
    const out = [];
    for (let c = t.firstChild[n]; c >= 0; c = t.nextSibling[c]) out.push(__v().locateNode(c) !== null);
    return out;
  }, big.node);
  const inside = c1.filter((i) => i > big.node && i < big.end);
  ok(
    (await menu.count()) === 0 && !c1.includes(big.node) && r1 > r0 && r1 <= r0 - 1 + 20,
    `a click expands the largest collapsed clade (${big.tips} tips) in place: ${r0} → ${r1} rows, at most 19 more`,
  );
  ok(
    c0.every((i) => i === big.node || c1.includes(i)) && kids.every(Boolean) && inside.length > 0,
    `its children come in (${kids.length}), its large subclades collapsed (${inside.length}), the other collapsed clades stay`,
  );
  // jump into another collapsed clade: Show only from its menu (a click on its branch), with an overview inside; Back returns
  const other = await largest([big.node]);
  await openMenu(await ev((n) => __stem(n), other.node));
  await act('subtree');
  await page.waitForTimeout(400);
  const r2 = await rows();
  ok(
    (await tipCount()) === other.tips && r2 <= 50 && r2 >= 20,
    `Show only jumps into a collapsed clade of ${other.tips} tips, with its overview: ${r2} rows`,
  );
  // Overview inside the clade shown keeps it collapsed outside, so Back still returns to the view before
  await btn('Overview: 50 clades').click();
  await page.waitForTimeout(400);
  ok((await rows()) === r2, `Overview inside it gives the same overview (${await rows()} rows)`);
  await btn('Back').click();
  await page.waitForTimeout(400);
  ok(
    (await tipCount()) === tips && (await rows()) === r1 && (await ev((n) => __v().layout.collapsed?.[n] === 1, other.node)),
    `Back returns to the tree as it was (${await rows()} rows, the clade jumped into collapsed again)`,
  );
  // Expand in the menu opens a collapsed clade whole, unlike the click (not the clade jumped into: the clades collapsed inside it stay)
  const whole = await ev((skip) => {
    const t = __v().getTree();
    let best = null;
    for (let i = 1; i < t.nodeCount; i++) {
      if (i === skip || !__v().layout.collapsed?.[i] || (best && t.leafEnd[i] - t.leafStart[i] <= best.tips)) continue;
      const stem = __stem(i);
      if (stem) best = { node: i, tips: t.leafEnd[i] - t.leafStart[i], stem };
    }
    return best;
  }, other.node);
  await openMenu(whole.stem);
  await act('expand');
  ok((await rows()) === r1 - 1 + whole.tips, `Expand in the menu opens a clade of ${whole.tips} tips whole (${r1} → ${await rows()} rows)`);
  await btn('Expand all').click();
  await page.waitForTimeout(300);
};
const loadVia = async (id) => {
  const t0 = Date.now();
  await page.selectOption('.page-head select', id);
  await page.waitForFunction((i) => document.querySelector('.page-head select').value === i && document.querySelector('.ex-outer canvas'), id, {
    timeout: 90000,
  });
  await page.waitForFunction(() => typeof window.__explorer === 'function' && window.__explorer() !== null);
  await page.evaluate(HELPERS);
  await page.waitForTimeout(400);
  return Date.now() - t0;
};
for (const [id, tipsWanted] of [
  ['rich-butterflies-496', 496],
  ['syn-yule-1000', 1000],
  ['gtdb-10k-archaea', 10122],
]) {
  const ms = await loadVia(id);
  const n = await tipCount();
  ok(n === tipsWanted, `${id}: ${n} tips shown (${ms} ms)`);
}
{
  // a large tree: the Open Tree vertebrates, 91k tips; then the 190k-tip GTDB bacteria. Nothing is disabled on either
  const ms = await loadVia('otl-100k-vertebrata');
  const n = await tipCount();
  ok(n > 90000 && (await page.locator('.ex-note').count()) === 0, `otl-100k-vertebrata: ${n} tips (${ms} ms), `);
  // zoomed to rows of 20 px, the explorer's minCladePx 14 draws the same tips as the library's 3: the cherry of near-identical
  // Ochotona princeps subspecies and the single tip under Tribosphenomys keep their rows (#87)
  const tipsAt20 = await ev(() => {
    const v = __v();
    const t = v.getTree();
    const rank = t.tipLabels.findIndex((l) => l.startsWith('Ochotona_princeps_saxatilis'));
    if (rank < 0) return null;
    const counts = [];
    for (const minCladePx of [14, 3]) {
      v.setOptions({ minCladePx });
      v.focusTip(rank, false);
      v.renderNow();
      const q = v.nodePosition(t.tipNode[rank]);
      v.zoomBy(1, 20.5 / v.getStats().ky, q.x, q.y);
      v.renderNow();
      const s = v.getStats();
      counts.push({ minCladePx, rowPx: s.ky, tips: s.tips, summaries: s.summaries });
    }
    v.setOptions({ minCladePx: 14 });
    v.fit(false);
    v.renderNow();
    return counts;
  });
  ok(tipsAt20 !== null, 'the tip Ochotona princeps saxatilis is in the tree');
  ok(
    tipsAt20 !== null && tipsAt20.every((c) => c.rowPx >= 20 && c.summaries === 0) && tipsAt20[0].tips === tipsAt20[1].tips && tipsAt20[0].tips > 20,
    `rows of 20 px: minCladePx 14 draws the tips minCladePx 3 does, no summaries (${JSON.stringify(tipsAt20)})`,
  );
  await openMenu(
    await ev(() => {
      const t = __v().getTree();
      for (let i = 1; i < t.nodeCount; i++) {
        const c = t.leafEnd[i] - t.leafStart[i];
        if (t.firstChild[i] >= 0 && c >= 2000 && c < 20000) {
          const q = __v().locateNode(i);
          if (q) return { x: q.x, y: q.y };
        }
      }
      return null;
    }),
  );
  await act('subtree');
  await page.waitForTimeout(500);
  ok((await tipCount()) < 20000, `Show only works on it (${await tipCount()} tips)`);
  const ms2 = await loadVia('gtdb-190k-bacteria');
  const n2 = await tipCount();
  ok(n2 > 150000, `gtdb-190k-bacteria: ${n2} tips (${ms2} ms)`);
  ok(
    (await page.locator('.ex-note').count()) === 0 &&
      (await btn('Midpoint').isEnabled()) &&
      (await page.locator('select[aria-label="Ladderize by"]').isEnabled()) &&
      (await page.locator('button[title^="Ladderize ascending"]').isEnabled()),
    'nothing is disabled on a large tree',
  );
  ok((await btn('Reroot').isEnabled()) && (await btn('Color').isEnabled()), 'and the tools are on');
  await drillDown(n2);
  // search is not capped (#58): every match is counted and highlighted
  await page.locator('button[aria-label="Search tips"]').click();
  await page.keyboard.type('a');
  await page.waitForTimeout(800);
  const all = await ev(() => __v().getHighlighted().length);
  const count = await page.locator('.ex-search-count').innerText();
  ok(
    all > 5000 && count === `1 / ${all.toLocaleString('en')}`,
    `search highlights and counts every match, past the old 5,000 cap (${count}, ${all} highlighted)`,
  );
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks pass');
process.exit(failures ? 1 : 0);
