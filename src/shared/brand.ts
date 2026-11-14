/** 产品显示名。只管界面上看到的名字；appId、数据目录、安装包文件名仍沿用旧名，换了会让老用户的数据与快捷方式对不上。 */
export const APP_BRAND = {
  zhName: '书童',
  enName: 'Pagekin',
  shortName: '书童',
  formerZhName: 'AI小说作家',
  formerEnName: 'AI Novel Writer',
  tagline: '本地优先的 AI 长篇小说创作 IDE',
  taglineEn: 'A local-first IDE for long-form fiction',
  assistantName: 'AI 写作助手',
} as const

/** 安装包的 appId（electron-builder.json5）。Windows 按它把系统通知归到安装时建的快捷方式名下。 */
export const APP_ID = 'com.ai-novel-writer.app'
