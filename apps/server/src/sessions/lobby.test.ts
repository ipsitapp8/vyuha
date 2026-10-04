import { afterEach, describe, expect, it } from 'vitest';
import {
  SESSION_CODE_ALPHABET,
  lobbyViewSchema,
  sessionListResponseSchema,
  type LobbyView,
} from '@vyuha/shared';
import { SILENT_RIDGE_ID } from '../seed/silentRidge';
import { closeEnv, makeEnv, setupLobby, type Env } from './testenv';

let env: Env | undefined;
afterEach(async () => {
  await closeEnv(env);
  env = undefined;
});

const INST = 'inst@x.io';

describe('session creation and joining', () => {
  it('creates a session with a 6-character code from the unambiguous alphabet', async () => {
    env = await makeEnv();
    const res = await env.api('POST', '/sessions', INST, { scenarioId: SILENT_RIDGE_ID });
    expect(res.status).toBe(201);
    const view = lobbyViewSchema.parse(res.body);
    expect(view.session.code).toMatch(/^[A-Z2-9]{6}$/);
    for (const ch of view.session.code) expect(SESSION_CODE_ALPHABET).toContain(ch);
    expect(view.session.status).toBe('LOBBY');
    expect(view.units.every((u) => !u.id.startsWith('r-'))).toBe(true);
    expect(view.units.length).toBe(8);
  });

  it('only instructors create sessions; unknown scenarios and bad bodies are rejected', async () => {
    env = await makeEnv();
    expect(
      (await env.api('POST', '/sessions', 'pl@x.io', { scenarioId: SILENT_RIDGE_ID })).status,
    ).toBe(403);
    expect((await env.api('POST', '/sessions', INST, { scenarioId: 'nope' })).status).toBe(404);
    expect((await env.api('POST', '/sessions', INST, {})).status).toBe(400);
    const anon = await env.app.fastify.inject({ method: 'POST', url: '/sessions', payload: {} });
    expect(anon.statusCode).toBe(401);
  });

  it('trainees join by code (case-insensitive); joining twice is idempotent', async () => {
    env = await makeEnv();
    const view = (await env.api('POST', '/sessions', INST, { scenarioId: SILENT_RIDGE_ID }))
      .body as LobbyView;
    const lower = view.session.code.toLowerCase();
    const a = await env.api('POST', '/sessions/join', 'pl@x.io', { code: lower });
    const b = await env.api('POST', '/sessions/join', 'pl@x.io', { code: view.session.code });
    expect(a.status).toBe(200);
    expect((a.body as { playerId: string }).playerId).toBe(
      (b.body as { playerId: string }).playerId,
    );
    const lobby = await env.api('GET', `/sessions/${view.session.id}/lobby`, INST);
    expect((lobby.body as LobbyView).players).toHaveLength(1);
    expect((lobby.body as LobbyView).players[0]?.name).toBe('Asha PL');
  });

  it('rejects unknown codes, malformed codes and instructors joining as players', async () => {
    env = await makeEnv();
    expect((await env.api('POST', '/sessions/join', 'pl@x.io', { code: 'ZZZZZZ' })).status).toBe(
      404,
    );
    expect((await env.api('POST', '/sessions/join', 'pl@x.io', { code: 'abc' })).status).toBe(400);
    expect((await env.api('POST', '/sessions/join', INST, { code: 'ZZZZZZ' })).status).toBe(403);
  });

  it('lobby is visible to the instructor and joined trainees only; lists show all sessions', async () => {
    env = await makeEnv();
    const { sessionId, code } = await setupLobby(env);
    expect((await env.api('GET', `/sessions/${sessionId}/lobby`, 'sec@x.io')).status).toBe(200);
    expect((await env.api('GET', `/sessions/code/${code}/lobby`, 'sec@x.io')).status).toBe(200);
    expect((await env.api('GET', `/sessions/${sessionId}/lobby`, 'out@x.io')).status).toBe(403);
    expect((await env.api('GET', `/sessions/code/${code}/lobby`, 'out@x.io')).status).toBe(403);
    expect((await env.api('GET', '/sessions/nope/lobby', INST)).status).toBe(404);
    const list = sessionListResponseSchema.parse((await env.api('GET', '/sessions', INST)).body);
    expect(list.sessions[0]?.playerCount).toBe(3);
    expect((await env.api('GET', '/sessions', 'pl@x.io')).status).toBe(403);
  });
});

