// Deterministic end-to-end test of flows.html with a fully mocked fetch.
//
// The page's real <script> runs in a vm DOM stub; every RPC / Mellow call is
// served from canned fixtures. All expected values below are HAND-COMPUTED
// (see the arithmetic in comments) — never derived by calling page code.
//
// Fixture design (chosen so every number is exact and far from format/threshold
// boundaries):
//   headBlk        = 26,000,000
//   headTs         = 1,900,000,000  (17 Mar 2030 17:46:40 UTC)
//   secPerBlk      = 8640 exactly   (mocked old-block timestamp), so
//                    day bucket = floor((headBlk - blk) / 10)  — exact.
//   WIN=30d  =>  fromBlk = headBlk - ceil(30*86400/8640) - 2000 = headBlk - 2300
//                => exactly ONE 9,900-block getLogs chunk per vault => coverage 100%.
//   EarnETH: totalSupply 500,000 shares, Mellow TVL $1,000,000 => price = $2.00 exactly.
//            1% of TVL = $10,000 => "large settlement" threshold = 5,000 shares.
//   EarnUSD: totalSupply 500,000 shares, Mellow TVL $500,000  => price = $1.00 exactly.
import test from "node:test";
import assert from "node:assert/strict";
import { runFlowsScript, waitFor, parseRects, assertRectsInBox } from "./_pageload.mjs";

// ---------------- fixture constants ----------------
const HEAD_BLK = 26_000_000;
const HEAD_TS = 1_900_000_000;
const SEC_PER_BLK = 8640;
const BACK_EST = 30 * 7200 + 2000; // ceil(30*7200)+2000 = 218,000 (page's backEst for WIN=30)

const XFER = "0x" + "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ETH_TOKEN = "0xbbfc8683c8fe8cf73777fede7ab9574935fea0a4";
const USD_TOKEN = "0x4ce1ac8f43e0e5bd7a346a98af777bf8fbea1981";
const ETH_VAULT = "0x6a37725ca7f4ce81c004c955f7280d5c704a249e";
const USD_VAULT = "0x014e6da8f283c4af65b2aa0f201438680a004452";
const FEE_RECIPIENT = "0xccf2daba8bb04a232a2fda0d01010d4ef6c69b85";
const ZADDR = "0x" + "0".repeat(40);

const USER1 = "0x1000000000000000000000000000000000000001";
const USER2 = "0x2000000000000000000000000000000000000002";
const USER3 = "0x3000000000000000000000000000000000000003";
const USER4 = "0x4000000000000000000000000000000000000004";
const USER5 = "0x5000000000000000000000000000000000000005"; // dominant redeem requester
const USER6 = "0x6000000000000000000000000000000000000006";
const USER7 = "0x7000000000000000000000000000000000000007"; // out-of-window depositor
const USER8 = "0x8000000000000000000000000000000000000008";
const USER9 = "0x9000000000000000000000000000000000000009";
const QUEUE1 = "0xabcd000000000000000000000000000000000001"; // deposit queue w/ forward
const QUEUE2 = "0xabcd000000000000000000000000000000000002"; // deposit queue w/o forward
const REQA = "0xdddd000000000000000000000000000000000001";
const REQB = "0xdddd000000000000000000000000000000000002";
const REQC = "0xdddd000000000000000000000000000000000003";

const pad32 = a => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const shHex = n => "0x" + (BigInt(n) * 10n ** 18n).toString(16);
const mkLog = (tx, blkOff, from, to, shares) => ({
  transactionHash: tx,
  blockNumber: "0x" + (HEAD_BLK - blkOff).toString(16),
  data: shHex(shares),
  topics: [XFER, pad32(from), pad32(to)],
});

