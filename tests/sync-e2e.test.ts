/**
 * End-to-end test for codeburn sync setup flow.
 *
 * Spins up a mock IdP, runs the auth flow programmatically
 * (simulating the browser callback), and verifies tokens are
 * stored and retrievable.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { startMockIdp, type MockIdp } from './fixtures/mock-idp.js'
import { fetchDiscoveryDoc } from '../src/sync/discovery.js'
import {
  fetchOidcConfig,
  generatePkce,
  buildAuthUrl,
  resolveScopes,
  startCallbackServer,
  exchangeCode,
  refreshToken,
  revokeToken,
} from '../src/sync/auth.js'
import { createCredentialStore } from '../src/sync/credentials.js'
import { writeSyncConfig, readSyncConfig, deleteSyncConfig } from '../src/sync/config.js'

let idp: MockIdp
let tmpHome: string
const originalHome = process.env.HOME

beforeAll(async () => {
  idp = await startMockIdp({ rotateTokens: false })
})

afterAll(async () => {
  await idp.close()
})

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'codeburn-sync-e2e-'))
  process.env.HOME = tmpHome
})

afterEach(async () => {
  process.env.HOME = originalHome
  await rm(tmpHome, { recursive: true, force: true })
})

describe('sync e2e (mock IdP)', () => {
  it('full setup flow: discovery → OIDC → callback → token → store', async () => {
    // 1. Fetch discovery doc
    const discovery = await fetchDiscoveryDoc(idp.baseUrl)
    expect(discovery.version).toBe(1)
    expect(discovery.issuer).toBe(idp.baseUrl)
    expect(discovery.client_id).toBe('mock-client-id')
    expect(discovery.scopes).toContain('codeburn:write')

    // 2. Fetch OIDC config
    const oidc = await fetchOidcConfig(discovery.issuer)
    expect(oidc.authorization_endpoint).toContain('/oauth2/authorize')
    expect(oidc.token_endpoint).toContain('/oauth2/token')
    expect(oidc.revocation_endpoint).toContain('/oauth2/revoke')
    expect(oidc.scopes_supported).toContain('offline_access')

    // 3. Resolve scopes (offline_access should be added since IdP supports it)
    const scopes = resolveScopes(discovery.scopes, oidc.scopes_supported)
    expect(scopes).toContain('offline_access')

    // 4. Generate PKCE + state
    const pkce = generatePkce()
    const state = 'e2e-test-state'

    // 5. Start callback server
    const { promise: callbackPromise, server } = startCallbackServer(state, 5000)
    await new Promise(resolve => setTimeout(resolve, 100))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 19876
    const redirectUri = `http://127.0.0.1:${port}/callback`

    // 6. Build auth URL (verify it's well-formed)
    const authUrl = buildAuthUrl({
      authorization_endpoint: oidc.authorization_endpoint,
      client_id: discovery.client_id,
      redirect_uri: redirectUri,
      scopes,
      state,
      pkce,
    })
    const parsedUrl = new URL(authUrl)
    expect(parsedUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(parsedUrl.searchParams.get('client_id')).toBe('mock-client-id')

    // 7. Simulate browser callback (as if user logged in and IdP redirected)
    const authCode = 'e2e-auth-code-12345'
    await fetch(`http://127.0.0.1:${port}/callback?code=${authCode}&state=${state}`)

    const callbackResult = await callbackPromise
    expect(callbackResult.code).toBe(authCode)

    // 8. Exchange code for tokens
    const tokens = await exchangeCode(
      oidc.token_endpoint,
      callbackResult.code,
      pkce.code_verifier,
      redirectUri,
      discovery.client_id,
    )
    expect(tokens.access_token).toBe('mock-access-token-xyz')
    expect(tokens.refresh_token).toBe('mock-refresh-token-v1')
    expect(tokens.expires_in).toBe(3600)

    // Verify the mock IdP received the code
    expect(idp.exchangedCodes).toContain(authCode)

    // 9. Store refresh token
    const store = createCredentialStore()
    store.store(tokens.refresh_token!)
    const retrieved = store.retrieve()
    expect(retrieved).toBe('mock-refresh-token-v1')

    // 10. Write config
    writeSyncConfig({
      baseUrl: idp.baseUrl,
      clientId: discovery.client_id,
      tracesPath: discovery.traces_path,
      issuer: discovery.issuer,
    })
    const config = readSyncConfig()
    expect(config).not.toBeNull()
    expect(config!.baseUrl).toBe(idp.baseUrl)
    expect(config!.clientId).toBe('mock-client-id')
  }, 10000)

  it('token refresh flow', async () => {
    // Store a refresh token
    const store = createCredentialStore()
    store.store('mock-refresh-token-v1')

    // Refresh it
    const oidc = await fetchOidcConfig(idp.baseUrl)
    const tokens = await refreshToken(oidc.token_endpoint, 'mock-refresh-token-v1', 'mock-client-id')

    expect(tokens.access_token).toContain('mock-access-token-xyz-refreshed')
    expect(tokens.refresh_token).toBe('mock-refresh-token-v1') // no rotation
    expect(tokens.token_type).toBe('Bearer')
  })

  it('refresh with invalid token returns auth error', async () => {
    const oidc = await fetchOidcConfig(idp.baseUrl)

    await expect(
      refreshToken(oidc.token_endpoint, 'wrong-token', 'mock-client-id')
    ).rejects.toThrow('Sync auth expired')
  })

  it('logout revokes token at IdP', async () => {
    const store = createCredentialStore()
    store.store('token-to-revoke')

    writeSyncConfig({
      baseUrl: idp.baseUrl,
      clientId: 'mock-client-id',
      tracesPath: '/v1/traces',
      issuer: idp.baseUrl,
    })

    // Revoke
    const oidc = await fetchOidcConfig(idp.baseUrl)
    await revokeToken(oidc.revocation_endpoint!, 'token-to-revoke', 'mock-client-id')

    expect(idp.revokedTokens).toContain('token-to-revoke')

    // Clean up
    store.delete()
    deleteSyncConfig()

    expect(store.retrieve()).toBeNull()
    expect(readSyncConfig()).toBeNull()
  })

  it('status shows correct info after setup', async () => {
    const store = createCredentialStore()
    store.store('status-test-token')

    writeSyncConfig({
      baseUrl: idp.baseUrl,
      clientId: 'mock-client-id',
      tracesPath: '/v1/traces',
      issuer: idp.baseUrl,
      lastSync: '2026-07-07T20:00:00Z',
    })

    const config = readSyncConfig()
    const token = store.retrieve()

    expect(config!.baseUrl).toBe(idp.baseUrl)
    expect(config!.lastSync).toBe('2026-07-07T20:00:00Z')
    expect(token).toBe('status-test-token')
    expect(store.method()).toMatch(/keychain|secret-tool|dpapi|file/)

    // Clean up
    store.delete()
    deleteSyncConfig()
  })
})

describe('sync e2e — token rotation', () => {
  let rotatingIdp: MockIdp

  beforeAll(async () => {
    rotatingIdp = await startMockIdp({ rotateTokens: true, refreshToken: 'rt-rotation-v1' })
  })

  afterAll(async () => {
    await rotatingIdp.close()
  })

  it('stores rotated refresh token after refresh', async () => {
    const store = createCredentialStore()
    store.store('rt-rotation-v1')

    const oidc = await fetchOidcConfig(rotatingIdp.baseUrl)

    // First refresh — should get rt-rotation-v2
    const tokens1 = await refreshToken(oidc.token_endpoint, 'rt-rotation-v1', 'mock-client-id')
    expect(tokens1.refresh_token).toBe('mock-refresh-token-v2')

    // Store the new one (as the client would)
    store.store(tokens1.refresh_token!)

    // Second refresh with the new token
    const tokens2 = await refreshToken(oidc.token_endpoint, tokens1.refresh_token!, 'mock-client-id')
    expect(tokens2.refresh_token).toBe('mock-refresh-token-v3')

    // Old token should fail
    await expect(
      refreshToken(oidc.token_endpoint, 'rt-rotation-v1', 'mock-client-id')
    ).rejects.toThrow('Sync auth expired')

    store.delete()
  })
})
