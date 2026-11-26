import { APP_BRAND } from '../../../shared/brand'
import { useLocaleStore } from '../../../stores/locale-store'
import { UpdateSettings } from '../StageUpdate'

export default function AboutSection() {
  const text = useLocaleStore(s => s.text)
  return (
    <div className="stage-set-rows">
      <div className="stage-set-about">
        <span className="stage-set-about-mark" aria-hidden="true" />
        <div>
          <p className="stage-set-about-name">{text(`${APP_BRAND.zhName} ${APP_BRAND.enName}`, APP_BRAND.enName)}</p>
          <p className="stage-set-about-former">{text(`原名「${APP_BRAND.formerZhName}」`, `Formerly “${APP_BRAND.formerEnName}”`)}</p>
          <p className="stage-set-about-version">{text('版本', 'Version')} <span className="pi-num">{__APP_VERSION__}</span></p>
        </div>
      </div>
      <p className="stage-set-about-text">{text(
        '面向长篇小说的本地写作工具。作品都存在你的电脑上，每一步都可以交给你选的模型协助。',
        'A local writing tool for long-form fiction. Your books stay on your computer, and every step can be assisted by the models you choose.',
      )}</p>
      <UpdateSettings />
    </div>
  )
}
