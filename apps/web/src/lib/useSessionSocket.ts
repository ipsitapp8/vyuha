import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  SOCKET_EVENTS,
  ackSchema,
  eventDtoSchema,
  joinAckSchema,
  lobbyViewSchema,
  perceivedStateSchema,
  sessionStatusEventSchema,
  truthEventDtoSchema,
  truthViewSchema,
  type Ack,
  type EventDto,
  type LobbyView,
  type PerceivedStateDto,
  type PlayerAction,
  type SessionStatusEvent,
  type TruthEventDto,
  type TruthViewDto,
} from '@vyuha/shared';
import { z } from 'zod';

const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const MAX_EVENTS = 200;

export type Connection = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface SessionLive {
  connection: Connection;
  error: string | null;
  role: 'INSTRUCTOR' | 'TRAINEE' | null;
  playerId: string | null;
  lobby: LobbyView | null;
  status: SessionStatusEvent | null;
  perceived: PerceivedStateDto | null;
  truth: TruthViewDto | null;
  playerEvents: EventDto[];
  truthEvents: TruthEventDto[];
  act: (action: PlayerAction) => Promise<Ack>;
}

const NOT_CONNECTED: Ack = {
  ok: false,
  error: { code: 'NOT_IN_SESSION', message: 'Not connected to the exercise yet.' },
};

/**
 * Connects to a session over Socket.IO (auth rides on the httpOnly cookie), joins by code and
 * keeps the latest lobby / status / perceived state / truth. Re-joins automatically on reconnect,
 * and the server answers a join with the current picture, so a refresh loses nothing.
 */
export function useSessionSocket(code: string | null): SessionLive {
  const socketRef = useRef<Socket | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<SessionLive['role']>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [lobby, setLobby] = useState<LobbyView | null>(null);
  const [status, setStatus] = useState<SessionStatusEvent | null>(null);
  const [perceived, setPerceived] = useState<PerceivedStateDto | null>(null);
  const [truth, setTruth] = useState<TruthViewDto | null>(null);
  const [playerEvents, setPlayerEvents] = useState<EventDto[]>([]);
  const [truthEvents, setTruthEvents] = useState<TruthEventDto[]>([]);

  useEffect(() => {
    if (!code) return;
    const socket = io(API_URL, { withCredentials: true });
    socketRef.current = socket;

    const join = (): void => {
      socket.emit(SOCKET_EVENTS.join, { code }, (raw: unknown) => {
        const ack = joinAckSchema.safeParse(raw);
        if (ack.success && ack.data.ok) {
          setRole(ack.data.role);
          setPlayerId(ack.data.playerId);
          setError(null);
          setConnection('connected');
        } else if (ack.success && !ack.data.ok) {
          setError(ack.data.error.message);
          setConnection('failed');
        }
      });
    };

    socket.on('connect', join);
    socket.on('disconnect', () => setConnection('reconnecting'));
    socket.on('connect_error', (err) => {
      setError(
        err.message === 'UNAUTHENTICATED'
          ? 'Your sign-in expired. Sign in again.'
          : 'Cannot reach the VYUHA server.',
      );
      setConnection('reconnecting');
    });
    socket.on(SOCKET_EVENTS.error, (raw: unknown) => {
      const parsed = z.object({ message: z.string() }).safeParse(raw);
      if (parsed.success) setError(parsed.data.message);
    });

    const on = <S extends z.ZodType>(
      event: string,
      schema: S,
      apply: (v: z.infer<S>) => void,
    ): void => {
      socket.on(event, (raw: unknown) => {
        const parsed = schema.safeParse(raw);
        if (parsed.success) apply(parsed.data);
        else setError(`Received an unexpected "${event}" message from the server.`);
      });
    };
    on(SOCKET_EVENTS.lobbyUpdate, lobbyViewSchema, setLobby);
    on(SOCKET_EVENTS.status, sessionStatusEventSchema, setStatus);
    on(SOCKET_EVENTS.perceived, perceivedStateSchema, setPerceived);
    on(SOCKET_EVENTS.truth, truthViewSchema, setTruth);
    on(SOCKET_EVENTS.playerEvents, z.array(eventDtoSchema), (events) =>
      setPlayerEvents((prev) => [...prev, ...events].slice(-MAX_EVENTS)),
    );
    on(SOCKET_EVENTS.truthEvents, z.array(truthEventDtoSchema), (events) =>
      setTruthEvents((prev) => [...prev, ...events].slice(-MAX_EVENTS)),
    );

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [code]);

  const act = useCallback((action: PlayerAction): Promise<Ack> => {
    const socket = socketRef.current;
    if (!socket || !socket.connected) return Promise.resolve(NOT_CONNECTED);
    return new Promise((resolve) => {
      socket
        .timeout(8000)
        .emit(SOCKET_EVENTS.action, action, (timeoutErr: Error | null, raw: unknown) => {
          if (timeoutErr) {
            resolve({
              ok: false,
              error: { code: 'INTERNAL_ERROR', message: 'The server did not answer in time.' },
            });
            return;
          }
          const parsed = ackSchema.safeParse(raw);
          resolve(parsed.success ? parsed.data : NOT_CONNECTED);
        });
    });
  }, []);

  return {
    connection,
    error,
    role,
    playerId,
    lobby,
    status,
    perceived,
    truth,
    playerEvents,
    truthEvents,
    act,
  };
}
