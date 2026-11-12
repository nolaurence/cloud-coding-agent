import net from "node:net";

/** Clash/sing-box Fake-IP and RFC 2544 benchmark range. */
export const FAKE_IP_V4_CIDR = "198.18.0.0/15";
/** Some Fake-IP stacks also answer AAAA in the RFC 5180 benchmark prefix. */
export const FAKE_IP_V6_CIDR = "2001:2::/48";

export interface SsrfAddressOptions {
  /** Allow RFC 2544 / Clash Fake-IP answers. Never used for IP literals. */
  allowFakeIp?: boolean;
}

function ipv4Octets(address: string): number[] | undefined {
  if (!net.isIPv4(address)) return undefined;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined;
  }
  return parts;
}

function stripIpv6Brackets(address: string): string {
  return address.replace(/^\[|\]$/g, "");
}

/** True for Clash/sing-box Fake-IP and RFC 2544 benchmark addresses. */
export function isFakeIpAddress(address: string): boolean {
  const ipv4 = ipv4Octets(address);
  if (ipv4) return ipv4[0] === 198 && ipv4[1]! >= 18 && ipv4[1]! <= 19;
  if (!net.isIPv6(address)) return false;
  const normalized = stripIpv6Brackets(address).toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (net.isIPv4(mapped)) return isFakeIpAddress(mapped);
  }
  // 2001:2::/48 — compare the first 48 bits of a parsed IPv6 address.
  const expanded = expandIpv6(normalized);
  return expanded !== undefined && expanded[0] === 0x2001 && expanded[1] === 0x0002;
}

function expandIpv6(address: string): number[] | undefined {
  const [head, tail] = address.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  if (address.includes("::")) {
    const missing = 8 - headParts.filter(Boolean).length - tailParts.filter(Boolean).length;
    if (missing < 0) return undefined;
    const parts = [
      ...headParts.filter(Boolean),
      ...Array.from({ length: missing }, () => "0"),
      ...tailParts.filter(Boolean),
    ];
    if (parts.length !== 8) return undefined;
    const words = parts.map((part) => Number.parseInt(part, 16));
    return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : undefined;
  }
  const parts = address.split(":");
  if (parts.length !== 8) return undefined;
  const words = parts.map((part) => Number.parseInt(part, 16));
  return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : undefined;
}

/**
 * SSRF destination check. Blocks loopback, RFC1918, link-local, CGNAT, unspecified,
 * multicast, and IPv4-mapped forms of those ranges. Fake-IP is blocked unless
 * `allowFakeIp` is set (hostname DNS through a TUN proxy).
 */
export function isBlockedSsrfAddress(address: string, options: SsrfAddressOptions = {}): boolean {
  const ipv4 = ipv4Octets(address);
  if (ipv4) {
    const [a, b] = ipv4;
    if (options.allowFakeIp && isFakeIpAddress(address)) return false;
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b! >= 64 && b! <= 127) || a! >= 224 ||
      (a === 198 && b! >= 18 && b! <= 19);
  }
  if (net.isIPv6(address)) {
    const normalized = stripIpv6Brackets(address).toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice("::ffff:".length);
      if (net.isIPv4(mapped)) return isBlockedSsrfAddress(mapped, options);
      const groups = mapped.split(":");
      if (groups.length === 2) {
        const high = Number.parseInt(groups[0]!, 16);
        const low = Number.parseInt(groups[1]!, 16);
        if (Number.isInteger(high) && Number.isInteger(low)) {
          return isBlockedSsrfAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`, options);
        }
      }
      return true;
    }
    if (options.allowFakeIp && isFakeIpAddress(normalized)) return false;
    if (isFakeIpAddress(normalized)) return true;
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff");
  }
  return true;
}

export function hostnameIsIpLiteral(hostname: string): boolean {
  return net.isIP(stripIpv6Brackets(hostname)) !== 0;
}

/** Reject the whole DNS answer set when any address is not an allowed destination. */
export function blockedResolvedAddress(
  hostname: string,
  addresses: readonly string[],
): string | undefined {
  const allowFakeIp = !hostnameIsIpLiteral(hostname);
  for (const address of addresses) {
    if (isBlockedSsrfAddress(address, { allowFakeIp })) return address;
  }
  return undefined;
}
