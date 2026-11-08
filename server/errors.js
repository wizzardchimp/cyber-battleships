/** Client-safe error type used by HTTP routes and socket acknowledgements. */
export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export class GameError extends AppError {
  constructor(code, message) {
    super(code, message, 400);
    this.name = 'GameError';
  }
}

export function assert(condition, code, message) {
  if (!condition) throw new GameError(code, message);
}

export function errorPayload(error) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'SERVER_ERROR', message: 'Something went wrong on the server.' };
}
