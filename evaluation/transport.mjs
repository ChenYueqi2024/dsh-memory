import { performance } from 'node:perf_hooks'

export const ENDPOINT = 'https://api.deepseek.com/chat/completions'

/** No SDK, retries, file credentials or response-body error logging. */
export function createTransport({ mode, model = 'deepseek-flash', key, maxCalls, fetchImpl = globalThis.fetch, onRecord = () => {} }) {
  if (!['smoke', 'live'].includes(mode)) throw new Error('Transport mode must be smoke or live')
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) throw new Error('Invalid call budget')
  if (mode === 'live' && !key) throw new Error('Set DEEPSEEK_API_KEY in the current process; no request was sent')
  const calls = []
  let fatal = false
  return {
    calls,
    get fatal() { return fatal },
    async complete({ messages, phase, maxTokens, signal }, label) {
      if (fatal || calls.length >= maxCalls) throw new Error('Evaluation call budget exhausted or transport stopped')
      const started = performance.now()
      const body = { model, messages, stream: false, temperature: 0, thinking: { type: 'disabled' },
        response_format: { type: 'json_object' }, max_tokens: maxTokens }
      const record = { ...label, index: calls.length + 1, phase, request: body, usage: null, status: 'pending' }
      calls.push(record)
      try {
        if (mode === 'smoke') {
          // Deliberately naive, no rubric access: exercise wiring, not model quality.
          const framed = messages.at(-1).content
          const transcript = framed.split('会话记录如下：\n')[1]?.split('\n\n请输出记忆 JSON。')[0] ?? ''
          const statements = transcript.split('\n').filter(s => s.startsWith('用户：')).flatMap(s => s.slice(3).split('。')).filter(s => s.trim().length >= 4)
          record.text = phase === 'extraction'
            ? JSON.stringify({ new: statements.map(text => ({ kind: 'fact', text: text.trim().slice(0, 400) })), reinforce: [], supersede: [] })
            : JSON.stringify({ answer: 'UNKNOWN', sources: [] })
          record.finishReason = 'stop'
          record.returnedModel = 'OFFLINE-FIXTURE'
        } else {
          const response = await fetchImpl(ENDPOINT, {
            method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          const choice = payload.choices?.[0]
          record.text = choice?.message?.content
          record.finishReason = choice?.finish_reason
          record.returnedModel = typeof payload.model === 'string' ? payload.model : null
          record.systemFingerprint = typeof payload.system_fingerprint === 'string' ? payload.system_fingerprint : null
          if (Number.isFinite(payload.usage?.prompt_tokens) && Number.isFinite(payload.usage?.completion_tokens)) {
            record.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']
              .filter(k => Number.isFinite(payload.usage[k])).map(k => [k, payload.usage[k]]))
          }
          if (typeof record.text !== 'string') throw new Error('Invalid response content')
          if (record.finishReason !== 'stop') throw new Error('Incomplete model response')
        }
        record.status = 'ok'
        return { text: record.text, finishReason: record.finishReason }
      } catch (error) {
        // Never persist raw network/provider exceptions or authorization headers.
        record.status = 'error'
        record.error = /^HTTP \d{3}$/.test(error.message) ? error.message
          : ['Invalid response content', 'Incomplete model response'].includes(error.message) ? error.message : 'Transport failed or timed out'
        fatal = true
        throw new Error(record.error)
      } finally {
        record.elapsedMs = Math.round((performance.now() - started) * 100) / 100
        onRecord(record)
      }
    },
  }
}
