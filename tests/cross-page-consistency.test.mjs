// Static cross-page consistency checks (pure file greps as assertions).
// Canonical facts are HARD-CODED here from the project's source of record,
// then every page is checked against them.
import test from "node:test";
import assert from "node:assert/strict";
import { readPage, parseRects, assertRectsInBox } from "./_pageload.mjs";

const idx = readPage("index.html");
const flows = readPage("flows.html");
const snapshot = readPage("flows-snapshot.html");

// Canonical addresses (lowercase):
const ETH_TOKEN = "0xbbfc8683c8fe8cf73777fede7ab9574935fea0a4";
const USD_TOKEN = "0x4ce1ac8f43e0e5bd7a346a98af777bf8fbea1981";
const ETH_VAULT = "0x6a37725ca7f4ce81c004c955f7280d5c704a249e";
const USD_VAULT = "0x014e6da8f283c4af65b2aa0f201438680a004452";

test("share-token / vault addresses identical across index.html and flows.html", () => {
  // 1) All four canonical addresses appear in both pages (case-insensitive).
  for (const [name, addr] of [["EarnETH token", ETH_TOKEN], ["EarnUSD token", USD_TOKEN],
                              ["EarnETH vault", ETH_VAULT], ["EarnUSD vault", USD_VAULT]]) {
    assert.ok(idx.toLowerCase().includes(addr), `index.html missing ${name} ${addr}`);
    assert.ok(flows.toLowerCase().includes(addr), `flows.html missing ${name} ${addr}`);
  }
  // 2) The PAIRING must agree, not just presence. flows.html SHARE config:
  const fEth = flows.match(/name:"EarnETH",\s*token:"(0x[0-9a-fA-F]{40})",\s*vault:"(0x[0-9a-fA-F]{40})"/);
  const fUsd = flows.match(/name:"EarnUSD",\s*token:"(0x[0-9a-fA-F]{40})",\s*vault:"(0x[0-9a-fA-F]{40})"/);
  assert.ok(fEth && fUsd, "flows.html SHARE config not found");
  assert.equal(fEth[1].toLowerCase(), ETH_TOKEN);
  assert.equal(fEth[2].toLowerCase(), ETH_VAULT);
  assert.equal(fUsd[1].toLowerCase(), USD_TOKEN);
  assert.equal(fUsd[2].toLowerCase(), USD_VAULT);
  // index.html: earnETH/earnUSD vault map + vstats token wiring.
  const iEthV = idx.match(/earnETH:\s*\{\s*addr:\s*"(0x[0-9a-fA-F]{40})"/);
  const iUsdV = idx.match(/earnUSD:\s*\{\s*addr:\s*"(0x[0-9a-fA-F]{40})"/);
  assert.ok(iEthV && iUsdV, "index.html earnETH/earnUSD vault map not found");
  assert.equal(iEthV[1].toLowerCase(), ETH_VAULT);
  assert.equal(iUsdV[1].toLowerCase(), USD_VAULT);
  const iEthT = idx.match(/el:\s*"vstatsEth",\s*token:\s*"(0x[0-9a-fA-F]{40})"/);
  const iUsdT = idx.match(/el:\s*"vstatsUsd",\s*token:\s*"(0x[0-9a-fA-F]{40})"/);
  assert.ok(iEthT && iUsdT, "index.html vstats token wiring not found");
  assert.equal(iEthT[1].toLowerCase(), ETH_TOKEN);
  assert.equal(iUsdT[1].toLowerCase(), USD_TOKEN);
});

test("fee description is consistent everywhere fees are mentioned", () => {
  const pages = { "index.html": idx, "flows.html": flows, "flows-snapshot.html": snapshot };
  // Any "<N>% management/mgmt" must be 1; any "<N>% [high-watermark] performance/perf" must be 10.
  const mgmtRe = /(\d+(?:\.\d+)?)\s*%(?:\/yr)?\s*(?:management|mgmt)/gi;
  const perfRe = /(\d+(?:\.\d+)?)\s*%\s*(?:high-watermark\s+)?(?:performance|perf\b)/gi;
  for (const [name, html] of Object.entries(pages)) {
    for (const m of html.matchAll(mgmtRe))
      assert.equal(m[1], "1", `${name}: management fee stated as ${m[0]}`);
    for (const m of html.matchAll(perfRe))
      assert.equal(m[1], "10", `${name}: performance fee stated as ${m[0]}`);
    // Every page that states a fee structure must anchor it to the high-watermark.
    if (html.match(mgmtRe) || html.match(perfRe))
      assert.match(html, /high[- ]watermark/i, `${name} states fees without high-watermark`);
  }
});

test("flows-snapshot.html: frozen banner, clean text, in-box SVGs, no external URLs", () => {
  assert.ok(snapshot.includes("frozen · block"), 'snapshot must carry "frozen · block"');
  const bad = snapshot.match(/\bNaN\b|\bundefined\b/g);
  assert.equal(bad, null, `snapshot contains ${JSON.stringify(bad)}`);
  // Both charts present with the expected viewBox; every rect inside it.
  const svgs = snapshot.match(/<svg[\s\S]*?<\/svg>/g) || [];
  assert.equal(svgs.length, 2, "snapshot must contain exactly two <svg> blocks");
  for (const [i, svg] of svgs.entries()) {
    const vb = svg.match(/viewBox="([\d.\s-]+)"/);
    assert.ok(vb, `svg #${i} has no viewBox`);
    const [x0, y0, w, h] = vb[1].trim().split(/\s+/).map(Number);
    assert.deepEqual([x0, y0, w, h], [0, 0, 960, 250], `svg #${i} unexpected viewBox`);
    const rects = parseRects(svg);
    assert.ok(rects.length > 0, `svg #${i} has no rects`);
    assertRectsInBox(rects, w, h, `snapshot svg #${i}`);
  }
  // Self-contained: no external URL besides Google Fonts hosts.
  const allowed = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
  for (const m of snapshot.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g))
    assert.ok(allowed.has(m[1].toLowerCase()), `snapshot references external host ${m[1]}`);
});
