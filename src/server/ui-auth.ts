import { randomUUID } from 'node:crypto'

export interface UiAuth {
  getToken: () => string
  validate: (token: string | undefined) => boolean
}

export const createUiAuth = (): UiAuth => {
  const token = randomUUID()

  return {
    getToken() {
      return token
    },
    validate(input) {
      return input === token
    },
  }
}
