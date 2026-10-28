/**
 * The local command surface: the `/help` text and the `/` menu rows.
 *
 * Both describe the same command set, so they sit together here rather than in
 * the application wiring file.
 *
 * @module dsh-native-tui/ui/commands/catalog
 */

import type { CommandSuggestion } from '../autocomplete.js'

/** `/help` rows, one line per command family. */
export const HELP_LINES: readonly string[] = [
  '/help · /new · /init · /sessions · /resume [id] · /status · /context · /clear',
  '/skill [<name>|list [page]|read <name>] · stage a skill call, review the catalog, or read one',
  '/skill:<name> [instructions] · invoke a skill, including names shared with commands',
  'Ctrl+N: new/blank session · Alt+S: switch session (keep draft and attachments)',
  'Shift+Tab: cycle reasoning efforts from the current model map (keeps draft)',
  'Ctrl+O: expand/collapse all tool cards (main-screen may redraw history and clear terminal scrollback)',
  'Fullscreen only: click the first line of a tool card to toggle it',
  '/exit · /quit (or bare exit/quit) · /reload',
  '/cancel · /model [provider/model] · /reasoning [effort|default|map] · /provider [add|list|edit|models|remove <route>]',
  '/mcp [add|list|remove <name>]',
  '/mode [manual|accept-edits|plan|auto|off] · /permissions [preset]',
  '/jobs [kill <id>] · /agents · /preset [id]',
  '/plugins [list|market [q]|inspect <spec>|install <spec>|remove <bundle>|enable <id>|disable <id>] · /exit',
  '/workspaces [new|use|pin|unpin|archive|unarchive] · /schedule [add|delete]',
  '/schedule [add <seconds> <title>|delete <id>] · /plugins · /exit',
  '/settings [tui|host|edit [ns]|items <ns> <field>|set <ns> <json>] · /export [path|zip|html] · /open <path> · /preview <image>',
  '/files [path] · /changes [diff <index>] · /deliverables [panel|open|reveal <index>]',
  '/tools · /tool <index> · /diff [index] · /exit',
  '/attach <path>|paste|preview <i>|list|clear · /attachments · /exit',
  '/login · 引导选择登录平台（CodeBuddy / Codex / DeepSeek 官方，DeepSeek 官方待实现）',
  '/codebuddy [status|login|logout|models [refresh]|quota|checkin|prompt [show|reset]|doctor]',
  '/codex [status|setup|login [browser|device]|logout|models]',
  '@@<query> references another session · /exit',
]

