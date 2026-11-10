/** Emit the Host's stderr diagnostics only after the terminal is ready. */
process.once('message', message => {
  if (message !== 'native-tui-console-probe') return
  for (const owner of ['llm-deepseek-api-key', 'llm-deepseek-account']) {
    console.error('[' + owner + ']', 'model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)')
  }
  console.warn('[llm-deepseek-account] probe warning line')
  console.error('[llm-deepseek-account] probe error line')
  // One advisory per distinct catalogue failure: the Host repeats this line per
  // route and per retry, so the copy after another line must not repaint.
  const failure = '[llm-deepseek-account] model listing from https://api.deepseek.com/models failed'
    + ' (llmError: could not reach https://api.deepseek.com/models); keeping the previous catalog'
  console.warn(failure)
  console.warn('[llm-deepseek-account] probe warning line')
  console.warn(failure)
})
