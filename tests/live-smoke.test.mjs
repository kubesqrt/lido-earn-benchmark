// Live network sanity checks. Every subtest SKIPS (never fails) when the network
// or a public endpoint is unavailable, so an offline run keeps the suite green.
// Expectations here are deliberately loose sanity bounds, not exact values.
import test from "node:test";
import assert from "node:assert/strict";

const RPCS = [
  "https://gateway.tenderly.co/public/mainnet",
  "https://eth.drpc.org",
  "https://eth-mainnet.public.blastapi.io",
];
const ETH_TOKEN = "0xBBFC8683C8fE8cF73777feDE7ab9574935fea0A4";
const USD_TOKEN = "0x4Ce1ac8F43E0E5BD7A346A98aF777bF8fbeA1981";
const ETH_VAULT = "0x6a37725ca7f4CE81c004c955f7280d5C704a249e";
const USD_VAULT = "0x014e6DA8F283C4aF65B2AA0f201438680A004452";

class Unavailable extends Error {} // network/endpoint trouble => skip, not fail

async function rpc(method, params, urls = RPCS) {
  let lastErr = "no endpoint answered";
  for (const u of urls) {
    try {
      const r = await fetch(u, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json();
      if (j && j.result !== undefined && j.result !== null) return j.result;
      lastErr = `${u}: ${JSON.stringify(j && j.error || j).slice(0, 200)}`;
    } catch (e) { lastErr = `${u}: ${e.message}`; }
  }
  throw new Unavailable(`${method}: ${lastErr}`);
}

async function mellowData(vault) {
  const url = `https://api.mellow.finance/v1/chain/1/core-vaults/${vault}/data`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch (e) { throw new Unavailable(`mellow ${vault}: ${e.message}`); }
}

const sumTvl = d => d.allocations.reduce((s, a) => s + (+a.tvl.usd) / Math.pow(10, a.tvl.usd_decimals), 0);

let headMemo; // memoized so later subtests reuse the first answer
async function getHead() {
  if (headMemo === undefined) {
    try { headMemo = parseInt(await rpc("eth_blockNumber", []), 16); }
    catch (e) { headMemo = e; }
  }
  if (headMemo instanceof Error) throw headMemo;
  return headMemo;
}

const skipIfOffline = (t, e) => {
  if (e instanceof Unavailable) { t.skip("network unavailable — " + e.message); return true; }
  return false;
};

test("live smoke (auto-skips offline)", async t => {
  await t.test("RPC gateway eth_blockNumber > 25,000,000", async t => {
    let head;
    try { head = await getHead(); } catch (e) { if (skipIfOffline(t, e)) return; throw e; }
    assert.ok(Number.isInteger(head), "block number must parse to an integer");
    assert.ok(head > 25_000_000, `mainnet head ${head} should be past block 25M (mid-2026+)`);
  });

  await t.test("one 9,900-block eth_getLogs chunk on earnETH returns an array", async t => {
    try {
      const head = await getHead();
      const logs = await rpc("eth_getLogs", [{
        address: ETH_TOKEN,
        fromBlock: "0x" + (head - 9899).toString(16),
        toBlock: "0x" + head.toString(16),
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"],
      }]);
      assert.ok(Array.isArray(logs), "eth_getLogs must return an array");
      for (const l of logs.slice(0, 5)) { // spot-check shape of a few entries
        assert.match(l.blockNumber, /^0x[0-9a-f]+$/i);
        assert.equal(l.address.toLowerCase(), ETH_TOKEN.toLowerCase());
        assert.ok(Array.isArray(l.topics) && l.topics.length >= 1);
      }
    } catch (e) { if (skipIfOffline(t, e)) return; throw e; }
  });

  await t.test("Mellow /data: allocations with tvl.usd + usd_decimals, summed TVL > $1M", async t => {
    try {
      let total = 0;
      for (const vault of [ETH_VAULT, USD_VAULT]) {
        const d = await mellowData(vault);
        assert.ok(Array.isArray(d.allocations) && d.allocations.length > 0,
          `${vault}: allocations[] missing or empty`);
        for (const a of d.allocations) {
          assert.ok(a.tvl && a.tvl.usd !== undefined, `${vault}: allocation missing tvl.usd`);
          assert.ok(Number.isFinite(+a.tvl.usd), `${vault}: tvl.usd not numeric: ${a.tvl.usd}`);
          assert.ok(Number.isInteger(a.tvl.usd_decimals), `${vault}: usd_decimals missing`);
        }
        const tvl = sumTvl(d);
        assert.ok(Number.isFinite(tvl) && tvl > 0, `${vault}: TVL sum not positive`);
        total += tvl;
      }
      assert.ok(total > 1_000_000, `combined vault TVL $${Math.round(total)} should exceed $1M`);
    } catch (e) { if (skipIfOffline(t, e)) return; throw e; }
  });

  await t.test("share price = TVL/totalSupply is sane (EarnUSD within $0.5–$5)", async t => {
    try {
      for (const [name, token, vault, lo, hi] of [
        ["EarnETH", ETH_TOKEN, ETH_VAULT, 0, Infinity], // loose: finite and > 0
        ["EarnUSD", USD_TOKEN, USD_VAULT, 0.5, 5],       // a USD share ~ $1-ish
      ]) {
        const supHex = await rpc("eth_call", [{ to: token, data: "0x18160ddd" }, "latest"]);
        const supply = parseInt(supHex, 16) / 1e18;
        assert.ok(Number.isFinite(supply) && supply > 0, `${name}: bad totalSupply ${supHex}`);
        const tvl = sumTvl(await mellowData(vault));
        const price = tvl / supply;
        assert.ok(Number.isFinite(price) && price > 0, `${name}: share price not finite/positive`);
        assert.ok(price >= lo && price <= hi,
          `${name}: share price $${price.toFixed(4)} outside [${lo}, ${hi}]`);
      }
    } catch (e) { if (skipIfOffline(t, e)) return; throw e; }
  });
});
