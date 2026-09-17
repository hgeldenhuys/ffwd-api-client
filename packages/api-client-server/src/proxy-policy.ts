/**
 * SSRF proxy policy. Pure checks live here; the sender applies them per hop.
 *
 * - Schemes http and https only.
 * - Host must be a hostname, a dotted-quad IPv4 literal, or a bracketed IPv6
 *   literal. Decimal / octal / hex / shortened IPv4 literals are refused.
 * - All A / AAAA records resolved; deny if ANY record falls in a deny range.
 * - ALLOW_PRIVATE_TARGETS=1 lifts the address denies for local development,
 *   and is refused (logged and ignored) when NODE_ENV=production.
 */

import { lookup } from "node:dns/promises";
import { assertNotProductionOverride } from "./env";

export type IpRecord = { address: string; family: 4 | 6 };

export class PolicyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---- IP parsing and range checks -------------------------------------------

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** True when host is a strict dotted-quad IPv4 literal. */
export function isDottedQuad(host: string): boolean {
  return v4ToInt(host) !== null;
}

/**
 * Refuse IP-literal spellings that are NOT a dotted quad or a bracketed IPv6
 * literal: decimal (`2130706433`), hex (`0x7f000001`), shortened (`127.1`),
 * octal (`0177.0.0.1`). Returns an error message when refused.
 */
export function refuseNonCanonicalIpLiteral(host: string): string | null {
  const h = host.replace(/^\[|\]$/g, "");
  if (h.includes(":")) return null; // IPv6 handled elsewhere
  const allNumeric = /^\d+$/.test(h);
  if (allNumeric && !isDottedQuad(h)) {
    return `Host "${host}" is a decimal IP literal, not a hostname: decimal, hex, octal and shortened IP literals are refused to prevent address ambiguity. Use the dotted form (e.g. 127.0.0.1) or a DNS name.`;
  }
  if (/^0[xX]/.test(h) || /^0[oO]/.test(h)) {
    return `Host "${host}" is a hex or octal IP literal: decimal, hex, octal and shortened IP literals are refused. Use the dotted form (e.g. 127.0.0.1) or a DNS name.`;
  }
  const parts = h.split(".");
  const allNumericParts = parts.length > 0 && parts.every((p) => /^\d+$/.test(p));
  if (allNumericParts && !isDottedQuad(h)) {
    // e.g. 127.1 or 0177.0.0.1 — shortened or octal spellings
    if (parts.some((p) => p.length > 1 && p.startsWith("0"))) {
      return `Host "${host}" is an octal or shortened IP literal: decimal, hex, octal and shortened IP literals are refused. Use the full dotted form (e.g. 127.0.0.1) or a DNS name.`;
    }
    return `Host "${host}" is a shortened IP literal: decimal, hex, octal and shortened IP literals are refused. Use the full dotted form (e.g. 127.0.0.1) or a DNS name.`;
  }
  return null;
}

