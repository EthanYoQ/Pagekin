export async function ignoreFailure(reason, run) {
  try {
    return await run()
  } catch (error) {
    console.warn(`[ignored] ${reason}`, error)
    return undefined
  }
}
