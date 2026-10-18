import { describe, expect, it } from 'vitest';
import { connectSources, contentSecurityPolicy, nginxSecurityHeaders } from './securityHeaders';

describe('web container security headers', () => {
  it('allows the API and its socket on another origin (the Docker Compose layout)', () => {
    const inputs = { apiUrl: 'http://localhost:4000', mapMode: 'offline', mapStyleUrl: undefined };
    expect(connectSources(inputs)).toEqual([
      "'self'",
      'http://localhost:4000',
      'ws://localhost:4000',
    ]);
    expect(connectSources({ ...inputs, apiUrl: 'https://api.example.org/v1' })).toEqual([
      "'self'",
      'https://api.example.org',
      'wss://api.example.org',
    ]);
  });

  it('needs nothing beyond its own origin for a same-origin API path', () => {
    expect(connectSources({ apiUrl: '/api', mapMode: 'offline', mapStyleUrl: undefined })).toEqual([
      "'self'",
    ]);
  });

  it('mirrors the app default API URL when none is configured', () => {
    expect(
      connectSources({ apiUrl: undefined, mapMode: undefined, mapStyleUrl: undefined }),
    ).toContain('http://localhost:4000');
  });

  it('adds the hosted map only in online mode', () => {
    const style = 'https://tiles.openfreemap.org/styles/liberty';
    const base = { apiUrl: '/api', mapStyleUrl: style };
    expect(connectSources({ ...base, mapMode: 'offline' })).not.toContain(
      'https://tiles.openfreemap.org',
    );
    expect(connectSources({ ...base, mapMode: 'online' })).toContain(
      'https://tiles.openfreemap.org',
    );
    // a non-http style URL never widens the policy
    expect(
      connectSources({ ...base, mapMode: 'online', mapStyleUrl: 'javascript:alert(1)' }),
    ).toEqual(["'self'"]);
  });

  it('keeps scripts to this origin and forbids framing and plugins', () => {
    const csp = contentSecurityPolicy({
      apiUrl: '/api',
      mapMode: 'offline',
      mapStyleUrl: undefined,
    });
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval|\*)/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("worker-src 'self' blob:");
  });

  it('renders every header as an always-sent nginx directive, HSTS through the https-only map', () => {
    const conf = nginxSecurityHeaders({
      apiUrl: '/api',
      mapMode: 'offline',
      mapStyleUrl: undefined,
    });
    for (const name of [
      'Content-Security-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
      'Permissions-Policy',
      'Cross-Origin-Opener-Policy',
    ]) {
      expect(conf).toMatch(new RegExp(`^add_header ${name} .+ always;$`, 'm'));
    }
    expect(conf).toMatch(/^add_header Strict-Transport-Security \$vyuha_hsts always;$/m);
  });
});