describe('teams, PACE plans and assignments', () => {
  it('manages teams and lets only the team itself (or the instructor) set its PACE plan', async () => {
    env = await makeEnv();
    const { sessionId, teamId } = await setupLobby(env);
    const pace = { primary: 'HF', alternate: 'VHF', contingency: 'DATALINK', emergency: 'RUNNER' };
    const own = await env.api('PATCH', `/sessions/${sessionId}/teams/${teamId}/pace`, 'pl@x.io', {
      pace,
    });
    expect(own.status).toBe(200);
    expect((own.body as LobbyView).teams[0]?.pace.primary).toBe('HF');
    const other = await env.api('POST', `/sessions/${sessionId}/teams`, INST, { name: 'Bravo' });
    const bravo = (other.body as LobbyView).teams[1]?.id ?? '';
    expect(
      (await env.api('PATCH', `/sessions/${sessionId}/teams/${bravo}/pace`, 'pl@x.io', { pace }))
        .status,
    ).toBe(403);
    expect(
      (await env.api('PATCH', `/sessions/${sessionId}/teams/${bravo}/pace`, INST, { pace })).status,
    ).toBe(200);
    expect(
      (await env.api('PATCH', `/sessions/${sessionId}/teams/${bravo}/pace`, 'out@x.io', { pace }))
        .status,
    ).toBe(403);
    const dup = { primary: 'HF', alternate: 'HF', contingency: 'SATCOM', emergency: 'RUNNER' };
    expect(
      (await env.api('PATCH', `/sessions/${sessionId}/teams/${teamId}/pace`, INST, { pace: dup }))
        .status,
    ).toBe(400);
  });

  it('renames and deletes teams (unassigning their players)', async () => {
    env = await makeEnv();
    const { sessionId, teamId } = await setupLobby(env);
    const renamed = await env.api('PATCH', `/sessions/${sessionId}/teams/${teamId}`, INST, {
      name: 'Renamed',
    });
    expect((renamed.body as LobbyView).teams[0]?.name).toBe('Renamed');
    expect(
      (await env.api('PATCH', `/sessions/${sessionId}/teams/${teamId}`, INST, {})).status,
    ).toBe(400);
    const del = await env.api('DELETE', `/sessions/${sessionId}/teams/${teamId}`, INST);
    expect((del.body as LobbyView).teams).toHaveLength(0);
    expect((del.body as LobbyView).players.every((p) => p.teamId === null)).toBe(true);
    expect((await env.api('DELETE', `/sessions/${sessionId}/teams/${teamId}`, INST)).status).toBe(
      404,
    );
  });

  it('enforces unique roles per team, unique units, BLUE-only units and real teams', async () => {
    env = await makeEnv();
    const { sessionId, teamId, players } = await setupLobby(env);
    const put = (playerId: string, body: unknown) =>
      env!.api('PUT', `/sessions/${sessionId}/players/${playerId}`, INST, body);
    expect((await put(players.sec, { role: 'PL_CDR' })).status).toBe(409); // PL already taken
    expect((await put(players.sec, { unitId: 'b-pl' })).status).toBe(409); // unit taken
    expect((await put(players.sec, { unitId: 'r-recce' })).status).toBe(400); // hostile unit
    expect((await put(players.sec, { unitId: 'ghost' })).status).toBe(400);
    expect((await put(players.sec, { teamId: 'nope' })).status).toBe(404);
    expect((await put('nope', { role: 'EW_OFFICER' })).status).toBe(404);
    expect((await put(players.sec, {})).status).toBe(400);
    expect((await put(players.sec, { role: 'EW_OFFICER', unitId: 'b-ew' })).status).toBe(200);
    expect((await put(players.sec, { teamId: null })).status).toBe(200);
    expect(teamId).toBeTruthy();
  });
});

