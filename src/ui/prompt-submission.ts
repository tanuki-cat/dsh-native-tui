/** Commit staged input only after the native Host accepts its message. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { HostSession } from '../runtime/agent.js'
import type { PendingAttachment } from '../runtime/attachments.js'

/** Enqueue synchronously; failures leave every staged attachment available to retry. */
export function enqueuePrompt(
  agent: Pick<HostSession['agent'], 'status' | 'followup' | 'steer'>,
  text: string,
  pending: PendingAttachment[],
): boolean {
  const submitted = [...pending]
  const content: ContentBlock[] = []
  if (text.trim() !== '') content.push({ type: 'text', text })
  for (const item of submitted) content.push(item.block)
  if (content.length === 0) return false
  const message = createUserMessage({ content, source: { kind: 'user' } })
  if (agent.status === 'running') agent.steer(message)
  else agent.followup(message)
  for (const item of submitted) {
    const index = pending.indexOf(item)
    if (index !== -1) pending.splice(index, 1)
  }
  return true
}

/** Clear only the accepted draft, never a newer edit made during submission. */
export function submitDraft(
  draft: string,
  editor: { getText(): string; setText(text: string): void },
  send: () => boolean,
): boolean {
  // pi-tui clears its buffer before onSubmit; restore the submitted text until admission succeeds.
  if (editor.getText() === '') editor.setText(draft)
  if (!send()) return false
  if (editor.getText() === draft) editor.setText('')
  return true
}
