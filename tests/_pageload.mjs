// Shared test harness: runs a page's <script> inside `vm` with a DOM stub.
// Pattern reused from ../../harness-render.mjs (same DOM-stub approach, but
// with an injectable `fetch` so tests are deterministic).
// This file is a helper, not a test (no .test. in the name).
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function readPage(name) {
  return fs.readFileSync(path.join(ROOT, name), "utf8");
}

export function extractScript(html) {
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error("no <script> block found in page");
  return m[1];
}

function mkEl(id) {
  return {
    id, _html: "", _text: "",
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; },
    style: {}, dataset: {},
    addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
    closest() { return null; }, getBoundingClientRect() { return { width: 0, height: 0 }; },
  };
}

export function makeDom() {
  const els = {};
  const document = { getElementById(id) { return els[id] || (els[id] = mkEl(id)); } };
  return { els, document };
}

// Run flows.html's actual <script> in a fresh vm context.
// `appendix` is JS appended to the page source (used to export internals via _export).
export function runFlowsScript({ fetchImpl, appendix = "" }) {
  const src = extractScript(readPage("flows.html")) + "\n;" + appendix;
  const { els, document } = makeDom();
  const _export = {};
  const ctx = {
    fetch: fetchImpl, setTimeout, clearTimeout, console, Date, JSON, Math,
    AbortSignal, AbortController, parseInt, parseFloat, isNaN, Number, String,
    Array, Object, document, _export, innerWidth: 1200, innerHeight: 800,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "flows.html:<script>" });
  return { els, _export, ctx };
}

export async function waitFor(cond, timeoutMs = 15000, stepMs = 20) {
  const t0 = Date.now();
  while (true) {
    if (cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor: condition not met within " + timeoutMs + "ms");
    await new Promise(r => setTimeout(r, stepMs));
  }
}

// ---- SVG helpers (shared by unit + snapshot tests) ----

// Parses every <rect .../> in an svg string into an attribute object.
export function parseRects(svg) {
  const rects = [];
  for (const m of svg.matchAll(/<rect\b([^>]*?)\/?>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    rects.push(attrs);
  }
  return rects;
}

// Asserts every rect has finite, in-viewBox geometry. Throws with details on violation.
export function assertRectsInBox(rects, W, H, label = "svg") {
  for (const r of rects) {
    const x = Number(r.x), y = Number(r.y), w = Number(r.width), h = Number(r.height);
    for (const [k, v] of [["x", x], ["y", y], ["width", w], ["height", h]]) {
      if (!Number.isFinite(v)) throw new Error(`${label}: rect ${k} not finite: ${JSON.stringify(r)}`);
    }
    if (w < 0 || h < 0) throw new Error(`${label}: negative rect size: ${JSON.stringify(r)}`);
    if (x < 0 || y < 0 || x + w > W + 1e-9 || y + h > H + 1e-9)
      throw new Error(`${label}: rect outside viewBox 0 0 ${W} ${H}: ${JSON.stringify(r)}`);
  }
}
