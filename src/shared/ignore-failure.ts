export async function ignoreFailure<T>(reason: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    console.warn(`[ignored] ${reason}`, error)
    return undefined
  }
}

export function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
