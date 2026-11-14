/** Minimal host boundary for deterministic lifecycle tests, not a host emulator. */
const schema: any = new Proxy(() => schema, { get: () => schema })
export default schema
export const z = schema
export const defineDomain = (domain: unknown) => domain
export const defineTool = (tool: unknown) => tool
export const createUserMessage = (message: unknown) => message
export class BlockAssembler {
  private text = ''
  finish = { kind: 'stop' }
  push(chunk: any) {
    if (chunk.type === 'text-delta') this.text += chunk.text
    if (chunk.type === 'finish') this.finish = chunk.reason
  }
  blocks() { return [{ type: 'text', text: this.text }] }
}