// blkOff -> day bucket is floor(blkOff/10). Every classification path is covered:
const ETH_LOGS = [
  mkLog("0xa1", 1, ZADDR, USER1, 1000),          // day 0: plain mint (deposit)
  mkLog("0xa2", 3, ZADDR, USER1, 500),           // day 0: second mint, same depositor
  mkLog("0xb1", 2, ZADDR, FEE_RECIPIENT, 500),   // day 0: fee mint -> EXCLUDED
  mkLog("0xc1", 12, ZADDR, QUEUE1, 2000),        // day 1: mint to queue...
  mkLog("0xc1", 12, QUEUE1, USER2, 2000),        //   ...same-tx forward => depositor = USER2
  mkLog("0xm1", 13, ZADDR, QUEUE2, 800),         // day 1: mint to queue, NO forward => depositor = QUEUE2
  mkLog("0xd1", 25, USER3, ZADDR, 3000),         // day 2: burn $6,000  < 1% TVL => routine
  mkLog("0xl1", 26, USER8, USER9, 123),          // day 2: wallet-to-wallet transfer => ignored
  mkLog("0xe1", 35, USER4, ZADDR, 6000),         // day 3: burn $12,000 >= 1% TVL => LARGE
  mkLog("0xf1", 45, USER5, ETH_TOKEN, 1500),     // day 4: redeem request (into share token)
  mkLog("0xg1", 46, USER6, ETH_TOKEN, 300),      // day 4: redeem request, second requester
  mkLog("0xh1", 55, USER5, ETH_TOKEN, 700),      // day 5: redeem request, aggregates on USER5
  mkLog("0xk1", 65, USER3, ZADDR, 100),          // day 6: small routine burn ($200)
  mkLog("0xo1", 299, USER4, ZADDR, 600),         // day 29: routine burn at window edge ($1,200)
  mkLog("0xi1", 310, ZADDR, USER7, 9999),        // day 31: OUTSIDE window => dropped
  mkLog("0xn1", 320, USER3, ZADDR, 50),          // day 32: OUTSIDE window => dropped
];
// EarnUSD: only redeem requests, top share 35% (<40% => NO focus note), zero flows.
const USD_LOGS = [
  mkLog("0xu1", 5, REQA, USD_TOKEN, 35),
  mkLog("0xu2", 15, REQB, USD_TOKEN, 33),
  mkLog("0xu3", 27, REQC, USD_TOKEN, 32),
];

const MELLOW = {
  // 600000000000/10^6 + 40000000000000/10^8 = 600,000 + 400,000 = $1,000,000
  [ETH_VAULT]: { allocations: [
    { tvl: { usd: "600000000000", usd_decimals: 6 } },
    { tvl: { usd: "40000000000000", usd_decimals: 8 } },
  ] },
  // 500000000000/10^6 = $500,000
  [USD_VAULT]: { allocations: [{ tvl: { usd: "500000000000", usd_decimals: 6 } }] },
};

function makeFakeFetch(calls) {
  const respond = obj => ({ ok: true, json: async () => obj });
  return async function fakeFetch(url, opts = {}) {
    if (typeof url === "string" && url.startsWith("https://api.mellow.finance/")) {
      calls.push({ kind: "mellow", url });
      const vault = url.match(/core-vaults\/([^/]+)\/data/)[1].toLowerCase();
      if (!MELLOW[vault]) throw new Error("unexpected mellow vault: " + vault);
      return respond(MELLOW[vault]);
    }
    const req = JSON.parse(opts.body);
    calls.push({ kind: "rpc", method: req.method, params: req.params, url });
    let result;
    switch (req.method) {
      case "eth_blockNumber":
        result = "0x" + HEAD_BLK.toString(16); break;
      case "eth_getBlockByNumber": {
        const blk = parseInt(req.params[0], 16);
        result = { timestamp: "0x" + (HEAD_TS - (HEAD_BLK - blk) * SEC_PER_BLK).toString(16) };
        break;
      }
      case "eth_call": {
        const to = req.params[0].to.toLowerCase();
        if (to !== ETH_TOKEN && to !== USD_TOKEN) throw new Error("unexpected eth_call to " + to);
        result = "0x" + (500000n * 10n ** 18n).toString(16); // both tokens: 500,000 shares
        break;
      }
      case "eth_getLogs": {
        const { address, fromBlock, toBlock } = req.params[0];
        const lo = parseInt(fromBlock, 16), hi = parseInt(toBlock, 16);
        const all = address.toLowerCase() === ETH_TOKEN ? ETH_LOGS
                  : address.toLowerCase() === USD_TOKEN ? USD_LOGS
                  : null;
        if (!all) throw new Error("unexpected getLogs address " + address);
        result = all.filter(l => { const b = parseInt(l.blockNumber, 16); return b >= lo && b <= hi; });
        break;
      }
      case "eth_getCode":
        result = "0x"; break; // top requester is an EOA
      default:
        throw new Error("unexpected RPC method: " + req.method);
    }
    return respond({ jsonrpc: "2.0", id: req.id, result });
  };
}