function ipv4ToBytes(ip: string): Uint8Array | null {
  const n = v4ToInt(ip);
  if (n === null) return null;
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function ipv6ToBytes(ip: string): Uint8Array | null {
  let h = ip;
  // strip zone id
  const pct = h.indexOf("%");
  if (pct !== -1) h = h.slice(0, pct);
  if (!h.includes(":")) return null;
  // handle v4-mapped tail
  let tail4: Uint8Array | null = null;
  const lastColon = h.lastIndexOf(":");
  const tail = h.slice(lastColon + 1);
  if (tail.includes(".")) {
    tail4 = ipv4ToBytes(tail);
    if (!tail4) return null;
    h = h.slice(0, lastColon + 1) + "0:0";
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const back = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = 8 - head.length - back.length;
  if (halves.length === 2 && missing < 0) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  const groups: string[] = [...head];
  if (halves.length === 2) {
    for (let i = 0; i < missing; i++) groups.push("0");
  }
  groups.push(...back);
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const v = parseInt(groups[i], 16);
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 255;
  }
  if (tail4) bytes.set(tail4, 12);
  return bytes;
}

export function parseIp(ip: string): { family: 4 | 6; bytes: Uint8Array } | null {
  const v4 = ipv4ToBytes(ip);
  if (v4) return { family: 4, bytes: v4 };
  const v6 = ipv6ToBytes(ip);
  if (v6) return { family: 6, bytes: v6 };
  return null;
}

interface Range {
  prefix: Uint8Array;
  bits: number;
}

function cidr(cidrStr: string): Range {
  const [addr, bitsStr] = cidrStr.split("/");
  const parsed = parseIp(addr);
  if (!parsed) throw new Error(`bad built-in range ${cidrStr}`);
  return { prefix: parsed.bytes, bits: Number(bitsStr) };
}

const DENY_V4 = [
  "0.0.0.0/8",
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map(cidr);

const DENY_V6 = [
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
  "::ffff:0:0/96",
].map(cidr);

function inRange(bytes: Uint8Array, range: Range): boolean {
  let remaining = range.bits;
  for (let i = 0; i < bytes.length && remaining > 0; i++) {
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((bytes[i] & mask) !== (range.prefix[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

/** Apply the IPv4 deny rules to a v4-mapped IPv6 address. */
export function isDeniedIp(ip: string): boolean {
  const parsed = parseIp(ip);
  if (!parsed) return true; // unparsable = deny
  if (parsed.family === 4) {
    return DENY_V4.some((r) => inRange(parsed.bytes, r));
  }
  // v4-mapped ::ffff:a.b.c.d
  const isMapped =
    parsed.bytes.slice(0, 10).every((b) => b === 0) &&
    parsed.bytes[10] === 0xff &&
    parsed.bytes[11] === 0xff;
  if (isMapped) {
    const v4 = parsed.bytes.slice(12);
    return DENY_V4.some((r) => inRange(v4, r));
  }
  return DENY_V6.some((r) => inRange(parsed.bytes, r));
}

export function allowedPrivateTargets(): boolean {
  return assertNotProductionOverride().ok && process.env.ALLOW_PRIVATE_TARGETS === "1";
}

/** Runtime-tunable proxy limits, overridable by the host. */
export interface ProxyPolicyOptions {
  /** Allow targets resolving to private/loopback ranges (local dev only). Default: env-driven. */
  allowPrivateTargets?: boolean;
  /** Upstream send timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Response body cap in bytes. Default 10 MB. */
  maxBytes?: number;
}

// ---- URL / host checks ------------------------------------------------------

export function checkUrlShape(rawUrl: string): { url: URL } {
  // Inspect the TEXTUAL host first: `new URL` normalises decimal/octal/hex
  // IP literals into dotted quads, which would erase the ambiguity we refuse.
  const hostMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:?#]+)/.exec(rawUrl);
  if (hostMatch) {
    const literalMsg = refuseNonCanonicalIpLiteral(decodeURIComponent(hostMatch[1]));
    if (literalMsg) throw new PolicyError("ip_literal", literalMsg);
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PolicyError("bad_url", "The request URL could not be parsed: use a full absolute URL including the scheme.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PolicyError("bad_scheme", `Only http and https are allowed, not "${url.protocol}". Change the URL's scheme.`);
  }
  const host = url.hostname;
  if (!host) throw new PolicyError("bad_host", "The URL has no host: give the request a hostname or IP literal.");
  return { url };
}

export async function resolveHost(host: string): Promise<IpRecord[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  if (!records.length) {
    throw new PolicyError("dns_empty", `The host "${host}" resolved to no addresses: check the hostname.`);
  }
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
}

export function assertAddressesAllowed(records: IpRecord[], allowPrivate?: boolean): void {
  if (allowPrivate ?? allowedPrivateTargets()) return;
  for (const rec of records) {
    if (isDeniedIp(rec.address)) {
      throw new PolicyError(
        "private_target",
        `The host resolves to ${rec.address}, which is in a private or reserved range, so the request was blocked. To allow private targets during local development, set ALLOW_PRIVATE_TARGETS=1.`
      );
    }
  }
}

/** Full check for one hop: URL shape, DNS resolution, address denies. */
export async function checkTarget(rawUrl: string, allowPrivate?: boolean): Promise<{ url: URL; addresses: IpRecord[] }> {
  const { url } = checkUrlShape(rawUrl);
  const addresses = await resolveHost(url.hostname);
  assertAddressesAllowed(addresses, allowPrivate);
  return { url, addresses };
}

// ---- Redirect handling ------------------------------------------------------

export const MAX_REDIRECTS = 5;

/**
 * Given a response that is a redirect, decide the next hop. The caller must
 * re-run the whole policy on the returned URL. Returns null when not a
 * redirect or when the hop budget is exhausted (throws in the latter case).
 */
export function nextRedirectUrl(currentUrl: URL, status: number, locationHeader: string | null, hop: number): URL | null {
  if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) {
    return null;
  }
  if (hop >= MAX_REDIRECTS) {
    throw new PolicyError("too_many_redirects", `The request followed ${MAX_REDIRECTS} redirects without reaching a final response: the redirect chain was stopped.`);
  }
  if (!locationHeader) {
    throw new PolicyError("redirect_no_location", "The server sent a redirect without a Location header, so the next hop cannot be determined.");
  }
  return new URL(locationHeader, currentUrl);
}

/**
 * Strip auth-bearing headers when a redirect changes origin, and never carry
 * the app's own session cookie onto any hop. 303 always becomes GET and drops
 * the body, as do 301/302 for POST.
 */
export function hopRequest(
  originalHeaders: Headers,
  fromUrl: URL,
  toUrl: URL,
  status: number,
  method: string
): { headers: Headers; method: string; dropBody: boolean } {
  const headers = new Headers();
  for (const [k, v] of originalHeaders.entries()) {
    const lower = k.toLowerCase();
    if (lower === "host" || lower === "cookie" || lower === "content-length") continue;
    headers.set(k, v);
  }
  if (fromUrl.origin !== toUrl.origin) {
    headers.delete("authorization");
    headers.delete("cookie");
  }
  let newMethod = method;
  let dropBody = false;
  if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
    newMethod = "GET";
    dropBody = true;
  }
  return { headers, method: newMethod, dropBody };
}
