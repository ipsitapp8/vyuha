import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards for the container and Compose configuration: no database port on the host, no published
 * secrets, non-root containers. These files are not TypeScript, so a regression would otherwise only
 * show when someone deploys.
 */

const repoFile = (name: string): string =>
  fileURLToPath(new URL(`../../../${name}`, import.meta.url));
const read = (name: string): string => readFileSync(repoFile(name), 'utf8');

/** The lines of one top-level service in a Compose file (indentation-based; the files are hand-kept). */
function service(compose: string, name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`no service ${name}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {0,2}\S/.test(l));
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

/** Everything after the last FROM: the stage that becomes the running image. */
const finalStage = (dockerfile: string): string =>
  dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

const compose = read('docker-compose.yml');
const devCompose = read('docker-compose.dev.yml');

describe('docker-compose.yml', () => {
  it('does not publish PostgreSQL on the host; the server reaches it over the Compose network', () => {
    expect(service(compose, 'db')).not.toMatch(/^\s+ports:/m);
    expect(service(compose, 'server')).toMatch(/DATABASE_URL: postgresql:\/\/[^\n]*@db:5432\//);
  });

  it('requires every secret explicitly and ships no default for any of them', () => {
    expect(compose).toMatch(/POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?/);
    expect(compose).toMatch(/JWT_SECRET: \$\{JWT_SECRET:\?/);
    expect(compose).toMatch(/SEED_PASSWORD: \$\{SEED_PASSWORD:-\}/);
    for (const published of ['vyuha_dev_password', 'Vyuha@123', 'change-me']) {
      expect(compose).not.toContain(published);
    }
    // No ${..._PASSWORD:-value} / ${..._SECRET:-value} fallback anywhere (an empty fallback is allowed).
    expect(compose).not.toMatch(/\$\{[A-Z_]*(PASSWORD|SECRET)[A-Z_]*:-[^}]/);
  });

  it('runs the server and web read-only with no privilege escalation', () => {
    for (const name of ['server', 'web']) {
      const block = service(compose, name);
      expect(block, name).toMatch(/read_only: true/);
      expect(block, name).toMatch(/tmpfs:\s*\n\s+- \/tmp/);
      expect(block, name).toMatch(/no-new-privileges:true/);
    }
    expect(service(compose, 'web')).toContain("'8080:8080'");
  });

  it('publishes the database for local development on loopback only', () => {
    const ports = devCompose.match(/^\s+- '([^']+)'$/gm) ?? [];
    expect(ports.length).toBeGreaterThan(0);
    for (const p of ports) expect(p.trim()).toMatch(/^- '127\.0\.0\.1:/);
  });
});

describe('public demo versus strict deployments', () => {
  it('only the Render blueprint opts into the published demo password, explicitly', () => {
    const render = read('render.yaml');
    expect(render).toMatch(/- key: DEMO_MODE\s*\n\s+value: 'true'/);
    // the opt-in and the published password travel together; nothing else may use that password
    expect(render).toMatch(/- key: SEED_PASSWORD\s*\n\s+value: Vyuha@123/);
    expect(compose).not.toContain('DEMO_MODE');
    expect(compose).not.toContain('SEED_RESET_PASSWORDS');
  });

  it('hides the demo-login box in the strict Docker Compose stack by default', () => {
    expect(service(compose, 'web')).toContain('VITE_SHOW_DEMO_LOGIN: ${SHOW_DEMO_LOGIN:-false}');
    expect(read('apps/web/Dockerfile')).toMatch(/^ARG VITE_SHOW_DEMO_LOGIN=false$/m);
  });
});

describe('readiness and single instance', () => {
  it('starts the web only once the server is ready, and Render runs exactly one instance', () => {
    expect(service(compose, 'server')).toContain("fetch('http://127.0.0.1:4000/health/ready')");
    expect(service(compose, 'web')).toMatch(/server:\s*\n\s+condition: service_healthy/);
    const render = read('render.yaml');
    expect(render).toMatch(/^\s+numInstances: 1$/m);
    expect(render).toMatch(/^\s+healthCheckPath: \/api\/health\/ready$/m);
  });
});

describe('Dockerfiles', () => {
  it('run the API as the unprivileged node user through the entrypoint (server and single image)', () => {
    for (const name of ['apps/server/Dockerfile', 'Dockerfile']) {
      const stage = finalStage(read(name));
      expect(stage, name).toMatch(/^USER node$/m);
      expect(stage, name).toContain('CMD ["/repo/apps/server/docker-entrypoint.sh"]');
      expect(stage, name).not.toMatch(/--chown/); // files stay root-owned, so not writable by node
      expect(stage.indexOf('USER node'), name).toBeGreaterThan(stage.lastIndexOf('RUN '));
    }
  });

  it('serve the web app from the unprivileged nginx build on 8080', () => {
    const stage = finalStage(read('apps/web/Dockerfile'));
    expect(stage).toContain('FROM nginxinc/nginx-unprivileged:');
    expect(stage).toMatch(/^EXPOSE 8080$/m);
    expect(read('apps/web/nginx.conf')).toMatch(/^\s+listen 8080;$/m);
    // the security headers generated by the web build are installed where nginx.conf includes them
    expect(stage).toContain(
      'COPY --from=build /repo/nginx-generated/security-headers.conf /etc/nginx/vyuha-security-headers.conf',
    );
    expect(read('apps/web/Dockerfile')).toContain(
      'RUN mv apps/web/dist/nginx /repo/nginx-generated',
    );
    // the single image serves dist itself, so the nginx file must not end up in its public files
    expect(read('Dockerfile')).toContain('RUN rm -r apps/web/dist/nginx');
  });
});

describe('Node.js version', () => {
  it('is one supported LTS line everywhere: .nvmrc, every Node image and CI', () => {
    const major = read('.nvmrc').trim();
    expect(major).toMatch(/^\d+$/);
    expect(Number(major)).toBeGreaterThanOrEqual(22); // 20 is end-of-life and cannot run the tests
    for (const name of ['Dockerfile', 'apps/server/Dockerfile', 'apps/web/Dockerfile']) {
      const images = read(name).match(/^FROM node:\S+/gm) ?? [];
      expect(images.length, name).toBeGreaterThan(0);
      for (const image of images) expect(image, name).toBe(`FROM node:${major}-slim`);
    }
    const ci = read('.github/workflows/ci.yml');
    expect(ci).not.toMatch(/node-version: /);
    expect(ci.match(/node-version-file: \.nvmrc/g)).toHaveLength(2);
  });
});

describe('docker-entrypoint.sh', () => {
  const script = read('apps/server/docker-entrypoint.sh');

  it('needs no pnpm or network at run time and hands PID 1 to the server', () => {
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toMatch(/^set -eu$/m);
    expect(script).not.toMatch(/^\s*(pnpm|corepack|npx)\b/m);
    expect(script).toContain('./node_modules/.bin/prisma migrate deploy');
    expect(script).toMatch(/^exec node dist\/index\.js$/m);
    // migrations, then the optional seed, then the server
    const order = ['migrate deploy', 'prisma/seed.ts', 'exec node'].map((s) => script.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('is executable in the working tree', () => {
    expect(statSync(repoFile('apps/server/docker-entrypoint.sh')).mode & 0o111).not.toBe(0);
  });
});

describe('example environment files', () => {
  it('leave every production secret blank', () => {
    const env = read('.env.example');
    for (const key of ['POSTGRES_PASSWORD', 'JWT_SECRET', 'SEED_PASSWORD']) {
      expect(env, key).toMatch(new RegExp(`^${key}=$`, 'm'));
    }
    expect(env).not.toContain('vyuha_dev_password');
    expect(read('apps/server/.env.example')).not.toContain('vyuha_dev_password');
  });
});
