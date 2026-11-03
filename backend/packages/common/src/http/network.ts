import net from 'net';
import { HttpError } from '../errors/app-error';

/**
 * "10.0.0.0/8,192.168.1.0/24,fd00::/8" -> BlockList, or null when unset (no restriction). A malformed
 * entry throws, so a typo fails at startup instead of silently opening or closing the staff APIs.
 */
export function parseCidrs(value: string | undefined): net.BlockList | null {
  if (!value || !value.trim()) return null;
  const list = new net.BlockList();
  for (const entry of value.split(',').map((e) => e.trim()).filter(Boolean)) {
    const [address, prefix, ...rest] = entry.split('/');
    const family = net.isIPv4(address) ? 'ipv4' : net.isIPv6(address) ? 'ipv6' : null;
    const maxBits = family === 'ipv6' ? 128 : 32;
    if (!family || rest.length || (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > maxBits))) {
      throw new Error(`Invalid network '${entry}' in STAFF_ALLOWED_CIDRS`);
    }
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

/** Client address without the IPv4-mapped IPv6 prefix ("::ffff:10.0.0.1" -> "10.0.0.1") */
export function normaliseClientIp(ip: string | undefined): string {
  return (ip || '').replace(/^::ffff:/i, '');
}

/** True if the (possibly IPv4-mapped) client address is inside one of the networks; false if unknown */
export function isAddressAllowed(networks: net.BlockList, ip: string | undefined): boolean {
  const address = normaliseClientIp(ip);
  if (net.isIPv4(address)) return networks.check(address, 'ipv4');
  if (net.isIPv6(address)) return networks.check(address, 'ipv6');
  return false;
}

/** STAFF_ALLOWED_CIDRS: VPN/office networks staff may work from (null = unrestricted) */
export function staffNetworksFromEnv(env: NodeJS.ProcessEnv = process.env): net.BlockList | null {
  return parseCidrs(env.STAFF_ALLOWED_CIDRS);
}

export function staffNetworkError(message = 'This endpoint is only available from the staff network'): HttpError {
  return new HttpError(403, 'NETWORK_NOT_ALLOWED', message);
}
