import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

// Headers applied to every response. The fixtures contain no scripts or inline
// styles, so a strict CSP is safe here and blocks injected markup if one ever
// slips through.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'self'; script-src 'none'; object-src 'none'",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// True when `file` is `root` or lives underneath it. `path.relative` avoids the
// bare-string prefix check, which misbehaves for roots like "/" and for
// case/separator edge cases. On Windows `relative` yields `..\\x` for escapes,
// so both separators and `..foo` names are covered.
function isWithin(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

// Only a request path that resolves to inside `root` (or `root` itself) is
// served. This must hold on every platform: on Windows `%5c` decodes to a
// backslash, which resolve/readFile treat as a separator, so a `..`-bearing
// path can escape the fixture dir. The containment check rejects that.
// Throws URIError for malformed percent-encoding; the caller turns that into a
// 400 instead of letting it reject the request handler.
function resolveWithin(root: string, urlPath: string): string | null {
  const decoded = normalize(decodeURIComponent(urlPath)).replace(/^[/\\]+/, "");
  const file = resolve(root, decoded || "index.html");
  return isWithin(root, file) ? file : null;
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

function sendHtml(res: ServerResponse, status: number, heading: string, detail: string): void {
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title></head>` +
      `<body><h1>${heading}</h1>${detail}</body></html>`,
  );
}

function sendError(res: ServerResponse, status: number): void {
  const heading = status === 400 ? "400 — Bad request" : "500 — Server error";
  const detail =
    status === 400 ? "<p>Malformed request path.</p>" : "<p>The fixture server could not answer.</p>";
  sendHtml(res, status, heading, detail);
}

// Serves fixtures/site for the demo. Answers any method with the page, so a
// POST form lands somewhere, and returns a 404 page for unknown paths.
export async function serveFixtures(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const absRoot = resolve(root);
  // Resolve once so symlink checks compare against the real fixture root.
  const realRoot = await realpath(absRoot);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      sendError(res, 400);
      return;
    }

    let file: string | null;
    try {
      file = resolveWithin(absRoot, pathname);
    } catch {
      // decodeURIComponent throws URIError on `/%` or an invalid UTF-8 escape.
      sendError(res, 400);
      return;
    }

    if (!file) {
      sendNotFound(res, pathname);
      return;
    }

    // A symlink inside the root may point anywhere; only the real target is
    // served, and only if it is still inside the real root.
    let real: string;
    try {
      real = await realpath(file);
    } catch {
      sendNotFound(res, pathname);
      return;
    }
    if (!isWithin(realRoot, real)) {
      sendNotFound(res, pathname);
      return;
    }

    let body: Buffer;
    try {
      body = await readFile(real);
    } catch {
      // Missing files, directories, and permission errors all read as 404.
      sendNotFound(res, pathname);
      return;
    }

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": TYPES[extname(real)] ?? "text/plain; charset=utf-8",
    });
    res.end(body);
  }

  function sendNotFound(res: ServerResponse, pathname: string): void {
    // Escape the requested path so a request like /%3cscript%3e cannot inject
    // markup into the 404 page.
    const shown = escapeHtml(pathname);
    sendHtml(res, 404, "404 — Not found", `<p>No fixture at <code>${shown}</code>.</p>`);
  }

  const server: Server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch {
      // Last-resort guard: an async handler must never reject unhandled, or the
      // demo process exits.
      sendError(res, 500);
    }
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      rejectPromise(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  }).catch((err: unknown) => {
    // Do not leave a half-open server behind when listen fails.
    server.close();
    throw err;
  });

  // Errors after startup (e.g. a socket failure) must not crash the process.
  server.on("error", () => {});

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        // Keep-alive sockets would otherwise hold the process open on shutdown.
        server.closeAllConnections();
      }),
  };
}
