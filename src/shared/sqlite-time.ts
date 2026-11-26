export const SQLITE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/u

export function sqliteTime(value: string): Date {
  const match = SQLITE_TIMESTAMP.exec(value)
  return new Date(match ? `${match[1]}T${match[2]}Z` : value)
}
