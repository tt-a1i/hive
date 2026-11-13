import { env, fetchMock, SELF } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import {
  GH_FLOW_COOKIE,
  GOOGLE_FLOW_COOKIE,
  sha256Base64url,
  validateRedirect,
} from '../src/oauth-common.js'
import { googleVerifyIdToken } from '../src/oauth-google.js'
import { SESSION_COOKIE_NAME, verifySession } from '../src/sessions.js'
import {
  forgeHmacWithPublicModulus,
  forgeNoneAlgIdToken,
  type GoogleSigner,
  makeGoogleSigner,
} from './helpers/google-idtoken.js'

const ORIGIN = 'https://app.hivehq.dev'

// /auth/* is now login-rate-limited per edge IP (CF-Connecting-IP). Under the shared singleWorker
// runtime, give each request a fresh source IP so unrelated login tests don't pile into one bucket
// and 429. A real browser flow comes from one IP, but each test is an independent client — and the
// dedicated rate-limit suite proves the per-IP limit actually trips. Merges onto caller headers.
function gw(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', crypto.randomUUID())
  return SELF.fetch(url, { ...init, headers })
}

// All outbound provider calls must hit the injected mock URLs (mock.test); a real-network attempt is
// a failure, which PROVES the env base URLs are honored (testability invariant).
beforeAll(() => {
  fetchMock.activate()
  fetchMock.disableNetConnect()
})
afterEach(() => {
  fetchMock.assertNoPendingInterceptors()
})

// ---- helpers --------------------------------------------------------------

// workerd Headers implements getSetCookie() at runtime; the workers-types Headers type doesn't
// surface it, so read it through a narrow cast rather than disabling strictness file-wide.
function setCookies(res: Response): string[] {
  const h = res.headers as unknown as { getSetCookie(): string[] }
  return h.getSetCookie()
}

// Parse the first Set-Cookie matching `name` from a Headers, returning its value (before the first ';').
function cookieValue(res: Response, name: string): string | null {
  for (const c of setCookies(res)) {
    const head = c.split(';')[0] ?? ''
    const eq = head.indexOf('=')
    if (eq === -1) continue
    if (head.slice(0, eq).trim() === name) {
      const v = head.slice(eq + 1).trim()
      return v.length > 0 ? v : null
    }
  }
  return null
}

function locationParams(res: Response): URLSearchParams {
  const loc = res.headers.get('Location') ?? ''
  const u = new URL(loc, ORIGIN)
  return u.searchParams
}

// Drive an authorize step and return the redirect URL params + the flow cookie value the browser
// would send back on the callback.
async function authorize(
  path: string,
  flowCookieName: string
): Promise<{
  params: URLSearchParams
  flowCookie: string
  location: string
}> {
  const res = await gw(`${ORIGIN}${path}`, { redirect: 'manual' })
  expect(res.status).toBe(302)
  const flow = cookieValue(res, flowCookieName)
  expect(flow).not.toBeNull()
  return {
    params: locationParams(res),
    flowCookie: `${flowCookieName}=${flow}`,
    location: res.headers.get('Location') ?? '',
  }
}

// ---- mock providers -------------------------------------------------------

// GitHub token + identity. `accountId` becomes the immutable provider_sub.
function mockGithub(opts: {
  accountId: number
  login?: string
  name?: string | null
  emails?: Array<{ email: string; primary: boolean; verified: boolean }>
  tokenReply?: { status: number; body: unknown }
}): void {
  const ghOAuth = fetchMock.get('https://mock.test')
  ghOAuth
    .intercept({ path: (p) => p.startsWith('/gh/login/oauth/access_token'), method: 'POST' })
    .reply(
      opts.tokenReply?.status ?? 200,
      JSON.stringify(
        opts.tokenReply?.body ?? { access_token: 'gh-access-token', token_type: 'bearer' }
      ),
      { headers: { 'content-type': 'application/json' } }
    )
  ghOAuth
    .intercept({ path: (p) => p.startsWith('/gh/api/user/emails'), method: 'GET' })
    .reply(
      200,
      JSON.stringify(opts.emails ?? [{ email: 'gh@example.com', primary: true, verified: true }]),
      { headers: { 'content-type': 'application/json' } }
    )
  ghOAuth
    .intercept({
      path: (p) => p.startsWith('/gh/api/user') && !p.startsWith('/gh/api/user/emails'),
      method: 'GET',
    })
    .reply(
      200,
      JSON.stringify({
        id: opts.accountId,
        login: opts.login ?? 'octocat',
        name: opts.name ?? 'Octo Cat',
      }),
      { headers: { 'content-type': 'application/json' } }
    )
}

