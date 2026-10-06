import { describe, expect, it } from 'vitest'
import { parseExtraction } from '../src/parse.ts'

describe('parseExtraction object contract', () => {
  it('parses {"new", "reinforce"} output', () => {
    const text = '{"new":[{"kind":"fact","text":"新的记忆条目内容"}],"reinforce":["#ab12cd34"]}'
    const out = parseExtraction(text)
    expect(out.new).toEqual([{ kind: 'fact', text: '新的记忆条目内容' }])
    expect(out.reinforce).toEqual(['#ab12cd34'])
  })

  it('accepts empty object output', () => {
    expect(parseExtraction('{"new":[],"reinforce":[]}')).toEqual({ new: [], reinforce: [] })
  })

  it('tolerates junk around the JSON object', () => {
    const text = '好的。\n{"new":[],"reinforce":["c32400e3"]}\n以上。'
    expect(parseExtraction(text).reinforce).toEqual(['c32400e3'])
  })
})

describe('parseCandidates', () => {
  it('parses a plain JSON array', () => {
    const out = parseExtraction('[{"kind":"fact","text":"本项目在 D 盘"}]')
    expect(out.new).toEqual([{ kind: 'fact', text: '本项目在 D 盘' }])
  })

  it('parses JSON wrapped in prose or code fences', () => {
    const text = '好的，以下是记忆：\n```json\n[{"kind":"decision","text":"数据库选 SQLite。"}]\n```'
    expect(parseExtraction(text).new).toEqual([{ kind: 'decision', text: '数据库选 SQLite。' }])
  })

  it('returns empty for empty-array output', () => {
    expect(parseExtraction('[]').new).toEqual([])
  })

  it('returns empty for invalid JSON', () => {
    expect(parseExtraction('这不是 JSON').new).toEqual([])
    expect(parseExtraction('[{kind:fact}]').new).toEqual([])
  })

  it('drops unknown kinds and over-short texts', () => {
    const out = parseExtraction(JSON.stringify([
      { kind: ' rumor ', text: '不确定的信息来源' },
      { kind: 'fact', text: '短' },
      { kind: 'fact', text: '合法的记忆条目' },
    ]))
    expect(out.new).toEqual([{ kind: 'fact', text: '合法的记忆条目' }])
  })

  it('returns empty when the model outputs a non-array', () => {
    expect(parseExtraction('{"kind":"fact","text":"对象而非数组"}').new).toEqual([])
  })
})
