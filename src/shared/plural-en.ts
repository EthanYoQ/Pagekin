export const pluralEn = (count: number, noun: string, plural = `${noun}s`) => (count === 1 ? noun : plural)