describe('starting an exercise', () => {
  it('lists every problem when the lobby is not playable', async () => {
    env = await makeEnv();
    const created = (await env.api('POST', '/sessions', INST, { scenarioId: SILENT_RIDGE_ID }))
      .body as LobbyView;
    const empty = await env.api('POST', `/sessions/${created.session.id}/start`, INST);
    expect(empty.status).toBe(409);
    await env.api('POST', '/sessions/join', 'pl@x.io', { code: created.session.code });
    const unassigned = await env.api('POST', `/sessions/${created.session.id}/start`, INST);
    expect(JSON.stringify(unassigned.body)).toContain('needs a team, a role and a unit');

    const { sessionId, players } = await setupLobby(env);
    await env.api('PUT', `/sessions/${sessionId}/players/${players.pl}`, INST, {
      role: 'EW_OFFICER',
      unitId: 'b-ew',
    });
    const noPl = await env.api('POST', `/sessions/${sessionId}/start`, INST);
    expect(JSON.stringify(noPl.body)).toContain('platoon commander');
  });

  it('refuses to start without ingested terrain', async () => {
    env = await makeEnv();
    const lobby = await setupLobby(env);
    (env.mem.deps.geo as unknown as { terrain: Map<string, unknown> }).terrain.clear();
    const res = await env.api('POST', `/sessions/${lobby.sessionId}/start`, INST);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('terrain');
  });

  it('start locks the lobby: no more joins, assignments or team edits; only instructors control', async () => {
    env = await makeEnv();
    const { sessionId, code, players, teamId } = await setupLobby(env);
    expect((await env.api('POST', `/sessions/${sessionId}/start`, 'pl@x.io')).status).toBe(403);
    const started = await env.api('POST', `/sessions/${sessionId}/start`, INST);
    expect(started.status).toBe(200);
    expect((started.body as LobbyView).session.status).toBe('RUNNING');
    expect((await env.api('POST', `/sessions/${sessionId}/start`, INST)).status).toBe(409);
    expect((await env.api('POST', '/sessions/join', 'out@x.io', { code })).status).toBe(409);
    expect((await env.api('POST', '/sessions/join', 'pl@x.io', { code })).status).toBe(200); // reconnect ok
    expect(
      (
        await env.api('PUT', `/sessions/${sessionId}/players/${players.pl}`, INST, {
          role: 'EW_OFFICER',
        })
      ).status,
    ).toBe(409);
    expect(
      (await env.api('POST', `/sessions/${sessionId}/teams`, INST, { name: 'Late' })).status,
    ).toBe(409);
    expect((await env.api('DELETE', `/sessions/${sessionId}/teams/${teamId}`, INST)).status).toBe(
      409,
    );
  });

  it('pause, resume, speed and end follow the legal state machine', async () => {
    env = await makeEnv();
    const { sessionId } = await setupLobby(env);
    const status = async (path: string, body?: unknown) =>
      (await env!.api('POST', `/sessions/${sessionId}/${path}`, INST, body)).status;
    expect(await status('pause')).toBe(409); // not running yet
    expect(await status('start')).toBe(200);
    expect(await status('resume')).toBe(409);
    expect(await status('pause')).toBe(200);
    expect(await status('pause')).toBe(409);
    expect(await status('speed', { speed: 3 })).toBe(400);
    const sped = await env.api('POST', `/sessions/${sessionId}/speed`, INST, { speed: 4 });
    expect((sped.body as LobbyView).session.speed).toBe(4);
    expect(await status('resume')).toBe(200);
    expect(await status('end')).toBe(200);
    expect(await status('end')).toBe(409);
    expect(await status('speed', { speed: 2 })).toBe(409);
  });

  it('a lobby session can be ended without ever starting', async () => {
    env = await makeEnv();
    const created = (await env.api('POST', '/sessions', INST, { scenarioId: SILENT_RIDGE_ID }))
      .body as LobbyView;
    const ended = await env.api('POST', `/sessions/${created.session.id}/end`, INST);
    expect((ended.body as LobbyView).session.status).toBe('ENDED');
    expect(
      (await env.api('POST', '/sessions/join', 'pl@x.io', { code: created.session.code })).status,
    ).toBe(409);
  });
});
