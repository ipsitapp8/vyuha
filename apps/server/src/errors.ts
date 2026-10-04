import type { FastifyReply } from 'fastify';
import type { ApiError, ApiErrorCode } from '@vyuha/shared';
import type { ZodError } from 'zod';

export function sendError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
  issues?: ApiError['error']['issues'],
): FastifyReply {
  const body: ApiError = { error: { code, message, ...(issues ? { issues } : {}) } };
  return reply.status(status).send(body);
}

export function sendValidationError(reply: FastifyReply, err: ZodError): FastifyReply {
  return sendError(
    reply,
    400,
    'VALIDATION_ERROR',
    'Request validation failed',
    err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

/** Thrown by services; route/socket layers turn it into a typed error response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
