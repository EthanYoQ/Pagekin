export interface CharacterExtractionReadiness {
  projectKey: string
  dataProjectKey: string | null
  loadingProjectKey: string | null
  lastError: string | null
  characterCount: number
}

export function isCharacterExtractionReady(
  state: CharacterExtractionReadiness,
): boolean {
  return state.dataProjectKey === state.projectKey
    && state.loadingProjectKey === null
    && state.lastError === null
    && state.characterCount === 0
}
