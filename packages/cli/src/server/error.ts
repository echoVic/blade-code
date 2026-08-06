import { type Static, Type } from '../schema/index.js';

export class BladeServerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = 'BladeServerError';
  }

  toObject() {
    return {
      error: {
        code: this.code,
        message: this.message,
      },
    };
  }
}

export class NotFoundError extends BladeServerError {
  constructor(resource: string, id?: string) {
    super(
      'NOT_FOUND',
      id ? `${resource} not found: ${id}` : `${resource} not found`,
      404
    );
  }
}

export class BadRequestError extends BladeServerError {
  constructor(message: string) {
    super('BAD_REQUEST', message, 400);
  }
}

export class ConflictError extends BladeServerError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}

export class TooManyRequestsError extends BladeServerError {
  constructor(message: string) {
    super('TOO_MANY_REQUESTS', message, 429);
  }
}

export class AmbiguousSessionError extends BladeServerError {
  constructor() {
    super(
      'AMBIGUOUS_SESSION',
      'Multiple workspaces contain this session ID; projectPath is required',
      409
    );
  }
}

export class InternalServerError extends BladeServerError {
  constructor(message = 'Internal server error') {
    super('INTERNAL_ERROR', message, 500);
  }
}

export const ErrorResponse = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
});

export type ErrorResponse = Static<typeof ErrorResponse>;
