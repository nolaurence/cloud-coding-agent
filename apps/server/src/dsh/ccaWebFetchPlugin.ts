import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { FAKE_IP_V4_CIDR, FAKE_IP_V6_CIDR } from "../networkPolicy.js";

const require = createRequire(import.meta.url);

export const CCA_WEB_FETCH_PLUGIN_ID = "cca-web-fetch";
export const CCA_WEB_FETCH_PROVIDER_ID = "cca-http";
export const CCA_WEB_FETCH_PLUGIN_FILE = "cca-web-fetch.mjs";

export function dshWebFetchHttpHref(): string {
  return pathToFileURL(require.resolve("@deepseek-ai/dsh-web-fetch-http")).href;
}

/**
 * Cordis plugin that registers a fetch provider with a resolver that accepts
 * Clash/sing-box Fake-IP DNS answers for hostnames. IP literals in those ranges
 * stay blocked, as do private, link-local, loopback, and cloud-metadata addresses.
 */
export function ccaWebFetchPluginSource(httpFetchHref = dshWebFetchHttpHref()): string {
  return `import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpFetchProvider } from ${JSON.stringify(httpFetchHref)};

export const name = ${JSON.stringify(CCA_WEB_FETCH_PLUGIN_ID)};
export const inject = ['web'];
// Hostname Fake-IP allowlist: ${FAKE_IP_V4_CIDR} / ${FAKE_IP_V6_CIDR}

function stripBrackets(value) {
  return String(value).replace(/^\\[|\\]$/g, '');
}

function isFakeIp(address) {
  const host = stripBrackets(address);
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 198 && b >= 18 && b <= 19;
  }
  if (isIP(host) !== 6) return false;
  const normalized = host.toLowerCase();
  if (normalized.startsWith('::ffff:')) return isIP(normalized.slice(7)) === 4 && isFakeIp(normalized.slice(7));
  const parts = expandIpv6(normalized);
  return parts !== undefined && parts[0] === 0x2001 && parts[1] === 0x0002;
}

function expandIpv6(address) {
  if (address.includes('::')) {
    const [head, tail] = address.split('::');
    const headParts = head ? head.split(':').filter(Boolean) : [];
    const tailParts = tail ? tail.split(':').filter(Boolean) : [];
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return;
    const parts = [...headParts, ...Array.from({ length: missing }, () => '0'), ...tailParts];
    if (parts.length !== 8) return;
    const words = parts.map((part) => Number.parseInt(part, 16));
    return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : undefined;
  }
  const parts = address.split(':');
  if (parts.length !== 8) return;
  const words = parts.map((part) => Number.parseInt(part, 16));
  return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : undefined;
}

function isBlocked(address, allowFakeIp) {
  const host = stripBrackets(address);
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    if (allowFakeIp && a === 198 && b >= 18 && b <= 19) return false;
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224 ||
      (a === 198 && b >= 18 && b <= 19);
  }
  if (isIP(host) !== 6) return true;
  const normalized = host.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    return isIP(mapped) === 4 ? isBlocked(mapped, allowFakeIp) : true;
  }
  if (isFakeIp(normalized)) return !allowFakeIp;
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff');
}

export async function resolveAllowingFakeIp(hostname, signal) {
  const unbracketed = stripBrackets(hostname);
  const literalFamily = isIP(unbracketed);
  const resolved = literalFamily === 0
    ? await lookup(unbracketed, { all: true, verbatim: true })
    : [{ address: unbracketed, family: literalFamily }];
  if (signal?.aborted) {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  }
  if (!resolved.length) {
    const error = new Error('hostname resolved to no addresses');
    error.code = 'WEB_PROVIDER_ERROR';
    throw error;
  }
  const allowFakeIp = literalFamily === 0;
  const addresses = [];
  for (const entry of resolved) {
    if (isBlocked(entry.address, allowFakeIp)) {
      const error = new Error('URL hostname "' + hostname + '" resolves to a non-public IP address');
      error.code = 'WEB_BLOCKED_URL';
      throw error;
    }
    addresses.push({ address: entry.address, family: entry.family });
  }
  return addresses;
}

class CcaHttpFetchProvider {
  id = ${JSON.stringify(CCA_WEB_FETCH_PROVIDER_ID)};
  inner = new HttpFetchProvider({
    maxResponseBytes: 5_000_000,
    maxBodyChars: 100_000,
    timeoutMs: 30_000,
    maxRedirects: 5,
    userAgent: 'cloud-coding-agent/dsh-web-fetch (+https://github.com/nolaurence/cloud-coding-agent)',
  }, resolveAllowingFakeIp);
  available() { return this.inner.available(); }
  fetch(request, signal) { return this.inner.fetch(request, signal); }
}

export function apply(ctx) {
  ctx.web.registerFetchProvider(new CcaHttpFetchProvider());
}
`;
}
