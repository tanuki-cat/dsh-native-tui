import { spawn } from 'node:child_process'
import { dirname } from 'node:path'

/** One platform command that opens or reveals a filesystem path. */
export interface SystemOpenCommand {
  readonly command: string
  readonly args: readonly string[]
}

/**
 * Resolve the platform command that opens a path or URL with its default
 * application.
 * @param platform - Node platform string.
 * @param path - absolute or cwd-resolved path, or an http(s) URL.
 * @returns command and arguments, or undefined on an unsupported platform.
 */
export function systemOpenCommand(platform: NodeJS.Platform, path: string): SystemOpenCommand | undefined {
  switch (platform) {
    case 'darwin': return { command: 'open', args: [path] }
    case 'win32': return { command: 'cmd', args: ['/c', 'start', '', path] }
    case 'linux': return { command: 'xdg-open', args: [path] }
    default: return undefined
  }
}

/**
 * Whether a string is an absolute http(s) URL this module may hand to the
 * platform opener. Anything else (a relative path, a file: or javascript:
 * URL) is refused rather than passed through.
 * @param value - candidate URL.
 * @returns true when the value parses as http or https.
 */
export function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  }
  catch {
    return false
  }
}

/**
 * Resolve the platform command that reveals a path in the file manager.
 * @param platform - Node platform string.
 * @param path - absolute or cwd-resolved path.
 * @returns command and arguments, or undefined on an unsupported platform.
 */
export function systemRevealCommand(platform: NodeJS.Platform, path: string): SystemOpenCommand | undefined {
  switch (platform) {
    case 'darwin': return { command: 'open', args: ['-R', path] }
    case 'win32': return { command: 'explorer', args: ['/select,' + path] }
    case 'linux': return { command: 'xdg-open', args: [dirname(path)] }
    default: return undefined
  }
}

function launch(command: SystemOpenCommand): boolean {
  try {
    const child = spawn(command.command, [...command.args], { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Open a path with the platform default application. */
export function openWithSystemApp(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const command = systemOpenCommand(platform, path)
  return command === undefined ? false : launch(command)
}

/**
 * Open a web page in the platform browser. Only absolute http(s) URLs are
 * accepted, so a value that came off the wire can never select a different
 * handler.
 * @param url - authorization or documentation URL.
 * @param platform - Node platform string.
 * @returns true when the launcher was started.
 */
export function openUrlInBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!isWebUrl(url)) return false
  const command = systemOpenCommand(platform, url)
  return command === undefined ? false : launch(command)
}

/** Reveal a path in the platform file manager. */
export function revealWithSystemApp(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const command = systemRevealCommand(platform, path)
  return command === undefined ? false : launch(command)
}
