import http from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import WebSocket from "ws";
import type { DshRuntime, DshStatus } from "./dshManager.js";

interface AuthUser {
  username: string;
  role: string;
}

interface DshRouteOptions {
  managers: { forUser(username: string): DshRuntime };
  authenticate(header: string | undefined): AuthUser | null;
  /** Directory of the vendored DSH shell build (`apps/dsh-web/dist`). */
  webDir?: string;
}

interface Ticket {
  username: string;
  authorization: string | undefined;
  expiresAt: number;
}

interface PortalSession {
  username: string;
  authorization: string | undefined;
  cookies: Map<string, string>;
  sockets: Set<WebSocket>;
  expiresAt: number;
}

const TICKET_TTL_MS = 60_000;
const PORTAL_TTL_MS = 12 * 60 * 60_000;
const PORTAL_COOKIE = "cca_dsh_session";
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const LOCALE_SCRIPT =
  '<script>(function(){try{Object.defineProperty(navigator,"language",{get:function(){return "zh-CN"}});Object.defineProperty(navigator,"languages",{get:function(){return ["zh-CN","zh"]}})}catch(e){}})();</script>';

const SHELL_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

/** Files the vendored shell owns below /dsh/; everything else is proxied. */
const SHELL_STATIC_PATH = /^\/(?:assets\/.+|favicon(?:-dark)?\.svg|kloud-logo\.svg|manifest\.webmanifest|robots\.txt)$/;

interface ShellCache {
  path: string;
  mtimeMs: number;
  html: string;
}

let shellCache: ShellCache | undefined;

function resolveWebDir(configured: string | undefined): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    configured,
    process.env.CCA_DSH_WEB_DIR,
    path.resolve(process.cwd(), "apps/dsh-web/dist"),
    path.resolve(here, "../../dsh-web/dist"),
    path.resolve(here, "../../web/dist"),
  ].filter((value): value is string => typeof value === "string" && value.trim() !== "");
  return candidates.find((dir) => fs.existsSync(path.join(dir, "index.html")));
}

async function readShellIndex(webDir: string): Promise<string> {
  const file = path.join(webDir, "index.html");
  const stat = await fs.promises.stat(file);
  if (shellCache?.path === file && shellCache.mtimeMs === stat.mtimeMs) return shellCache.html;
  const html = await fs.promises.readFile(file, "utf8");
  shellCache = { path: file, mtimeMs: stat.mtimeMs, html };
  return html;
}

/**
 * The DSH host renders the boot manifest, module loader, preload rows, and
 * theme bootstrap into its index.html. The vendored shell only replaces the
 * application assets, so lift those injected blocks out of the host page.
 */
function extractBootBlocks(html: string): { head: string; body: string } {
  const headOpen = html.search(/<head(?:\s[^>]*)?>/i);
  const headStart = headOpen >= 0 ? html.indexOf(">", headOpen) + 1 : -1;
  const metaAt = headStart >= 0 ? html.indexOf("<meta charset", headStart) : -1;
  const head = headStart >= 0 && metaAt > headStart ? html.slice(headStart, metaAt) : "";

  const bodyOpen = html.search(/<body(?:\s[^>]*)?>/i);
  const bodyStart = bodyOpen >= 0 ? html.indexOf(">", bodyOpen) + 1 : -1;
  const rootAt = bodyStart >= 0 ? html.indexOf('<div id="root"', bodyStart) : -1;
  const body = bodyStart >= 0 && rootAt > bodyStart ? html.slice(bodyStart, rootAt) : "";

  return {
    head: head.replace(/<base\b[^>]*>/gi, "").trim(),
    body: body.trim(),
  };
}

function fetchDshIndex(port: number, host: string, cookie: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        method: "GET",
        headers: { host, cookie, "accept-encoding": "identity" },
        timeout: 15_000,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`DSH 页面请求失败 (HTTP ${response.statusCode ?? "unknown"})`));
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    request.once("timeout", () => request.destroy(new Error("DSH 页面请求超时")));
    request.once("error", reject);
    request.end();
  });
}