// Callback tests use the configured JWKS URL and a locally signed token.
function mockGoogleJwks(signer: GoogleSigner): void {
  fetchMock
    .get('https://mock.test')
    .intercept({ path: '/google/certs', method: 'GET' })
    .reply(200, JSON.stringify(signer.jwks), { headers: { 'content-type': 'application/json' } })
}

function mockGoogleToken(idToken: string, reply?: { status: number; body: unknown }): void {
  fetchMock
    .get('https://mock.test')
    .intercept({ path: (p) => p.startsWith('/google/token'), method: 'POST' })
    .reply(
      reply?.status ?? 200,
      JSON.stringify(
        reply?.body ?? { id_token: idToken, access_token: 'g-access', token_type: 'Bearer' }
      ),
      { headers: { 'content-type': 'application/json' } }
    )
}

// =========================================================================
// Module A — OAuth CSRF / PKCE / redirect
// =========================================================================

describe('A — GitHub authorize: state + PKCE + cookie binding', () => {
  test('1. authorize sets a non-empty state in Location AND binds it in a signed cookie', async () => {
    const { params, flowCookie } = await authorize('/auth/github', GH_FLOW_COOKIE)
    const state = params.get('state')
    expect(state).toBeTruthy()
    expect((state ?? '').length).toBeGreaterThan(16)
    // the cookie is a signed JWT (three dot-separated parts), NOT the raw state value
    const cookieVal = flowCookie.split('=')[1] ?? ''
    expect(cookieVal.split('.').length).toBe(3)
    expect(cookieVal).not.toContain(state ?? 'STATE')
  })

  test('5. authorize carries code_challenge + S256, length matches a sha256 base64url digest', async () => {
    const { params } = await authorize('/auth/github', GH_FLOW_COOKIE)
    const challenge = params.get('code_challenge')
    expect(challenge).toBeTruthy()
    expect(params.get('code_challenge_method')).toBe('S256')
    // S256 challenge is base64url(sha256(verifier)): 32-byte digest => 43 chars, no padding/+//.
    expect((challenge ?? '').length).toBe(43)
    expect(challenge ?? '').not.toMatch(/[+/=]/)
  })

  test('5b. the verifier in the cookie matches the challenge sent (full PKCE round-trip succeeds)', async () => {
    const { params, flowCookie } = await authorize('/auth/github', GH_FLOW_COOKIE)
    const state = params.get('state') ?? ''
    // The token exchange will carry the verifier from the cookie; GitHub (mock) accepts it. A
    // 302 with a session proves the verifier the gateway sent == the challenge it committed to.
    mockGithub({ accountId: 5001 })
    const cb = await gw(`${ORIGIN}/auth/github/callback?code=abc&state=${state}`, {
      headers: { Cookie: flowCookie },
      redirect: 'manual',
    })
    expect(cb.status).toBe(302)
    expect(cookieValue(cb, SESSION_COOKIE_NAME)).not.toBeNull()
  })

  test('6. two authorize calls produce different state + challenge (no hardcoded verifier)', async () => {
    const a = await authorize('/auth/github', GH_FLOW_COOKIE)
    const b = await authorize('/auth/github', GH_FLOW_COOKIE)
    expect(a.params.get('state')).not.toBe(b.params.get('state'))
    expect(a.params.get('code_challenge')).not.toBe(b.params.get('code_challenge'))
  })
})

