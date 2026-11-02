/**
 * A deliberately small User-Agent reader: browser family and OS family, enough to label a session ("Chrome on
 * Windows", "Safari on iPhone") and to recognise "the same browser on the same OS" for new-device alerts.
 * Versions are ignored on purpose: a browser update must not look like a new device. User agents are
 * client-controlled, so the result is a hint for the account holder, never a security decision on its own.
 */
export interface ParsedUserAgent {
  browser: string;
  os: string;
  label: string;
}

export const UNKNOWN_BROWSER = 'Unknown browser';
export const UNKNOWN_OS = 'Unknown OS';

/** Stored user agents are cut to this length (headers can be several KB) */
export const MAX_USER_AGENT_LENGTH = 512;

// Order matters: Edge, Opera and Samsung Internet also send "Chrome/", and Chrome also sends "Safari/"
const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bCriOS\/|\bChrome\/|\bChromium\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\/|\bAppleWebKit\/.*\bMobile\//, 'Safari'],
];

// iOS user agents say "like Mac OS X" and Android ones say "Linux": the specific platforms come first
const SYSTEMS: Array<[RegExp, string]> = [
  [/\biPhone\b/, 'iPhone'],
  [/\biPad\b/, 'iPad'],
  [/\biPod\b/, 'iPod'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows Phone\b/, 'Windows Phone'],
  [/\bWindows\b/, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMacintosh\b|\bMac OS X\b/, 'macOS'],
  [/\bLinux\b|\bX11\b/, 'Linux'],
];

/** Printable, trimmed and length-limited, or null when absent */
export function cleanUserAgent(userAgent: string | undefined | null): string | null {
  if (!userAgent) return null;
  // eslint-disable-next-line no-control-regex
  const clean = userAgent.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_USER_AGENT_LENGTH);
  return clean || null;
}

export function parseUserAgent(userAgent: string | undefined | null): ParsedUserAgent {
  const ua = cleanUserAgent(userAgent) ?? '';
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? UNKNOWN_BROWSER;
  const os = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? UNKNOWN_OS;
  const label =
    browser === UNKNOWN_BROWSER && os === UNKNOWN_OS
      ? 'Unknown device'
      : browser === UNKNOWN_BROWSER
        ? `Unknown browser on ${os}`
        : os === UNKNOWN_OS
          ? browser
          : `${browser} on ${os}`;
  return { browser, os, label };
}
