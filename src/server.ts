import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

// Serves fixtures/site for the demo. Answers any method with the page, so a
// POST form lands somewhere, and returns a plain page for unknown paths.
export async function serveFixtures(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { ".html": "text/html", ".css": "text/css" };
  const server: Server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^([/\\])+/, "");
    const file = join(root, path || "index.html");
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(file)] ?? "text/plain" });
      res.end(body);
    } catch {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>${path}</title><body><h1>${path}</h1><p>Done.</p></body>`);
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
