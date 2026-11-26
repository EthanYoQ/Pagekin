import type { Decorator } from '@storybook/react'

export const paperInkFrame: Decorator = (Story, context) => {
  const theme = (context.globals as { theme?: string }).theme
  return (
    <div className="paper-ink" data-theme={theme === 'dark' ? 'dark' : 'light'} style={{ padding: 32, minHeight: 360 }}>
      <Story />
    </div>
  )
}
