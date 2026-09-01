/**
 * Who is allowed to talk to this server.
 *
 * The Manager runs on the operator's own machine, which makes it tempting to
 * treat as trusted. It is not: it can write `content/`, commit, and push to the
 * repository every install reads. A page open in the same browser — any page,
 * on any site — can issue requests to `127.0.0.1`, and two well-known tricks
 * make that reachable:
 *
 *   CSRF            a form or `fetch` from evil.example aimed at our port. The
 *                   browser sends it; without a check we would act on it.
 *   DNS rebinding   evil.example resolves to 127.0.0.1 on the second lookup, so
 *                   the page is same-origin with us by the browser's reckoning.
 *
 * Three cheap checks close both, with no dependency and no token to store:
 *
 *   1. bind to the loopback interface only, so nothing off this machine can
 *      reach the port at all (`bin.ts`);
 *   2. require the `Host` header to name loopback — a rebinding attack arrives
 *      carrying the attacker's hostname, which is what gives it away;
 *   3. require `Origin`, when the browser sends one, to be an origin we serve.
 *      A cross-site `fetch` cannot forge it, and a cross-site form cannot set
 *      the JSON content type that mutations also require.
 *
 * Everything here is a pure function of the headers so it can be tested without
 * a socket.
 */

export interface RequestFacts {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  contentType: string | undefined;
}

export type GuardVerdict = { ok: true } | { ok: false; status: 403 | 415; reason: string };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The content types a mutation may carry.
 *
 * `application/json` for everything, `application/octet-stream` for raw image
 * bytes. Both are types a cross-site HTML form cannot produce — a form is
 * limited to url-encoded, multipart and plain text — so requiring one of them
 * is what stops a form post from reaching a route at all.
 */
const MUTATION_CONTENT_TYPES = ['application/json', 'application/octet-stream'];

export function checkRequest(facts: RequestFacts, allowedOrigins: readonly string[]): GuardVerdict {
  const hostname = hostnameOf(facts.host);
  if (hostname === null || !LOOPBACK_HOSTS.has(hostname)) {
    return {
      ok: false,
      status: 403,
      reason:
        `Refused: this server answers only to a loopback host, and this request named ` +
        `"${facts.host ?? '(none)'}". If you reached it through a hostname that resolves here, ` +
        'that is a DNS rebinding attempt, not a configuration problem.',
    };
  }

  // A same-origin GET from an address bar has no Origin at all, which is fine.
  // A cross-site request always has one, and cannot lie about it.
  if (facts.origin !== undefined && !allowedOrigins.includes(facts.origin)) {
    return {
      ok: false,
      status: 403,
      reason: `Refused: "${facts.origin}" is not an origin this Manager serves.`,
    };
  }

  if (MUTATING.has(facts.method.toUpperCase())) {
    const type = (facts.contentType ?? '').split(';')[0]!.trim().toLowerCase();
    if (!MUTATION_CONTENT_TYPES.includes(type)) {
      return {
        ok: false,
        status: 415,
        reason:
          `Refused: a ${facts.method} must be ${MUTATION_CONTENT_TYPES.join(' or ')}. ` +
          'A type an HTML form can produce is a type a hostile page can send.',
      };
    }
  }

  return { ok: true };
}

/** The hostname out of a `Host` header, port stripped, IPv6 brackets kept. */
export function hostnameOf(host: string | undefined): string | null {
  if (!host) return null;

  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    return close === -1 ? null : host.slice(0, close + 1).toLowerCase();
  }

  const colon = host.indexOf(':');
  return (colon === -1 ? host : host.slice(0, colon)).toLowerCase();
}
