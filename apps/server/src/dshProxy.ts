import http from "node:http";
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import WebSocket from "ws";
import type { DshManager } from "./dshManager.js";

interface AuthUser {
  username: string;
  role: string;
}

interface DshRouteOptions {
  manager: DshManager;
  authenticate(header: string | undefined): AuthUser | null;
}

interface Ticket {
  username: string;
  expiresAt: number;
}

interface PortalSession {
  username: string;
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
  const { manager, authenticate } = options;
  const tickets = new Map<string, Ticket>();
  const sessions = new Map<string, PortalSession>();

  const createTicket = (username: string) => {
    const now = Date.now();
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(key);
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(ticket, { username, expiresAt: now + TICKET_TTL_MS });
    return ticket;
  };

  const consumeTicket = (token: string): Ticket | undefined => {
    const ticket = tickets.get(token);
    tickets.delete(token);
    return ticket && ticket.expiresAt > Date.now() ? ticket : undefined;
  };

  const createSession = (username: string) => {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
    const token = randomBytes(32).toString("base64url");
    sessions.set(token, { username, expiresAt: now + PORTAL_TTL_MS });
    return token;
  };

  const sessionFor = (req: FastifyRequest): PortalSession | undefined => {
    const token = cookieValue(req.headers.cookie, PORTAL_COOKIE);
    if (!token) return undefined;
    const session = sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return undefined;
    }
    return session;
  };

  app.get("/api/dsh/status", async (req, reply) => {
    const user = authenticate(req.headers.authorization);
    if (!user) return reply.code(401).send({ error: "未授权" });
    return manager.status();
  });

  app.post("/api/dsh/retry", async (req, reply) => {
    const user = authenticate(req.headers.authorization);
    if (!user) return reply.code(401).send({ error: "未授权" });
    const status = manager.status();
    if (!status.enabled) return reply.code(503).send({ error: "DeepSeek Harness 已禁用" });
    // A retry may wake a failed launch, but must not interrupt a running one.
    if (!status.ready && !status.starting) manager.reload();
    return manager.status();
  });

  app.post("/api/dsh/ticket", async (req, reply) => {
    const user = authenticate(req.headers.authorization);
    if (!user) return reply.code(401).send({ error: "未授权" });
    const status = manager.status();
    if (!status.enabled) return reply.code(503).send({ error: "DeepSeek Harness 已禁用" });
    return { ticket: createTicket(user.username) };
  });

  app.get("/dsh", async (_req, reply) => reply.redirect("/dsh/", 308));

  app.get("/dsh/enter", async (req, reply) => {
    const query = req.query as { ticket?: string };
    const ticket = query.ticket ? consumeTicket(query.ticket) : undefined;
    if (!ticket) {
      return reply.code(401).type("text/plain; charset=utf-8").send("登录凭据无效或已过期，请刷新页面");
    }
    const host = req.headers.host;
    if (!host) {
      return reply.code(400).type("text/plain; charset=utf-8").send("请求缺少 Host");
    }
    try {
      await manager.waitUntilReady(20_000);
    } catch (error) {
      return reply
        .code(503)
        .type("text/plain; charset=utf-8")
        .send(`DeepSeek Harness 尚未就绪: ${error instanceof Error ? error.message : String(error)}`);
    }
    const port = manager.upstreamPort;
    const launchToken = manager.launchToken;
    if (!port || !launchToken) {
      return reply.code(503).type("text/plain; charset=utf-8").send("DeepSeek Harness 尚未就绪");
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
    const portalToken = createSession(ticket.username);
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
      "set-cookie": [...dshCookies, portalCookie],
    });
    reply.raw.end();
    return reply;
  });

  app.route({
    method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/dsh/*",
    bodyLimit: 64 * 1024 * 1024,
    handler: async (req, reply) => {
      if (!sessionFor(req)) {
        return reply.code(401).type("text/plain; charset=utf-8").send("DeepSeek Harness 会话无效，请刷新页面");
      }
      const port = manager.upstreamPort;
      if (!manager.status().ready || !port) {
        return reply.code(503).type("text/plain; charset=utf-8").send("DeepSeek Harness 尚未就绪");
      }
      const rawUrl = req.raw.url ?? "/dsh/";
      const suffix = rawUrl.slice("/dsh".length) || "/";
      reply.hijack();
      const body = Buffer.isBuffer(req.body)
        ? req.body
        : req.body === undefined
          ? undefined
          : typeof req.body === "string"
            ? Buffer.from(req.body)
            : Buffer.from(JSON.stringify(req.body));
      const headers = sanitizeHeaders(req.raw.headers, req.headers.host, body);
      const upstream = http.request({
        host: "127.0.0.1",
        port,
        path: suffix,
        method: req.method,
        headers,
      });

      upstream.once("response", (response) => {
        const responseHeaders: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
          responseHeaders[name] = value;
        }
        const location = redirectLocation(response.headers.location);
        if (location !== undefined) responseHeaders.location = location;
        const contentType = String(response.headers["content-type"] ?? "");
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
    if (!sessionFor(req)) {
      socket.close(4401, "unauthorized");
      return;
    }
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
    if (req.headers.cookie) headers.cookie = req.headers.cookie;
    if (req.headers.origin) headers.origin = req.headers.origin;
    if (req.headers["user-agent"]) headers["user-agent"] = req.headers["user-agent"];
    const upstream = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`, { headers });
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
    socket.on("close", () => upstream.close());
  });
}
