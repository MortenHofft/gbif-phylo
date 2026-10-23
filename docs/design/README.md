# Design notes

Measurements and design notes carried over from the research on the `research` branch. They are records of what was measured and decided at
the time. Paths in them (`spikes/custom/...`, `spikes/shared/...`, `docs/results/...`) refer to the layout of that branch. Here:

| Path on `research` | Path here |
|---|---|
| `spikes/custom/src/core/` | `packages/viewer/src/` |
| `spikes/custom/src/react/` | `packages/react/src/` |
| `spikes/shared/newick.ts`, `tree.ts` | `packages/io/src/` |
| `spikes/custom/scripts/check-radial-ui.mjs`, `bench/` | `tests/browser/` |
| `docs/results/custom.md`, `tree-ops.md`, `treesource-slice.md` | this folder |

| File | What |
|---|---|
| [library.md](library.md) | Turning the renderer into a library: the design decisions, what it cost, what is not done (written on this branch) |
| [custom.md](custom.md) | The custom renderer's measurements: benchmarks, scenarios, the radial work, polytomies, the hardening pass |
| [custom-renderer.md](custom-renderer.md) | The research that preceded it: why our own renderer, and its architecture |
| [data-layer.md](data-layer.md) | Data layer research: formats, loading, partial trees |
| [treesource-slice.md](treesource-slice.md) | The `TreeSource` slice: partially loaded trees (its `ParquetSource` is on `research`) |
| [tree-ops.md](tree-ops.md), [tree-ops-libraries.md](tree-ops-libraries.md) | Tree operations: results and the libraries looked at |
| [undo-memory.md](undo-memory.md) | What one more tree costs in memory (bytes per node, 10k to 1.5M tips) and the bounded undo of the examples (#44) |
| [highlight-cost.md](highlight-cost.md) | What highlighting 10k to 1M tips costs on the 2.39M-tip OTL tree, before and after bounding the bands by pixels, and the label scan of a search (#58) |
| [unrooted.md](unrooted.md) | The equal-angle unrooted layout spike: pictures of real trees, layout and draw timings up to 2.39M tips, and the go/no-go (#42) |
| [auto-collapse-named.md](auto-collapse-named.md) | Collapse to 50 clades by size or preferring named clades, on GTDB 190k and OTL 100k: how many rows are named, with pictures (#57) |
| [ete-ideas.md](ete-ideas.md) | Ideas from the ETE toolkit worth reimplementing |
