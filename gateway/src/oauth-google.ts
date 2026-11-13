// Google OAuth / OIDC (authorization-code + PKCE + nonce). Accounts key on the id_token `sub` — the
// stable Google account id — never on email. The id_token is verified against Google's JWKS with the
// algorithm PINNED to RS256 (blocks alg:none and RS<->HS confusion), issuer pinned to env.GOOGLE_ISSUER
// (no hardcoded provider literal — HARDEN §4.4), audience pinned to our client_id, exp enforced, and
// the nonce matched to the one we put in the flow cookie. Only after ALL checks do we read claims.

import type { Context } from 'hono'
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose'
import type { Env } from './env.js'
import {
  FLOW_TTL_MS,
  flowClearCookie,
  flowSetCookie,
  GOOGLE_FLOW_COOKIE,
  OAuthError,
  randB64url,
  readFlowCookie,
  sha256Base64url,
  signFlowState,
  upsertIdentity,
  validateRedirect,
  verifyFlowState,
} from './oauth-common.js'
import { BROWSER_SESSION_TTL_MS, mintSession, sessionSetCookie } from './sessions.js'

const CALLBACK_PATH = '/auth/google/callback'
const GOOGLE_SCOPE = 'openid email profile'

type Ctx = Context<{ Bindings: Env }>

function fail(code: string, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      'content-type': 'application/json',
      'Set-Cookie': flowClearCookie(GOOGLE_FLOW_COOKIE, CALLBACK_PATH),
    },
  })
}

export async function googleAuthorize(c: Ctx): Promise<Response> {
  const env = c.env
  const redirect = validateRedirect(env, c.req.query('redirect') ?? null)
  const state = randB64url(32)
  const codeVerifier = randB64url(32)
  const nonce = randB64url(32)
  const challenge = await sha256Base64url(codeVerifier)

  const flow = await signFlowState(env, {
    p: 'google',
    state,
    codeVerifier,
    nonce,
    redirect,
    exp: Date.now() + FLOW_TTL_MS,
  })

  const authorizeUrl = new URL(`${env.GOOGLE_OAUTH_BASE}/auth`)
  authorizeUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('scope', GOOGLE_SCOPE)
  authorizeUrl.searchParams.set('redirect_uri', `${env.GATEWAY_ORIGIN}${CALLBACK_PATH}`)
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('nonce', nonce)
  authorizeUrl.searchParams.set('code_challenge', challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
  authorizeUrl.searchParams.set('access_type', 'online')
  authorizeUrl.searchParams.set('prompt', 'select_account')

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl.toString(),
      'Set-Cookie': flowSetCookie(GOOGLE_FLOW_COOKIE, flow, CALLBACK_PATH),
    },
  })
}

export async function googleCallback(c: Ctx): Promise<Response> {
  const env = c.env
  const req = c.req.raw

  const code = c.req.query('code')
  const queryState = c.req.query('state')
  const providerError = c.req.query('error')
  const flowCookie = readFlowCookie(req, GOOGLE_FLOW_COOKIE)

  if (flowCookie === null) return fail('invalid_state', 400)
  const flow = await verifyFlowState(env, flowCookie)
  if (flow === null || flow.p !== 'google') return fail('invalid_state', 400)

  if (providerError !== undefined) return fail('access_denied', 400)
  if (!queryState || queryState !== flow.state) return fail('state_mismatch', 400)
  if (!code) return fail('missing_code', 400)
  if (flow.nonce === undefined) return fail('invalid_state', 400)

  try {
    const { idToken } = await googleExchangeCode(env, code, flow.codeVerifier)
    const verified = await googleVerifyIdToken(env, idToken, flow.nonce)

    const { userId } = await upsertIdentity(env, {
      provider: 'google',
      providerSub: verified.sub,
      email: verified.email,
      displayName: verified.name,
    })
    const { token } = await mintSession(env, {
      userId,
      deviceId: null,
      ttlMs: BROWSER_SESSION_TTL_MS,
    })
    const redirect = validateRedirect(env, flow.redirect)
    return new Response(null, {
      status: 302,
      headers: new Headers([
        ['Location', redirect],
        ['Set-Cookie', sessionSetCookie(token, BROWSER_SESSION_TTL_MS)],
        ['Set-Cookie', flowClearCookie(GOOGLE_FLOW_COOKIE, CALLBACK_PATH)],
      ]),
    })
  } catch (err) {
    const status = err instanceof OAuthError ? err.status : 400
    const codeStr = err instanceof OAuthError ? err.code : 'oauth_failed'
    return fail(codeStr, status)
  }
}

export async function googleExchangeCode(
  env: Env,
  code: string,
  codeVerifier: string
): Promise<{ idToken: string }> {
  // GOOGLE_TOKEN_URL is its own var: Google's token host differs from authorize. Form-encoded body.
  const form = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: `${env.GATEWAY_ORIGIN}${CALLBACK_PATH}`,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  })
  const res = await fetch(env.GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  })
  if (!res.ok) throw new OAuthError('oauth_exchange_failed', 400)
  const body = (await res.json().catch(() => null)) as { id_token?: unknown } | null
  const idToken = body?.id_token
  if (typeof idToken !== 'string' || idToken.length === 0) {
    throw new OAuthError('oauth_exchange_failed', 400)
  }
  return { idToken }
}

// The id_token verification crux. `getKey` is injectable so tests verify against a local JWKS with
// zero network; prod uses createRemoteJWKSet(GOOGLE_JWKS_URL). Throws OAuthError on ANY failure.
export async function googleVerifyIdToken(
  env: Env,
  idToken: string,
  expectedNonce: string,
  getKey?: JWTVerifyGetKey
): Promise<{ sub: string; email: string | null; emailVerified: boolean; name: string | null }> {
  const resolver = getKey ?? createRemoteJWKSet(new URL(env.GOOGLE_JWKS_URL))
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload']
  try {
    const result = await jwtVerify(idToken, resolver, {
      algorithms: ['RS256'], // pin RS256 => no alg:none, no RS<->HS confusion
      issuer: env.GOOGLE_ISSUER, // ONLY the env issuer — no hardcoded fallback widening the set
      audience: env.GOOGLE_CLIENT_ID,
      requiredClaims: ['sub', 'email', 'nonce', 'exp', 'iat'],
      clockTolerance: 5,
    })
    payload = result.payload
  } catch {
    // Collapse every verification failure (bad sig / wrong iss-aud / expired / unknown kid / wrong
    // alg / missing claim) into one generic error — no oracle, no provider detail leaked.
    throw new OAuthError('id_token_invalid', 400)
  }

  if (payload.nonce !== expectedNonce) throw new OAuthError('id_token_invalid', 400)
  if (payload.email_verified !== true) throw new OAuthError('email_unverified', 403)

  const rec = payload as Record<string, unknown>
  const sub = typeof rec.sub === 'string' ? rec.sub : null
  if (sub === null) throw new OAuthError('id_token_invalid', 400)
  const email = typeof rec.email === 'string' ? rec.email : null
  const name = typeof rec.name === 'string' ? rec.name : null
  return { sub, email, emailVerified: true, name }
}
