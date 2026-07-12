/**
 * Mock OIDC Identity Provider for codeburn sync e2e tests.
 *
 * Serves:
 * - /.well-known/codeburn-export.json (discovery doc)
 * - /.well-known/openid-configuration (OIDC discovery)
 * - /oauth2/authorize (redirect with code — not used directly in tests)
 * - /oauth2/token (exchanges code for tokens)
 * - /oauth2/revoke (token revocation)
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'

export interface MockIdpOptions {
  /** Port to listen on (0 = ephemeral) */
  port?: number
  /** Refresh token to issue */
  refreshToken?: string
  /** Access token to issue */
  accessToken?: string
  /** Simulate rotation: return a new refresh token on each exchange */
  rotateTokens?: boolean
}

export interface MockIdp {
  port: number
  baseUrl: string
  server: Server
  close(): Promise<void>
  /** Tokens issued so far */
  issuedTokens: { access: string[]; refresh: string[] }
  /** Revoked tokens */
  revokedTokens: string[]
  /** Authorization codes that have been exchanged */
  exchangedCodes: string[]
}

export async function startMockIdp(opts: MockIdpOptions = {}): Promise<MockIdp> {
  const refreshToken = opts.refreshToken ?? 'mock-refresh-token-v1'
  const accessToken = opts.accessToken ?? 'mock-access-token-xyz'
  let currentRefreshToken = refreshToken
  let rotationCounter = 0

  const state: MockIdp = {
    port: 0,
    baseUrl: '',
    server: null!,
    issuedTokens: { access: [], refresh: [] },
    revokedTokens: [],
    exchangedCodes: [],
    close: async () => {},
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${state.port}`)
    const path = url.pathname

    // --- Discovery doc ---
    if (path === '/.well-known/codeburn-export.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        version: 1,
        issuer: state.baseUrl,
        client_id: 'mock-client-id',
        scopes: ['openid', 'codeburn:write'],
        traces_path: '/v1/traces',
        max_batch_size: 100,
      }))
      return
    }

    // --- OIDC Discovery ---
    if (path === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        issuer: state.baseUrl,
        authorization_endpoint: `${state.baseUrl}/oauth2/authorize`,
        token_endpoint: `${state.baseUrl}/oauth2/token`,
        revocation_endpoint: `${state.baseUrl}/oauth2/revoke`,
        scopes_supported: ['openid', 'offline_access', 'codeburn:write'],
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      }))
      return
    }

    // --- Token endpoint ---
    if (path === '/oauth2/token' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const params = new URLSearchParams(body)
        const grantType = params.get('grant_type')

        if (grantType === 'authorization_code') {
          const code = params.get('code')
          if (!code) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid_request', error_description: 'missing code' }))
            return
          }

          state.exchangedCodes.push(code)
          state.issuedTokens.access.push(accessToken)
          state.issuedTokens.refresh.push(currentRefreshToken)

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            access_token: accessToken,
            refresh_token: currentRefreshToken,
            token_type: 'Bearer',
            expires_in: 3600,
          }))
          return
        }

        if (grantType === 'refresh_token') {
          const rt = params.get('refresh_token')
          if (rt !== currentRefreshToken) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'invalid_grant' }))
            return
          }

          // Simulate rotation if enabled
          if (opts.rotateTokens) {
            rotationCounter++
            currentRefreshToken = `mock-refresh-token-v${rotationCounter + 1}`
          }

          const newAccess = `${accessToken}-refreshed-${Date.now()}`
          state.issuedTokens.access.push(newAccess)
          state.issuedTokens.refresh.push(currentRefreshToken)

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            access_token: newAccess,
            refresh_token: currentRefreshToken,
            token_type: 'Bearer',
            expires_in: 3600,
          }))
          return
        }

        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }))
      })
      return
    }

    // --- Revocation endpoint ---
    if (path === '/oauth2/revoke' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        const params = new URLSearchParams(body)
        const token = params.get('token')
        if (token) state.revokedTokens.push(token)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
      return
    }

    // --- 404 ---
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  })

  await new Promise<void>((resolve, reject) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr) {
        state.port = addr.port
        state.baseUrl = `http://127.0.0.1:${addr.port}`
      }
      resolve()
    })
    server.once('error', reject)
  })

  state.server = server
  state.close = () => new Promise(resolve => server.close(() => resolve()))

  return state
}
