import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveFixtures } from "./server.ts";

test("fixture server blocks path traversal and escapes reflected 404", async () => {
  const root = mkdtempSync(join(tmpdir(), "stopline-srv-"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "index.html"), "<!doctype html><h1>home</h1>");
  writeFileSync(join(root, "..", "sibling.txt"), "OUTSIDE-ROOT");

  const { url, close } = await serveFixtures(root);
  const base = url.replace(/\/$/, "");
  try {
    // Traversal attempts must never read the sibling that lives outside root.
    for (const path of [
       "/%2e%2e/sibling.txt",
       "/sub/%2e%2e/sibling.txt",
       "/..%5c..%5csibling.txt",
       "/%2e%2e%2f%2e%2e%2fsibling.txt",
      ]) {
       const body = await (await fetch(base + path)).text();
      assert.ok(!body.includes("OUTSIDE-ROOT"), `leaked the sibling via ${path}`);
     }

    // Normal serving still works.
    assert.ok((await (await fetch(base + "/")).text()).includes("home"));

    // A 404 must not echo a live script tag from the request path.
    const xss = await (await fetch(base + "/%3cscript%3ealert(1)%3c%2fscript%3e")).text();
    assert.ok(!xss.includes("<script>alert(1)</script>"), "unescaped script reflected in 404");
    assert.ok(!/<script/i.test(xss), "a live <script> tag appears in the 404 page");
   } finally {
    await close();
   }
});
