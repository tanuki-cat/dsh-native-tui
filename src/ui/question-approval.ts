import type { TUI } from '@earendil-works/pi-tui'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { showChoice } from './dialogs.js'
import { showApprovalDetails } from './approval-details.js'
import { literalToolText } from './tool-output.js'
import type { Palette } from './theme.js'

type Frame = Parameters<typeof showApprovalDetails>[3]
type Intent = Extract<NonNullable<AskUserQuestionItem['intent']>, { kind: 'approval' }>
const localized = (value: { en: string } | undefined): string | undefined => value?.en

/** Fixed permission actions with a bounded summary and a complete read-only viewer. */
export async function showPermissionQuestion(
  tui: TUI, palette: Palette, question: AskUserQuestionItem & { intent: Intent },
  index: number, total: number, choose: typeof showChoice, frame: Frame, signal?: AbortSignal,
): Promise<string | undefined> {
  const intent = question.intent
  const actions = [
    { value: 'reject', answer: intent.reject },
    { value: 'approve', answer: intent.approve },
    ...(intent.always === undefined ? [] : [{ value: 'always', answer: intent.always }]),
  ]
  const items = actions.map(action => {
    const option = question.options?.find(candidate => candidate.label === action.answer)
    if (option === undefined) throw new Error('Approval question is missing a declared option.')
    return {
      value: action.value,
      label: literalToolText(action.value === 'approve' ? localized(intent.display?.approve) ?? action.answer : action.answer),
      description: option.description === undefined ? undefined : literalToolText(option.description),
    }
  })
  items.push({ value: 'details', label: 'View full request details', description: undefined })
  const title = [
    ...(intent.subject === undefined ? [] : [literalToolText(intent.subject.name)]),
    literalToolText(question.header ?? 'Question') + ' · ' + (index + 1) + '/' + total,
    literalToolText(localized(intent.display?.question) ?? question.question),
    ...(question.detail === undefined && intent.display?.detail === undefined ? []
      : [literalToolText(localized(intent.display?.detail) ?? question.detail ?? '')]),
  ].join(String.fromCharCode(10))
  while (!signal?.aborted) {
    const choice = await choose(tui, palette, title, items, 'Enter selects · Esc cancels', signal,
      () => Math.max(1, Math.min(10, Math.floor((tui.terminal?.rows ?? 30) * 0.8) - items.length - 5)))
    if (choice === 'details') {
      await showApprovalDetails(tui, palette, title, frame, signal)
      continue
    }
    return actions.find(action => action.value === choice)?.answer
  }
  return undefined
}