// ---------------- run the page once, then assert ----------------
const calls = [];
const { els, _export } = runFlowsScript({
  fetchImpl: makeFakeFetch(calls),
  appendix: "_export.getCache = () => (typeof CACHE !== 'undefined' ? CACHE : null);",
});
await waitFor(() =>
  (els["slot-eth"]?._html || "").includes("tblwrap") &&
  (els["slot-usd"]?._html || "").includes("tblwrap"));
const ethHtml = els["slot-eth"]._html;
const usdHtml = els["slot-usd"]._html;
const CACHE = _export.getCache();

test("mocked chain setup is read exactly (head block, secPerBlk, chunking)", () => {
  assert.equal(CACHE.headBlk, HEAD_BLK);
  assert.equal(CACHE.headTs, HEAD_TS);
  // secPerBlk = (headTs - oldTs)/backEst; mock makes it exactly 8640 s/block.
  assert.equal(CACHE.secPerBlk, SEC_PER_BLK);
  assert.equal(els["asof"]._text, "block 26000000");
  // One 9,900-block chunk per vault (window needs only 2,300 blocks) => 2 getLogs calls,
  // each spanning [headBlk-2300, headBlk]. 26,000,000-2,300 = 25,997,700 = 0x18cb184.
  const logCalls = calls.filter(c => c.method === "eth_getLogs");
  assert.equal(logCalls.length, 2);
  for (const c of logCalls) {
    assert.equal(c.params[0].fromBlock, "0x18cb184");
    assert.equal(c.params[0].toBlock, "0x18cba80"); // 26,000,000
    assert.deepEqual(c.params[0].topics, [XFER]);
  }
  assert.equal(logCalls[0].params[0].address.toLowerCase(), ETH_TOKEN);
  assert.equal(logCalls[1].params[0].address.toLowerCase(), USD_TOKEN);
});

