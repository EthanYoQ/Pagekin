export const documentStartKey = (platform = process.platform) => platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home'
export const documentEndKey = (platform = process.platform) => platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'
export const redoKey = (platform = process.platform) => platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y'
