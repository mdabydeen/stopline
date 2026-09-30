import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, resolve, sep } from "node:path";

// Only a request path that resolves to inside `root` (or `root` itself) is
// served. This must hold on every platform: on Windows `%5c` decodes to a
// backslash, which resolve/readFile treat as a separator, so a `..`-bearing
// path can escape the fixture dir. The containment check rejects that.
function resolveWithin(root: string, urlPath: string): string | null {
  const decoded = normalize(decodeURIComponent(urlPath)).replace(/^[/\\]+/, "");
  const file = resolve(root, decoded || "index.html");
  if (file !== root && !file.startsWith(root + sep)) return null;
  return file;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "/": "&sol;",
  };
  return s.replace(/[&<>"'/]/g, (c) => map[c]);
}

// Serves fixtures/site for the demo. Answers any method with the page, so a
// POST form lands somewhere, and returns a plain page for unknown paths.
export async function serveFixtures(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const absRoot = resolve(root);
  const types: Record<string, string> = { ".html": "text/html", ".css": "text/css" };
  const server: Server = createServer(async (req, res) => {
    const file = resolveWithin(absRoot, new URL(req.url ?? "/", "http://x").pathname);
    if (!file) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>404</title><body><h1>404</h1><p>Done.</p></body>`);
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(file)] ?? "text/plain" });
      res.end(body);
    } catch {
      // Escape the requested path so a request like /%3cscript%3e cannot inject
      // markup into the 404 page.
      const shown = escapeHtml(new URL(req.url ?? "/", "http://x").pathname);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>${shown}</title><body><h1>${shown}</h1><p>Done.</p></body>`);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
