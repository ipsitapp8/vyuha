import { afterEach, describe, expect, it } from 'vitest';
import { progressResponseSchema, progressTraineesResponseSchema } from '@vyuha/shared';
import { hashPassword } from '../auth';
import { closeEnv, makeEnv, setupLobby, type Env } from '../sessions/testenv';

/**
 * Progress spans sessions, so it must follow session ownership: an instructor sees a trainee's metrics
 * only from sessions they own or co-instruct, in the API and in the PDF's "Progress so far" section.
 * A trainee always sees their own complete record.
 */

const OWNER = 'inst@x.io';
const OTHER = 'other@x.io';
const FRESH = 'fresh@x.io';

let env: Env | undefined;
afterEach(async () => {
  await closeEnv(env);
  env = undefined;
});

/** Two ended exercises with the same three trainees: one run by OWNER, a later one by OTHER. */
async function twoInstructors() {
  const e = await makeEnv();
  env = e;
  const passwordHash = await hashPassword('Vyuha@123');
  for (const [id, email] of [
    ['u-other', OTHER],
    ['u-fresh', FRESH],
  ] as const) {
    e.mem.users.set(id, { id, name: id, email, role: 'INSTRUCTOR', passwordHash });
  }
  const play = async (instructor: string) => {
    const lobby = await setupLobby(e, instructor);
    expect((await e.api('POST', `/sessions/${lobby.sessionId}/start`, instructor)).status).toBe(
      200,
    );
    await e.app.manager.stepNow(lobby.sessionId, 40);
    expect((await e.api('POST', `/sessions/${lobby.sessionId}/end`, instructor)).status).toBe(200);
    return lobby.sessionId;
  };
  const mine = await play(OWNER);
  e.scheduler.time += 60_000;
  const theirs = await play(OTHER);
  return { e, mine, theirs };
}

const sessionsSeen = async (e: Env, userId: string, as: string): Promise<string[]> => {
  const res = await e.api('GET', `/progress/${userId}`, as);
  expect(res.status).toBe(200);
  return progressResponseSchema.parse(res.body).sessions.map((s) => s.sessionId);
};

const countsSeen = async (e: Env, as: string): Promise<Record<string, number>> => {
  const res = await e.api('GET', '/progress/trainees', as);
  expect(res.status).toBe(200);
  return Object.fromEntries(
    progressTraineesResponseSchema.parse(res.body).trainees.map((t) => [t.id, t.sessionCount]),
  );
};

describe('progress is scoped to the sessions an instructor may review', () => {
  it('shows each instructor only the metrics of their own sessions', async () => {
    const { e, mine, theirs } = await twoInstructors();
    expect(e.mem.sessions.metrics.filter((m) => m.userId === 'u-sec')).toHaveLength(2);

    expect(await sessionsSeen(e, 'u-sec', OWNER)).toEqual([mine]);
    expect(await sessionsSeen(e, 'u-sec', OTHER)).toEqual([theirs]);
    expect(await sessionsSeen(e, 'u-sec', FRESH)).toEqual([]);

    expect(await countsSeen(e, OWNER)).toMatchObject({ 'u-sec': 1, 'u-pl': 1, 'u-out': 0 });
    expect(await countsSeen(e, OTHER)).toMatchObject({ 'u-sec': 1, 'u-pl': 1 });
    expect(await countsSeen(e, FRESH)).toMatchObject({ 'u-sec': 0, 'u-pl': 0, 'u-isr': 0 });
  });

  it('keeps a trainee’s own complete record, and nobody else’s', async () => {
    const { e, mine, theirs } = await twoInstructors();
    expect(await sessionsSeen(e, 'u-sec', 'sec@x.io')).toEqual([mine, theirs]);
    expect((await e.api('GET', '/progress/u-pl', 'sec@x.io')).status).toBe(403);
    expect((await e.api('GET', '/progress/trainees', 'sec@x.io')).status).toBe(403);
    expect((await e.api('GET', '/progress/nobody', OWNER)).status).toBe(404);
  });

  it('follows co-instructor grants and ownerless sessions', async () => {
    const { e, mine, theirs } = await twoInstructors();
    await e.api('POST', `/sessions/${theirs}/instructors`, OTHER, { email: OWNER });
    expect(await sessionsSeen(e, 'u-sec', OWNER)).toEqual([mine, theirs]);
    expect(await countsSeen(e, OWNER)).toMatchObject({ 'u-sec': 2 });

    await e.api('DELETE', `/sessions/${theirs}/instructors/u-inst`, OTHER);
    expect(await sessionsSeen(e, 'u-sec', OWNER)).toEqual([mine]);

    e.mem.sessions.clearOwner(mine);
    expect(await sessionsSeen(e, 'u-sec', OWNER)).toEqual([]);
    expect(await countsSeen(e, OWNER)).toMatchObject({ 'u-sec': 0 });
    // The trainee's own record does not depend on who owns the sessions.
    expect(await sessionsSeen(e, 'u-sec', 'sec@x.io')).toEqual([mine, theirs]);
  });
});

describe('"Progress so far" in the AAR PDF', () => {
  const pdfText = async (e: Env, sessionId: string, as: string): Promise<string> => {
    const res = await e.app.fastify.inject({
      method: 'GET',
      url: `/aar/${sessionId}/export.pdf`,
      headers: { cookie: await e.cookie(as) },
    });
    expect(res.statusCode).toBe(200);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(res.rawPayload),
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      text += content.items.map((it) => ('str' in it ? it.str : '')).join(' ');
    }
    return text.replace(/\s+/g, ' ');
  };

  it('leaves out another instructor’s sessions', async () => {
    const { e, theirs } = await twoInstructors();
    // Every trainee has two sessions, but OTHER may review only the second one.
    expect(await pdfText(e, theirs, OTHER)).not.toContain('Progress so far');
  });

  it('includes earlier sessions the reader may review', async () => {
    const { e, mine, theirs } = await twoInstructors();
    await e.api('POST', `/sessions/${mine}/instructors`, OWNER, { email: OTHER });
    const text = await pdfText(e, theirs, OTHER);
    expect(text).toContain('Progress so far (2 sessions)');
    expect(text.match(/Progress so far/g)).toHaveLength(3); // one section per trainee
  });
});
