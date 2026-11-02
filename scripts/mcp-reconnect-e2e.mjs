/**
 * End-to-end check that a restarted Streamable HTTP MCP server is noticed and
 * reconnected without restarting the Host.
 *
 * mcp-client cannot see this failure on its own: the HTTP transport reports a
 * close only when it is closed from this side, so a restarted server leaves the
 * tools registered and every call failing. mcp-manager treats a
 * connection-class tool failure as the disconnect signal and rebuilds the row.
 * This probe drives that path through a real mcp-client instance:
 *
 *   1. serve, connect, call the tool   -> connected, the call succeeds
 *   2. kill the server and call again  -> the call fails, state goes down
 *   3. serve again                     -> the manager rebuilds the row, the
 *                                         tool is registered again and works
 *
 * Run with: pnpm build && node scripts/mcp-reconnect-e2e.mjs
 */
import { spawn } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { apply as applyManager } from '../dist/mcp-manager.js'

const TOOL_NAME = 'mcp__demo__echo'
const SERVER_SCRIPT = 'scripts/fake-mcp-http.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Fail the probe with one readable line instead of a stack trace. */
function fail(message) {
  console.log('FAIL ' + message)
  process.exit(1)
}

/**
 * Start one fake HTTP MCP server and wait until it reports its port.
 * @param port - endpoint to bind; 0 picks a free one.
 */
function serve(port = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_SCRIPT, String(port)], { stdio: ['ignore', 'pipe', 'inherit'] })
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const match = /LISTENING (\d+)/u.exec(buffer)
      if (match !== null) resolve({ child, port: Number(match[1]) })
    })
    child.on('error', reject)
    setTimeout(() => reject(new Error('fake server did not start')), 5000).unref()
  })
}

const ctx = new Context()
const registered = new Map()
const loaded = new Map()

// Minimal stand-in for @deepseek-ai/dsh-tools: mcp-client registers through it
// and mcp-manager reads connection state back through schemas().
ctx.provide('tools', {
  register(definition) {
    registered.set(definition.name, definition)
    return () => { registered.delete(definition.name) }
  },
  schemas() {
    return [...registered.values()].map(definition => ({ name: definition.name }))
  },
})

const configured = { url: '' }
// The manager builds its rows through the Host Loader. This shim implements
// exactly the three calls mcp-manager makes: create() loads the real
// mcp-client plugin into the calling scope, resolve() reports that fiber, and
// remove() disposes it.
ctx.provide('loader', {
  async create({ id, config }) {
    const fiber = ctx.plugin(mcpClient, { ...config, url: configured.url })
    // Cordis exposes FiberState.ACTIVE as 2; mcp-client activation implies it.
    loaded.set(id, fiber)
    await fiber.await()
    return id
  },
  resolve(id) {
    return { fiber: loaded.get(id) }
  },
  remove(id) {
    const fiber = loaded.get(id)
    loaded.delete(id)
    if (fiber !== undefined) void fiber.dispose()
  },
})
ctx.provide('settings', { configure: () => () => {} })

/** Ask the manager what it currently believes about `demo`. */
let manager
const statusOf = () => manager?.snapshot().demo

/**
 * Run one tool call the way the Host does.
 *
 * The registry pipeline owns the `tools/result` notification, so this helper
 * performs the same two steps for the call it dispatches: invoke the
 * definition, then emit the normalized outcome. Only the pipeline wrapper is
 * reproduced here; the definitions, the registry and the manager's listener
 * are the real ones.
 */
async function call(text) {
  const definition = registered.get(TOOL_NAME)
  if (definition === undefined) return { ok: false, error: 'tool is not registered' }
  const exec = {
    callId: 'call-' + text,
    rootCallId: 'call-' + text,
    name: TOOL_NAME,
    arguments: { text },
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  }
  try {
    const value = await definition.execute({ text }, exec)
    ctx.emit('tools/result', exec, { isError: false, content: [{ type: 'text', text: '' }] })
    return { ok: true, value }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.emit('tools/result', exec, { isError: true, error: { message }, content: [{ type: 'text', text: 'Error: ' + message }] })
    return { ok: false, error: message }
  }
}

let server = await serve()
configured.url = 'http://127.0.0.1:' + server.port + '/mcp'
console.log('fake server on', server.port)

// Load the manager itself through the plugin system so it publishes
// mcpManagerStatus exactly as it does in a Host.
const servers = () => ({ demo: { transport: 'streamable-http', serverName: 'demo' } })
ctx.plugin(applyManager, { servers: { get: servers } })
await sleep(600)
manager = ctx.get('mcpManagerStatus')
if (manager === undefined) fail('mcp-manager did not publish mcpManagerStatus')

await sleep(600)
console.log('step 1: state after startup =', JSON.stringify(statusOf()))
const first = await call('one')
if (!first.ok) fail('initial call failed: ' + first.error)
console.log('step 1 ok: call returned', JSON.stringify(first.value))

// A server restart is the case under test: the process goes away and comes
// back on the same endpoint while the Host keeps running.
server.child.kill('SIGKILL')
await sleep(400)
const broken = await call('two')
if (broken.ok) fail('the call should have failed while the server was down')
console.log('step 2: call while down ->', broken.error)
await sleep(100)
console.log('step 2: state after the failed call =', JSON.stringify(statusOf()))
if (statusOf()?.status !== 'disconnected') fail('the manager did not notice the lost connection')

// A restart keeps the endpoint: the manager must rebuild against the same URL.
server = await serve(server.port)
console.log('step 3: fake server restarted on', server.port)

// The automatic rebuild fires on the reconnect backoff; give it room to land.
for (let index = 0; index < 30; index += 1) {
  await sleep(200)
  if (statusOf()?.status === 'connected' && registered.has(TOOL_NAME)) break
}
console.log('step 3: state after the restart =', JSON.stringify(statusOf()))
if (statusOf()?.status !== 'connected') fail('the manager did not reconnect')

const again = await call('three')
if (!again.ok) fail('the call after the restart failed: ' + again.error)
console.log('step 3 ok: call returned', JSON.stringify(again.value))

// The manual path must work on its own: a server that is already healthy is
// rebuilt without waiting for a failure, and keeps working afterwards.
const before = loaded.size
await manager.reload('demo')
if (loaded.size !== before) fail('reload left ' + loaded.size + ' rows instead of ' + before)
console.log('step 4: /mcp reload rebuilt the row, state =', JSON.stringify(statusOf()))
if (statusOf()?.status !== 'connected') fail('reload did not reconnect')
const reloaded = await call('four')
if (!reloaded.ok) fail('the call after /mcp reload failed: ' + reloaded.error)
console.log('step 4 ok: call returned', JSON.stringify(reloaded.value))

server.child.kill('SIGKILL')
console.log('PASS')
process.exit(0)