async function renderShell(webDir: string, hostHtml: string): Promise<string> {
  const shell = await readShellIndex(webDir);
  const blocks = extractBootBlocks(hostHtml);
  if (blocks.head === "" && blocks.body === "") {
    throw new Error("DeepSeek Harness 页面缺少 boot 注入，无法挂载自建外壳");
  }
  return shell
    .replace(
      /<head(\s[^>]*)?>/i,
      (tag) => `${tag}${blocks.head === "" ? "" : `\n${blocks.head}`}\n${LOCALE_SCRIPT}`,
    )
    .replace(/<body(\s[^>]*)?>/i, (tag) => `${tag}${blocks.body === "" ? "" : `\n${blocks.body}`}`);
}

function shellStaticFile(webDir: string, suffix: string): string | undefined {
  if (!SHELL_STATIC_PATH.test(suffix)) return undefined;
  let relative: string;
  try {
    relative = decodeURIComponent(suffix);
  } catch {
    return undefined;
  }
  const root = path.resolve(webDir);
  const file = path.resolve(root, `.${relative}`);
  if (file !== root && !file.startsWith(root + path.sep)) return undefined;
  try {
    if (!fs.statSync(file).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return file;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderStartingPage(status: DshStatus): string {
  const reason = status.error
    ? `<p class="detail">${escapeHtml(status.error)}</p>`
    : "<p class=\"detail\">DeepSeek Harness 正在启动，页面会自动刷新。</p>";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>正在启动 · Kloud Work</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #fff; color: #52525b; }
  @media (prefers-color-scheme: dark) { body { background: #151517; color: #a1a1aa; } }
  main { max-width: 34rem; padding: 2rem; text-align: center; }
  .spinner { width: 1.5rem; height: 1.5rem; margin: 0 auto 1rem; border-radius: 50%;
    border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
  .detail { white-space: pre-wrap; word-break: break-word; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head><body><main><div class="spinner"></div>
<strong>正在启动 DeepSeek Harness…</strong>${reason}</main></body></html>`;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const segment of header.split(";")) {
    const at = segment.indexOf("=");
    if (at === -1) continue;
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim();
  }
  return undefined;
}

function isSecureRequest(req: FastifyRequest): boolean {
  if (req.headers["x-forwarded-proto"] === "https") return true;
  return process.env.CCA_PUBLIC_URL?.trim().startsWith("https:") === true;
}

function sanitizeHeaders(
  headers: http.IncomingHttpHeaders,
  host: string | undefined,
  body: Buffer | undefined,
): http.OutgoingHttpHeaders {
  const next: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === "authorization") continue;
    if (name.toLowerCase() === "cookie") continue;
    if (name.toLowerCase() === "accept-encoding") continue;
    if (name.toLowerCase() === "content-length") continue;
    next[name] = value;
  }
  if (host) next.host = host;
  next["accept-encoding"] = "identity";
  if (body) next["content-length"] = String(body.byteLength);
  return next;
}

async function loginHostCookie(
  port: number,
  token: string,
  host: string,
): Promise<string[] | undefined> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: `/?token=${encodeURIComponent(token)}`,
        method: "GET",
        headers: { host, "accept-encoding": "identity" },
        timeout: 15_000,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          const cookie = response.headers["set-cookie"];
          if (response.statusCode !== 303 || !cookie?.length) {
            reject(
              new Error(
                `DSH 登录凭据兑换失败 (HTTP ${response.statusCode ?? "unknown"})`,
              ),
            );
            return;
          }
          resolve(cookie);
        });
      },
    );
    request.once("timeout", () => request.destroy(new Error("DSH 登录凭据兑换超时")));
    request.once("error", reject);
    request.end();
  });
}

function injectDshPage(body: Buffer): Buffer {
  const source = body.toString("utf8");
  if (!source.includes("</head>")) return body;
  const localized = source
    .replace(/<html\s+lang="[^"]*"/i, '<html lang="zh-CN"')
    .replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}${LOCALE_SCRIPT}`);
  return Buffer.from(localized, "utf8");
}

function redirectLocation(value: string | string[] | undefined): string | undefined {
  const location = Array.isArray(value) ? value[0] : value;
  if (!location) return undefined;
  if (!location.startsWith("/") || location.startsWith("//")) return location;
  if (location === "/dsh" || location.startsWith("/dsh/")) return location;
  return `/dsh${location}`;
}

export function registerDshRoutes(app: FastifyInstance, options: DshRouteOptions): void {
  const { managers, authenticate } = options;
  const webDir = resolveWebDir(options.webDir);
  const tickets = new Map<string, Ticket>();
  const sessions = new Map<string, PortalSession>();

  const createTicket = (username: string, authorization: string | undefined) => {
    const now = Date.now();
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(key);
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(ticket, { username, authorization, expiresAt: now + TICKET_TTL_MS });
    return ticket;
  };

  const consumeTicket = (token: string): Ticket | undefined => {
    const ticket = tickets.get(token);
    tickets.delete(token);
    return ticket && ticket.expiresAt > Date.now() ? ticket : undefined;
  };

  const revokeSession = (token: string) => {
    const session = sessions.get(token);
    sessions.delete(token);
    for (const socket of session?.sockets ?? []) socket.close(4401, "session expired");
  };

  const updateCookies = (session: PortalSession, cookies: string[]) => {
    for (const cookie of cookies) {
      const pair = cookie.split(";", 1)[0] ?? "";
      const at = pair.indexOf("=");
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      if (/;\s*max-age=0(?:;|$)/i.test(cookie)) session.cookies.delete(name);
      else session.cookies.set(name, pair);
    }
  };

  const upstreamCookie = (session: PortalSession) => [...session.cookies.values()].join("; ");

  const createSession = (ticket: Ticket, cookies: string[], previousToken: string | undefined) => {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expiresAt <= now) revokeSession(key);
    if (previousToken && sessions.get(previousToken)?.username !== ticket.username) revokeSession(previousToken);
    const token = randomBytes(32).toString("base64url");
    const session: PortalSession = {
      username: ticket.username, authorization: ticket.authorization,
      cookies: new Map(), sockets: new Set(), expiresAt: now + PORTAL_TTL_MS,
    };
    updateCookies(session, cookies);
    sessions.set(token, session);
    return token;
  };

  const sessionFor = (req: FastifyRequest): PortalSession | undefined => {
    const token = cookieValue(req.headers.cookie, PORTAL_COOKIE);
    if (!token) return undefined;
    const session = sessions.get(token);
    if (!session || session.expiresAt <= Date.now() ||
      authenticate(session.authorization)?.username !== session.username ||
      (req.headers.authorization && authenticate(req.headers.authorization)?.username !== session.username)) {
      revokeSession(token);
      return undefined;
    }
    return session;
  };

  app.get("/api/dsh/status", async (req, reply) => {
    const user = authenticate(req.headers.authorization);
    if (!user) return reply.code(401).send({ error: "未授权" });
    return managers.forUser(user.username).status();
  });

  app.post("/api/dsh/retry", async (req, reply) => {
    const user = authenticate(req.headers.authorization);
    if (!user) return reply.code(401).send({ error: "未授权" });
    const manager = managers.forUser(user.username);
    const status = manager.status();
    if (!status.enabled) return reply.code(503).send({ error: "DeepSeek Harness 已禁用" });
    // A retry may wake a failed launch, but must not interrupt a running one.
    if (!status.ready && !status.starting) manager.reload();
    return manager.status();
  });

  app.post("/api/dsh/ticket", async (req, reply) => {
    const user = authenticate(req.headers.authorization);
    if (!user) return reply.code(401).send({ error: "未授权" });
    const manager = managers.forUser(user.username);
    const status = manager.status();
    if (!status.enabled) return reply.code(503).send({ error: "DeepSeek Harness 已禁用" });
    return { ticket: createTicket(user.username, req.headers.authorization) };
  });

  const logoutPortal = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = cookieValue(req.headers.cookie, PORTAL_COOKIE);
    if (token) revokeSession(token);
    return reply
      .header("cache-control", "no-store")
      .header("set-cookie", [
        `${PORTAL_COOKIE}=`,
        "Max-Age=0",
        "Path=/dsh",
        "HttpOnly",
        "SameSite=Strict",
        ...(isSecureRequest(req) ? ["Secure"] : []),
      ].join("; "))
      .send({ ok: true });
  };
  app.post("/api/dsh/logout", logoutPortal);
  // The portal cookie is Path=/dsh, so the browser also needs a route below
  // that prefix to revoke the server-side session before clearing the cookie.
  app.post("/dsh/logout", logoutPortal);

  app.get("/dsh", async (_req, reply) => reply.redirect("/dsh/", 308));

  app.get("/dsh/enter", async (req, reply) => {
    const query = req.query as { ticket?: string };
    const ticket = query.ticket ? consumeTicket(query.ticket) : undefined;
    if (!ticket) {
      return reply.code(401).type("text/plain; charset=utf-8").send("登录凭据无效或已过期，请刷新页面");
    }
    if (authenticate(ticket.authorization)?.username !== ticket.username) {
      return reply.code(401).type("text/plain; charset=utf-8").send("登录凭据已失效，请刷新页面");
    }
    const manager = managers.forUser(ticket.username);
    const host = req.headers.host;
    if (!host) {
      return reply.code(400).type("text/plain; charset=utf-8").send("请求缺少 Host");
    }
    try {
      await manager.waitUntilReady(20_000);
    } catch (error) {
      return reply
        .code(503)
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .send(renderStartingPage({
          ...manager.status(),
          error: error instanceof Error ? error.message : String(error),
        }));
    }
    const port = manager.upstreamPort;
    const launchToken = manager.launchToken;
    if (!port || !launchToken) {
      return reply
        .code(503)
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .send(renderStartingPage(manager.status()));
    }
    let dshCookies: string[];
    try {
      const cookies = await loginHostCookie(port, launchToken, host);
      if (!cookies) throw new Error("DSH 未返回登录 Cookie");
      dshCookies = cookies;
    } catch (error) {
      return reply
        .code(502)
        .type("text/plain; charset=utf-8")
        .send(error instanceof Error ? error.message : String(error));
    }
    const portalToken = createSession(ticket, dshCookies, cookieValue(req.headers.cookie, PORTAL_COOKIE));
    const portalCookie = [
      `${PORTAL_COOKIE}=${portalToken}`,
      `Max-Age=${Math.floor(PORTAL_TTL_MS / 1000)}`,
      "Path=/dsh",
      "HttpOnly",
      "SameSite=Strict",
      ...(isSecureRequest(req) ? ["Secure"] : []),
    ].join("; ");
    reply.hijack();
    reply.raw.writeHead(303, {
      location: "/dsh/",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      // DSH credentials stay server-side and are bound to this CCA user.
      "set-cookie": [portalCookie],
    });
    reply.raw.end();
    return reply;
  });

  app.route({
    method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/dsh/*",
    bodyLimit: 64 * 1024 * 1024,
    handler: async (req, reply) => {
      const rawUrl = req.raw.url ?? "/dsh/";
      const suffix = rawUrl.slice("/dsh".length) || "/";

      // The vendored shell owns its hashed assets; the DSH host never sees them.
      if (webDir !== undefined) {
        const file = shellStaticFile(webDir, suffix);
        if (file !== undefined) {
          const type = SHELL_MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
          return reply
            .header("content-type", type)
            .header(
              "cache-control",
              suffix.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
            )
            .send(fs.createReadStream(file));
        }
      }

      const session = sessionFor(req);
      if (!session) {
        if ((req.method === "GET" || req.method === "HEAD") && (suffix === "/" || suffix === "/index.html")) {
          return reply.redirect("/login", 302);
        }
        return reply.code(401).type("text/plain; charset=utf-8").send("DeepSeek Harness 会话无效，请刷新页面");
      }
      const manager = managers.forUser(session.username);
      const status = manager.status();
      const port = manager.upstreamPort;

      // Serve the copied shell and splice in the boot manifest the per-user DSH
      // host renders for this request. The host's own frontend stays the
      // fallback when the shell build is absent.
      if (
        webDir !== undefined &&
        (suffix === "/" || suffix === "/index.html") &&
        (req.method === "GET" || req.method === "HEAD")
      ) {
        if (!status.ready || !port) {
          return reply
            .code(503)
            .type("text/html; charset=utf-8")
            .header("cache-control", "no-store")
            .send(renderStartingPage(status));
        }
        try {
          const hostHtml = await fetchDshIndex(port, req.headers.host ?? "", upstreamCookie(session));
          const html = await renderShell(webDir, hostHtml);
          return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(html);
        } catch (error) {
          req.log.error({ err: error }, "dsh shell render failed");
          return reply
            .code(502)
            .type("text/html; charset=utf-8")
            .header("cache-control", "no-store")
            .send(renderStartingPage({
              ...status,
              error: error instanceof Error ? error.message : String(error),
            }));
        }
      }

      if (!status.ready || !port) {
        return reply.code(503).type("text/plain; charset=utf-8").send("DeepSeek Harness 尚未就绪");
      }
      reply.hijack();
      const body = Buffer.isBuffer(req.body)
        ? req.body
        : req.body === undefined
          ? undefined
          : typeof req.body === "string"
            ? Buffer.from(req.body)
            : Buffer.from(JSON.stringify(req.body));
      const headers = sanitizeHeaders(req.raw.headers, req.headers.host, body);
      headers.cookie = upstreamCookie(session);
      const upstream = http.request({
        host: "127.0.0.1",
        port,
        path: suffix,
        method: req.method,
        headers,
      });

      upstream.once("response", (response) => {
        updateCookies(session, response.headers["set-cookie"] ?? []);
        const responseHeaders: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
          if (name.toLowerCase() === "set-cookie") continue;
          responseHeaders[name] = value;
        }
        const location = redirectLocation(response.headers.location);
        if (location !== undefined) responseHeaders.location = location;
        const contentType = String(response.headers["content-type"] ?? "");
        if (contentType.includes("text/html") || suffix.startsWith("/api/")) {
          responseHeaders["cache-control"] = "private, no-store";
        }
        const contentEncoding = String(response.headers["content-encoding"] ?? "");
        const shouldLocalize =
          req.method === "GET" &&
          suffix === "/" &&
          contentType.includes("text/html") &&
          !contentEncoding;
        if (!shouldLocalize) {
          reply.raw.writeHead(response.statusCode ?? 502, responseHeaders);
          response.pipe(reply.raw);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size <= 8 * 1024 * 1024) chunks.push(chunk);
        });
        response.once("end", () => {
          if (size > 8 * 1024 * 1024) {
            reply.raw.destroy();
            return;
          }
          const output = injectDshPage(Buffer.concat(chunks));
          delete responseHeaders["content-length"];
          responseHeaders["content-length"] = String(output.byteLength);
          reply.raw.writeHead(response.statusCode ?? 502, responseHeaders);
          reply.raw.end(output);
        });
      });
      upstream.once("error", () => {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          reply.raw.end("DeepSeek Harness 连接失败");
        } else {
          reply.raw.destroy();
        }
      });
      req.raw.once("aborted", () => upstream.destroy());
      reply.raw.once("close", () => upstream.destroy());
      upstream.end(body);
      return reply;
    },
  });

  app.get("/dsh/api/remote.mux", { websocket: true }, (socket, req) => {
    const session = sessionFor(req);
    if (!session) {
      socket.close(4401, "unauthorized");
      return;
    }
    const manager = managers.forUser(session.username);
    const port = manager.upstreamPort;
    if (!manager.status().ready || !port) {
      socket.close(1013, "dsh unavailable");
      return;
    }
    const host = req.headers.host;
    if (!host) {
      socket.close(4400, "missing host");
      return;
    }
    const headers: http.OutgoingHttpHeaders = {
      host,
      "accept-encoding": "identity",
    };
    headers.cookie = upstreamCookie(session);
    if (req.headers.origin) headers.origin = req.headers.origin;
    if (req.headers["user-agent"]) headers["user-agent"] = req.headers["user-agent"];
    const upstream = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`, { headers });
    session.sockets.add(socket);
    const pending: Array<{ data: WebSocket.RawData; binary: boolean }> = [];
    socket.on("message", (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else if (upstream.readyState === WebSocket.CONNECTING) pending.push({ data, binary });
    });
    upstream.on("message", (data, binary) => {
      if (socket.readyState === socket.OPEN) socket.send(data, { binary });
    });
    upstream.on("open", () => {
      for (const message of pending.splice(0)) {
        upstream.send(message.data, { binary: message.binary });
      }
    });
    upstream.on("error", () => socket.close(1011, "dsh unavailable"));
    upstream.on("close", () => socket.close());
    socket.on("close", () => {
      session.sockets.delete(socket);
      upstream.close();
    });
  });
}
