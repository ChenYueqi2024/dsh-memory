import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Lifecycle tests substitute only host registration/schema/LLM framing APIs.
// The plugin entry, extractor, parser and store run unchanged; real host loading
// is verified separately by scripts/verify-host.mjs.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@deepseek-ai\/(schemastery|dsh-storage-domain|dsh-tools|dsh-llm)$/, replacement: fileURLToPath(new URL('./tests/host.ts', import.meta.url)) },
      { find: /^zod$/, replacement: fileURLToPath(new URL('./tests/host.ts', import.meta.url)) },
    ],
  },
})
