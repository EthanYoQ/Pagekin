function channels(color: string) {
  const values = color.match(/[\d.]+/g)!.map(Number)
  return color.startsWith('color(srgb') ? [...values.slice(0, 3).map((value) => value * 255), ...values.slice(3)] : values
}

export function luminance(color: string) {
  const [r, g, b] = channels(color).slice(0, 3).map((value) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(foreground: string, background: string) {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (high + 0.05) / (low + 0.05)
}

export function composite(over: string, under: string) {
  const [r, g, b, a = 1] = channels(over)
  const base = channels(under)
  return `rgb(${[r, g, b].map((value, i) => Math.round(value * a + base[i] * (1 - a))).join(', ')})`
}
