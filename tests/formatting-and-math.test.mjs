// Unit tests for flows.html internals (stats, fmtUsd, fmtNative, barChart, dayMeta).
// The page script is executed in a vm with network disabled (run() aborts on the
// "no RPC" path); internals are exported by appending `_export.*` assignments to
// the source. Every expected value is hand-derived from reading the code's rules,
// then HARD-CODED here — the tests never call page code to produce an expectation.
import test from "node:test";
import assert from "node:assert/strict";
import { runFlowsScript, parseRects, assertRectsInBox } from "./_pageload.mjs";

const { _export } = runFlowsScript({
  fetchImpl: () => Promise.reject(new Error("network disabled in unit tests")),
  appendix: "_export.stats = stats; _export.fmtUsd = fmtUsd; _export.fmtNative = fmtNative;" +
            "_export.barChart = barChart; _export.dayMeta = dayMeta; _export.shortA = shortA;",
});
const { stats, fmtUsd, fmtNative, barChart, dayMeta, shortA } = _export;

// ---------------- stats() ----------------

test("stats: empty array is all-zero (no NaN)", () => {
  // Note: {...s} because vm-realm objects have a foreign Object.prototype.
  const s = stats([]);
  assert.deepEqual({ ...s }, { median: 0, max: 0, total: 0, active: 0, n: 0, activeMedian: 0, activeMax: 0 });
});

test("stats: single element", () => {
  const s = stats([7]);
  assert.equal(s.median, 7);
  assert.equal(s.max, 7);
  assert.equal(s.total, 7);
  assert.equal(s.active, 1);
  assert.equal(s.activeMedian, 7);
  assert.equal(s.activeMax, 7);
});

test("stats: even-length median interpolates; activeMedian takes the upper-middle", () => {
  // median of [1,2,3,4]: q(0.5) with n=4 -> i=1.5 -> s[1] + (s[2]-s[1])*0.5 = 2.5 (interpolated)
  // activeMedian uses act[len>>1] -> act[2] = 3 (upper-middle by design, NOT interpolated)
  const s = stats([4, 1, 3, 2]); // unsorted on purpose: stats must sort a copy
  assert.equal(s.median, 2.5);
  assert.equal(s.activeMedian, 3);
  assert.equal(s.total, 10);
  assert.equal(s.max, 4);
});

test("stats: activeMedian ignores zeros, median does not", () => {
  // [0,0,5,0,9]: overall sorted [0,0,0,5,9], median = s[2] = 0.
  // active = [5,9] -> act[2>>1] = act[1] = 9; active count 2.
  const s = stats([0, 0, 5, 0, 9]);
  assert.equal(s.median, 0);
  assert.equal(s.active, 2);
  assert.equal(s.activeMedian, 9);
  assert.equal(s.activeMax, 9);
  assert.equal(s.total, 14);
});

test("stats: does not mutate its input", () => {
  const arr = [4, 1, 3, 2];
  stats(arr);
  assert.deepEqual(arr, [4, 1, 3, 2]);
});

test("stats: negatives allowed (net-flow series)", () => {
  // sorted [-5,5], median = -5 + (5 - -5)*0.5 = 0; active drops the negative.
  const s = stats([5, -5]);
  assert.equal(s.median, 0);
  assert.equal(s.active, 1);
  assert.equal(s.activeMedian, 5);
});

// ---------------- fmtUsd() ----------------
// Rules read from the code: >=1e6 -> M with 2dp (1dp from 1e7); >=1e3 -> k with
// 1dp (0dp from 1e5); else "$" + Math.round(v). Expected strings hand-computed.

test("fmtUsd boundaries", () => {
  const cases = [
    [0, "$0"],
    [999, "$999"],
    [999.49, "$999"],          // Math.round
    [1000, "$1.0k"],           // k-branch starts
    [1049, "$1.0k"],
    [99_999, "$100.0k"],       // 99.999.toFixed(1) rounds up to "100.0"
    [100_000, "$100k"],        // 0dp from 1e5
    [999_999, "$1000k"],       // quirk: k-branch runs to 1e6, prints "$1000k" not "$1.00M"
    [1_000_000, "$1.00M"],
    [9_999_999, "$10.00M"],    // 9.999999.toFixed(2) rounds up
    [10_000_000, "$10.0M"],    // 1dp from 1e7
    [12_345_678, "$12.3M"],
  ];
  for (const [v, want] of cases) assert.equal(fmtUsd(v), want, `fmtUsd(${v})`);
});

