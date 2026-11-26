import type { PromptTemplate } from '../prompt-templates'
import {
  appendRequiredPromptContext,
  composePromptSystemRole,
  getBuiltinPromptTemplate,
  pruneEmptyOptionalPromptSections,
} from '../prompt-templates'
import type { WritingLanguage } from '../../shared/writing-language'

export class BasePromptBuilder {
  protected template: PromptTemplate;
  protected variables: Record<string, string> = {};

  constructor(template: PromptTemplate, private readonly writingLanguage: WritingLanguage) {
    this.template = template;
  }

  public getSystemRole(): string {
    return composePromptSystemRole(this.template, this.writingLanguage)
  }

  public build(): string {
    let result = this.template.content
    for (const [key, value] of Object.entries(this.variables)) {
      const safeValue = value || ''
      result = result.replaceAll(`{{${key}}}`, safeValue)
    }

    if (this.template.taskGuidance?.trim()) {
      let taskGuidance = this.template.taskGuidance
      for (const [key, value] of Object.entries(this.variables)) {
        taskGuidance = taskGuidance.replaceAll(`{{${key}}}`, value || '')
      }
      const heading = this.writingLanguage === 'en-US'
        ? '[User-defined creative guidance]'
        : '【用户自定义创作指导】'
      result += `\n\n${heading}\n${taskGuidance.trim()}`
    }

    const builtinTemplate = getBuiltinPromptTemplate(this.template.key, this.writingLanguage)
    const suffix = builtinTemplate?.systemSuffix
    if (suffix) {
      let renderedSuffix = suffix
      for (const [key, value] of Object.entries(this.variables)) {
        renderedSuffix = renderedSuffix.replaceAll(`{{${key}}}`, value)
      }
      result = result + '\n\n' + renderedSuffix
    }

    result = appendRequiredPromptContext(result, this.template, this.variables, this.writingLanguage)

    result = pruneEmptyOptionalPromptSections(result)

    const missing = result.match(/\{\{.*?\}\}/g)
    if (missing) {
      console.warn(`[PromptBuilder] 警告：模板 "${this.template.name}" 中有未赋值的变量残留:`, missing)
    }
    return result
  }
}

export class ChapterPromptBuilder extends BasePromptBuilder {
  
  withArchitecture(architecture: string) {
    this.variables.architecture = architecture;
    return this;
  }

  withGlobalSummary(globalSummary: string) {
    this.variables.global_summary = globalSummary;
    return this;
  }

  withCharacterStates(characterStates: string) {
    this.variables.character_states = characterStates;
    return this;
  }

  withShortSummary(shortSummary: string) {
    this.variables.short_summary = shortSummary;
    return this;
  }

  withPreviousEnding(previousEnding: string) {
    this.variables.previous_ending = previousEnding;
    return this;
  }

  withChapterInfo(chapterInfo: string | object) {
    this.variables.chapter_info = typeof chapterInfo === 'string' 
      ? chapterInfo 
      : JSON.stringify(chapterInfo, null, 2);
    return this;
  }

  withFutureBlueprints(futureBlueprints: string) {
    this.variables.future_blueprints = futureBlueprints;
    return this;
  }

  withUserGuidance(userGuidance: string) {
    this.variables.user_guidance = userGuidance;
    return this;
  }

  withFilteredContext(filteredContext: string) {
    this.variables.filtered_context = filteredContext;
    return this;
  }

  withGlobalGuidance(globalGuidance: string) {
    this.variables.global_guidance = globalGuidance;
    return this;
  }

  withNovelConfig(novelConfig: string | object) {
    this.variables.novel_config = typeof novelConfig === 'string' 
      ? novelConfig 
      : JSON.stringify(novelConfig, null, 2);
    return this;
  }

  withWordNumber(wordNumber: number | string) {
    this.variables.word_number = String(wordNumber);
    return this;
  }

  withDraftContent(draftContent: string) {
    this.variables.draft_content = draftContent;
    return this;
  }

  withUserRefinePrompt(userRefinePrompt: string) {
    this.variables.user_refine_prompt = userRefinePrompt;
    return this;
  }

  withReviewReport(reviewReport: string) {
    this.variables.review_report = reviewReport;
    return this;
  }

  withWritingStyle(style: string) {
    this.variables.writing_style = style;
    return this;
  }

  withKnowledgeQueryHint(hint: string) {
    this.variables.knowledge_query_hint = hint;
    return this;
  }
}

export class ReviewPromptBuilder extends BasePromptBuilder {
  withChapterContent(content: string) {
    this.variables.chapter_content = content;
    return this;
  }

  withCharacterStates(states: string) {
    this.variables.character_states = states;
    return this;
  }

  withGlobalSummary(summary: string) {
    this.variables.global_summary = summary;
    return this;
  }

