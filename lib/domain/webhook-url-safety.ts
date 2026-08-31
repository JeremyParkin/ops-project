import { promises as dns } from "node:dns";
import ipaddr from "ipaddr.js";

// SSRF protection for outbound webhook destinations. Canonical parsing +
// IP-range classification (isPublicAddress, assertCanonicalHttpsUrl) are
// pure and covered directly by unit tests. Actual DNS resolution
// (assertPublicHttpsWebhookUrl) takes an injectable `lookup` function rather
// than calling node:dns directly, so tests can exercise the full
// resolve-then-classify path -- including multi-address responses and
// IPv4-mapped IPv6 -- without a real network call or module mocking.
export class UnsafeWebhookUrlError extends Error {}

const BLOCKED_HOSTNAME_SUFFIXES = [".local", ".internal", ".localhost"];

// ipaddr.process() normalizes an IPv4-mapped IPv6 address (::ffff:a.b.c.d)
// to a plain IPv4 address before classifying it, so a mapped-loopback or
// mapped-private address is correctly caught here rather than slipping
// through as an unrecognized IPv6 range. "unicast" is the only range that
// means "ordinary public address" for both IPv4 and IPv6 in ipaddr.js's
// vocabulary -- every other range (private, loopback, linkLocal,
// uniqueLocal, reserved, multicast, unspecified, benchmarking, amt,
// broadcast, carrierGradeNat, as112, and IPv6's teredo/6to4/orchid2/etc.)
// is rejected. This is a fail-closed allowlist, not a denylist of "known
// bad" ranges.
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  return ipaddr.process(address).range() === "unicast";
}

function assertCanonicalHttpsUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeWebhookUrlError("Enter a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new UnsafeWebhookUrlError("Webhook URLs must use https://.");
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new UnsafeWebhookUrlError("Webhook URLs cannot target localhost or internal-style hostnames.");
  }

  // A bare IP literal in the hostname position (URL already strips the
  // brackets from an IPv6 literal) -- classify it directly rather than
  // waiting for the DNS-resolution step, which would just re-parse the
  // same literal.
  if (ipaddr.isValid(hostname) && !isPublicAddress(hostname)) {
    throw new UnsafeWebhookUrlError(`Webhook URLs cannot target a private or reserved address (${hostname}).`);
  }

  return url;
}

export type AddressLookup = (hostname: string) => Promise<string[]>;

async function defaultLookup(hostname: string): Promise<string[]> {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

// Validates canonical form + protocol + hostname denylist synchronously,
// then resolves the hostname and inspects every returned address (a
// hostname can have multiple A/AAAA records; all of them must be public,
// not just the first). Called both when a subscription is created/edited
// and again immediately before every delivery attempt -- DNS can change
// between the two, and re-resolving right before each attempt is the real
// defense against that gap, not a one-time check at creation.
export async function assertPublicHttpsWebhookUrl(rawUrl: string, lookup: AddressLookup = defaultLookup): Promise<URL> {
  const url = assertCanonicalHttpsUrl(rawUrl);

  if (ipaddr.isValid(url.hostname)) return url;

  let addresses: string[];
  try {
    addresses = await lookup(url.hostname);
  } catch {
    throw new UnsafeWebhookUrlError(`Unable to resolve ${url.hostname}.`);
  }

  if (addresses.length === 0) {
    throw new UnsafeWebhookUrlError(`${url.hostname} did not resolve to any address.`);
  }

  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw new UnsafeWebhookUrlError(`${url.hostname} resolves to a private or reserved address (${address}).`);
    }
  }

  return url;
}
