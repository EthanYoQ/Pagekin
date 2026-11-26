import { useEffect, useRef } from 'react'
import { useCharacterStore } from '../../../stores/character-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { refreshStageWork } from '../use-stage-work'
import CharacterProfile from './CharacterProfile'
import CharacterRoster from './CharacterRoster'
import CharacterSuggestions from './CharacterSuggestions'

function useRefreshSpineOnRosterChange(): void {
  const revision = useCharacterStore(s => s.rosterRevision)
  const seen = useRef(revision)
  useEffect(() => {
    if (revision === null || revision === seen.current) return
    seen.current = revision
    void refreshStageWork(useLocaleStore.getState().text)
  }, [revision])
}

export default function StageCharacters({ projectKey }: { projectKey: string }) {
  const text = useLocaleStore(s => s.text)
  useRefreshSpineOnRosterChange()
  return (
    <div className="cast-page" role="region" aria-label={text('角色名单', 'Cast')}>
      <CharacterSuggestions />
      <div className="cast-body">
        <CharacterRoster projectKey={projectKey} />
        <CharacterProfile projectKey={projectKey} />
      </div>
    </div>
  )
}
