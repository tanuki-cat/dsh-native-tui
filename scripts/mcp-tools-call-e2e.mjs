/**
 * End-to-end MCP check: the real official mcp-client bridge connects to the
 * fake stdio server, registers its tool on the harness tool registry, and one
 * tools/call round trip returns the server's real payload.
 *
 * Run with: node scripts/mcp-tools-call-e2e.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'

const TOOL_NAME = 'mcp__demo__echo'
const registered = new Map()
const ctx = new Context()

// Minimal stand-in for @deepseek-ai/dsh-tools: the bridge only needs register()
// and the registry query the manager uses for connection state.
ctx.provide('tools', {
  register(definition) {
    registered.set(definition.name, definition)
    return () => { registered.delete(definition.name) }
  },
  schemas() {
    return [...registered.values()].map(definition => ({ name: definition.name }))
  },
})

ctx.plugin(mcpClient, {
  transport: 'stdio',
  serverName: 'demo',
  command: process.execPath,
  args: ['scripts/fake-mcp-stdio.mjs'],
  env: {},
  cwd: process.cwd(),
  toolCallTimeoutMs: 10_000,
  failOnStartupError: true,
})

const fail = async (message) => {
  console.log('FAIL', message)
  try { await ctx.root.fiber.dispose() } catch {}
  process.exit(1)
}

const deadline = Date.now() + 20_000
while (!registered.has(TOOL_NAME) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))

if (!registered.has(TOOL_NAME)) {
  await fail('tool not registered; registry holds: ' + JSON.stringify([...registered.keys()]))
}

const tool = registered.get(TOOL_NAME)
console.log('registered tool:', tool.name, '| description:', tool.description)

const result = await tool.execute({ text: 'hello' }, {})
console.log('canonical value:', JSON.stringify(result))

if (result.structuredContent?.echoed !== 'hello') await fail('structuredContent.echoed mismatch: ' + JSON.stringify(result.structuredContent))
if (result.content?.[0]?.text !== 'echo:hello') await fail('text content mismatch: ' + JSON.stringify(result.content))

console.log('OK tools/call round trip verified')
try { await ctx.root.fiber.dispose() } catch {}
process.exit(0)