/** Local commands offered by the `/` menu, ahead of the host commands. */
export const LOCAL_COMMANDS: readonly CommandSuggestion[] = [
  { name: 'help', description: 'show local and host commands' },
  { name: 'new', description: 'open a matching blank session or create one' },
  { name: 'init', description: 'create a project-level AGENTS.md contributor guide' },
  { name: 'sessions', description: 'list persisted sessions' },
  { name: 'resume', description: 'resume a session', input: { hint: 'session-id' } },
  { name: 'status', description: 'show session, model, and preset' },
  { name: 'context', description: 'show context usage and its composition' },
  { name: 'skill', description: 'pick a skill to invoke, review the catalog, or read one', input: { hint: '[<name>|list [page]|read <name>]' }, keepExactSubmit: true, subcommands: [
    { name: 'list', description: 'page the skill table', hint: '[page]' },
    { name: 'read', description: 'read one skill body', hint: '<name>' },
  ] },
  { name: 'clear', description: 'clear the terminal view only' },
  { name: 'cancel', description: 'cancel the running turn' },
  { name: 'model', description: 'select a model', input: { hint: 'provider/model' } },
  { name: 'reasoning', description: 'select the reasoning effort or edit its mapping', input: { hint: '[effort|default|map]' }, keepExactSubmit: true, subcommands: [
    { name: 'map', description: 'guide an edit of the current model reasoning map' },
  ] },
  { name: 'mode', description: 'select manual, accept edits, plan, experimental Auto, or native permissions', keepExactSubmit: true, input: { hint: '[manual|accept-edits|plan|auto|off]' }, subcommands: [
    { name: 'manual', description: 'read-only files; changes require approval' },
    { name: 'accept-edits', description: 'allow workspace edits; ask for other actions' },
    { name: 'plan', description: 'explore read-only and submit a plan for review' },
    { name: 'auto', description: 'experimental model review with Full access; requires consent' },
    { name: 'off', description: 'use native DSH permissions without TUI mode policies' },
  ] },
  { name: 'permissions', description: 'select native DSH permissions (sandbox and approval)', keepExactSubmit: true, input: { hint: '[preset]' } },
  { name: 'preset', description: 'select the preset for the current or next session', input: { hint: 'id' } },
  { name: 'workspaces', description: 'list/create/use/pin/archive workspaces', subcommands: [
    { name: 'new', description: 'create a workspace session', hint: '<path>' },
    { name: 'use', description: 'switch to a workspace', hint: '<id|path>' },
    { name: 'pin', description: 'pin a workspace', hint: '<id>' },
    { name: 'unpin', description: 'unpin a workspace', hint: '<id>' },
    { name: 'archive', description: 'archive a workspace', hint: '<id>' },
    { name: 'unarchive', description: 'unarchive a workspace', hint: '<id>' },
  ] },
  { name: 'schedule', description: 'list/add/delete reminders', subcommands: [
    { name: 'add', description: 'add a one-shot reminder', hint: '<seconds> <title>' },
    { name: 'delete', description: 'delete a reminder', hint: '<id>' },
  ] },
  { name: 'jobs', description: 'list or kill background jobs' },
  { name: 'agents', description: 'list direct subagents' },
  { name: 'plugins', description: 'list, browse market, inspect/install/remove, or toggle plugin entries', input: { hint: '[list|market|inspect|install|remove|enable|disable]' }, subcommands: [
    { name: 'list', description: 'list installed plugin entries' },
    { name: 'market', description: 'browse the official market', hint: '[query]' },
    { name: 'inspect', description: 'inspect a bundle', hint: '<spec>' },
    { name: 'install', description: 'install a bundle', hint: '<spec>' },
    { name: 'remove', description: 'remove a bundle', hint: '<bundle>' },
    { name: 'enable', description: 'enable one entry', hint: '<entryId>' },
    { name: 'disable', description: 'disable one entry', hint: '<entryId>' },
  ] },
  { name: 'settings', description: 'guided terminal settings, inline Host editor, or scripted writes', input: { hint: '[tui|host|edit [ns]|items <ns> <field>|set <ns> <json>]' }, subcommands: [
    { name: 'tui', description: 'open the guided terminal settings page' },
    { name: 'host', description: 'open the inline Host namespace editor' },
    { name: 'edit', description: 'open the inline editor for one namespace', hint: '[ns]' },
    { name: 'items', description: 'open a namespace to manage array items', hint: '<ns> <field>' },
    { name: 'set', description: 'merge JSON into a namespace', hint: '<ns> <json>' },
  ] },
  { name: 'mcp', description: 'configure MCP servers', input: { hint: '[add|list|remove <name>]' }, subcommands: [
    { name: 'add', description: 'add a stdio or HTTP MCP server' },
    { name: 'list', description: 'list configured MCP servers' },
    { name: 'remove', description: 'remove an MCP server', hint: '<name>' },
  ] },
  { name: 'login', description: '引导选择登录平台（DeepSeek 官方待实现）' },
  { name: 'codebuddy', description: 'CodeBuddy / WorkBuddy sign-in, models and credits', input: { hint: '[status|login|logout|models [refresh]|quota|checkin|prompt [show|reset]|doctor]' }, subcommands: [
    { name: 'status', description: 'sign-in state, token rotation, catalogue' },
    { name: 'login', description: 'open the browser sign-in', hint: '[cn|en|all]' },
    { name: 'logout', description: 'remove the stored credential', hint: '[cn|en|all]' },
    { name: 'models', description: 'list models and the input modalities they declare', hint: '[refresh] [cn|en]' },
    { name: 'quota', description: 'remaining credits', hint: '[cn|en]' },
    { name: 'checkin', description: 'claim today credits', hint: '[cn|en]' },
    { name: 'prompt', description: 'guided system-prompt setup or show/reset', hint: '[show|reset]' },
    { name: 'doctor', description: 'endpoint and catalogue probe' },
  ] },
  { name: 'codex', description: 'ChatGPT Codex sign-in, route setup and models', input: { hint: '[status|setup|login [browser|device]|logout|models]' }, keepExactSubmit: true, subcommands: [
    { name: 'status', description: 'sign-in state, credential expiry, route and usage' },
    { name: 'setup', description: 'ensure the openai-codex route without signing in' },
    { name: 'login', description: 'sign in with ChatGPT', hint: '[browser|device]' },
    { name: 'logout', description: 'remove the shared credential after confirmation' },
    { name: 'models', description: 'list openai-codex models' },
  ] },
  { name: 'provider', description: 'guided third-party model provider setup', input: { hint: '[add|list|edit|models|input|remove <route>]' }, subcommands: [
    { name: 'add', description: 'guide a new provider route' },
    { name: 'list', description: 'list configured providers' },
    { name: 'edit', description: 'open a provider, fetch its models, or edit input types', hint: '[route]' },
    { name: 'models', description: 'refresh models for a provider route', hint: '<route>' },
    { name: 'input', description: 'edit the selected or named model input types', hint: '[provider/model]' },
    { name: 'remove', description: 'delete a provider route', hint: '<route>' },
  ] },
  { name: 'export', description: 'export JSONL, ZIP bundle, or static HTML', input: { hint: '[path|zip [path]|html [path]]' } },
  { name: 'open', description: 'preview text or Markdown; Markdown renders styled', input: { hint: '<path>' } },
  { name: 'preview', description: 'render a PNG/JPEG/GIF/WebP image', input: { hint: '<path>' } },
  { name: 'files', description: 'browse a directory and preview a file', input: { hint: '[path]' } },
  { name: 'changes', description: 'show the latest changed files or one file diff', input: { hint: '[diff <index>]' } },
  { name: 'deliverables', description: 'list, panel, open, or reveal files declared by the present tool', input: { hint: '[panel|open|reveal <index>]' } },
  { name: 'tools', description: 'list recent tool calls' },
  { name: 'tool', description: 'page one tool call and its result', input: { hint: 'index' } },
  { name: 'diff', description: 'page the latest or one indexed tool diff', input: { hint: '[index]' } },
  { name: 'attach', description: 'stage or preview a file, image, or clipboard image', input: { hint: '<path>|paste|preview <i>|list|clear' } },
  { name: 'attachments', description: 'open the staged attachment manager' },
  { name: 'reload', description: 'reload the TUI and plugins, resuming this session' },
  { name: 'exit', description: 'exit the terminal front door' },
  { name: 'quit', description: 'exit the terminal front door' },
]
