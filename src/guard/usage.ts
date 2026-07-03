import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { readSessionLines } from '../fs-utils.js'
import { parseApiCall, parseJsonlLine } from '../parser.js'
import { EDIT_TOOLS } from '../classifier.js'
import { allowPath, guardDir, sessionCachePath } from './store.js'

// Per-session running totals. The transcript is append-only, so each invocation
// streams only the bytes after `byteOffset` (the offset of the last complete
// line parsed) and folds them into the totals; a cold parse of a multi-hundred-
// MB transcript on every tool call is what this avoids.
export type GuardCache = {
  version: number
  sessionId: string
  byteOffset: number
  costUSD: number
  editCount: number
  sawGitCommit: boolean
  lastTurnAt: string | null
  updatedAt: string
  softWarned: boolean
  stopNotified: boolean
}

export const GUARD_CACHE_VERSION = 1

// Raw command text is needed (not the base-binary names parseApiCall's
// bashCommands reduces to), so the Stop check reads call.toolSequence.
const GIT_COMMIT = /\bgit\b[\s\S]*?\bcommit\b/

export function emptyCache(sessionId: string): GuardCache {
  return {
    version: GUARD_CACHE_VERSION,
    sessionId,
    byteOffset: 0,
    costUSD: 0,
    editCount: 0,
    sawGitCommit: false,
    lastTurnAt: null,
    updatedAt: '',
    softWarned: false,
    stopNotified: false,
  }
}

export async function readCache(sessionId: string, base?: string): Promise<GuardCache> {
  let raw: string
  try {
    raw = await readFile(sessionCachePath(sessionId, base), 'utf-8')
  } catch {
    return emptyCache(sessionId)
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GuardCache>
    if (parsed.version !== GUARD_CACHE_VERSION || typeof parsed.byteOffset !== 'number') {
      return emptyCache(sessionId)
    }
    return { ...emptyCache(sessionId), ...parsed, sessionId }
  } catch {
    return emptyCache(sessionId)
  }
}

export async function writeCache(cache: GuardCache, base?: string): Promise<void> {
  await mkdir(guardDir(base), { recursive: true })
  await writeFile(sessionCachePath(cache.sessionId, base), JSON.stringify(cache), 'utf-8')
}

// Fold the transcript tail into the totals. Reuses the streaming line reader
// (startByteOffset + a lastCompleteLineOffset tracker) and the shared per-call
// cost/pricing path (parseApiCall -> calculateCost), so the guard never
// reimplements cost math. `resumedFrom` is the offset the parse restarted at,
// which the test asserts to prove only the tail was read.
export async function computeSessionUsage(
  prev: GuardCache,
  transcriptPath: string,
): Promise<{ cache: GuardCache; resumedFrom: number }> {
  let size: number
  try {
    size = (await stat(transcriptPath)).size
  } catch {
    return { cache: prev, resumedFrom: prev.byteOffset }
  }

  // A shorter file than we last read means the transcript was rotated or
  // truncated; start over from a clean total rather than trusting a stale
  // offset into different bytes.
  const cache = size < prev.byteOffset
    ? { ...emptyCache(prev.sessionId), softWarned: prev.softWarned, stopNotified: prev.stopNotified }
    : { ...prev }
  const resumedFrom = cache.byteOffset

  const tracker = { lastCompleteLineOffset: resumedFrom }
  for await (const line of readSessionLines(transcriptPath, undefined, {
    startByteOffset: resumedFrom,
    byteOffsetTracker: tracker,
    largeLineAsBuffer: true,
  })) {
    const entry = parseJsonlLine(line)
    if (!entry) continue
    const call = parseApiCall(entry)
    if (!call) continue
    cache.costUSD += call.costUSD
    for (const tc of call.toolSequence?.flat() ?? []) {
      if (EDIT_TOOLS.has(tc.tool)) cache.editCount++
      if (!cache.sawGitCommit && tc.command && GIT_COMMIT.test(tc.command)) cache.sawGitCommit = true
    }
    if (call.timestamp) cache.lastTurnAt = call.timestamp
  }

  cache.byteOffset = tracker.lastCompleteLineOffset
  cache.updatedAt = new Date().toISOString()
  return { cache, resumedFrom }
}

export async function isAllowed(sessionId: string, base?: string): Promise<boolean> {
  try {
    await stat(allowPath(sessionId, base))
    return true
  } catch {
    return false
  }
}

export async function writeAllow(sessionId: string, base?: string): Promise<void> {
  await mkdir(guardDir(base), { recursive: true })
  await writeFile(allowPath(sessionId, base), '', 'utf-8')
}
