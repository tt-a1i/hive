export class IntegrationError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IntegrationError'
    this.code = code
  }
}
