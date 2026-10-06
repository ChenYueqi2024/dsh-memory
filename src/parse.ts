/**
 * Tolerant parsing of the extraction model's JSON output.
 * Accepts the current object contract {"new":[...],"reinforce":["#id"]} and the
 * legacy plain-array format (treated as all-new). Pure module: no dsh runtime
 * imports, unit-testable in isolation.
 * @module dsh-memory/parse
 */

import type { MemoryCandidate } from './store.ts'

const KINDS = ['decision', 'convention', 'preference', 'fact'] as const

export interface ExtractionOutput {
  new: MemoryCandidate[]
  reinforce: string[]
  supersede: string[]
}

export function parseExtraction(text: string): ExtractionOutput {
  const start = text.indexOf('{')
  const arrStart = text.indexOf('[')
  // 对象契约优先：首个 { 出现在首个 [ 之前才算对象输出
  if (start !== -1 && (arrStart === -1 || start < arrStart)) {
    const end = text.lastIndexOf('}')
    if (end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const out: ExtractionOutput = { new: candidatesOf(parsed.new), reinforce: idsOf(parsed.reinforce), supersede: idsOf(parsed.supersede) }
          if (out.new.length || out.reinforce.length) return out
          return { new: [], reinforce: [] }
        }
      } catch { /* fall through to array parsing */ }
    }
  }
  return { new: legacyArray(text), reinforce: [], supersede: [] }
}

const MAX_TEXT_CHARS = 400

function candidatesOf(raw: unknown): MemoryCandidate[] {
  if (!Array.isArray(raw)) return []
  const out: MemoryCandidate[] = []
  for (const item of raw) {
    const kind = (item as any)?.kind
    const text = typeof (item as any)?.text === 'string' ? (item as any).text.trim() : ''
    if (text.length >= 4 && (KINDS as readonly string[]).includes(kind)) {
      out.push({ kind, text: text.slice(0, MAX_TEXT_CHARS) })
    }
  }
  return out
}

function idsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string' && v.length >= 4)
}

function legacyArray(text: string): MemoryCandidate[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return candidatesOf(parsed)
  } catch {
    return []
  }
}
