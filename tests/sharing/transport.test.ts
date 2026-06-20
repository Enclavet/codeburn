import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { generateIdentity, type Identity } from '../../src/sharing/identity.js'
import { PeerStore } from '../../src/sharing/pairing.js'
import { ShareServer } from '../../src/sharing/share-server.js'
import { hello, pair, fetchUsage } from '../../src/sharing/client.js'

describe('device sharing transport (loopback mutual TLS)', () => {
  let server: ShareServer
  let serverId: Identity
  let clientId: Identity
  let peers: PeerStore
  let port: number

  beforeAll(async () => {
    serverId = await generateIdentity('MacBook')
    clientId = await generateIdentity('Mac Studio')
    peers = new PeerStore()
    server = new ShareServer({ identity: serverId, peers, getUsage: async () => ({ current: { cost: 42 } }) })
    port = await server.listen(0, '127.0.0.1')
  })

  afterAll(async () => {
    await server.close()
  })

  const ep = () => ({ identity: clientId, host: '127.0.0.1', port })

  it('hello exposes name + fingerprint, and the client sees the right cert', async () => {
    const r = await hello(ep())
    expect(r.status).toBe(200)
    const body = r.json as { name: string; fingerprint: string }
    expect(body.name).toBe('MacBook')
    expect(body.fingerprint).toBe(serverId.fingerprint)
    expect(r.serverFingerprint).toBe(serverId.fingerprint)
  })

  it('denies usage before pairing', async () => {
    const r = await fetchUsage(ep(), 'no-token')
    expect(r.status).toBe(401)
  })

  it('pairs with a valid PIN, then authorizes a pinned usage pull', async () => {
    const pin = server.openPairing()
    const pr = await pair(ep(), pin, 'Mac Studio')
    expect(pr.status).toBe(200)
    const token = (pr.json as { token: string }).token
    expect(token).toBeTruthy()

    const ur = await fetchUsage({ ...ep(), expectedFingerprint: serverId.fingerprint }, token)
    expect(ur.status).toBe(200)
    expect((ur.json as { current: { cost: number } }).current.cost).toBe(42)
  })

  it('rejects a wrong PIN', async () => {
    server.openPairing()
    const pr = await pair(ep(), '000000', 'x')
    expect(pr.status).toBe(401)
  })

  it('rejects a token replayed from a different device fingerprint', async () => {
    const pin = server.openPairing()
    const pr = await pair(ep(), pin, 'Mac Studio')
    const token = (pr.json as { token: string }).token
    const attacker = await generateIdentity('Evil')
    const r = await fetchUsage({ identity: attacker, host: '127.0.0.1', port }, token)
    expect(r.status).toBe(401)
  })

  it('aborts when the peer fingerprint does not match the pin', async () => {
    await expect(hello({ ...ep(), expectedFingerprint: 'deadbeef' })).rejects.toThrow(/fingerprint mismatch/)
  })
})
