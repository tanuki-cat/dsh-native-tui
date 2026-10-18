/**
 * Approval-gate probe for the terminal approval end-to-end check.
 *
 * A policy plugin gates a tool by returning an 'ask' decision from the
 * tools/pre-execute waterfall; the tool runtime then routes that decision
 * through the real ctx.approval service and the composed approval/request
 * waterfall. This probe does exactly that for one tool, so the terminal's
 * approval overlay can be exercised against a real Host without a reviewer
 * model or real credentials.
 */
export const name = 'approval-gate-probe'
export const inject = ['tools']

export function apply(ctx) {
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name !== 'bash') return next()
    return { kind: 'ask', reason: 'Approval gate probe: approve this bash call?' }
  })
}
