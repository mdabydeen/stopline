import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveFixtures } from "./server.ts";

type FixtureResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

// Use node:http directly (not fetch): fetch normalizes `%2e%2e` and other
// escapes before sending, which would hide the malformed paths under test.
function get(base: string, rawPath: string): Promise<FixtureResponse> {
  const { hostname, port } = new URL(base);
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request({ hostname, port, path: rawPath, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolvePromise({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", rejectPromise);
    req.end();
  });
}

type Site = {
  url: string;
  close: () => Promise<void>;
  root: string;
  parent: string;
};

// Builds a fixture root and a sibling file at the same level, both under one
// parent temp dir so nothing leaks into the shared OS temp root.
async function withSite(run: (site: Site) => Promise<void>): Promise<void> {
  const parent = mkdtempSync(join(tmpdir(), "stopline-srv-"));
  const root = join(parent, "site");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>home</title><h1>home page</h1>");
  writeFileSync(join(root, "sub", "page.html"), "<!doctype html><h1>sub page</h1>");
  writeFileSync(join(root, "style.css"), "body{color:#000}");
  writeFileSync(join(parent, "sibling.txt"), "OUTSIDE-ROOT");

  let served: { url: string; close: () => Promise<void> } | undefined;
  try {
    served = await serveFixtures(root);
    await run({ ...served, root, parent });
  } finally {
    await served?.close();
    rmSync(parent, { recursive: true, force: true });
  }
}

test("serves the index and subdirectory files with security headers", async () => {
  await withSite(async ({ url }) => {
    const home = await get(url, "/");
    assert.equal(home.status, 200);
    assert.ok(home.body.includes("home page"));
    assert.equal(home.headers["x-content-type-options"], "nosniff");
    assert.match(String(home.headers["content-security-policy"]), /script-src 'none'/);
    assert.match(String(home.headers["content-type"]), /^text\/html; charset=utf-8$/);

    const sub = await get(url, "/sub/page.html");
    assert.equal(sub.status, 200);
    assert.ok(sub.body.includes("sub page"));

    const css = await get(url, "/style.css");
    assert.equal(css.status, 200);
    assert.match(String(css.headers["content-type"]), /^text\/css; charset=utf-8$/);
  });
});

test("malformed percent-encoding returns 400 without crashing", async () => {
  await withSite(async ({ url }) => {
    for (const path of ["/%", "/%E0%A4%A"]) {
      const res = await get(url, path);
      assert.equal(res.status, 400, `expected 400 for ${path}`);
      assert.match(String(res.headers["content-type"]), /^text\/html; charset=utf-8$/);
    }

    // The process must still be alive and serving after the bad requests.
    const home = await get(url, "/");
    assert.equal(home.status, 200);
    assert.ok(home.body.includes("home page"));
  });
});

test("traversal vectors never expose a sibling outside the root", async () => {
  await withSite(async ({ url }) => {
    for (const path of [
      "/%2e%2e/sibling.txt",
      "/sub/%2e%2e/sibling.txt",
      "/..%5c..%5csibling.txt",
      "/%2e%2e%2f%2e%2e%2fsibling.txt",
    ]) {
      const res = await get(url, path);
      assert.equal(res.status, 404, `expected 404 for ${path}`);
      assert.ok(!res.body.includes("OUTSIDE-ROOT"), `leaked the sibling via ${path}`);
    }
  });
});

test("a symlink inside the root pointing outside is not served", async (t) => {
  await withSite(async ({ url, root, parent }) => {
    try {
      symlinkSync(join(parent, "sibling.txt"), join(root, "escape.txt"), "file");
    } catch {
      t.diagnostic("symlinks unsupported on this platform; skipping symlink escape check");
      return;
    }

    const res = await get(url, "/escape.txt");
    assert.equal(res.status, 404);
    assert.ok(!res.body.includes("OUTSIDE-ROOT"));
  });
});

test("missing paths return 404 with an escaped reflected path", async () => {
  await withSite(async ({ url }) => {
    const missing = await get(url, "/nope.html");
    assert.equal(missing.status, 404);

    // URL parsing leaves `'` literal in the pathname; the page must escape it.
    const xss = await get(url, "/'onmouseover=alert(1)");
    assert.equal(xss.status, 404);
    assert.ok(xss.body.includes("&#39;"), "reflected path was not escaped");
    assert.ok(!xss.body.includes("'onmouseover="), "unescaped apostrophe reflected in 404");
  });
});
