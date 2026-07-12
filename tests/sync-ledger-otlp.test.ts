/**
 * Unit tests for sync ledger and OTLP payload builder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  deriveSpanId,
  deriveTraceId,
  buildOtlpPayload,
  batchCalls,
  getDeviceId,
  type CallWithSession,
} from '../src/sync/otlp.js'

import type { ParsedApiCall, TokenUsage } from '../src/types.js'

// ── Helpers ───────────────────────────────────────────────────────────

function makeCall(overrides: Partial<ParsedApiCall> & { deduplicationKey: string }): ParsedApiCall {
  const usage: TokenUsage = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
  }
  return {
    provider: 'kiro',
    model: 'claude-sonnet-4-6',
    usage,
    costUSD: 0.05,
    tools: ['Edit', 'Bash'],
    mcpTools: [],
    skills: [],
    subagentTypes: [],
    hasAgentSpawn: false,
    hasPlanMode: false,
    speed: 'standard',
    timestamp: '2026-07-10T10:00:00.000Z',
    bashCommands: [],
    deduplicationKey: 'test:key:1',
    ...overrides,
  }
}

function makeCallWithSession(overrides?: Partial<ParsedApiCall> & { deduplicationKey?: string }): CallWithSession {
  return {
    call: makeCall({ deduplicationKey: overrides?.deduplicationKey ?? 'test:key:1', ...overrides }),
    sessionId: 'session-abc',
    project: 'my-project',
  }
}

// ── OTLP Span/Trace ID Derivation ────────────────────────────────────

describe('deriveSpanId', () => {
  it('returns 16 hex chars', () => {
    const id = deriveSpanId('cursor:bubble:abc123')
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic (same input = same output)', () => {
    const a = deriveSpanId('my:dedup:key')
    const b = deriveSpanId('my:dedup:key')
    expect(a).toBe(b)
  })

  it('different inputs produce different IDs', () => {
    const a = deriveSpanId('key-1')
    const b = deriveSpanId('key-2')
    expect(a).not.toBe(b)
  })
})

describe('deriveTraceId', () => {
  it('returns 32 hex chars', () => {
    const id = deriveTraceId('session-xyz')
    expect(id).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is deterministic', () => {
    const a = deriveTraceId('session-1')
    const b = deriveTraceId('session-1')
    expect(a).toBe(b)
  })
})

describe('getDeviceId', () => {
  it('returns 16 hex chars', () => {
    const id = getDeviceId()
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is stable across calls', () => {
    expect(getDeviceId()).toBe(getDeviceId())
  })
})

// ── OTLP Payload Builder ──────────────────────────────────────────────

describe('buildOtlpPayload', () => {
  it('builds valid OTLP structure with one span', () => {
    const payload = buildOtlpPayload([makeCallWithSession()])

    expect(payload.resourceSpans).toHaveLength(1)
    expect(payload.resourceSpans[0]!.resource.attributes).toEqual([
      { key: 'codeburn.device_id', value: { stringValue: expect.stringMatching(/^[0-9a-f]{16}$/) } },
    ])

    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans
    expect(spans).toHaveLength(1)

    const span = spans[0]!
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(span.name).toBe('kiro/claude-sonnet-4-6')
    expect(span.startTimeUnixNano).toBe('1783677600000000000')
  })

  it('includes correct span attributes', () => {
    const payload = buildOtlpPayload([makeCallWithSession()])
    const attrs = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes
    const attrMap = Object.fromEntries(attrs.map(a => [a.key, a.value]))

    expect(attrMap['ai.provider']).toEqual({ stringValue: 'kiro' })
    expect(attrMap['ai.model']).toEqual({ stringValue: 'claude-sonnet-4-6' })
    expect(attrMap['ai.input_tokens']).toEqual({ intValue: '1000' })
    expect(attrMap['ai.output_tokens']).toEqual({ intValue: '500' })
    expect(attrMap['ai.cost_usd']).toEqual({ doubleValue: 0.05 })
    expect(attrMap['ai.project']).toEqual({ stringValue: 'my-project' })
    expect(attrMap['ai.speed']).toEqual({ stringValue: 'standard' })
  })

  it('includes tools as array attribute', () => {
    const payload = buildOtlpPayload([makeCallWithSession()])
    const attrs = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes
    const toolsAttr = attrs.find(a => a.key === 'ai.tools')

    expect(toolsAttr).toBeDefined()
    expect(toolsAttr!.value).toEqual({
      arrayValue: { values: [{ stringValue: 'Edit' }, { stringValue: 'Bash' }] },
    })
  })

  it('omits tools attribute when empty', () => {
    const call = makeCallWithSession({ tools: [] as string[] } as any)
    const payload = buildOtlpPayload([call])
    const attrs = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes
    const toolsAttr = attrs.find(a => a.key === 'ai.tools')
    expect(toolsAttr).toBeUndefined()
  })

  it('multiple calls produce multiple spans', () => {
    const calls = [
      makeCallWithSession({ deduplicationKey: 'k1' }),
      makeCallWithSession({ deduplicationKey: 'k2' }),
      makeCallWithSession({ deduplicationKey: 'k3' }),
    ]
    const payload = buildOtlpPayload(calls)
    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans
    expect(spans).toHaveLength(3)
    // Each span has a unique spanId
    const ids = new Set(spans.map(s => s.spanId))
    expect(ids.size).toBe(3)
  })

  it('same deduplicationKey produces same spanId (idempotent re-send)', () => {
    const call = makeCallWithSession({ deduplicationKey: 'stable-key' })
    const p1 = buildOtlpPayload([call])
    const p2 = buildOtlpPayload([call])
    expect(p1.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.spanId)
      .toBe(p2.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.spanId)
  })
})

// ── Batching ──────────────────────────────────────────────────────────

describe('batchCalls', () => {
  it('returns single batch when under limit', () => {
    const calls = Array.from({ length: 5 }, (_, i) =>
      makeCallWithSession({ deduplicationKey: `k${i}` })
    )
    const batches = batchCalls(calls, 1000)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(5)
  })

  it('splits into multiple batches at the limit', () => {
    const calls = Array.from({ length: 2500 }, (_, i) =>
      makeCallWithSession({ deduplicationKey: `k${i}` })
    )
    const batches = batchCalls(calls, 1000)
    expect(batches).toHaveLength(3)
    expect(batches[0]).toHaveLength(1000)
    expect(batches[1]).toHaveLength(1000)
    expect(batches[2]).toHaveLength(500)
  })

  it('empty input returns empty array', () => {
    expect(batchCalls([], 1000)).toEqual([])
  })
})

// ── Ledger ────────────────────────────────────────────────────────────

describe('ledger', () => {
  let tmpDir: string
  const originalHome = process.env.HOME

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'codeburn-ledger-'))
    process.env.HOME = tmpDir
  })

  afterEach(async () => {
    process.env.HOME = originalHome
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('readLedger returns empty array when no file', async () => {
    const { readLedger } = await import('../src/sync/ledger.js')
    expect(readLedger()).toEqual([])
  })

  it('writeLedger + readLedger round-trips', async () => {
    const { writeLedger, readLedger } = await import('../src/sync/ledger.js')
    const entries = [
      { key: 'k1', ts: '2026-07-10T00:00:00Z' },
      { key: 'k2', ts: '2026-07-11T00:00:00Z' },
    ]
    writeLedger(entries)
    expect(readLedger()).toEqual(entries)
  })

  it('appendToLedger adds new entries and deduplicates', async () => {
    const { writeLedger, appendToLedger, readLedger } = await import('../src/sync/ledger.js')
    writeLedger([{ key: 'existing', ts: '2026-07-01T00:00:00Z' }])
    appendToLedger([
      { key: 'existing', ts: '2026-07-01T00:00:00Z' },  // duplicate
      { key: 'new-one', ts: '2026-07-10T00:00:00Z' },
    ])
    const result = readLedger()
    expect(result).toHaveLength(2)
    expect(result.map(e => e.key).sort()).toEqual(['existing', 'new-one'])
  })

  it('appendToLedger prunes entries older than 6 months', async () => {
    const { writeLedger, appendToLedger, readLedger } = await import('../src/sync/ledger.js')
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString() // 200 days ago
    writeLedger([{ key: 'old-entry', ts: old }])
    appendToLedger([{ key: 'fresh', ts: new Date().toISOString() }])
    const result = readLedger()
    expect(result.map(e => e.key)).toEqual(['fresh'])
  })

  it('ledgerKeySet returns set of keys', async () => {
    const { writeLedger, ledgerKeySet } = await import('../src/sync/ledger.js')
    writeLedger([
      { key: 'a', ts: '2026-07-01T00:00:00Z' },
      { key: 'b', ts: '2026-07-02T00:00:00Z' },
    ])
    const keys = ledgerKeySet()
    expect(keys.has('a')).toBe(true)
    expect(keys.has('b')).toBe(true)
    expect(keys.has('c')).toBe(false)
  })

  it('clearLedger removes the file and returns count', async () => {
    const { writeLedger, clearLedger, readLedger } = await import('../src/sync/ledger.js')
    writeLedger([{ key: 'x', ts: '2026-07-01T00:00:00Z' }])
    const count = clearLedger()
    expect(count).toBe(1)
    expect(readLedger()).toEqual([])
  })

  it('clearLedger returns 0 when no file', async () => {
    const { clearLedger } = await import('../src/sync/ledger.js')
    expect(clearLedger()).toBe(0)
  })
})
