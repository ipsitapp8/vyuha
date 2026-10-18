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

  it('sends the generated security headers everywhere, HSTS only behind https', () => {
    const include = 'include /etc/nginx/vyuha-security-headers.conf;';
    // server level, and again in each location that has its own add_header (nginx drops inherited ones)
    const blocks = conf.split(/\n\s*location /).slice(1);
    for (const block of blocks.filter((b) => b.includes('add_header'))) {
      expect(block).toContain(include);
    }
    expect(conf.split(include).length - 1).toBeGreaterThanOrEqual(3);
    expect(conf).toMatch(
      /map \$http_x_forwarded_proto \$vyuha_hsts \{\s*https 'max-age=31536000';\s*default '';/,
    );
  });

  it('listens on 8080, the port an unprivileged nginx can bind', () => {
    expect(conf).toMatch(/^\s+listen 8080;$/m);
    expect(conf).not.toMatch(/^\s+listen 80;$/m);
  });

  it('serves the single-page app for every route and never for a missing tile archive', () => {
    expect(conf).toMatch(/location \/ \{\s*try_files \$uri \/index\.html;/);
    expect(conf).toMatch(/location \/tiles\/ \{[^}]*try_files \$uri =404;/s);
  });
});
