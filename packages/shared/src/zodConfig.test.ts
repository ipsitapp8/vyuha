import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runsInBrowser } from './index';

describe('Zod configuration', () => {
  it('turns the eval probe off only in browsers', () => {
    expect(runsInBrowser({ document: {}, window: {} })).toBe(true);
    expect(runsInBrowser({})).toBe(false);
    // the server (this test runs in Node) keeps Zod's fast path
    expect(runsInBrowser()).toBe(false);
    expect(z.config().jitless).not.toBe(true);
  });

  it('runs before any schema of the package is built', () => {
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const firstStatement = index.split('\n').find((l) => /^(import|export)\b/.test(l));
    expect(firstStatement).toBe("import './zodConfig';");
  });
});
