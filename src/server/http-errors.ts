export class HttpError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
  }
}

export class PtyInactiveError extends HttpError {
  constructor(message: string) {
    super(409, message)
    this.name = 'PtyInactiveError'
  }
}

export class PromptReadinessTimeoutError extends Error {
  readonly code = 'PROMPT_READINESS_TIMEOUT'
  readonly command: string
  readonly runId: string

  constructor(command: string, runId: string) {
    super(`Timed out waiting for ${command} prompt readiness: ${runId}`)
    this.name = 'PromptReadinessTimeoutError'
    this.command = command
    this.runId = runId
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message: string) {
    super(401, message)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends HttpError {
  constructor(message: string) {
    super(403, message)
    this.name = 'ForbiddenError'
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, message)
    this.name = 'BadRequestError'
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(message: string) {
    super(413, message)
    this.name = 'PayloadTooLargeError'
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message)
    this.name = 'ConflictError'
  }
}

export class UnsupportedMediaTypeError extends HttpError {
  constructor(message: string) {
    super(415, message)
    this.name = 'UnsupportedMediaTypeError'
  }
}
