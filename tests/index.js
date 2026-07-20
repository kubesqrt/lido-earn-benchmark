// Aggregator so that `node --test tests\` works on Node 22 (Windows):
// the runner passes the directory itself to a child `node tests`, which CJS-resolves
// to this index.js. Importing the test modules registers all their tests in-process.
// Running with an explicit glob (`node --test "tests/*.test.mjs"`) bypasses this file,
// and it does not match the default *.test.* discovery pattern, so tests never run twice.
"use strict";
(async () => {
  await import("./flows-pipeline.test.mjs");
  await import("./formatting-and-math.test.mjs");
  await import("./cross-page-consistency.test.mjs");
  await import("./live-smoke.test.mjs");
})().catch(err => { console.error(err); process.exitCode = 1; });
