import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { validate, plan, score, answerMessages, summarize, redact, markdown } from './core.mjs'
import { createTransport, ENDPOINT } from './transport.mjs'

const directory = dirname(fileURLToPath(import.meta.url))
const cases = JSON.parse(readFileSync(join(directory, 'cases.json'), 'utf8')).cases
const rubric = JSON.parse(readFileSync(join(directory, 'rubric.json'), 'utf8')).cases
const request = { messages: answerMessages('', '项目代号是什么？'), phase: 'answer', maxTokens: 256 }
const label = { caseId: 'recall-codename', group: 'none', suite: 'comparison', repeat: 1 }
const response = (overrides = {}) => ({ ok: true, json: async () => ({
  model: 'provider-model', choices: [{ message: { content: '{"answer":"UNKNOWN","sources":[]}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_cache_hit_tokens: 3 }, ...overrides,
}) })

test('dataset has 20 balanced comparison cases and four independent diagnostics', () => {
  validate(cases, rubric)
  assert.equal(cases.length, 24)
  const main = cases.filter(c => c.suite === 'comparison')
  assert.equal(main.length, 20)
  assert.deepEqual(Object.values(Object.groupBy(main, c => c.category)).map(v => v.length), [4, 4, 4, 4, 4])
  assert.equal(plan(cases).cellCount, 192)
  assert.equal(plan(cases).maxCalls, 306)
  assert.equal(plan(cases).maxOutputTokens, 165888)
})

test('validator rejects duplicate cases, unscoped workspaces and mixed governance comparisons', () => {
  assert.throws(() => validate([...cases, cases[0]], rubric), /duplicate/)
  assert.throws(() => validate([{ ...cases[0], query: { workspace: '../outside', text: 'q' } }], rubric), /workspace/)
  assert.throws(() => validate([{ ...cases[0], requireApproval: true }], rubric), /diagnostics/)
})

test('schedule is deterministic, seed-sensitive and covers each cell exactly once', () => {
  const a = plan(cases, 2, 7), b = plan(cases, 2, 8)
  assert.deepEqual(a, plan(cases, 2, 7))
  assert.notDeepEqual(a.cells, b.cells)
  assert.equal(new Set(a.cells.map(c => JSON.stringify(c))).size, 128)
  assert.ok(a.cells.filter(c => c.suite === 'diagnostic').every(c => c.group === 'memory'))
  assert.throws(() => plan(cases, 0), /Invalid/)
})

test('scoring accepts normalized exact aliases but rejects stale/correct mixtures', () => {
  assert.equal(score('{"answer":" PNPM ","sources":["AGENTS.md"]}', { answers: ['pnpm'] }, ['AGENTS.md']).correct, true)
  assert.equal(score('{"answer":"npm 或 pnpm","sources":["AGENTS.md"]}', { answers: ['pnpm'] }, ['AGENTS.md']).correct, false)
  assert.equal(score('{"answer":"星期五","sources":[]}', rubric['update-release-day'], []).correct, true)
})

test('invalid JSON, extra fields and malformed sources cannot earn credit', () => {
  for (const text of ['```json\n{}\n```', 'null', '{"answer":"pnpm","sources":"AGENTS.md"}', '{"answer":"pnpm","sources":[],"extra":1}']) {
    assert.equal(score(text, { answers: ['pnpm'] }, []).correct, false)
  }
})

test('UNKNOWN needs empty sources and invented source IDs fail independently of answer', () => {
  assert.equal(score('{"answer":"UNKNOWN","sources":[]}', { answers: ['UNKNOWN'] }, []).sourceValid, true)
  assert.equal(score('{"answer":"UNKNOWN","sources":["#fake"]}', { answers: ['UNKNOWN'] }, []).sourceValid, false)
  const result = score('{"answer":"pnpm","sources":["#fake"]}', { answers: ['pnpm'] }, ['#12345678'])
  assert.equal(result.correct, true)
  assert.equal(result.sourceValid, false)
  assert.equal(score('{"answer":"pnpm","sources":[]}', { answers: ['UNKNOWN'] }, []).unsupportedAnswer, true)
})

test('memory checks separate pending, active and retired entries', () => {
  const records = [{ approved: true }, { approved: false }, { approved: true, supersededAt: 'date' }]
  const result = score('{"answer":"npm","sources":[]}', { answers: ['npm'], memory: { total: 3, active: 1, pending: 1, supersededMin: 1 } }, [], records)
  assert.ok(Object.values(result.memoryChecks).every(Boolean))
})

test('answer messages contain supplied context and question only, never a gold field', () => {
  const messages = answerMessages('PROJECT_CONTEXT', 'QUESTION')
  assert.equal(messages.length, 2)
  assert.ok(messages[0].content.endsWith('PROJECT_CONTEXT'))
  assert.equal(messages[1].content, 'QUESTION')
  assert.ok(!JSON.stringify(messages).includes('answers'))
})

test('smoke never fetches, never gets gold and records no token usage', async () => {
  const transport = createTransport({ mode: 'smoke', maxCalls: 1, fetchImpl: () => assert.fail('network called') })
  const result = await transport.complete(request, label)
  assert.equal(JSON.parse(result.text).answer, 'UNKNOWN')
  assert.equal(transport.calls[0].usage, null)
  await assert.rejects(transport.complete(request, label), /budget/)
})

test('live adapter sends configured request and records usage without credentials', async () => {
  const key = 'synthetic-test-credential-not-real'
  const transport = createTransport({ mode: 'live', key, maxCalls: 1, fetchImpl: async (url, options) => {
    assert.equal(url, ENDPOINT)
    assert.equal(options.headers.Authorization, `Bearer ${key}`)
    assert.equal(options.redirect, 'error')
    const body = JSON.parse(options.body)
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.deepEqual(body.response_format, { type: 'json_object' })
    assert.equal(body.max_tokens, 256)
    assert.equal(body.temperature, 0)
    assert.equal(options.signal.aborted, false)
    return response()
  } })
  await transport.complete(request, label)
  assert.equal(transport.calls[0].usage.total_tokens, 20)
  assert.equal(transport.calls[0].returnedModel, 'provider-model')
  assert.ok(!JSON.stringify(transport.calls).includes(key))
})

test('missing credentials and invalid budgets fail before network', () => {
  assert.throws(() => createTransport({ mode: 'live', maxCalls: 1 }), /DEEPSEEK_API_KEY/)
  assert.throws(() => createTransport({ mode: 'smoke', maxCalls: NaN }), /budget/)
})

test('HTTP errors suppress response body and stop subsequent paid requests', async () => {
  let requests = 0
  const transport = createTransport({ mode: 'live', key: 'fake', maxCalls: 3, fetchImpl: async () => {
    requests++
    return { ok: false, status: 401, json: () => assert.fail('must not log error body') }
  } })
  await assert.rejects(transport.complete(request, label), /^Error: HTTP 401$/)
  await assert.rejects(transport.complete(request, label), /stopped/)
  assert.equal(requests, 1)
  assert.equal(transport.fatal, true)
})

test('network exceptions are sanitized and abort propagates to fetch', async () => {
  const controller = new AbortController()
  controller.abort()
  const transport = createTransport({ mode: 'live', key: 'fake', maxCalls: 1, fetchImpl: async (_, options) => {
    assert.equal(options.signal.aborted, true)
    throw new Error('PRIVATE PROVIDER CONTENT')
  } })
  await assert.rejects(transport.complete({ ...request, signal: controller.signal }, label), /timed out/)
  assert.ok(!JSON.stringify(transport.calls).includes('PRIVATE'))
})

test('truncated or malformed provider responses cannot pass as completed answers', async () => {
  for (const choices of [[], [{ message: { content: '{}' }, finish_reason: 'length' }]]) {
    const transport = createTransport({ mode: 'live', key: 'fake', maxCalls: 1, fetchImpl: async () => response({ choices }) })
    await assert.rejects(transport.complete(request, label), /response/)
    assert.equal(transport.fatal, true)
    assert.equal(transport.calls[0].status, 'error')
  }
})

test('summary retains failed denominator and separates diagnostic costs', () => {
  const schedule = plan([cases[0]], 1)
  const rows = schedule.cells.map(c => ({ ...c, status: c.group === 'none' ? 'error' : 'ok',
    score: score(c.group === 'none' ? '' : '{"answer":"pnpm","sources":["AGENTS.md"]}', rubric[c.caseId], ['AGENTS.md']) }))
  const calls = ['comparison', 'diagnostic'].map(suite => ({ suite, group: 'memory', phase: 'extraction', elapsedMs: 1, usage: { prompt_tokens: 10, completion_tokens: 5 } }))
  const summary = summarize(rows, calls, 'live', schedule)
  assert.equal(summary.groups.none.quality.accuracy, 0)
  assert.equal(summary.groups.static.quality.accuracy, 1)
  assert.equal(summary.cost.memory.promptTokens, 10)
  assert.equal(summary.diagnosticCost.promptTokens, 10)
  assert.equal(summary.paired.none.memoryOnlyCorrect, 1)
})

test('smoke summary cannot manufacture quality scores or measured costs', () => {
  const summary = summarize([], [], 'smoke', plan(cases, 1))
  assert.ok(Object.values(summary.groups).every(g => g.quality === null))
  assert.equal(summary.cost.memory.promptTokens, null)
  assert.equal(summary.paired, null)
  assert.equal(summary.complete, false)
  assert.match(markdown(summary), /NOT MODEL QUALITY EVIDENCE/)
})

test('failed unknown answers are not silently counted as successful abstentions', () => {
  const c = cases.find(c => c.id === 'scope-unknown'), schedule = plan([c], 1)
  const rows = schedule.cells.map(cell => ({ ...cell, status: 'error', score: score('', rubric[c.id], []) }))
  const summary = summarize(rows, [], 'live', schedule)
  assert.equal(summary.groups.none.quality.accuracy, 0)
  assert.equal(summary.groups.none.quality.unsupportedAnswerRate, null)
  assert.equal(summary.groups.none.quality.unsupportedAnswerDenominator, 0)
  assert.equal(summary.groups.none.quality.formatFailureCount, 0)
  assert.equal(summary.groups.none.errors, 1)
})

test('redactor removes repeated exact credential strings', () => {
  assert.equal(redact('fake-secret / fake-secret', ['', undefined, 'fake-secret']), '[REDACTED] / [REDACTED]')
})

test('CLI plan and missing-key preflight create no run directory', () => {
  const output = join(directory, 'runs', `must-not-exist-${randomUUID()}`)
  const env = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  const run = mode => spawnSync(process.execPath, [join(directory, 'run.mjs'), '--mode', mode, '--out', output, '--case', 'recall-package', '--repeats', '1'], { env, encoding: 'utf8' })
  const dry = run('plan')
  assert.equal(dry.status, 0, dry.stderr)
  assert.equal(JSON.parse(dry.stdout).maxCalls, 4)
  const live = run('live')
  assert.equal(live.status, 1)
  assert.match(live.stderr, /DEEPSEEK_API_KEY/)
  assert.equal(existsSync(output), false)
})
