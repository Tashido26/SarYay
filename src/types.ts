export type WritingStyle = 'colloquial' | 'literary' | 'refined_flow';

export type VoiceEnding = 'colloquial' | 'literary';

export type GeminiModel = 'gemini-2.5-flash' | 'gemini-2.5-pro';

export type ProcessingMode = 'full_polish' | 'summarize_structure';

export interface AudioMeta {
  filename: string;
  mimeType: string;
  durationSec: number;
  sizeBytes: number;
}

export interface SectionVersion {
  id: string;
  text: string;
  style: WritingStyle;
  refinedEnding?: VoiceEnding;
  model: GeminiModel;
  mode?: ProcessingMode;
  timestamp: string;
}

export interface ManuscriptSection {
  id: string;
  ownerId?: string;
  storyId?: string;
  order?: number;
  content: string;
  style: WritingStyle;
  refinedEnding?: VoiceEnding;
  model: GeminiModel;
  mode?: ProcessingMode;
  audioUrl?: string;
  storagePath?: string;
  audioId?: string;
  audioMeta?: AudioMeta;
  versions?: SectionVersion[];
  activeVersionIndex?: number;
  createdAt: string;
  updatedAt: string;
}

export interface StorySession {
  id: string;
  ownerId?: string;
  title: string;
  defaultStyle: WritingStyle;
  defaultRefinedEnding?: VoiceEnding;
  defaultModel: GeminiModel;
  sectionCount?: number;
  sections: ManuscriptSection[];
  createdAt: string;
  updatedAt: string;
}

export interface StagedAudio {
  blob: Blob;
  url: string;
  filename: string;
  mimeType: string;
  durationSec: number;
  sizeBytes: number;
  source: 'recording' | 'upload';
}

export const STYLE_LABELS: Record<WritingStyle, string> = {
  colloquial: 'Colloquial Style',
  literary: 'Literary Style',
  refined_flow: 'Refined Flow & Tightened',
};

export const STYLE_SHORT_LABELS: Record<WritingStyle, string> = {
  colloquial: 'Colloquial',
  literary: 'Literary',
  refined_flow: 'Refined Flow',
};

export const STYLE_DESCRIPTIONS: Record<WritingStyle, string> = {
  colloquial: 'Natural spoken Burmese endings, smooth and readable for dialogue or essays',
  literary: 'Formal written Burmese prose crafted for novels, stories, and published articles',
  refined_flow:
    'Light-touch edit that trims looped thoughts and interrupted jumps while preserving your exact voice',
};

export const ENDING_LABELS: Record<VoiceEnding, string> = {
  colloquial: 'Colloquial Endings',
  literary: 'Literary Endings',
};

export const MODE_LABELS: Record<ProcessingMode, string> = {
  full_polish: 'Full Polish (Clean Text)',
  summarize_structure: 'Summarize & Structure',
};

export const MODE_DESCRIPTIONS: Record<ProcessingMode, string> = {
  full_polish: 'Complete transcription without summarizing — preserves 100% of ideas and details',
  summarize_structure:
    'Structured summary with clear sections and key takeaways for long lectures and talks',
};

export const MODEL_LABELS: Record<GeminiModel, string> = {
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
};

export const MODEL_SHORT_LABELS: Record<GeminiModel, string> = {
  'gemini-2.5-flash': 'Flash',
  'gemini-2.5-pro': 'Pro',
};

export function formatStyleWithEnding(
  style: WritingStyle,
  refinedEnding?: VoiceEnding,
): string {
  if (style === 'refined_flow') {
    const endingText = refinedEnding === 'literary' ? 'Literary' : 'Colloquial';
    return `${STYLE_LABELS.refined_flow} (${endingText})`;
  }
  return STYLE_LABELS[style];
}

export function formatCompactStyleLabel(
  style: WritingStyle,
  refinedEnding?: VoiceEnding,
): string {
  if (style === 'refined_flow') {
    const endingText = refinedEnding === 'literary' ? 'Literary' : 'Colloquial';
    return `Refined Flow · ${endingText}`;
  }
  return STYLE_SHORT_LABELS[style];
}

export function getSectionVersions(section: ManuscriptSection): SectionVersion[] {
  if (Array.isArray(section.versions) && section.versions.length > 0) {
    return section.versions;
  }
  return [
    {
      id: `${section.id}_v1`,
      text: section.content,
      style: section.style,
      refinedEnding: section.style === 'refined_flow' ? (section.refinedEnding ?? 'colloquial') : undefined,
      model: section.model,
      mode: section.mode,
      timestamp: section.updatedAt || section.createdAt,
    },
  ];
}

export function getActiveVersionIndex(section: ManuscriptSection): number {
  const versions = getSectionVersions(section);
  if (
    typeof section.activeVersionIndex === 'number' &&
    section.activeVersionIndex >= 0 &&
    section.activeVersionIndex < versions.length
  ) {
    return section.activeVersionIndex;
  }
  return versions.length - 1;
}

export function getActiveSectionVersion(section: ManuscriptSection): SectionVersion {
  const versions = getSectionVersions(section);
  return versions[getActiveVersionIndex(section)];
}
