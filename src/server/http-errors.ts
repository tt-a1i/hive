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