  withWorldBuilding(world: string) {
    this.variables.world_building = world;
    return this;
  }

  withReviewFocus(focus: string) {
    this.variables.review_focus = focus;
    return this;
  }
}

export class PostProcessPromptBuilder extends BasePromptBuilder {
  withChapterContent(content: string) {
    this.variables.chapter_content = content;
    return this;
  }

  withChapterNumber(num: string | number) {
    this.variables.chapter_number = String(num);
    return this;
  }

  withChapterTitle(title: string) {
    this.variables.chapter_title = title;
    return this;
  }

  withExistingCardsJson(json: string | object) {
    this.variables.existing_cards_json = typeof json === 'string'
      ? json
      : JSON.stringify(json, null, 2);
    return this;
  }
}

export class ArchitecturePromptBuilder extends BasePromptBuilder {
  withGenre(genre: string) {
    this.variables.genre = genre;
    return this;
  }
  
  withSubGenre(subGenre: string) {
    this.variables.sub_genre = subGenre;
    return this;
  }

  withTopic(topic: string) {
    this.variables.topic = topic;
    return this;
  }

  withTargetAudience(audience: string) {
    this.variables.target_audience = audience;
    return this;
  }

  withNumberOfChapters(num: string | number) {
    this.variables.number_of_chapters = String(num);
    return this;
  }

  withWordNumber(num: string | number) {
    this.variables.word_number = String(num);
    return this;
  }

  withCoreSetting(setting: string) {
    this.variables.core_setting = setting;
    return this;
  }

  withGoldenFinger(finger: string) {
    this.variables.golden_finger = finger;
    return this;
  }

  withProtagonistProfile(profile: string) {
    this.variables.protagonist_profile = profile;
    return this;
  }

  withGlobalGuidance(guidance: string) {
    this.variables.global_guidance = guidance;
    return this;
  }

  withCoreSeed(seed: string) {
    this.variables.premise = seed;
    return this;
  }

  withCharacterDynamics(dynamics: string) {
    this.variables.character_dynamics = dynamics;
    return this;
  }

  withWorldBuilding(world: string) {
    this.variables.world_building = world;
    return this;
  }

  withPlotStructureGuide(guide: string) {
    this.variables.plot_structure_guide = guide;
    return this;
  }

  withNarrativePov(pov: string) {
    this.variables.narrative_pov = pov;
    return this;
  }
  
  withUserIdea(idea: string) {
    this.variables.user_idea = idea;
    return this;
  }

  withStepGuidance(guidance: string) {
    this.variables.step_guidance = guidance;
    return this;
  }

  withReferenceWorks(works: string) {
    this.variables.reference_works = works;
    return this;
  }
}

export class DirectoryPromptBuilder extends BasePromptBuilder {
  withNovelArchitecture(arch: string) {
    this.variables.novel_architecture = arch;
    return this;
  }

  withNumberOfChapters(num: string | number) {
    this.variables.number_of_chapters = String(num);
    return this;
  }

  withGlobalGuidance(guidance: string) {
    this.variables.global_guidance = guidance;
    return this;
  }

  withGenre(genre: string) {
    this.variables.genre = genre;
    return this;
  }

  withChapterList(list: string) {
    this.variables.chapter_list = list;
    return this;
  }

  withN(n: string | number) {
    this.variables.n = String(n);
    return this;
  }

  withM(m: string | number) {
    this.variables.m = String(m);
    return this;
  }

  withPacingGuidance(guidance: string) {
    this.variables.pacing_guidance = guidance;
    return this;
  }
}

export class ImportPromptBuilder extends BasePromptBuilder {
  withSampledWorldview(content: string) {
    this.variables.sampled_worldview = content;
    return this;
  }

  withSampledProtagonist(content: string) {
    this.variables.sampled_protagonist = content;
    return this;
  }

  withSampledConflict(content: string) {
    this.variables.sampled_conflict = content;
    return this;
  }

  withSampledStyle(content: string) {
    this.variables.sampled_style = content;
    return this;
  }

  withFirstChapter(content: string) {
    this.variables.first_chapter = content;
    return this;
  }

  withLatestChapter(content: string) {
    this.variables.latest_chapter = content;
    return this;
  }

  withTotalChapters(num: number | string) {
    this.variables.total_chapters = String(num);
    return this;
  }

  withChapterContent(content: string) {
    this.variables.chapter_content = content;
    return this;
  }

  withChapterNumber(num: number | string) {
    this.variables.chapter_number = String(num);
    return this;
  }

  withChapterTitle(title: string) {
    this.variables.chapter_title = title;
    return this;
  }

  withNovelConfigSummary(summary: string) {
    this.variables.novel_config_summary = summary;
    return this;
  }

  withSampleContent(content: string) {
    this.variables.sample_content = content;
    return this;
  }
}