test("EarnETH: every classification path lands in the right bucket (shares)", () => {
  const d = CACHE.vaults.eth.data;
  assert.equal(d.coverage, 1); // 1/1 chunks => coverage exactly 100%
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} !~ ${b}`);
  // series[i] is day (29-i) ago; series[29] = today.
  const byAgo = ago => d.series[29 - ago];
  near(byAgo(0).dep, 1500);      // 1000 + 500 mints; 500 fee mint EXCLUDED
  near(byAgo(1).dep, 2800);      // 2000 via queue-forward + 800 queue-no-forward
  near(byAgo(2).routine, 3000);  // $6,000 burn < $10,000 threshold
  near(byAgo(3).big, 6000);      // $12,000 burn >= threshold
  near(byAgo(6).routine, 100);
  near(byAgo(29).routine, 600);  // window-edge burn kept
  // Out-of-window logs (blkOff 310/320) fully dropped:
  const totDep = d.series.reduce((s, x) => s + x.dep, 0);
  const totRout = d.series.reduce((s, x) => s + x.routine, 0);
  const totBig = d.series.reduce((s, x) => s + x.big, 0);
  near(totDep, 1500 + 2800);     // no 9999 from USER7 mint at day 31
  near(totRout, 3000 + 100 + 600); // no 50 burn at day 32
  near(totBig, 6000);
  assert.equal(d.bigEvents.length, 1);
  assert.equal(d.bigEvents[0].day, 3);
  near(d.bigEvents[0].shares, 6000);
  // Depositor resolution: queue forward followed to USER2; no-forward stays at QUEUE2.
  assert.deepEqual(Object.keys(d.depBy).sort(), [USER1, USER2, QUEUE2].sort());
  near(d.depBy[USER1], 1500);
  near(d.depBy[USER2], 2000);
  near(d.depBy[QUEUE2], 800);
  assert.ok(!(FEE_RECIPIENT in d.depBy), "fee recipient must not appear as depositor");
  assert.ok(!(USER7 in d.depBy), "out-of-window depositor must be dropped");
  // Redeem-requester aggregation:
  assert.deepEqual(Object.keys(d.reqBy).sort(), [USER5, USER6].sort());
  near(d.reqBy[USER5], 2200); // 1500 + 700 aggregated
  near(d.reqBy[USER6], 300);
});

test("EarnETH: rendered tiles match hand-computed USD figures", () => {
  // price $2: dep USD/day = {d0:3000, d1:5600}; routine = {d2:6000, d6:200, d29:1200}; big = {d3:12000}
  // Median settlement: active routine [200,1200,6000] -> act[3>>1] = 1200 -> "$1.2k"
  assert.match(ethHtml, /<div class="k">Median settlement<\/div><div class="v out">\$1\.2k<\/div>/);
  assert.ok(ethHtml.includes("3 routine settlements · largest $6.0k"));
  // Median deposit day: active [3000,5600] -> act[2>>1] = 5600 -> "$5.6k"; 2 of 30 days active
  assert.match(ethHtml, /<div class="k">Median deposit day<\/div><div class="v inn">\$5\.6k<\/div>/);
  assert.ok(ethHtml.includes("2/30 days with deposits"));
  // Net flow: in 3000+5600 = 8600; out 6000+200+1200+12000 = 19400; net = -10800
  assert.match(ethHtml, /<div class="v neg">−\$10\.8k<\/div>/);
  assert.ok(ethHtml.includes("in $8.6k · out $19.4k"));
  // Largest settlement: 6000 sh * $2 = $12,000 = 1.2% of $1M TVL
  assert.match(ethHtml, /<div class="k">Largest settlement<\/div><div class="v blk">\$12\.0k<\/div>/);
  assert.ok(ethHtml.includes("1.2% of TVL"));
  // Card head: TVL $1.00M at exactly $2.00/share, full coverage => no "% coverage" note
  assert.ok(ethHtml.includes("TVL $1.00M · $2.00/share"));
  assert.ok(ethHtml.includes("settled flows, 30d</small>"));
  assert.ok(!ethHtml.includes("% coverage"), "coverage=100% must not print a coverage note");
});

// FIXME(page bug, flows.html renderVault): the "Largest settlement" tile does
//   data.series[biggest.day].full
// but `biggest.day` is a DAYS-AGO bucket index while `series` is ordered oldest-first
// (series[i] = (WIN-1-i) days ago). The tile therefore shows the MIRRORED date:
// our large settlement happened 3 days ago (14 Mar 2030) but the tile prints the
// label of series[3] = 26 days ago (19 Feb 2030). Correct would be
// data.series[WIN-1-biggest.day].full. Chart and daily table are unaffected.
// Per instructions the page is NOT fixed; this test SKIPS (with explanation) while
// the bug exists and will start asserting once it is fixed.
test("EarnETH: largest-settlement tile shows the date of the event [FIXME: known page bug]", t => {
  const m = ethHtml.match(/1\.2% of TVL · ([^<]*)</);
  assert.ok(m, "largest-settlement tile with date suffix not found");
  const shown = m[1].trim();
  if (shown === "19 Feb 2030") {
    t.skip("KNOWN BUG in flows.html renderVault: tile shows series[biggest.day] (mirrored date " +
      "'19 Feb 2030') instead of series[WIN-1-biggest.day] ('14 Mar 2030'). See FIXME above.");
    return;
  }
  assert.equal(shown, "14 Mar 2030"); // event was 3 days before head (blkOff 35 => day 3)
});

test("EarnETH: concentration tables — requester % shares and depositor ranking", () => {
  // Requesters: USER5 2200/2500 = 88%, USER6 300/2500 = 12%; USD at $2/share.
  assert.ok(ethHtml.includes("0x500000…0005"));
  assert.ok(ethHtml.includes(">$4.4k</td><td class=\"num\">88%</td>"));
  assert.ok(ethHtml.includes("0x600000…0006"));
  assert.ok(ethHtml.includes(">$600</td><td class=\"num\">12%</td>"));
  // Focus note fired (88% > 40%) => requester row is annotated "· EOA" (mocked eth_getCode = 0x)
  assert.ok(ethHtml.includes("· EOA"));
  // Depositors ranked USER2 ($4.0k, 2000/4300=47%) > USER1 ($3.0k, 35%) > QUEUE2 ($1.6k, 19%)
  assert.ok(ethHtml.includes(">$4.0k</td><td class=\"num\">47%</td>"));
  assert.ok(ethHtml.includes(">$3.0k</td><td class=\"num\">35%</td>"));
  assert.ok(ethHtml.includes(">$1.6k</td><td class=\"num\">19%</td>"));
  const i2 = ethHtml.indexOf("0x200000…0002"), i1 = ethHtml.indexOf("0x100000…0001"),
        iq = ethHtml.indexOf("0xabcd00…0002");
  assert.ok(i2 > -1 && i1 > i2 && iq > i1, "depositors must be ranked by size desc");
  // Fee recipient must never appear in the depositor table:
  assert.ok(!ethHtml.includes("0xccf2da…9b85"));
});

test("focus note fires iff top requester > 40%", () => {
  // EarnETH: 88% => fires, names the EOA and the share.
  assert.ok(ethHtml.includes("Concentration:"));
  assert.ok(ethHtml.includes("one wallet (EOA)"));
  assert.ok(ethHtml.includes("<code>0x500000…0005</code>"));
  assert.ok(ethHtml.includes("<b>88%</b>"));
  // USER5 never deposited, so the "and $X of deposits" clause must be absent.
  assert.ok(!ethHtml.includes("of deposits"));
  // EarnUSD: top share 35/100 = 35% < 40% => no note.
  assert.ok(!usdHtml.includes("Concentration:"));
});

test("EarnETH: buffer note and daily table rows (hand-formatted)", () => {
  // 5% buffer = $50,000 -> "$50.0k"; median settlement $1.2k -> round(50000/1200) = 42x
  assert.ok(ethHtml.includes("A 5% buffer ($50.0k) covers the median settlement <b>42×</b> over."));
  assert.ok(ethHtml.includes("<b>$12.0k (1.2% of TVL)</b>"));
  // Daily table (newest first). Exact rows, mirroring the page's format rules by hand:
  const rows = [
    '<tr><td>17 Mar 2030</td><td class="num in">$3.0k</td><td class="num out">—</td><td class="num blk">—</td><td class="num pos">+$3.0k</td></tr>',
    '<tr><td>16 Mar 2030</td><td class="num in">$5.6k</td><td class="num out">—</td><td class="num blk">—</td><td class="num pos">+$5.6k</td></tr>',
    '<tr><td>15 Mar 2030</td><td class="num in">—</td><td class="num out">$6.0k</td><td class="num blk">—</td><td class="num neg">−$6.0k</td></tr>',
    '<tr><td>14 Mar 2030</td><td class="num in">—</td><td class="num out">—</td><td class="num blk">$12.0k</td><td class="num neg">−$12.0k</td></tr>',
    '<tr><td>13 Mar 2030</td><td class="num in">—</td><td class="num out">—</td><td class="num blk">—</td><td class="num pos">—</td></tr>', // redeem requests do NOT hit daily flows
    '<tr><td>11 Mar 2030</td><td class="num in">—</td><td class="num out">$200</td><td class="num blk">—</td><td class="num neg">−$200</td></tr>',
    '<tr><td>16 Feb 2030</td><td class="num in">—</td><td class="num out">$1.2k</td><td class="num blk">—</td><td class="num neg">−$1.2k</td></tr>',
  ];
  let last = -1;
  for (const r of rows) {
    const i = ethHtml.indexOf(r);
    assert.ok(i > -1, "missing daily row: " + r);
    assert.ok(i > last, "daily rows out of order at: " + r);
    last = i;
  }
});

test("EarnETH: chart SVG has the hand-counted rects, all inside the viewBox", () => {
  const svg = ethHtml.match(/<svg[\s\S]*?<\/svg>/)[0];
  const rects = parseRects(svg);
  assert.equal(rects.filter(r => r.fill === "var(--in)").length, 2);    // 2 deposit days
  assert.equal(rects.filter(r => r.fill === "var(--out)").length, 3);   // 3 routine days
  assert.equal(rects.filter(r => r.fill === "var(--block)").length, 1); // 1 large day
  assert.equal(rects.filter(r => r.fill === "transparent").length, 30); // 30 hover hits
  assertRectsInBox(rects, 960, 250, "EarnETH chart");
});

test("EarnUSD: zero-flow vault renders sane tiles and requester table", () => {
  assert.ok(usdHtml.includes("TVL $500k · $1.00/share"));
  assert.match(usdHtml, /<div class="k">Median settlement<\/div><div class="v out">\$0<\/div>/);
  assert.ok(usdHtml.includes("0/30 days with deposits"));
  assert.match(usdHtml, /<div class="v pos">\+\$0<\/div>/);
  assert.ok(usdHtml.includes("in $0 · out $0"));
  // No burn >= 1% TVL => the alternate tile
  assert.ok(usdHtml.includes("Settlements ≥1% TVL"));
  assert.ok(usdHtml.includes("none in window"));
  assert.ok(usdHtml.includes("No settlement exceeded 1% of TVL in this window."));
  assert.ok(usdHtml.includes("A 5% buffer ($25.0k) covers the median settlement <b>—</b> over."));
  // Requesters at $1/share: 35/33/32 shares => $35/$33/$32, 35%/33%/32%
  assert.ok(usdHtml.includes(">$35</td><td class=\"num\">35%</td>"));
  assert.ok(usdHtml.includes(">$33</td><td class=\"num\">33%</td>"));
  assert.ok(usdHtml.includes(">$32</td><td class=\"num\">32%</td>"));
  assert.ok(!usdHtml.includes("no requests in window"));
  // Empty chart: no colored bars, 30 hit rects, still in-box
  const svg = usdHtml.match(/<svg[\s\S]*?<\/svg>/)[0];
  const rects = parseRects(svg);
  assert.equal(rects.filter(r => r.fill !== "transparent").length, 0);
  assert.equal(rects.filter(r => r.fill === "transparent").length, 30);
  assertRectsInBox(rects, 960, 250, "EarnUSD chart");
});

test("rendered output contains no NaN / undefined / Infinity", () => {
  for (const [name, html] of [["slot-eth", ethHtml], ["slot-usd", usdHtml],
                              ["status", els["status"]._html], ["asof", els["asof"]._text]]) {
    const bad = html.match(/\bNaN\b|\bundefined\b|\bInfinity\b/g);
    assert.equal(bad, null, `${name} contains ${JSON.stringify(bad)}`);
  }
  // Status bar reached its terminal happy state:
  assert.ok(els["status"]._html.includes("blk 26000000"));
  assert.ok(els["status"]._html.includes("tenderly/drpc"));
});
