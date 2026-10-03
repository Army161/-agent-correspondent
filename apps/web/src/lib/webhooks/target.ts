/**
 * Where a webhook may be delivered.
 *
 * A webhook is a server-side fetch to a URL a tenant chose. Unchecked, that is
 * SSRF: a tenant points it at 127.0.0.1, a cloud metadata service
 * (169.254.169.254), or a private network host, and reads the delivery's
 * recorded status code as a port and route oracle. So the host is resolved and
 * every address it resolves to must be public -- checked when the
 * subscription is created and again immediately before each delivery, since
 * DNS can change in between.
 *
 * Residual risk, stated: a host that answers the check with a public address
 * and the connection with a private one (DNS rebinding inside the TTL) is not
 * fully closed without pinning the resolved address into the connection.
 *
 * Pure apart from the injectable resolver, so it is tested exhaustively.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Resolver = (hostname: string) => Promise<readonly string[]>;

const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

function ipv4ToInt(address: string): number {
  return address.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function inV4Range(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4: readonly [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
];

/** Expand an IPv6 address to eight 16-bit groups. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0] ?? "";
  // An embedded dotted IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) {
    const n = ipv4ToInt(dotted[1]);
    text = text.slice(0, -dotted[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined && left.length !== 8) return null;
  const groups = [...left, ...Array<string>(Math.max(missing, 0)).fill("0"), ...right].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE_V4.some(([base, bits]) => inV4Range(address, base, bits));
  if (family !== 6) return true; // not an address at all: refuse rather than guess

  const g = ipv6Groups(address);
  if (!g) return true;
  const [a, b] = [g[0]!, g[1]!];
  const embeddedV4 = () => `${g[6]! >>> 8}.${g[6]! & 0xff}.${g[7]! >>> 8}.${g[7]! & 0xff}`;

  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateAddress(embeddedV4()); // ::ffff:v4
  if (a === 0x64 && b === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateAddress(embeddedV4()); // NAT64
  if ((a & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((a & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export interface TargetPolicy {
  /** Require https and ignore `allowPrivate`. Driven by ACOR_ENV=production. */
  readonly production: boolean;
  /** Development and CI only: permit loopback/private receivers. */
  readonly allowPrivate: boolean;
  readonly resolve?: Resolver;
}

export function policyFromEnv(): TargetPolicy {
  const production = process.env.ACOR_ENV === "production";
  return {
    production,
    allowPrivate: !production && process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === "true",
  };
}

export type TargetCheck = { ok: true } | { ok: false; reason: string };

export async function checkWebhookTarget(rawUrl: string, policy: TargetPolicy): Promise<TargetCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "url is not a valid URL." };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !policy.production)) {
    return { ok: false, reason: policy.production ? "url must use https." : "url must use http or https." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "url must not contain credentials." };
  }
  if (policy.allowPrivate) return { ok: true };

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: readonly string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await (policy.resolve ?? systemResolver)(host);
    } catch {
      return { ok: false, reason: `url host ${host} does not resolve.` };
    }
  }
  if (addresses.length === 0) return { ok: false, reason: `url host ${host} does not resolve.` };
  const blocked = addresses.find(isPrivateAddress);
  if (blocked) {
    return { ok: false, reason: `url resolves to a non-public address (${blocked}); webhooks are delivered to public hosts only.` };
  }
  return { ok: true };
}
