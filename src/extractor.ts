/**
 * Transcript accumulation and the one auxiliary LLM call that turns a session
 * transcript into durable memory candidates (JSON array output).
 * @module dsh-memory/extractor
 */

import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryCandidate } from './store.ts'
import type { Config } from './index.ts'
import { parseExtraction } from './parse.ts'

const KINDS = ['decision', 'convention', 'preference', 'fact'] as const

/** Existing memories shown to the extractor so it can reinforce instead of re-extract. */
export interface ExistingMemory {
  id: string
  text: string
}

const EXTRACTION_SYSTEM = [
  '你是项目会话的记忆提取器。从 AI 编程助手会话记录中提取"值得跨会话记住"的信息。',
  '只提取这四类：',
  '- decision: 已做出的技术/方案决策（如"数据库选 SQLite"）',
  '- convention: 项目约定（如"提交信息用中文""不用 npm 用 pnpm"）',
  '- preference: 用户表达的长期偏好（如"回答用中文""不要加注释"）',
  '- fact: 项目重要事实（如"这个仓库是期末项目""部署在 D 盘"）',
  '规则：',
  '1. 只提取明确的、持久的、未来有用的信息；闲聊、临时上下文、一次性任务不要。',
  '2. 每条记忆必须自包含（不依赖上下文就能看懂），一句话，中文。',
  '3. 相似信息合并成一条。',
  '4. 只输出 JSON 数组，格式 [{"kind":"decision","text":"..."}]，没有任何值得记的就输出 []。',
  '5. 不要沉淀关于记忆系统本身或本次对话的元评论（如"这条记忆值得保存""记忆库中没有……"）。',
  '6. 不要输出数组以外的任何文字。',
].join('\n')

/** Rolling transcript for one session, capped to protect the extraction call. */
export class TranscriptBuffer {
  private readonly entries: { role: 'user' | 'assistant'; text: string }[] = []
  private totalChars = 0
  private seenChars = 0

  constructor(private readonly maxChars = 24000) {}

  add(role: 'user' | 'assistant', text: string): void {
    this.entries.push({ role, text })
    this.totalChars += text.length
    this.seenChars += text.length
    while (this.totalChars > this.maxChars && this.entries.length > 2) {
      const dropped = this.entries.shift()!
      this.totalChars -= dropped.text.length
    }
  }

  /** Cumulative characters ever added (never decreases; drives delta-triggered extraction). */
  get seen(): number {
    return this.seenChars
  }

  /** Drop oldest entries until only the trailing `chars` characters remain. */
  keepTail(chars: number): void {
    while (this.entries.length > 1 && this.totalChars > chars) {
      const dropped = this.entries.shift()!
      this.totalChars -= dropped.text.length
    }
  }

  size(): number {
    return this.totalChars
  }

  clear(): void {
    this.entries.length = 0
    this.totalChars = 0
  }

  render(): string {
    return this.entries
      .map(entry => `${entry.role === 'user' ? '用户' : '助手'}：${entry.text}`)
      .join('\n\n')
  }
}

/**
 * One auxiliary LLM call: transcript in, JSON memory candidates out.
 * Mirrors the session-title-llm call policy (frozen options, deadline, assembler).
 */
export async function extractMemories(
  ctx: Context,
  config: Config,
  sessionId: string,
  transcript: string,
  existing: ExistingMemory[] = [],
): Promise<{ new: MemoryCandidate[]; reinforce: string[] }> {
  const framed = `会话记录如下：\n${transcript}\n\n请输出记忆 JSON 数组。`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const options: GenerateOptions = Object.freeze({
      provider: config.provider,
      model: config.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: framed }],
        source: { kind: 'dsh-memory-extract' } as never,
      })],
      system: EXTRACTION_SYSTEM,
      maxTokens: config.maxOutputTokens,
      sessionId,
      purpose: 'dsh-memory-extract',
      signal: controller.signal,
    })
    const assembler = new BlockAssembler()
    for await (const chunk of (ctx.llm as any).stream(options)) assembler.push(chunk)
    const finish = (assembler as any).finish
    if (finish && finish.kind !== 'stop') {
      throw new Error(`extraction llm finish=${finish.kind}`)
    }
    const text = (assembler.blocks() ?? [])
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join(' ')
    return parseExtraction(text)
  } finally {
    clearTimeout(timer)
  }
}
