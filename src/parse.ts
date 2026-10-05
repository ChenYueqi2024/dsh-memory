/**
 * Tolerant parsing of the extraction model's JSON-array output.
 * Pure module: no dsh runtime imports, unit-testable in isolation.
 * @module dsh-memory/parse
 */

import type { MemoryCandidate } from './store.ts'

const KINDS = ['decision', 'convention', 'preference', 'fact'] as const

export function parseCandidates(text: string): MemoryCandidate[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: MemoryCandidate[] = []
  for (const item of parsed) {
    const kind = (item as any)?.kind
    const text = typeof (item as any)?.text === 'string' ? (item as any).text.trim() : ''
    if (text.length >= 4 && (KINDS as readonly string[]).includes(kind)) {
      out.push({ kind, text })
    }
  }
  return out
}
