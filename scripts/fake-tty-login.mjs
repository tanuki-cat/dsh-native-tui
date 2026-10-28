/** Real-Host login picker probe; never starts OAuth or needs an account. */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

mkdirSync('.tmp', { recursive: true })
const temporaryRoot = realpathSync('.tmp')
const home = mkdtempSync(join(temporaryRoot, 'login-probe-'))
try {
  const profile = join(home, 'profiles/tui')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  writeFileSync(join(profile, 'cordis.yml'), '# dsh profile root\n[]\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-tui', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + process.cwd() },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
  }))
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- id: native-tui', '  name: dsh-native-tui', '  config:', '    agentPreset: standard', '',
  ].join('\n'))
  symlinkSync(process.cwd(), join(profile, 'node_modules/dsh-native-tui'), 'dir')

  const child = spawn(process.execPath, ['scripts/fake-tty-entry.mjs', '--profile', 'tui'], {
    cwd: process.cwd(),
    env: {
      ...process.env, DSH_HOME: home, DSH_NATIVE_TUI_NO_LAUNCHER: '1',
      TERM: 'xterm-256color', COLORTERM: 'truecolor', FAKE_TTY_COLUMNS: '120',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let out = '', err = '', pending = '', stage = 0, timedOut = false
  const closed = new Promise(resolve => {
    child.on('error', error => { err += String(error) })
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30000)
  child.stderr.on('data', chunk => { err += String(chunk) })
  child.stdin.on('error', error => { err += String(error) })
  child.stdout.on('data', chunk => {
    out += String(chunk)
    pending += String(chunk)
    const text = pending.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    if (stage === 0 && text.includes('enter send')) {
      stage = 1; pending = ''
      child.stdin.write('/login\r')
    }
    else if (stage === 1 && ['选择登录平台', 'CodeBuddy / WorkBuddy', 'ChatGPT Codex', 'DeepSeek 官方（待实现）'].every(label => text.includes(label))) {
      console.log('PASS /login opens the platform picker with all three platforms')
      stage = 2; pending = ''
      child.stdin.write('\x1b[B\x1b[B\r')
    }
    else if (stage === 2 && text.includes('DeepSeek 官方登录待实现，请使用 /provider 配置 API Key。')) {
      console.log('PASS DeepSeek selection reports the pending implementation')
      stage = 3; pending = ''
      child.stdin.write('\x04')
    }
  })
  const { code, signal } = await closed
  clearTimeout(deadline)
  if (timedOut || code !== 0 || signal !== null || stage !== 3) {
    console.error('FAIL login probe', { timedOut, code, signal, stage })
    console.error(out.slice(-12000), err.slice(-4000))
    process.exitCode = 1
  }
  else console.log('PASS process exits cleanly without starting OAuth')
}
finally {
  if (dirname(home) !== temporaryRoot || !basename(home).startsWith('login-probe-') || realpathSync(home) !== home) {
    throw new Error('Refusing to remove an unexpected probe directory: ' + home)
  }
  rmSync(home, { recursive: true, force: true })
}
