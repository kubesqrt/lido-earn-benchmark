# Test suite — Lido Earn live dashboard

Automated tests for the client-side pages (`flows.html`, `index.html`, `positions.html`,
`architecture.html`, `flows-snapshot.html`). No dependencies — Node 22's built-in
`node:test` runner only.

## Run

From the repo directory (`lido-earn-live\`):

```
node --test tests\
```

One-line CI command (same thing, portable separator):

```
node --test tests/
```

Offline runs stay green: the live tests skip themselves when the network or a public
endpoint is unreachable.

## What each file covers

| File | What it does |
| --- | --- |
| `_pageload.mjs` | Shared harness (not a test): extracts a page's `<script>`, runs it in `node:vm` with a DOM stub and an injectable `fetch`; SVG rect parsing/bounds helpers. Same pattern as `../../harness-render.mjs`. |
| `index.js` | Aggregator that makes the bare directory invocation (`node --test tests\`) work on Node 22/Windows, where the runner spawns the directory itself as a child entry. It just imports the four test modules; explicit-glob runs bypass it, so tests never run twice. |
| `flows-pipeline.test.mjs` | Deterministic end-to-end of `flows.html` with a fully mocked chain (canned JSON-RPC + Mellow responses). A 19-log fixture covers every Transfer classification path: plain mint, fee-recipient mint (excluded), queue mint with/without same-tx forward (depositor resolution), routine burn (<1% TVL), large burn (>=1% TVL), redeem-request transfers into the share token (requester aggregation), an out-of-window log (dropped), and a wallet-to-wallet transfer (ignored). Mocked head-block timestamps make seconds-per-block exactly 8640 and the share price exactly $2.00 (EarnETH) / $1.00 (EarnUSD), so every rendered figure is hand-computable. Asserts exact tile/table/note strings, focus-note gating at the 40% threshold (88% fires, 35% doesn't), coverage 100%, chart rect counts/bounds, and absence of NaN/undefined/Infinity. |
| `formatting-and-math.test.mjs` | Unit tests of `stats`, `fmtUsd`, `fmtNative`, `barChart`, `dayMeta`, `shortA` (exported by appending `_export.*` to the vm source, network disabled). `stats` on empty/single/even-length/zero-heavy arrays; `fmtUsd` boundary table (999, 1000, 99 999, 100 000, 999 999, 1e6, 1e7, ...); `barChart` extremes (one huge day + 29 zeros, all zeros, stacked outflows, n=1) with every rect parsed and bounds-checked against the viewBox. |
| `cross-page-consistency.test.mjs` | Static greps as assertions: the four share-token/vault addresses agree (case-insensitively, including the token<->vault pairing) between `index.html` and `flows.html`; `positions.html` §04 carries the e-mode triplets (Aave 93/95 twice, Spark 92/93, Aave-Plasma syrupUSDT 90/92); every page that states fees says 1% management + 10% performance over a high-watermark; `flows-snapshot.html` contains "frozen · block", no NaN/undefined, both SVGs have all rects inside the 960x250 viewBox, and no external URLs besides Google Fonts. |
| `live-smoke.test.mjs` | Network sanity, auto-skipping offline: mainnet head block > 25M; one 9,900-block `eth_getLogs` chunk on earnETH returns an array; Mellow `/data` for both vaults has `allocations[]` with `tvl.usd` + `usd_decimals` and combined TVL > $1M; share price = TVL/totalSupply is finite and positive, EarnUSD within $0.5–$5. |

## Known page bugs (deliberately not fixed by the tests)

* **`flows.html` — "Largest settlement" tile shows a mirrored date.** `renderVault`
  renders `data.series[biggest.day].full`, but `biggest.day` is a *days-ago* bucket
  index while `series` is ordered oldest-first (`series[i]` = `WIN-1-i` days ago).
  An event 3 days ago in a 30d window shows the label from 26 days ago. Correct:
  `data.series[WIN - 1 - biggest.day].full`. The corresponding test in
  `flows-pipeline.test.mjs` is marked FIXME and skips with an explanation while the
  bug exists; it will assert the correct date once fixed.

## Quirks documented (not bugs)

* `fmtUsd(999_999)` prints `$1000k` (the k-branch runs to 1e6); `fmtUsd(99_999)`
  rounds up to `$100.0k`.
* `stats().activeMedian` takes the upper-middle element for even-length arrays
  (`act[len>>1]`), unlike `median` which interpolates.
