import net from 'net';

/**
 * Address helpers for account security: masking for display, networks for the new-device rule, and exact CIDR
 * arithmetic for IP rules (net.BlockList can check an address but can't say whether two networks overlap).
 */

export type IpFamily = 4 | 6;

export interface Cidr {
  family: IpFamily;
  /** Network address as an integer (host bits cleared) */
  network: bigint;
  prefix: number;
  /** Canonical text: "203.0.113.0/24", "2001:db8::/32" */
  text: string;
}

const strip = (ip: string) => ip.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

function ipv4ToBigInt(address: string): bigint {
  return address.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

/** The eight 16-bit groups of an IPv6 address (handles "::" and an embedded IPv4 tail) */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const n = Number(ipv4ToBigInt(v4[1]));
    text = `${text.slice(0, -v4[1].length)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail ? tail.split(':') : [];
  const missing = text.includes('::') ? 8 - headParts.length - tailParts.length : 0;
  return [...headParts, ...Array<string>(missing).fill('0'), ...tailParts].map((h) => parseInt(h, 16));
}

function ipv6ToBigInt(address: string): bigint {
  return ipv6Groups(address).reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 0xffn).toString()).join('.');
}

/** RFC 5952: lower case, no leading zeros, the longest run of two or more zero groups as "::" */
function formatIpv6(value: bigint): string {
  const groups = Array.from({ length: 8 }, (_, i) => Number((value >> BigInt((7 - i) * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLength && j - i >= 2) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

const maskOf = (family: IpFamily, prefix: number): bigint => {
  const bits = family === 4 ? 32 : 128;
  return prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
};

/** "203.0.113.7/24" -> network 203.0.113.0/24 (host bits cleared); a bare address is a /32 or /128; null if invalid */
export function parseCidr(input: string): Cidr | null {
  const [rawAddress, prefixText, ...rest] = input.trim().split('/');
  if (rest.length || !rawAddress) return null;
  const family: IpFamily | null = net.isIPv4(rawAddress) ? 4 : net.isIPv6(rawAddress) ? 6 : null;
  if (!family) return null;
  const bits = family === 4 ? 32 : 128;
  if (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = prefixText === undefined ? bits : Number(prefixText);
  if (prefix > bits) return null;
  const value = family === 4 ? ipv4ToBigInt(rawAddress) : ipv6ToBigInt(rawAddress);
  const network = value & maskOf(family, prefix);
  return { family, network, prefix, text: `${family === 4 ? formatIpv4(network) : formatIpv6(network)}/${prefix}` };
}

/** True for IPv4-mapped IPv6 networks (::ffff:0:0/96), which must be written in their IPv4 form */
export function isIpv4Mapped(cidr: Cidr): boolean {
  return cidr.family === 6 && cidr.prefix >= 96 && cidr.network >> 32n === 0xffffn;
}

/** True when the two networks share at least one address */
export function cidrsOverlap(a: Cidr, b: Cidr): boolean {
  if (a.family !== b.family) return false;
  const mask = maskOf(a.family, Math.min(a.prefix, b.prefix));
  return (a.network & mask) === (b.network & mask);
}

/** True when the (possibly IPv4-mapped) address lies inside the network */
export function cidrContains(cidr: Cidr, ip: string | undefined): boolean {
  if (!ip) return false;
  const address = parseCidr(strip(ip));
  return Boolean(address && address.prefix === (address.family === 4 ? 32 : 128) && cidrsOverlap(cidr, address));
}

/** STAFF_ALLOWED_CIDRS as exact networks (the format parseCidrs in @banksphere/common accepts) */
export function parseCidrList(value: string | undefined): Cidr[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const cidr = parseCidr(entry);
      if (!cidr) throw new Error(`Invalid network '${entry}' in STAFF_ALLOWED_CIDRS`);
      return cidr;
    });
}

/**
 * The network part of an address, for display (design section 9): "203.0.113.x" for IPv4 (its /24) and
 * "2001:db8:1::/48" for IPv6. Null for a missing or unparseable address.
 */
export function maskIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const address = strip(ip);
  if (net.isIPv4(address)) return `${address.split('.').slice(0, 3).join('.')}.x`;
  if (!net.isIPv6(address)) return null;
  const network = ipv6ToBigInt(address) & maskOf(6, 48);
  return `${formatIpv6(network)}/48`;
}

/** The network the new-device rule compares (/24 IPv4, /48 IPv6): the same string maskIp shows */
export const networkOf = maskIp;

/**
 * Rate-limit / ban keys (clientIpKey in @banksphere/common): an IPv4 address or an IPv6 /64 written as
 * "2001:db8:1:2::/64". Strict, because the key is interpolated into a Redis key name.
 */
export function isIpKey(value: string): boolean {
  if (net.isIPv4(value)) return true;
  const match = /^([0-9a-f]{1,4}(?::[0-9a-f]{1,4}){3})::\/64$/.exec(value);
  return Boolean(match);
}

/** maskIp for a ban key: the address itself, or the /48 around an IPv6 /64 */
export function maskIpKey(ipKey: string): string | null {
  if (net.isIPv4(ipKey)) return maskIp(ipKey);
  if (!isIpKey(ipKey)) return null;
  return maskIp(ipKey.slice(0, -'/64'.length));
}
