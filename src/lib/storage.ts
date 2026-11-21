import type { GeminiModel, ManuscriptSection, StorySession, WritingStyle } from '../types.ts';
import { getActiveVersionIndex, getSectionVersions } from '../types.ts';

const SESSIONS_KEY = 'sarpay_studio_sessions_v1';
const ACTIVE_SESSION_KEY = 'sarpay_studio_active_session_v1';
const SIDEBAR_KEY = 'sarpay_studio_sidebar_open_v1';

export function createId(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeSection(section: ManuscriptSection): ManuscriptSection {
  const versions = getSectionVersions(section);
  const activeVersionIndex = getActiveVersionIndex({ ...section, versions });
  const active = versions[activeVersionIndex];
  return {
    ...section,
    content: active.text,
    style: active.style,
    refinedEnding: active.refinedEnding,
    model: active.model,
    versions,
    activeVersionIndex,
  };
}

export function createNewSession(
  defaultStyle: WritingStyle = 'literary',
  defaultModel: GeminiModel = 'gemini-2.5-flash',
  title = 'Untitled Story',
): StorySession {
  const now = new Date().toISOString();
  return {
    id: createId('story'),
    title,
    defaultStyle,
    defaultModel,
    sections: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function loadSessions(): StorySession[] {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (!raw) {
      const initial = createNewSession('literary', 'gemini-2.5-flash', 'Untitled Story');
      saveSessions([initial]);
      return [initial];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      const initial = createNewSession('literary', 'gemini-2.5-flash', 'Untitled Story');
      saveSessions([initial]);
      return [initial];
    }
    return (parsed as StorySession[]).map((session) => ({
      ...session,
      sections: Array.isArray(session.sections) ? session.sections.map(normalizeSection) : [],
    }));
  } catch {
    const initial = createNewSession('literary', 'gemini-2.5-flash', 'Untitled Story');
    return [initial];
  }
}

export function saveSessions(sessions: StorySession[]): void {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch (err) {
    console.warn('Failed to persist story sessions to localStorage:', err);
  }
}

export function loadActiveSessionId(fallbackId: string): string {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY) || fallbackId;
  } catch {
    return fallbackId;
  }
}

export function saveActiveSessionId(sessionId: string): void {
  try {
    localStorage.setItem(ACTIVE_SESSION_KEY, sessionId);
  } catch {
    // Ignore storage quota / privacy errors
  }
}

export function loadSidebarOpen(): boolean {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY);
    if (raw === null) return true;
    return raw === 'true';
  } catch {
    return true;
  }
}

export function saveSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, String(open));
  } catch {
    // Ignore storage errors
  }
}
