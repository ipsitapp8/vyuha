import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest runs with apps/web as the working directory
const conf = readFileSync(resolve('nginx.conf'), 'utf8');

describe('nginx.conf of the web container', () => {
  it('keeps the standard MIME table next to its own types block', () => {
    // A `types { ... }` block replaces the inherited table. Without the include, index.html is served as
    // application/octet-stream and (with nosniff) the browser downloads the page instead of showing it.
    const include = conf.indexOf('include /etc/nginx/mime.types;');
    const types = conf.search(/\n\s*types\s*\{/);
    expect(include).toBeGreaterThan(-1);
    expect(types).toBeGreaterThan(include);
    expect(conf).toMatch(/application\/javascript\s+mjs;/);
  });

  it('serves the single-page app for every route and never for a missing tile archive', () => {
    expect(conf).toMatch(/location \/ \{\s*try_files \$uri \/index\.html;/);
    expect(conf).toMatch(/location \/tiles\/ \{[^}]*try_files \$uri =404;/s);
  });
});