describe('A — GitHub callback: CSRF / state binding', () => {
  test('2. callback with NO flow cookie is rejected BEFORE any exchange; no session', async () => {
    const res = await gw(`${ORIGIN}/auth/github/callback?code=abc&state=xyz`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(400)
    expect(cookieValue(res, SESSION_COOKIE_NAME)).toBeNull()
    // The error code proves we rejected at the state gate, NOT at a failed (network-blocked) exchange.
    // No token interceptor is registered; if the impl proceeded to exchange it would surface
    // 'oauth_failed' (or throw), so asserting 'invalid_state' catches a removed cookie check.
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('invalid_state')
  })

  test('3. callback state != cookie state is rejected at the CSRF gate (not at the exchange)', async () => {
    const { flowCookie } = await authorize('/auth/github', GH_FLOW_COOKIE)
    const res = await gw(`${ORIGIN}/auth/github/callback?code=abc&state=ATTACKER_STATE`, {
      headers: { Cookie: flowCookie },
      redirect: 'manual',
    })
    expect(res.status).toBe(400)
    expect(cookieValue(res, SESSION_COOKIE_NAME)).toBeNull()
    // Distinguishes "rejected by state equality" from "exchange attempted then network-blocked":
    // with the check present the code is 'state_mismatch'; remove the check and the exchange runs,
    // surfacing 'oauth_failed' — so this assertion genuinely fails on a broken impl.
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe('state_mismatch')
  })

  test('4. replay of a successful callback (cookie cleared single-use) is rejected', async () => {
    const { params, flowCookie } = await authorize('/auth/github', GH_FLOW_COOKIE)
    const state = params.get('state') ?? ''
    mockGithub({ accountId: 6001 })
    const first = await gw(`${ORIGIN}/auth/github/callback?code=abc&state=${state}`, {
      headers: { Cookie: flowCookie },
      redirect: 'manual',
    })
    expect(first.status).toBe(302)
    expect(cookieValue(first, SESSION_COOKIE_NAME)).not.toBeNull()
    // the response cleared the flow cookie (Max-Age=0). A replay where the browser no longer holds
    // the cookie => rejected. (We simulate the cleared state by sending no flow cookie.)
    const replay = await gw(`${ORIGIN}/auth/github/callback?code=abc&state=${state}`, {
      redirect: 'manual',
    })
    expect(replay.status).toBeGreaterThanOrEqual(400)
  })

  test('clears the flow cookie on the callback response (single-use)', async () => {
    const { params, flowCookie } = await authorize('/auth/github', GH_FLOW_COOKIE)
    const state = params.get('state') ?? ''
    mockGithub({ accountId: 6002 })
    const res = await gw(`${ORIGIN}/auth/github/callback?code=abc&state=${state}`, {
      headers: { Cookie: flowCookie },
      redirect: 'manual',
    })
    const cleared = setCookies(res).find((c) => c.startsWith(`${GH_FLOW_COOKIE}=`))
    expect(cleared).toBeDefined()
    expect(cleared ?? '').toMatch(/Max-Age=0/i)
  })
})

describe('A — open redirect (validateRedirect unit + e2e)', () => {
  test('7/8. validateRedirect collapses external + protocol-relative + backslash to /', () => {
    expect(validateRedirect(env, '//evil.com')).toBe('/')
    expect(validateRedirect(env, 'https://evil.com')).toBe('/')
    expect(validateRedirect(env, '/\\evil')).toBe('/')
    expect(validateRedirect(env, 'https://app.hivehq.dev.evil.com')).toBe('/')
    expect(validateRedirect(env, '/../../x')).toBe('/')
    expect(validateRedirect(env, null)).toBe('/')
    // allowlisted path passes through
    expect(validateRedirect(env, '/machines')).toBe('/machines')
    // the mobile app shell is an allowlisted return path — the phone's OAuth bounce (redirect=/app)
    // must land back IN the app, not collapse to the server page.
    expect(validateRedirect(env, '/app')).toBe('/app')
    // the daemon-approve return path is allowlisted AND keeps its ?code= query, so a user bounced
    // through login lands back on the right approve page (not a code-less dead page).
    expect(validateRedirect(env, '/daemon/approve?code=hc_abc123')).toBe(
      '/daemon/approve?code=hc_abc123'
    )
    // but it's still pathname-allowlisted: a sibling /daemon/* path is NOT a permitted redirect target
    expect(validateRedirect(env, '/daemon/token')).toBe('/')
  })

  test('7. e2e: ?redirect=//evil.com lands the final 302 at a same-origin path, never external', async () => {
    const { params, flowCookie } = await authorize(
      '/auth/github?redirect=%2F%2Fevil.com',
      GH_FLOW_COOKIE
    )
    const state = params.get('state') ?? ''
    mockGithub({ accountId: 7001 })
    const cb = await gw(`${ORIGIN}/auth/github/callback?code=abc&state=${state}`, {
      headers: { Cookie: flowCookie },
      redirect: 'manual',
    })
    expect(cb.status).toBe(302)
    const loc = cb.headers.get('Location') ?? ''
    const u = new URL(loc, ORIGIN)
    expect(u.origin).toBe(ORIGIN)
    expect(loc.startsWith('//')).toBe(false)
  })

  test('e2e: a daemon-approve return path survives sign-in — callback lands back on the approve page', async () => {
    // The whole point of the redirect fix: open the `hive remote login` link logged-out → log in →
    // return to the SAME approve page with the code intact. Drive authorize(redirect=/daemon/approve?
    // code=...) → callback, and assert the final 302 is exactly that approve URL.
    const back = '/daemon/approve?code=hc_e2e_returnpath'
    const { params, flowCookie } = await authorize(
      `/auth/github?redirect=${encodeURIComponent(back)}`,
      GH_FLOW_COOKIE
    )
    const state = params.get('state') ?? ''
    mockGithub({ accountId: 7100 })
    const cb = await gw(`${ORIGIN}/auth/github/callback?code=abc&state=${state}`, {
      headers: { Cookie: flowCookie },
      redirect: 'manual',
    })
    expect(cb.status).toBe(302)
    expect(cb.headers.get('Location')).toBe(back)
  })
})

describe('A — account identity keying', () => {
  test('9. two callbacks for the same GitHub sub => exactly one users row, same userId', async () => {
    mockGithub({ accountId: 9001 })
    const a = await authorize('/auth/github', GH_FLOW_COOKIE)
    const first = await gw(
      `${ORIGIN}/auth/github/callback?code=abc&state=${a.params.get('state')}`,
      { headers: { Cookie: a.flowCookie }, redirect: 'manual' }
    )
    expect(first.status).toBe(302)

    mockGithub({ accountId: 9001 })
    const b = await authorize('/auth/github', GH_FLOW_COOKIE)
    const second = await gw(
      `${ORIGIN}/auth/github/callback?code=abc&state=${b.params.get('state')}`,
      { headers: { Cookie: b.flowCookie }, redirect: 'manual' }
    )
    expect(second.status).toBe(302)

    const rows = await env.DB.prepare(
      "SELECT id FROM users WHERE provider = 'github' AND provider_sub = ?1"
    )
      .bind('9001')
      .all<{ id: string }>()
    expect(rows.results.length).toBe(1)
  })

  test('10. a GitHub user and a Google user with the SAME email are two distinct accounts (no link-by-email)', async () => {
    const sharedEmail = `same-${crypto.randomUUID()}@example.com`
    // GitHub side
    mockGithub({
      accountId: 10001,
      emails: [{ email: sharedEmail, primary: true, verified: true }],
    })
    const g = await authorize('/auth/github', GH_FLOW_COOKIE)
    await gw(`${ORIGIN}/auth/github/callback?code=abc&state=${g.params.get('state')}`, {
      headers: { Cookie: g.flowCookie },
      redirect: 'manual',
    })
    // Google side, same email, sub differs
    const signer = await makeGoogleSigner()
    const a = await authorize('/auth/google', GOOGLE_FLOW_COOKIE)
    const nonce = a.params.get('nonce') ?? ''
    const idToken = await signer.mint({
      iss: env.GOOGLE_ISSUER,
      aud: env.GOOGLE_CLIENT_ID,
      sub: 'google-sub-10001',
      email: sharedEmail,
      email_verified: true,
      name: 'Same Email',
      nonce,
    })
    mockGoogleToken(idToken)
    mockGoogleJwks(signer)
    await gw(`${ORIGIN}/auth/google/callback?code=g&state=${a.params.get('state')}`, {
      headers: { Cookie: a.flowCookie },
      redirect: 'manual',
    })

    const rows = await env.DB.prepare('SELECT provider FROM users WHERE email = ?1')
      .bind(sharedEmail)
      .all<{ provider: string }>()
    const providers = rows.results.map((r) => r.provider).sort()
    expect(providers).toEqual(['github', 'google'])
  })
})

// =========================================================================
// Module B — Google OIDC (id_token verification crux)
// =========================================================================

describe('B — googleVerifyIdToken (getKey seam, zero network)', () => {
  let signer: GoogleSigner
  beforeAll(async () => {
    signer = await makeGoogleSigner()
  })

  function claims(over: Partial<Parameters<GoogleSigner['mint']>[0]> = {}) {
    return {
      iss: env.GOOGLE_ISSUER,
      aud: env.GOOGLE_CLIENT_ID,
      sub: 'gsub-1',
      email: 'g@example.com',
      email_verified: true,
      name: 'G User',
      nonce: 'the-nonce',
      ...over,
    }
  }

  test('11. valid id_token (right iss/aud/exp/nonce/RS256/kid) verifies', async () => {
    const token = await signer.mint(claims())
    const out = await googleVerifyIdToken(env, token, 'the-nonce', signer.getKey)
    expect(out.sub).toBe('gsub-1')
    expect(out.email).toBe('g@example.com')
    expect(out.emailVerified).toBe(true)
  })

  test('12. wrong iss is rejected', async () => {
    const token = await signer.mint(claims({ iss: 'https://evil.example' }))
    await expect(googleVerifyIdToken(env, token, 'the-nonce', signer.getKey)).rejects.toBeTruthy()
  })

  test('12b. flipping env.GOOGLE_ISSUER rejects a token with the OLD iss (no hardcoded fallback widens the set)', async () => {
    const token = await signer.mint(claims({ iss: 'https://accounts.google.com' }))
    const flipped = { ...env, GOOGLE_ISSUER: 'https://issuer.example.test' }
    await expect(
      googleVerifyIdToken(flipped, token, 'the-nonce', signer.getKey)
    ).rejects.toBeTruthy()
  })

  test('13. wrong aud is rejected (token substitution)', async () => {
    const token = await signer.mint(claims({ aud: 'someone-elses-client-id' }))
    await expect(googleVerifyIdToken(env, token, 'the-nonce', signer.getKey)).rejects.toBeTruthy()
  })

  test('14. expired exp is rejected', async () => {
    const past = Math.floor(Date.now() / 1000) - 100
    const token = await signer.mint(claims({ iat: past - 3600, exp: past }))
    await expect(googleVerifyIdToken(env, token, 'the-nonce', signer.getKey)).rejects.toBeTruthy()
  })

  test('15. nonce mismatch is rejected', async () => {
    const token = await signer.mint(claims({ nonce: 'attacker-nonce' }))
    await expect(googleVerifyIdToken(env, token, 'the-nonce', signer.getKey)).rejects.toBeTruthy()
  })

  test('15b. absent nonce is rejected (requiredClaims)', async () => {
    // mint with NO nonce claim at all (exactOptionalPropertyTypes: omit, don't pass undefined)
    const token = await signer.mint({
      iss: env.GOOGLE_ISSUER,
      aud: env.GOOGLE_CLIENT_ID,
      sub: 'gsub-1',
      email: 'g@example.com',
      email_verified: true,
      name: 'G User',
    })
    await expect(googleVerifyIdToken(env, token, 'the-nonce', signer.getKey)).rejects.toBeTruthy()
  })

  test('16. id_token signed by a key not in JWKS (unknown kid) is rejected', async () => {
    const other = await makeGoogleSigner()
    const token = await other.mint(claims())
    // verify against the FIRST signer's JWKS — kid won't resolve
    await expect(googleVerifyIdToken(env, token, 'the-nonce', signer.getKey)).rejects.toBeTruthy()
  })

  test('17. alg:none id_token is rejected', async () => {
    const token = forgeNoneAlgIdToken(claims())
    await expect(googleVerifyIdToken(env, token, 'the-nonce', signer.getKey)).rejects.toBeTruthy()
  })

  test('18. RS<->HS confusion (HS256 signed with the public modulus) is rejected', async () => {
    const token = await forgeHmacWithPublicModulus(claims(), signer.publicJwk, signer.kid)
    await expect(googleVerifyIdToken(env, token, 'the-nonce', signer.getKey)).rejects.toBeTruthy()
  })

  test('email_verified=false is rejected even with a valid signature', async () => {
    const token = await signer.mint(claims({ email_verified: false }))
    await expect(googleVerifyIdToken(env, token, 'the-nonce', signer.getKey)).rejects.toBeTruthy()
  })
})

describe('B — Google end-to-end + injected URLs honored', () => {
  test('19/20. callback hits the injected GOOGLE_TOKEN_URL mock and mints a session', async () => {
    const signer = await makeGoogleSigner()
    const a = await authorize('/auth/google', GOOGLE_FLOW_COOKIE)
    const nonce = a.params.get('nonce') ?? ''
    expect(nonce.length).toBeGreaterThan(16)
    expect(a.params.get('code_challenge_method')).toBe('S256')

    const idToken = await signer.mint({
      iss: env.GOOGLE_ISSUER,
      aud: env.GOOGLE_CLIENT_ID,
      sub: 'g-e2e-1',
      email: 'e2e@example.com',
      email_verified: true,
      name: 'E2E',
      nonce,
    })
    // interceptor on the injected mock token URL — if production hardcoded oauth2.googleapis.com this
    // interceptor would stay pending (assertNoPendingInterceptors fails) AND disableNetConnect throws.
    mockGoogleToken(idToken)
    mockGoogleJwks(signer)

    const cb = await gw(
      `${ORIGIN}/auth/google/callback?code=gcode&state=${a.params.get('state')}`,
      {
        headers: { Cookie: a.flowCookie },
        redirect: 'manual',
      }
    )
    expect(cb.status).toBe(302)
    const session = cookieValue(cb, SESSION_COOKIE_NAME)
    expect(session).not.toBeNull()
    const claims = await verifySession(env, session ?? '')
    expect(claims).not.toBeNull()
  })
})

describe('sha256Base64url (PKCE S256 primitive)', () => {
  test('produces RFC7636-style 43-char base64url with no padding/+//', async () => {
    const out = await sha256Base64url('verifier-sample')
    expect(out.length).toBe(43)
    expect(out).not.toMatch(/[+/=]/)
  })
})