test("fmtNative units and precision", () => {
  assert.equal(fmtNative(0.5, "ETH"), "0.50 ETH");    // ETH gets 2dp
  assert.equal(fmtNative(999.4, "USDC"), "999 USDC"); // stables 0dp
  assert.equal(fmtNative(1234, "USDC"), "1.2k USDC");
  assert.equal(fmtNative(2_500_000, "ETH"), "2.50M ETH");
});

test("shortA / dayMeta helpers", () => {
  assert.equal(shortA("0x5000000000000000000000000000000000000005"), "0x500000…0005");
  // 1,900,000,000s = 17 Mar 2030 17:46:40 UTC (hand-checked)
  assert.deepEqual({ ...dayMeta(1_900_000_000, 0) }, { label: "17 Mar", full: "17 Mar 2030" });
  assert.deepEqual({ ...dayMeta(1_900_000_000, 29) }, { label: "16 Feb", full: "16 Feb 2030" });
});

// ---------------- barChart() ----------------
// Geometry read from the code: viewBox 0 0 960 250, margins L/R 8, T 18, B 24
// => plot 944x208, zero line at y=122, half-heights 104. DEN defaults to "usd".

const day = (dep = 0, routine = 0, big = 0, label = "x") => ({ dep, routine, big, label });

test("barChart: one huge day + 29 zeros stays finite and inside the viewBox", () => {
  const series = Array.from({ length: 30 }, (_, i) => day(0, 0, 0, "d" + i));
  series[7] = day(1e9, 0, 0, "d7");
  const svg = barChart(series, 1, "USDC");
  assert.ok(svg.startsWith('<svg viewBox="0 0 960 250"'));
  const rects = parseRects(svg);
  assertRectsInBox(rects, 960, 250, "huge-day chart");
  // exactly one colored bar (the huge deposit), full height 104 ending at the top margin
  const colored = rects.filter(r => r.fill !== "transparent");
  assert.equal(colored.length, 1);
  assert.equal(colored[0].fill, "var(--in)");
  assert.equal(Number(colored[0].height), 104); // 1e9/maxAbs * 104, maxAbs = 1e9
  assert.equal(Number(colored[0].y), 18);       // zeroY(122) - 104
  assert.equal(rects.filter(r => r.fill === "transparent").length, 30);
  // x labels: gap = round(30/6) = 5 -> i = 0,5,10,15,20,25 plus i=29, +2 legend texts = 9
  assert.equal((svg.match(/<text /g) || []).length, 9);
  assert.ok(!/NaN|Infinity|undefined/.test(svg));
});

test("barChart: all zeros renders only the 30 hover hits, nothing colored", () => {
  const series = Array.from({ length: 30 }, (_, i) => day(0, 0, 0, "d" + i));
  const svg = barChart(series, 2, "ETH");
  const rects = parseRects(svg);
  assert.equal(rects.filter(r => r.fill !== "transparent").length, 0);
  assert.equal(rects.filter(r => r.fill === "transparent").length, 30);
  assertRectsInBox(rects, 960, 250, "all-zero chart");
  assert.ok(!/NaN|Infinity|undefined/.test(svg));
});

test("barChart: stacked routine+big fill the down half exactly, never overflow", () => {
  // maxAbs = 100 (day1 outs). routine bar 40 -> h 41.6 at y=122; big bar 60 -> h 62.4 at y=163.6.
  // Stack bottom = 122 + 41.6 + 62.4 = 226 = mT + plotH (bottom plot edge), inside viewBox.
  const series = [day(100), day(0, 40, 60)];
  const svg = barChart(series, 1, "USDC");
  const rects = parseRects(svg);
  assertRectsInBox(rects, 960, 250, "stacked chart");
  const out = rects.find(r => r.fill === "var(--out)");
  const blk = rects.find(r => r.fill === "var(--block)");
  assert.equal(Number(out.y), 122);
  assert.equal(Number(out.height), 41.6);
  assert.equal(Number(blk.y), 163.6);
  assert.equal(Number(blk.height), 62.4);
  assert.ok(Number(blk.y) + Number(blk.height) <= 226 + 1e-9);
});

test("barChart: single-day series (n=1) keeps geometry finite", () => {
  const svg = barChart([day(5, 1, 0, "solo")], 1, "USDC");
  const rects = parseRects(svg);
  assertRectsInBox(rects, 960, 250, "n=1 chart");
  assert.equal(rects.filter(r => r.fill === "transparent").length, 1);
  const dep = rects.find(r => r.fill === "var(--in)");
  assert.equal(Number(dep.height), 104); // dep is the max -> full half-height
  assert.ok(!/NaN|Infinity|undefined/.test(svg));
});
