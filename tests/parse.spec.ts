import { describe, expect, it } from 'vitest'
import { parseCandidates } from '../src/parse.ts'

describe('parseCandidates', () => {
  it('parses a plain JSON array', () => {
    const out = parseCandidates('[{"kind":"fact","text":"本项目在 D 盘"}]')
    expect(out).toEqual([{ kind: 'fact', text: '本项目在 D 盘' }])
  })

  it('parses JSON wrapped in prose or code fences', () => {
    const text = '好的，以下是记忆：\n```json\n[{"kind":"decision","text":"数据库选 SQLite。"}]\n```'
    expect(parseCandidates(text)).toEqual([{ kind: 'decision', text: '数据库选 SQLite。' }])
  })

  it('returns empty for empty-array output', () => {
    expect(parseCandidates('[]')).toEqual([])
  })

  it('returns empty for invalid JSON', () => {
    expect(parseCandidates('这不是 JSON')).toEqual([])
    expect(parseCandidates('[{kind:fact}]')).toEqual([])
  })

  it('drops unknown kinds and over-short texts', () => {
    const out = parseCandidates(JSON.stringify([
      { kind: ' rumor ', text: '不确定的信息来源' },
      { kind: 'fact', text: '短' },
      { kind: 'fact', text: '合法的记忆条目' },
    ]))
    expect(out).toEqual([{ kind: 'fact', text: '合法的记忆条目' }])
  })

  it('returns empty when the model outputs a non-array', () => {
    expect(parseCandidates('{"kind":"fact","text":"对象而非数组"}')).toEqual([])
  })
})
