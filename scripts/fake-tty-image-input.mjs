/** Real Host: inline labels, thumbnail protocols, removal and original image bytes on the model wire. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const protocols = process.argv.slice(2)
if (protocols.length === 0) protocols.push('none', 'kitty', 'iterm2')
assert.ok(protocols.every(protocol => ['none', 'kitty', 'iterm2'].includes(protocol)), 'protocols must be none, kitty, or iterm2')
const root = mkdtempSync(join(tmpdir(), 'native-tui-image-input-'))
const pngChunk = (type, data) => {
  const size = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data])
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([size, body, crc])
}
const header = Buffer.alloc(13)
header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
  pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), pngChunk('IEND', Buffer.alloc(0))])
const imagePath = join(root, 'pasted-image-20261110-' + 'long-private-path-'.repeat(6) + '中文.png')
writeFileSync(imagePath, png)
const strip = text => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const requests = []
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    if (req.url !== '/v1/responses') { res.writeHead(404); res.end(); return }
    const body = JSON.parse(raw)
    if (!raw.includes('Create a concise title')) requests.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, payload = {}) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n')
    const text = 'IMAGE INPUT RECEIVED'
    const item = { id: 'answer', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    send('response.created', { response: { id: 'image-input', status: 'in_progress', output: [] } })
    send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    send('response.output_text.delta', { output_index: 0, delta: text })
    send('response.output_item.done', { output_index: 0, item })
    send('response.completed', { response: { id: 'image-input', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } })
    res.end('data: [DONE]\n\n')
  })
})

async function run(fullscreen, protocol) {
  requests.length = 0
  const label = (fullscreen ? 'fullscreen' : 'main-screen') + '-' + protocol
  const supportsThumbnails = protocol !== 'none'
  const home = join(root, label), profile = join(home, 'profiles/tui'), workspace = join(home, 'workspace'), log = join(home, 'frames.jsonl')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  for (const dir of [workspace, join(home, 'agents'), join(home, 'bundled')]) mkdirSync(dir)
  writeFileSync(join(workspace, 'package.json'), '{"private":true}')
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'image-input-probe', private: true,
    dependencies: { 'dsh-native-tui': 'link:' + repo }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-native-tui'] } },
  }))
  symlinkSync(repo, join(profile, 'node_modules/dsh-native-tui'), 'dir')
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- id: llm-pi-ai', '  config:', '    providers:', '      mock:', '        api: openai-responses',
    '        baseURL: http://127.0.0.1:' + server.address().port + '/v1', '        apiKeyEnv: MOCK_API_KEY',
    '        models:', '          - id: image-model', '            input: [text, image]', '            contextWindow: 128000', '            maxTokens: 4096',
    '- id: native-tui', '  config:', '    agentPreset: standard', '    fullscreen: ' + fullscreen,
    '- id: agent-default-model', '  config:', '    provider: mock', '    model: image-model', '',
  ].join('\n'))
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|CREDENTIAL/.test(key))),
    DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_BUNDLED_SKILL_DIR: join(home, 'bundled'),
    MOCK_API_KEY: 'dummy', TERM: 'xterm-256color', FAKE_TTY_IMAGE_PROTOCOL: protocol,
    FAKE_TTY_COLUMNS: '100', FAKE_TTY_GEOMETRY_LOG: log, FAKE_TTY_FRAME_SNAPSHOT: '1', FAKE_TTY_TRACE_OVERLAYS: '1' }
  delete env.DSH_PERMISSION_MODE; delete env.DSH_TOOLS_MODE
  const child = spawn(process.execPath, ['--import', join(repo, 'scripts/fake-tty-chrome-trace.mjs'), join(repo, 'scripts/fake-tty-entry.mjs'), '--profile', 'tui'],
    { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
  const closed = once(child, 'close')
  const frames = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const waitFor = async (predicate, stage) => {
    const until = Date.now() + 20_000
    while (!predicate(strip(out), frames())) {
      if (Date.now() > until || child.exitCode !== null || child.signalCode !== null) throw new Error(label + ': ' + stage
        + ' failed (exit=' + child.exitCode + ', signal=' + child.signalCode + ', stdout=' + out.length + ', stderr=' + err.length + ')')
      await new Promise(resolve => setTimeout(resolve, 40))
    }
  }
  const imageFrames = records => records.filter(frame => frame.lines.some(line => line.startsWith('› [Image #')))
  const thumbnail = line => protocol === 'kitty' ? line.includes('\x1b_G') : line.includes('\x1b]1337;File=')
  const hasThumbnail = frame => frame.rawLines.some(thumbnail)
  const paste = text => child.stdin.write('\x1b[200~' + text + '\x1b[201~')
  const openAttachmentMenu = async () => {
    const start = frames().length
    child.stdin.write('@')
    await waitFor((_text, records) => records.slice(start).some(frame =>
      frame.lines.some(line => line.startsWith('› @')) && frame.lines.some(line => line.includes('package.json'))), 'typed attachment marker menu')
  }
  const waitForViewer = async (start, number, total) => {
    await waitFor((_text, records) => records.slice(start).some(frame => frame.overlay
      && frame.lines.some(line => line.includes('Image · ' + number + '/' + total))
      && frame.lines.some(line => line.includes('image/png'))), 'image viewer ' + number + '/' + total)
    const frame = recordsWithViewer(number, total).at(-1)
    if (supportsThumbnails) {
      const line = frame.rawLines.find(thumbnail)
      assert.ok(line?.includes(png.toString('base64')), 'viewer preserves the full image protocol payload')
    }
    else assert.ok(!frame.rawLines.some(thumbnail), 'viewer keeps text fallback without an image protocol')
  }
  const recordsWithViewer = (number, total) => frames().filter(frame => frame.overlay
    && frame.lines.some(line => line.includes('Image · ' + number + '/' + total)))
  const thumbnailSetting = () => /^\s+showImageThumbnails:\s*(true|false)\s*$/mu.exec(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'))?.[1]
  const setThumbnails = async enabled => {
    const offset = frames().length
    child.stdin.write('/settings\r')
    await waitFor((_text, records) => records.slice(offset).some(frame => frame.overlay
      && frame.lines.some(line => line.includes('TUI settings'))), 'thumbnail settings page')
    let start = frames().length
    child.stdin.write('image thumbnails')
    await waitFor((_text, records) => records.slice(start).some(frame => frame.lines.some(line => line.includes('› Image thumbnails'))), 'find thumbnail setting')
    start = frames().length
    child.stdin.write('\r')
    await waitFor((_text, records) => records.slice(start).some(frame => frame.lines.some(line => line.includes('Use default'))), 'thumbnail setting choices')
    start = frames().length
    // The submenu preselects the current value: off -> on goes up, on -> off goes down.
    child.stdin.write(enabled ? '\x1b[A' : '\x1b[B')
    child.stdin.write('\r')
    await waitFor((_text, records) => records.slice(start).some(frame => frame.lines.some(line => line.includes('TUI settings · 1 pending change'))), 'stage thumbnail setting')
    start = frames().length
    child.stdin.write('\x15')
    child.stdin.write('save')
    await waitFor((_text, records) => records.slice(start).some(frame => frame.lines.some(line => line.includes('› Save and apply'))), 'find settings save action')
    start = frames().length
    child.stdin.write('\r')
    await waitFor((_text, records) => records.slice(start).some(frame => frame.lines.some(line => line.includes('Save TUI settings'))), 'confirm settings save')
    start = frames().length
    const saving = out.length
    child.stdin.write('\r')
    await waitFor((_text, records) => {
      const frame = records.at(-1)
      return strip(out.slice(saving)).includes('Saved TUI settings: showImageThumbnails (live).')
        && thumbnailSetting() === String(enabled) && records.length > start && frame !== undefined && !frame.overlay
        && frame.lines.some(line => line.startsWith('› [Image #1]')) && (enabled || !hasThumbnail(frame))
    }, 'thumbnail setting saved and applied live')
  }
  try {
    await waitFor(text => text.includes('enter send'), 'startup')
    await openAttachmentMenu()
    paste('"' + imagePath + '"')
    await waitFor((_text, records) => imageFrames(records).some(frame => frame.lines.some(line => line.includes('[Image #1]'))), 'first image chip')
    const imported = imageFrames(frames()).at(-1)
    assert.ok(imported.lines.some(line => line.trimEnd() === '› [Image #1]'), 'successful import consumes the typed marker')
    assert.ok(!imported.lines.some(line => line.includes('package.json')), 'successful import closes file completion')
    assert.ok(!hasThumbnail(imported), 'image thumbnails are disabled by default')
    assert.equal(thumbnailSetting(), undefined, 'the initial profile does not override the default')
    await setThumbnails(true)
    if (supportsThumbnails) {
      await waitFor((_text, records) => imageFrames(records).some(hasThumbnail), 'automatic thumbnail')
      const frame = imageFrames(frames()).find(hasThumbnail)
      const imageRow = frame.rawLines.findIndex(thumbnail)
      const inputRow = frame.lines.findLastIndex(line => line.startsWith('› [Image #'))
      assert.ok(imageRow < inputRow, 'thumbnail precedes the text input inside the composer')
      const line = frame.rawLines[imageRow]
      if (protocol === 'kitty') assert.match(line, /c=8,r=4(?:,|;)/)
      else assert.ok(line.includes('width=8;'), 'iTerm2 thumbnail is bounded to eight cells')
    }
    let offset = frames().length
    child.stdin.write('preview draft')
    child.stdin.write('\x1bi')
    await waitForViewer(offset, 1, 1)
    offset = frames().length
    child.stdin.write('\x1b')
    await waitFor((_text, records) => records.slice(offset).some(frame => !frame.overlay
      && frame.lines.some(line => line.startsWith('› [Image #1] preview draft'))), 'return to the unchanged draft')
    assert.equal(requests.length, 0, 'previewing never sends a model request')
    // Escape clears the text draft after the viewer has returned keyboard focus.
    child.stdin.write('\x1b')
    await waitFor((_text, records) => records.slice(offset).some(frame => !frame.overlay
      && frame.lines.some(line => line.trimEnd() === '› [Image #1]')), 'clear preview draft')
    await setThumbnails(false)
    assert.ok(!hasThumbnail(frames().at(-1)), 'disabling thumbnails removes the displayed picture')
    // The scripted settings path shares the same live-update bridge as the guided settings page.
    offset = frames().length
    child.stdin.write('/settings set native-tui {"showImageThumbnails":true}\r')
    await waitFor((_text, records) => thumbnailSetting() === 'true' && records.slice(offset).some(frame => !frame.overlay
      && frame.lines.some(line => line.startsWith('› [Image #1]')) && (!supportsThumbnails || hasThumbnail(frame))), 'scripted thumbnail enable applies live')
    offset = frames().length
    child.stdin.write('\x7f')
    await waitFor((_text, records) => records.slice(offset).some(frame => imageFrames([frame]).length === 0 && !frame.status.includes('1 attached')), 'backspace removal')
    assert.ok(!hasThumbnail(frames().at(-1)), 'removal clears the thumbnail')
    offset = frames().length
    paste('@"' + imagePath + '" @"' + imagePath + '"')
    await waitFor((_text, records) => imageFrames(records.slice(offset)).some(frame => frame.lines.some(line => line.includes('[Image #1] [Image #2]'))), 'two image chips')
    if (supportsThumbnails) await waitFor((_text, records) => records.slice(offset).some(frame => frame.rawLines.filter(thumbnail).length === 2), 'two thumbnails')
    offset = frames().length
    if (fullscreen) {
      const frame = frames().at(-1)
      const position = '15;' + String(frame.editorRow + 1)
      child.stdin.write('\x1b[<0;' + position + 'M\x1b[<0;' + position + 'm')
      await waitForViewer(offset, 2, 2)
      offset = frames().length
      child.stdin.write('\x1b[D')
      await waitForViewer(offset, 1, 2)
    } else {
      child.stdin.write('\x1bi')
      await waitForViewer(offset, 1, 2)
    }
    offset = frames().length
    child.stdin.write('\x1b[C')
    await waitForViewer(offset, 2, 2)
    offset = frames().length
    child.stdin.write('\r')
    await waitFor((_text, records) => records.slice(offset).some(frame => !frame.overlay
      && frame.lines.some(line => line.includes('[Image #1] [Image #2]'))), 'close viewer without sending images')
    assert.equal(requests.length, 0, 'Enter closes the viewer without submitting the composer')
    child.stdin.write('/attach clear\r')
    await waitFor(text => text.includes('Cleared 2 staged'), 'clear images')
    await openAttachmentMenu()
    // Enter follows the paste without waiting for attachment persistence.
    paste('"' + imagePath + '"')
    child.stdin.write('describe this image\r')
    await waitFor((_text, records) => records.some(frame => frame.status.includes('Ready') && frame.lines.some(line => line.includes('IMAGE INPUT RECEIVED'))), 'image answer')
    const hasHistoryImage = records => records.some(frame => imageFrames([frame]).length === 0 && frame.lines.some(line => line.includes('[Image #1]')))
    if (fullscreen) {
      for (let page = 0; page < 8 && !hasHistoryImage(frames()); page += 1) {
        const count = frames().length
        child.stdin.write('\x1b[5~')
        await waitFor((_text, records) => records.length > count, 'browse image history')
      }
    }
    const records = frames(), chips = imageFrames(records)
    assert.ok(chips.length > 0)
    assert.ok(chips.every(frame => !frame.lines.some(line => line.startsWith('› ') && line.includes('long-private-path-'))), 'pasted paths must stay out of rendered input')
    assert.ok(records.every(frame => !frame.overflow), 'all rendered rows fit')
    assert.ok(hasHistoryImage(records), 'user message retains its numbered image label')
    const input = requests.flatMap(body => body.input ?? [])
    assert.ok(input.filter(item => item.role === 'user').flatMap(item => item.content ?? [])
      .some(block => block.type === 'input_text' && block.text === 'describe this image'), 'the model receives the draft without a stray marker')
    const images = input.flatMap(item => item.content ?? []).filter(block => block.type === 'input_image')
    assert.equal(images.length, 1, 'removed and cleared attachments must not be sent')
    assert.ok(images[0].image_url.startsWith('data:image/png;base64,'))
    assert.deepEqual(Buffer.from(images[0].image_url.split(',')[1], 'base64'), png, 'request contains the original PNG')
    assert.ok(!JSON.stringify(input).includes(imagePath), 'model prompt does not contain the local path')
    assert.equal(imageFrames([records.at(-1)]).length, 0, 'accepted submission clears the composer chips')
    assert.ok(!hasThumbnail(records.at(-1)), 'accepted submission clears the thumbnail')
    if (!supportsThumbnails) assert.ok(!records.some(frame => frame.rawLines.some(line => line.includes('\x1b_G') || line.includes('\x1b]1337;File='))))
    if (fullscreen && protocol === 'iterm2') {
      const paints = [...out.matchAll(/\x1b\[\?2026h([\s\S]*?)\x1b\[\?2026l/gu)]
        .map(match => match[1]).filter(paint => paint.includes('\x1b]1337;File='))
      assert.ok(paints.length > 0, 'fullscreen iTerm2 actually writes image payloads to the terminal')
      for (const paint of paints) {
        const firstImage = paint.indexOf('\x1b]1337;File=')
        assert.ok(paint.lastIndexOf('\x1b[2K') < firstImage, 'all text clears precede image output')
        assert.match(paint, /\x1b7\x1b\[\d+;\d+H\x1b\]1337;File=/, 'images use final absolute coordinates')
        assert.ok(paint.endsWith('\x1b8'), 'image painting restores the editor cursor')
        assert.ok(!paint.includes('height=auto'), 'fullscreen image height stays within its reserved rows')
      }
    }
    child.stdin.write('\x04')
    const [code, signal] = await closed
    assert.equal(code, 0); assert.equal(signal, null)
    console.log(label, 'PASS', JSON.stringify({ chipFrames: chips.length, thumbnails: records.filter(hasThumbnail).length,
      thumbnailsDefaultOff: true, settingsToggledLive: true, viewer: true, gallery: true, mouse: fullscreen, draftRestored: true,
      imagesSent: images.length, originalBytes: true, consumedAtMarker: true, completionClosed: true, overflow: false }))
  } catch (error) {
    child.kill('SIGTERM'); await closed
    console.error(label, strip(out).slice(-5000), err.slice(-2500))
    throw error
  }
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  for (const protocol of protocols) {
    await run(false, protocol)
    await run(true, protocol)
  }
  console.log('RESULT PASS ' + String(protocols.length * 2) + ' configurations')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
