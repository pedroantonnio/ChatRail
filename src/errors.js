export class AppError extends Error {
  constructor(message, { status = 400, code = 'APP_ERROR', details = undefined } = {}) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function toErrorBody(error) {
  if (error instanceof AppError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    }
  }

  return {
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error'
    }
  }
}
