import { z } from 'zod';

/** True in a browser page (the only place a Content-Security-Policy applies). */
export function runsInBrowser(scope: object = globalThis): boolean {
  return 'document' in scope && 'window' in scope;
}

/**
 * Zod 4 probes `new Function` when it builds an object schema, to decide whether it may compile fast
 * parsers. Under the web app's Content-Security-Policy (script-src 'self', no 'unsafe-eval') the probe
 * is blocked and reported as a CSP violation on every page, although Zod catches it. In browsers the
 * probe is switched off (`jitless`); validation results are identical. The server keeps the fast path.
 *
 * This module is the first import of the package index, so it runs before any schema here is built.
 */
if (runsInBrowser()) z.config({ jitless: true });
