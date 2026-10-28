import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)), repo = dirname(here)
const root = await realpath(tmpdir())
const home = await mkdtemp(join(root, 'native-tui-console-'))
let child, closed, timeout, killTimer
try {
  const profile = join(home, 'profiles/tui')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'cordis.yml'), '[]\n')
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'console-probe', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + repo },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
  }))
  await writeFile(join(profile, 'cordis.patch.yml'), '- id: native-tui\n  name: dsh-native-tui\n  config:\n    agentPreset: standard\n')
  await symlink(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
  const inject = pathToFileURL(join(here, 'fake-tty-console-inject.mjs')).href
  child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
    cwd: repo,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|CREDENTIAL/.test(key))),
      DSH_HOME: home, DSH_NATIVE_TUI_NO_LAUNCHER: '1', TERM: 'xterm-256color',
      DSH_NATIVE_TUI_DEBUG: '1', NODE_OPTIONS: '--import ' + inject,
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  })
  closed = once(child, 'close')
  let out = '', err = '', sent = false, exiting = false, timedOut = false
  const traced = () => ['llm-deepseek-api-key', 'llm-deepseek-account']
    .every(owner => err.includes('[native-tui] console.info: [' + owner + '] model listing'))
  const notices = () => out.includes('! [llm-deepseek-account] probe warning line')
    && out.includes('✕ [llm-deepseek-account] probe error line')
  const advance = () => {
    if (!sent && out.includes('enter send')) {
      sent = true
      child.send('native-tui-console-probe')
    }
    if (!exiting && notices() && traced()) {
      exiting = true
      child.stdin.write(String.fromCharCode(4))
    }
  }
  child.stdout.on('data', data => { out += String(data); advance() })
  child.stderr.on('data', data => { err += String(data); advance() })
  timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    killTimer = setTimeout(() => { child.kill('SIGKILL') }, 5000)
  }, 20000)
  const [code, signal] = await closed
  assert(!timedOut, 'Console probe timed out: ' + err.slice(-2000))
  assert.equal(signal, null)
  assert.equal(code, 0, err.slice(-2000))
  const result = {
    infoOnScreen: out.includes('model listing from'),
    warningAsNotice: out.includes('! [llm-deepseek-account] probe warning line'),
    errorAsNotice: out.includes('✕ [llm-deepseek-account] probe error line'),
    rawDiagnosticWrite: /(^|[\r\n])\[llm-deepseek-(?:account|api-key)\]/.test(out),
    infoTraced: traced(),
  }
  assert(sent && exiting && !result.infoOnScreen && result.warningAsNotice && result.errorAsNotice
    && !result.rawDiagnosticWrite && result.infoTraced, JSON.stringify(result))
  console.log('PASS console diagnostics ' + JSON.stringify(result))
} finally {
  clearTimeout(timeout)
  clearTimeout(killTimer)
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await closed.catch(() => {})
  }
  if (dirname(home) !== root || !home.startsWith(join(root, 'native-tui-console-'))) throw new Error('unsafe cleanup target')
  await rm(home, { recursive: true, force: true })
}
