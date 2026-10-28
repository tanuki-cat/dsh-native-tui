import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** Command-facing access to the owning Agent's durable selection. */
export interface ModelSelectionState {
  current: { provider: string; model: string; reasoningEffort?: string } | undefined
}

/** Bind commands to one Agent; reads never resolve adapter defaults. */
export function bindModelSelection(agent: Agent): ModelSelectionState {
  return {
    get current() { return agent.model.current() },
    set current(selection) {
      if (selection === undefined) throw new Error('A complete model selection is required.')
      agent.model.select({
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
      })
    },
  }
}

/** Agent reads are detached snapshots, so compare values rather than identity. */
export function sameModelSelection(left: ModelSelectionState['current'], right: ModelSelectionState['current']): boolean {
  return left?.provider === right?.provider && left?.model === right?.model && left?.reasoningEffort === right?.reasoningEffort
}
