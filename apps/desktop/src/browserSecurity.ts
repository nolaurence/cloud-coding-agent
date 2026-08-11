import net from "node:net";
import { lookup } from "node:dns/promises";

const ALLOW_PRIVATE_NETWORK = process.env.BROWSER_ALLOW_PRIVATE_NETWORK === "true";
export interface BrowserBounds { x: number; y: number; width: number; height: number }

export function isValidBrowserBounds(value: unknown): value is BrowserBounds {
  if (!value || typeof value !== "object") return false;
  const bounds = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((key) => typeof bounds[key] === "number" && Number.isFinite(bounds[key])) &&
    (bounds.x as number) >= 0 && (bounds.y as number) >= 0 && (bounds.width as number) >= 1 && (bounds.height as number) >= 1 &&
    (bounds.x as number) <= 20_000 && (bounds.y as number) <= 20_000 && (bounds.width as number) <= 20_000 && (bounds.height as number) <= 20_000;
}

function privateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127) || a! >= 224;
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) return privateAddress(value.slice(7));
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value) || value.startsWith("ff");
  }
  return true;
}

export async function safeElectronBrowserUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("浏览器地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("仅支持不含凭据的 HTTP 或 HTTPS 地址");
  if (ALLOW_PRIVATE_NETWORK) return url;
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error("浏览器默认禁止访问本机、内网和元数据地址");
  return url;
}
