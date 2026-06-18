import pkg from '../../package.json' with { type: 'json' }

export const APP_VERSION = pkg.version as string
