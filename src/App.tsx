import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertCircle,
  BookOpen,
  Check,
  ChevronDown,
  Cloud,
  Copy,
  FileDown,
  FileText,
  Loader2,
  PanelLeft,
  RefreshCw,
  X,
} from 'lucide-react';
import type {
  GeminiModel,
  ManuscriptSection,
  ProcessingMode,
  ReprocessSource,
  SectionSaveStatus,
  SectionVersion,
  StagedAudio,
  StorySession,
  TrashedSection,
  VoiceEnding,
  WritingStyle,
} from './types.ts';
import {
  formatCompactStyleLabel,
  getActiveSectionVersion,
  getActiveVersionIndex,
  getSectionVersions,
} from './types.ts';
import { deleteAudioClip, getAudioClip, saveAudioClip } from './lib/audioDb.ts';
import { restyleTextApi, transcribeAudioApi } from './lib/api.ts';
import {
  STORIES_PAGE_SIZE,
  appendSectionVersionInCloud,
  createSectionInCloud,
  createStoryInCloud,
  downloadSectionAudioBlob,
  fetchOlderStoriesPage,
  formatCloudErrorMessage,
  moveSectionToTrashInCloud,
  moveStoryToTrashInCloud,
  permanentlyDeleteSectionFromTrashInCloud,
  permanentlyDeleteStoryInCloud,
  purgeExpiredTrashInCloud,
  renameStoryInCloud,
  restoreSectionFromTrashInCloud,
  restoreStoryFromTrashInCloud,
  selectSectionVersionInCloud,
  subscribeToRecentStories,
  subscribeToSections,
  subscribeToTrashedSections,
  subscribeToTrashedStories,
  syncFirestoreConnection,
  updateSectionContentInCloud,
  updateStoryGlossaryInCloud,
  updateStoryModelInCloud,
  updateStoryRefinedEndingInCloud,
  updateStoryStyleInCloud,
  type StoryCursor,
} from './lib/cloudStore.ts';
import {
  compileFullStoryMarkdown,
  compileFullStoryPlainText,
  countCharacters,
  formatSessionTokenSummary,
  safeExportFilename,
  sortSectionsChronologically,
  triggerBlobDownload,
} from './lib/format.ts';
import {
  createId,
  loadActiveSessionId,
  loadSidebarOpen,
  saveActiveSessionId,
  saveSidebarOpen,
} from './lib/storage.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { DictationDock } from './components/DictationDock.tsx';
import { SectionBlock } from './components/SectionBlock.tsx';
import { AuthGate } from './components/AuthGate.tsx';
import { ConfirmDialog } from './components/ConfirmDialog.tsx';
import { TrashBinView } from './components/TrashBinView.tsx';
import { BRAND_LOGO_URL } from './lib/brand.ts';

const LEGACY_SESSIONS_KEY = 'sarpay_studio_sessions_v1';
const MIGRATED_FLAG_KEY = 'sarpay_studio_cloud_migrated_v1';

type PendingConfirmAction =
  | { kind: 'trash_story'; story: StorySession }
  | { kind: 'trash_section'; section: ManuscriptSection }
  | { kind: 'delete_story_forever'; story: StorySession }
  | { kind: 'delete_section_forever'; section: TrashedSection };

function getNextUntitledStoryTitle(stories: StorySession[]): string {
  let maxNumber = 0;
  for (const story of stories) {
    const trimmed = (story.title || '').trim();
    const match = /^Untitled Story\s+(\d+)$/i.exec(trimmed);
    if (match) {
      const parsed = Number.parseInt(match[1], 10);
      if (Number.isFinite(parsed) && parsed > maxNumber) {
        maxNumber = parsed;
      }
    }
  }
  return `Untitled Story ${maxNumber + 1}`;
}

const MAX_CONTINUITY_WORDS = 150;
const MAX_CONTINUITY_CHARS = 1400;

function extractPreviousParagraphContext(ordered: ManuscriptSection[]): string | undefined {
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const raw = getActiveSectionVersion(ordered[i]).text.trim();
    if (!raw) continue;

    // Take trailing ~150 whitespace-separated tokens, then clamp cleanly for dense Burmese prose
    const tokens = raw.split(/\s+/).filter(Boolean);
    let tail =
      tokens.length > MAX_CONTINUITY_WORDS
        ? tokens.slice(-MAX_CONTINUITY_WORDS).join(' ')
        : raw;

    if (tail.length > MAX_CONTINUITY_CHARS) {
      tail = tail.slice(-MAX_CONTINUITY_CHARS);
      const breakIdx = Math.max(tail.indexOf('။'), tail.indexOf('\n'), tail.indexOf(' '));
      if (breakIdx > 0 && breakIdx < 240) {
        tail = tail.slice(breakIdx + 1);
      }
    }

    const cleaned = tail.trim();
    if (cleaned) return cleaned;
  }
  return undefined;
}

function getSectionOutlinePreview(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (!singleLine) return 'Empty section';
  return singleLine.length > 72 ? `${singleLine.slice(0, 72)}…` : singleLine;
}

export default function App() {
  return (
    <AuthGate>
      {({ user, onSignOut }) => <StudioWorkspace user={user} onSignOut={onSignOut} />}
    </AuthGate>
  );
}

interface StudioWorkspaceProps {
  user: User;
  onSignOut: () => Promise<void>;
}

function StudioWorkspace({ user, onSignOut }: StudioWorkspaceProps) {
  const uid = user.uid;

  const [recentStories, setRecentStories] = useState<StorySession[]>([]);
  const [recentHasMore, setRecentHasMore] = useState(false);
  const [olderStories, setOlderStories] = useState<StorySession[]>([]);
  const [optimisticStories, setOptimisticStories] = useState<StorySession[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [isLoadingMoreStories, setIsLoadingMoreStories] = useState(false);
  const [isCreatingStory, setIsCreatingStory] = useState(false);
  const creatingStoryRef = useRef(false);
  const recentLastDocRef = useRef<StoryCursor | null>(null);
  const olderLastDocRef = useRef<StoryCursor | null>(null);

  const [storiesLoaded, setStoriesLoaded] = useState(false);
  const [trashedStories, setTrashedStories] = useState<StorySession[]>([]);
  const [trashedStoriesLoaded, setTrashedStoriesLoaded] = useState(false);
  const [trashedSections, setTrashedSections] = useState<TrashedSection[]>([]);
  const [trashedSectionsLoaded, setTrashedSectionsLoaded] = useState(false);

  const [activeView, setActiveView] = useState<'story' | 'trash'>('story');
  // Start with no story opened so zero section listeners attach on initial page load
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [lastOpenedStoryId, setLastOpenedStoryId] = useState<string>(() => loadActiveSessionId(''));
  const [sections, setSections] = useState<ManuscriptSection[]>([]);
  const [sectionsLoaded, setSectionsLoaded] = useState(true);

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      return false;
    }
    return loadSidebarOpen();
  });

  // Instant local editing buffers (debounced to Firestore & flushed on switch)
  const [titleDraft, setTitleDraft] = useState<string>('');
  const titleDraftRef = useRef<string>('');
  const titleDirtyRef = useRef<boolean>(false);
  const titleDebounceRef = useRef<number | null>(null);

  const [glossaryOpen, setGlossaryOpen] = useState<boolean>(false);
  const [outlineOpen, setOutlineOpen] = useState<boolean>(false);
  const [glossaryDraft, setGlossaryDraft] = useState<string>('');
  const [glossarySaveStatus, setGlossarySaveStatus] = useState<SectionSaveStatus>('saved');
  const glossaryDraftRef = useRef<string>('');
  const glossaryDirtyRef = useRef<boolean>(false);
  const glossaryDebounceRef = useRef<number | null>(null);

  const [sectionDrafts, setSectionDrafts] = useState<Record<string, string>>({});
  const [sectionSaveStatus, setSectionSaveStatus] = useState<Record<string, SectionSaveStatus>>({});
  const sectionDraftsRef = useRef<Record<string, string>>({});
  const sectionDebounceRefs = useRef<Record<string, number>>({});
  const sectionsRef = useRef<ManuscriptSection[]>([]);

  const [pendingSyncOps, setPendingSyncOps] = useState(0);
  const [isManualSyncing, setIsManualSyncing] = useState(false);
  const [syncPulseState, setSyncPulseState] = useState<'idle' | 'synced' | 'offline'>('idle');
  const [reprocessingSectionId, setReprocessingSectionId] = useState<string | null>(null);
  const reprocessingSectionIdRef = useRef<string | null>(null);
  const [trashBusyItemId, setTrashBusyItemId] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmAction | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [copiedFull, setCopiedFull] = useState(false);

  const toastTimeoutRef = useRef<number | null>(null);
  const syncPulseTimeoutRef = useRef<number | null>(null);
  const lastHiddenAtRef = useRef<number>(0);
  const lastResumeSyncAtRef = useRef<number>(0);
  const resumeSyncInFlightRef = useRef<boolean>(false);
  const activeSessionIdRef = useRef<string>('');
  const flushAllPendingEditsRef = useRef<(explicitStoryId?: string) => Promise<void>>(async () => {});
  const mainScrollRef = useRef<HTMLElement | null>(null);
  const outlinePopoverRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollSectionIdRef = useRef<string | null>(null);
  const bootstrappedRef = useRef<boolean>(false);
  const initialPurgeRanRef = useRef<boolean>(false);

  // Merge live top-30 stories with paginated older stories and newly created optimistic stories
  const loadedStories = useMemo(() => {
    const byId = new Map<string, StorySession>();
    for (const story of recentStories) {
      byId.set(story.id, story);
    }
    for (const story of olderStories) {
      if (!byId.has(story.id)) {
        byId.set(story.id, story);
      }
    }
    for (const story of optimisticStories) {
      if (!byId.has(story.id)) {
        byId.set(story.id, story);
      }
    }
    return Array.from(byId.values()).sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
  }, [recentStories, olderStories, optimisticStories]);

  const activeStories = useMemo(
    () => loadedStories.filter((s) => !s.isDeleted),
    [loadedStories],
  );

  const allKnownStories = useMemo(() => {
    const byId = new Map<string, StorySession>();
    for (const s of loadedStories) byId.set(s.id, s);
    for (const s of trashedStories) byId.set(s.id, s);
    return Array.from(byId.values());
  }, [loadedStories, trashedStories]);

  const hasMoreStories = olderHasMore !== null ? olderHasMore : recentHasMore;
  const trashCount = trashedStories.length + trashedSections.length;

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimeoutRef.current !== null) {
      window.clearTimeout(toastTimeoutRef.current);
    }
    toastTimeoutRef.current = window.setTimeout(() => {
      setToastMessage(null);
    }, 2800);
  }, []);

  const trackSync = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    setPendingSyncOps((c) => c + 1);
    try {
      return await task();
    } finally {
      setPendingSyncOps((c) => Math.max(0, c - 1));
    }
  }, []);

  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);

  useEffect(() => {
    sectionDraftsRef.current = sectionDrafts;
  }, [sectionDrafts]);

  useEffect(() => {
    reprocessingSectionIdRef.current = reprocessingSectionId;
  }, [reprocessingSectionId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    if (activeSessionId) {
      saveActiveSessionId(activeSessionId);
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth >= 1024) {
      saveSidebarOpen(sidebarOpen);
    }
  }, [sidebarOpen]);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current !== null) {
        window.clearTimeout(toastTimeoutRef.current);
      }
      if (syncPulseTimeoutRef.current !== null) {
        window.clearTimeout(syncPulseTimeoutRef.current);
      }
      if (titleDebounceRef.current !== null) {
        window.clearTimeout(titleDebounceRef.current);
      }
      if (glossaryDebounceRef.current !== null) {
        window.clearTimeout(glossaryDebounceRef.current);
      }
      for (const timerId of Object.values(sectionDebounceRefs.current)) {
        window.clearTimeout(timerId);
      }
    };
  }, []);

  const triggerSyncPulse = useCallback((state: 'synced' | 'offline') => {
    setSyncPulseState(state);
    if (syncPulseTimeoutRef.current !== null) {
      window.clearTimeout(syncPulseTimeoutRef.current);
    }
    syncPulseTimeoutRef.current = window.setTimeout(() => {
      setSyncPulseState('idle');
    }, 2600);
  }, []);

  // Automatic lightweight background sync when returning to the iOS PWA or refocusing the tab
  useEffect(() => {
    const runResumeSync = (forceReconnect: boolean) => {
      if (resumeSyncInFlightRef.current) return;
      const now = Date.now();
      if (now - lastResumeSyncAtRef.current < 5000) return;

      lastResumeSyncAtRef.current = now;
      resumeSyncInFlightRef.current = true;

      void syncFirestoreConnection({
        uid,
        activeStoryId: activeSessionIdRef.current || undefined,
        forceReconnect,
        verifyServer: false,
      })
        .then(({ online }) => {
          triggerSyncPulse(online ? 'synced' : 'offline');
        })
        .catch(() => {
          // Non-fatal; active onSnapshot listeners keep retrying automatically
        })
        .finally(() => {
          resumeSyncInFlightRef.current = false;
        });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        lastHiddenAtRef.current = Date.now();
        // Flush any debounced title, glossary, or section keystrokes before iOS PWA suspends
        void flushAllPendingEditsRef.current(activeSessionIdRef.current);
      } else if (document.visibilityState === 'visible') {
        const hiddenDuration =
          lastHiddenAtRef.current > 0 ? Date.now() - lastHiddenAtRef.current : 0;
        lastHiddenAtRef.current = 0;
        runResumeSync(hiddenDuration >= 2500);
      }
    };

    const handlePageHide = () => {
      void flushAllPendingEditsRef.current(activeSessionIdRef.current);
    };

    const handleWindowFocus = () => {
      if (document.visibilityState === 'visible') {
        runResumeSync(false);
      }
    };

    const handleOnline = () => {
      lastResumeSyncAtRef.current = 0;
      runResumeSync(true);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('online', handleOnline);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('online', handleOnline);
    };
  }, [uid, triggerSyncPulse]);

  // Real-time Firestore listener for only the 30 most recent lightweight story metadata docs
  useEffect(() => {
    bootstrappedRef.current = false;
    initialPurgeRanRef.current = false;
    recentLastDocRef.current = null;
    olderLastDocRef.current = null;
    setRecentStories([]);
    setRecentHasMore(false);
    setOlderStories([]);
    setOptimisticStories([]);
    setOlderHasMore(null);
    setStoriesLoaded(false);

    const unsubscribe = subscribeToRecentStories(
      uid,
      STORIES_PAGE_SIZE,
      ({ stories, hasMore, lastDoc }) => {
        setRecentStories(stories);
        setOptimisticStories((prev) =>
          prev.length === 0 ? prev : prev.filter((opt) => !stories.some((s) => s.id === opt.id)),
        );
        setRecentHasMore(hasMore);
        recentLastDocRef.current = lastDoc;
        setStoriesLoaded(true);

        // If the currently open story was soft-deleted, clear selection
        setActiveSessionId((prevId) => {
          if (!prevId) return '';
          const match = stories.find((s) => s.id === prevId);
          if (match && match.isDeleted) return '';
          return prevId;
        });
      },
      (err) => {
        setStoriesLoaded(true);
        setGlobalError(formatCloudErrorMessage(err));
      },
    );

    return () => unsubscribe();
  }, [uid]);

  // Lightweight single-field listener for soft-deleted stories (keeps Trash count & cleanup accurate at 1,000+ stories)
  useEffect(() => {
    setTrashedStoriesLoaded(false);
    const unsubscribe = subscribeToTrashedStories(
      uid,
      (items) => {
        setTrashedStories(items);
        setTrashedStoriesLoaded(true);
      },
      (err) => {
        setTrashedStoriesLoaded(true);
        setGlobalError(formatCloudErrorMessage(err));
      },
    );
    return () => unsubscribe();
  }, [uid]);

  // First-time bootstrap only when the account genuinely has zero active and zero trashed stories
  useEffect(() => {
    if (!storiesLoaded || !trashedStoriesLoaded) return;
    if (bootstrappedRef.current) return;
    if (recentStories.length > 0 || trashedStories.length > 0) {
      bootstrappedRef.current = true;
      return;
    }

    bootstrappedRef.current = true;
    void (async () => {
      try {
        await trackSync(async () => {
          let imported = false;
          try {
            const alreadyMigrated = localStorage.getItem(MIGRATED_FLAG_KEY) === 'true';
            const legacyRaw = localStorage.getItem(LEGACY_SESSIONS_KEY);
            if (!alreadyMigrated && legacyRaw) {
              const legacyParsed = JSON.parse(legacyRaw) as StorySession[];
              const meaningful = Array.isArray(legacyParsed)
                ? legacyParsed.filter(
                    (s) =>
                      (Array.isArray(s.sections) && s.sections.length > 0) ||
                      (s.title && s.title.trim() && s.title.trim() !== 'Untitled Story'),
                  )
                : [];

              if (meaningful.length > 0) {
                for (const legacyStory of meaningful) {
                  const newStoryId = createId('story');
                  await createStoryInCloud(uid, {
                    storyId: newStoryId,
                    title: legacyStory.title || 'Untitled Story',
                    defaultStyle: legacyStory.defaultStyle || 'colloquial',
                    defaultRefinedEnding: legacyStory.defaultRefinedEnding || 'colloquial',
                    defaultModel: legacyStory.defaultModel || 'gemini-2.5-flash',
                  });

                  const legacySections = sortSectionsChronologically(legacyStory.sections || []);
                  let secCount = 0;
                  for (let i = 0; i < legacySections.length; i++) {
                    const sec = legacySections[i];
                    const secId = createId('sec');
                    const versions = getSectionVersions(sec);
                    const initialVersion = versions[0];
                    secCount += 1;
                    await createSectionInCloud(uid, newStoryId, {
                      sectionId: secId,
                      order: Date.parse(sec.createdAt) || Date.now() + i,
                      initialVersion,
                      audioId: sec.audioId,
                      audioMeta: sec.audioMeta,
                      nextSectionCount: secCount,
                    });
                    if (versions.length > 1) {
                      await appendSectionVersionInCloud(uid, newStoryId, secId, versions);
                    }
                  }
                }
                localStorage.setItem(MIGRATED_FLAG_KEY, 'true');
                imported = true;
                showToast('Imported local stories to Firebase Cloud');
              }
            }
          } catch {
            // Ignore legacy migration errors and fall back to fresh story
          }

          if (!imported) {
            const freshId = createId('story');
            const initialTitle = 'Untitled Story 1';
            const nowIso = new Date().toISOString();
            setOptimisticStories((prev) => [
              {
                id: freshId,
                title: initialTitle,
                defaultStyle: 'colloquial',
                defaultRefinedEnding: 'colloquial',
                defaultModel: 'gemini-2.5-flash',
                sectionCount: 0,
                glossary: '',
                isDeleted: false,
                deletedAt: null,
                sections: [],
                createdAt: nowIso,
                updatedAt: nowIso,
              },
              ...prev.filter((s) => s.id !== freshId),
            ]);
            setTitleDraft(initialTitle);
            titleDraftRef.current = initialTitle;
            activeSessionIdRef.current = freshId;
            setActiveSessionId(freshId);
            setLastOpenedStoryId(freshId);
            setActiveView('story');
            await createStoryInCloud(uid, {
              storyId: freshId,
              title: initialTitle,
              defaultStyle: 'colloquial',
              defaultRefinedEnding: 'colloquial',
              defaultModel: 'gemini-2.5-flash',
            });
          }
        });
      } catch (err) {
        setGlobalError(formatCloudErrorMessage(err));
      }
    })();
  }, [uid, storiesLoaded, trashedStoriesLoaded, recentStories.length, trashedStories.length, showToast, trackSync]);

  // Real-time Firestore listener for individually trashed sections under users/{uid}/trashedSections
  useEffect(() => {
    setTrashedSectionsLoaded(false);
    const unsubscribe = subscribeToTrashedSections(
      uid,
      (items) => {
        setTrashedSections(items);
        setTrashedSectionsLoaded(true);
      },
      (err) => {
        setTrashedSectionsLoaded(true);
        setGlobalError(formatCloudErrorMessage(err));
      },
    );
    return () => unsubscribe();
  }, [uid]);

  // Automatic 30-day permanent cleanup helper
  const runExpiredTrashCleanup = useCallback(async () => {
    if (trashedStories.length === 0 && trashedSections.length === 0) return;
    const purged = await purgeExpiredTrashInCloud(uid, trashedStories, trashedSections);
    if (purged > 0) {
      showToast(
        `Auto-cleaned ${purged} expired Trash ${purged === 1 ? 'item' : 'items'} (> 30 days)`,
      );
    }
  }, [uid, trashedStories, trashedSections, showToast]);

  // Run automatic 30-day cleanup on initial app load once Trash data arrives
  useEffect(() => {
    if (!storiesLoaded || !trashedStoriesLoaded || !trashedSectionsLoaded) return;
    if (initialPurgeRanRef.current) return;
    initialPurgeRanRef.current = true;
    void runExpiredTrashCleanup();
  }, [storiesLoaded, trashedStoriesLoaded, trashedSectionsLoaded, runExpiredTrashCleanup]);

  // Also run automatic 30-day cleanup whenever the user opens the Trash view
  useEffect(() => {
    if (activeView === 'trash' && storiesLoaded && trashedStoriesLoaded && trashedSectionsLoaded) {
      void runExpiredTrashCleanup();
    }
  }, [activeView, storiesLoaded, trashedStoriesLoaded, trashedSectionsLoaded, runExpiredTrashCleanup]);

  // Lazy-loaded real-time listener for sections: ONLY attaches when a story is actively opened
  useEffect(() => {
    if (!activeSessionId || activeView !== 'story') {
      setSections([]);
      setSectionsLoaded(true);
      setSectionSaveStatus({});
      return;
    }

    setSectionsLoaded(false);
    for (const timerId of Object.values(sectionDebounceRefs.current)) {
      window.clearTimeout(timerId);
    }
    sectionDebounceRefs.current = {};
    sectionDraftsRef.current = {};
    setSectionDrafts({});
    setSectionSaveStatus({});

    const unsubscribe = subscribeToSections(
      uid,
      activeSessionId,
      (cloudSections) => {
        setSections(cloudSections);
        setSectionsLoaded(true);
      },
      (err) => {
        setSectionsLoaded(true);
        setGlobalError(formatCloudErrorMessage(err));
      },
    );

    return () => unsubscribe();
  }, [uid, activeSessionId, activeView]);

  const activeSession = useMemo(
    () => (activeSessionId ? activeStories.find((s) => s.id === activeSessionId) ?? null : null),
    [activeStories, activeSessionId],
  );

  // Suggested story for 1-click resume on the clean initial screen (without eagerly fetching sections)
  const suggestedResumeStory = useMemo(() => {
    if (activeStories.length === 0) return null;
    if (lastOpenedStoryId) {
      const remembered = activeStories.find((s) => s.id === lastOpenedStoryId);
      if (remembered) return remembered;
    }
    return activeStories[0];
  }, [activeStories, lastOpenedStoryId]);

  const handleLoadOlderStories = async () => {
    const cursor = olderLastDocRef.current ?? recentLastDocRef.current;
    if (!cursor || isLoadingMoreStories) return;
    setIsLoadingMoreStories(true);
    setGlobalError(null);
    try {
      const page = await fetchOlderStoriesPage(uid, cursor, STORIES_PAGE_SIZE);
      setOlderStories((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        const additions = page.stories.filter((s) => !seen.has(s.id));
        return [...prev, ...additions];
      });
      olderLastDocRef.current = page.lastDoc;
      setOlderHasMore(page.hasMore);
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
    } finally {
      setIsLoadingMoreStories(false);
    }
  };

  // Sync local title & glossary buffers with remote Firestore values when not actively editing
  useEffect(() => {
    if (!activeSession) return;
    if (!titleDirtyRef.current) {
      setTitleDraft(activeSession.title);
      titleDraftRef.current = activeSession.title;
    }
  }, [activeSession?.id, activeSession?.title]);

  useEffect(() => {
    if (!activeSession) {
      setGlossaryDraft('');
      glossaryDraftRef.current = '';
      setGlossarySaveStatus('saved');
      return;
    }
    if (!glossaryDirtyRef.current) {
      const nextGlossary = activeSession.glossary ?? '';
      setGlossaryDraft(nextGlossary);
      glossaryDraftRef.current = nextGlossary;
      setGlossarySaveStatus('saved');
    }
  }, [activeSession?.id, activeSession?.glossary]);

  // Collapse glossary drawer and section outline cleanly when changing stories
  useEffect(() => {
    setGlossaryOpen(false);
    setOutlineOpen(false);
  }, [activeSession?.id]);

  // Dismiss section outline popover on outside click or Escape
  useEffect(() => {
    if (!outlineOpen) return;
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (outlinePopoverRef.current && target && !outlinePopoverRef.current.contains(target)) {
        setOutlineOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOutlineOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [outlineOpen]);

  // Count non-empty glossary lines/items for the subtle toggle badge
  const glossaryEntryCount = useMemo(() => {
    const raw = glossaryDraft.trim();
    if (!raw) return 0;
    return raw
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean).length;
  }, [glossaryDraft]);

  const handleScrollToTop = useCallback(() => {
    mainScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const handleJumpToSection = useCallback((sectionId: string) => {
    setOutlineOpen(false);
    const container = mainScrollRef.current;
    const el = container?.querySelector<HTMLElement>(`[data-section-id="${sectionId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  // Merge any in-flight local typing drafts into displayed sections (unchanged sections keep ref identity for React.memo)
  const orderedSections = useMemo(() => {
    const sorted = sortSectionsChronologically(sections);
    return sorted.map((sec) => {
      const draft = sectionDrafts[sec.id];
      if (draft === undefined) return sec;
      const versions = getSectionVersions(sec);
      const activeIdx = getActiveVersionIndex(sec);
      const updatedVersions = versions.map((v, idx) =>
        idx === activeIdx ? { ...v, text: draft } : v,
      );
      return {
        ...sec,
        content: draft,
        versions: updatedVersions,
        activeVersionIndex: activeIdx,
      };
    });
  }, [sections, sectionDrafts]);

  // Smoothly scroll newly transcribed section into view at the bottom of the manuscript
  useEffect(() => {
    const targetId = pendingScrollSectionIdRef.current;
    if (!targetId) return;
    if (!orderedSections.some((sec) => sec.id === targetId)) return;
    pendingScrollSectionIdRef.current = null;

    window.requestAnimationFrame(() => {
      const container = mainScrollRef.current;
      const el = container?.querySelector<HTMLElement>(`[data-section-id="${targetId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (container) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      }
    });
  }, [orderedSections]);

  // Cumulative token usage & estimated USD cost across all versions of active sections in this story
  const sessionTokenStats = useMemo(() => {
    let totalTokens = 0;
    let totalCostUsd = 0;
    for (const sec of orderedSections) {
      const versions = getSectionVersions(sec);
      for (const ver of versions) {
        if (ver.usage) {
          totalTokens += ver.usage.totalTokens || 0;
          totalCostUsd += ver.usage.estimatedCostUsd || 0;
        }
      }
    }
    return { totalTokens, totalCostUsd };
  }, [orderedSections]);

  const flushSectionDraft = useCallback(
    async (sectionId: string, explicitStoryId?: string) => {
      const pendingTimer = sectionDebounceRefs.current[sectionId];
      if (pendingTimer !== undefined) {
        window.clearTimeout(pendingTimer);
        delete sectionDebounceRefs.current[sectionId];
      }

      const targetStoryId = explicitStoryId ?? activeSessionIdRef.current;
      const draftText = sectionDraftsRef.current[sectionId];
      if (draftText === undefined || !targetStoryId) return;

      const targetSection = sectionsRef.current.find((s) => s.id === sectionId);
      if (!targetSection) return;

      const now = new Date().toISOString();
      const versions = getSectionVersions(targetSection);
      const activeIdx = getActiveVersionIndex(targetSection);
      const updatedVersions = versions.map((v, idx) =>
        idx === activeIdx ? { ...v, text: draftText, timestamp: now } : v,
      );

      // Remove this snapshot from the pending map before awaiting Firestore
      if (sectionDraftsRef.current[sectionId] === draftText) {
        const nextRefCopy = { ...sectionDraftsRef.current };
        delete nextRefCopy[sectionId];
        sectionDraftsRef.current = nextRefCopy;
      }
      setSectionDrafts((prev) => {
        if (prev[sectionId] !== draftText) return prev;
        const copy = { ...prev };
        delete copy[sectionId];
        return copy;
      });
      setSectionSaveStatus((prev) => ({ ...prev, [sectionId]: 'saving' }));

      try {
        await trackSync(() =>
          updateSectionContentInCloud(uid, targetStoryId, sectionId, draftText, updatedVersions),
        );
        // Only switch to "Saved" after the Firestore promise resolves and no newer keystroke is queued
        if (
          activeSessionIdRef.current === targetStoryId &&
          sectionDraftsRef.current[sectionId] === undefined
        ) {
          setSectionSaveStatus((prev) => ({ ...prev, [sectionId]: 'saved' }));
        }
      } catch (err) {
        if (activeSessionIdRef.current === targetStoryId) {
          setSectionSaveStatus((prev) => ({ ...prev, [sectionId]: 'error' }));
        }
        setGlobalError(formatCloudErrorMessage(err));
      }
    },
    [uid, trackSync],
  );

  const handleRenameSession = useCallback(
    async (id: string, title: string) => {
      setGlobalError(null);
      const clean = title.trim() || 'Untitled Story';
      try {
        await trackSync(() => renameStoryInCloud(uid, id, clean));
      } catch (err) {
        setGlobalError(formatCloudErrorMessage(err));
      }
    },
    [uid, trackSync],
  );

  const flushTitleDraft = useCallback(
    async (explicitStoryId?: string) => {
      const targetStoryId = explicitStoryId ?? activeSessionIdRef.current;
      if (titleDebounceRef.current !== null) {
        window.clearTimeout(titleDebounceRef.current);
        titleDebounceRef.current = null;
      }
      if (!targetStoryId || !titleDirtyRef.current) return;
      titleDirtyRef.current = false;
      const clean = titleDraftRef.current.trim() || 'Untitled Story';
      if (activeSessionIdRef.current === targetStoryId) {
        setTitleDraft(clean);
      }
      titleDraftRef.current = clean;
      await handleRenameSession(targetStoryId, clean);
    },
    [handleRenameSession],
  );

  const flushGlossaryDraft = useCallback(
    async (explicitStoryId?: string) => {
      const targetStoryId = explicitStoryId ?? activeSessionIdRef.current;
      if (glossaryDebounceRef.current !== null) {
        window.clearTimeout(glossaryDebounceRef.current);
        glossaryDebounceRef.current = null;
      }
      if (!targetStoryId || !glossaryDirtyRef.current) return;
      glossaryDirtyRef.current = false;
      const valueToSave = glossaryDraftRef.current;
      if (activeSessionIdRef.current === targetStoryId) {
        setGlossarySaveStatus('saving');
      }
      try {
        await trackSync(() => updateStoryGlossaryInCloud(uid, targetStoryId, valueToSave));
        if (activeSessionIdRef.current === targetStoryId && !glossaryDirtyRef.current) {
          setGlossarySaveStatus('saved');
        }
      } catch (err) {
        if (activeSessionIdRef.current === targetStoryId) {
          setGlossarySaveStatus('error');
        }
        setGlobalError(formatCloudErrorMessage(err));
      }
    },
    [uid, trackSync],
  );

  const flushAllPendingEdits = useCallback(
    async (explicitStoryId?: string) => {
      const targetStoryId = explicitStoryId ?? activeSessionIdRef.current;
      if (!targetStoryId) return;

      const tasks: Promise<unknown>[] = [];
      if (titleDirtyRef.current || titleDebounceRef.current !== null) {
        tasks.push(flushTitleDraft(targetStoryId));
      }
      if (glossaryDirtyRef.current || glossaryDebounceRef.current !== null) {
        tasks.push(flushGlossaryDraft(targetStoryId));
      }
      const pendingDraftIds = Object.keys(sectionDraftsRef.current);
      for (const secId of pendingDraftIds) {
        tasks.push(flushSectionDraft(secId, targetStoryId));
      }
      if (tasks.length > 0) {
        await Promise.allSettled(tasks);
      }
    },
    [flushTitleDraft, flushGlossaryDraft, flushSectionDraft],
  );

  useEffect(() => {
    flushAllPendingEditsRef.current = flushAllPendingEdits;
  }, [flushAllPendingEdits]);

  const handleSelectStory = useCallback(
    (nextStoryId: string) => {
      const prevStoryId = activeSessionIdRef.current;
      if (prevStoryId && prevStoryId !== nextStoryId) {
        void flushAllPendingEdits(prevStoryId);
      }
      titleDirtyRef.current = false;
      glossaryDirtyRef.current = false;
      setActiveSessionId(nextStoryId);
      setLastOpenedStoryId(nextStoryId);
      setActiveView('story');
      setGlobalError(null);
    },
    [flushAllPendingEdits],
  );

  const handleSelectTrashView = useCallback(() => {
    const prevStoryId = activeSessionIdRef.current;
    if (prevStoryId) {
      void flushAllPendingEdits(prevStoryId);
    }
    setActiveView('trash');
    setGlobalError(null);
  }, [flushAllPendingEdits]);

  const handleCreateSession = async () => {
    if (creatingStoryRef.current) return;
    creatingStoryRef.current = true;
    setIsCreatingStory(true);

    const prevStoryId = activeSessionIdRef.current;
    if (prevStoryId) {
      void flushAllPendingEdits(prevStoryId);
    }
    setGlobalError(null);

    const freshId = createId('story');
    const nextTitle = getNextUntitledStoryTitle(activeStories);
    const defaultStyle = activeSession?.defaultStyle ?? 'colloquial';
    const defaultRefinedEnding = activeSession?.defaultRefinedEnding ?? 'colloquial';
    const defaultModel = activeSession?.defaultModel ?? 'gemini-2.5-flash';
    const nowIso = new Date().toISOString();

    const optimisticStory: StorySession = {
      id: freshId,
      title: nextTitle,
      defaultStyle,
      defaultRefinedEnding,
      defaultModel,
      sectionCount: 0,
      glossary: '',
      isDeleted: false,
      deletedAt: null,
      sections: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    // Optimistically register the new story and navigate straight into its editor
    setOptimisticStories((prev) => [optimisticStory, ...prev.filter((s) => s.id !== freshId)]);
    titleDirtyRef.current = false;
    glossaryDirtyRef.current = false;
    setTitleDraft(nextTitle);
    titleDraftRef.current = nextTitle;
    setGlossaryDraft('');
    glossaryDraftRef.current = '';
    setSections([]);
    setSectionsLoaded(true);
    activeSessionIdRef.current = freshId;
    setActiveSessionId(freshId);
    setLastOpenedStoryId(freshId);
    setActiveView('story');
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setSidebarOpen(false);
    }

    const rollbackCreation = (err: unknown) => {
      setOptimisticStories((prev) => prev.filter((s) => s.id !== freshId));
      if (activeSessionIdRef.current === freshId) {
        activeSessionIdRef.current = prevStoryId;
        setActiveSessionId(prevStoryId);
      }
      setGlobalError(formatCloudErrorMessage(err));
    };

    const writePromise = trackSync(() =>
      createStoryInCloud(uid, {
        storyId: freshId,
        title: nextTitle,
        defaultStyle,
        defaultRefinedEnding,
        defaultModel,
      }),
    );

    try {
      await Promise.race([
        writePromise,
        new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
      ]);
    } catch (err) {
      rollbackCreation(err);
      return;
    } finally {
      creatingStoryRef.current = false;
      setIsCreatingStory(false);
    }

    // If the write took > 1.5s (e.g. reconnecting/offline) and later rejects, roll back cleanly
    writePromise.catch((err) => {
      rollbackCreation(err);
    });
  };

  const handleTitleInputChange = (nextTitle: string) => {
    if (!activeSession) return;
    titleDirtyRef.current = true;
    titleDraftRef.current = nextTitle;
    setTitleDraft(nextTitle);

    if (titleDebounceRef.current !== null) {
      window.clearTimeout(titleDebounceRef.current);
    }
    const targetStoryId = activeSession.id;
    titleDebounceRef.current = window.setTimeout(() => {
      void flushTitleDraft(targetStoryId);
    }, 550);
  };

  const handleTitleInputBlur = () => {
    if (!activeSession) return;
    if (titleDirtyRef.current || titleDraftRef.current.trim() !== activeSession.title) {
      titleDirtyRef.current = true;
      void flushTitleDraft(activeSession.id);
    }
  };

  const handleGlossaryInputChange = (nextGlossary: string) => {
    if (!activeSession) return;
    glossaryDirtyRef.current = true;
    glossaryDraftRef.current = nextGlossary;
    setGlossaryDraft(nextGlossary);
    setGlossarySaveStatus('saving');

    if (glossaryDebounceRef.current !== null) {
      window.clearTimeout(glossaryDebounceRef.current);
    }
    const targetStoryId = activeSession.id;
    glossaryDebounceRef.current = window.setTimeout(() => {
      void flushGlossaryDraft(targetStoryId);
    }, 650);
  };

  const handleGlossaryInputBlur = () => {
    if (!activeSession) return;
    if (glossaryDirtyRef.current) {
      void flushGlossaryDraft(activeSession.id);
    }
  };

  // Mandatory confirmation triggers (never delete immediately!)
  const handleRequestTrashStory = useCallback(
    (storyId: string) => {
      const story = activeStories.find((s) => s.id === storyId);
      if (!story) return;
      setPendingConfirm({ kind: 'trash_story', story });
    },
    [activeStories],
  );

  const handleRequestTrashSection = useCallback((sectionId: string) => {
    const section = sectionsRef.current.find((s) => s.id === sectionId);
    if (!section) return;
    setPendingConfirm({ kind: 'trash_section', section });
  }, []);

  const handleConfirmAction = async () => {
    if (!pendingConfirm || confirmBusy) return;
    setConfirmBusy(true);
    setGlobalError(null);

    try {
      if (pendingConfirm.kind === 'trash_story') {
        const trashedId = pendingConfirm.story.id;
        if (activeSessionId === trashedId) {
          await flushAllPendingEdits(trashedId);
        }
        await trackSync(() => moveStoryToTrashInCloud(uid, trashedId));
        setOlderStories((prev) => prev.filter((s) => s.id !== trashedId));
        if (activeSessionId === trashedId) {
          setActiveSessionId('');
        }
        showToast('Moved story to Trash (recoverable for 30 days)');
      } else if (pendingConfirm.kind === 'trash_section') {
        if (!activeSession) return;
        await flushSectionDraft(pendingConfirm.section.id);
        const nextCount = Math.max(0, sectionsRef.current.length - 1);
        await trackSync(() =>
          moveSectionToTrashInCloud(
            uid,
            activeSession.id,
            titleDraft || activeSession.title,
            pendingConfirm.section,
            nextCount,
          ),
        );
        showToast('Moved section to Trash (recoverable for 30 days)');
      } else if (pendingConfirm.kind === 'delete_story_forever') {
        const deletedId = pendingConfirm.story.id;
        setTrashBusyItemId(deletedId);
        await trackSync(() => permanentlyDeleteStoryInCloud(uid, deletedId));
        setOlderStories((prev) => prev.filter((s) => s.id !== deletedId));
        showToast('Story permanently deleted');
      } else if (pendingConfirm.kind === 'delete_section_forever') {
        setTrashBusyItemId(pendingConfirm.section.id);
        if (pendingConfirm.section.audioId) {
          deleteAudioClip(pendingConfirm.section.audioId).catch(() => undefined);
        }
        await trackSync(() =>
          permanentlyDeleteSectionFromTrashInCloud(uid, pendingConfirm.section),
        );
        showToast('Section permanently deleted');
      }
      setPendingConfirm(null);
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
    } finally {
      setConfirmBusy(false);
      setTrashBusyItemId(null);
    }
  };

  const handleRestoreStory = async (story: StorySession) => {
    if (trashBusyItemId) return;
    setTrashBusyItemId(story.id);
    setGlobalError(null);
    try {
      await trackSync(() => restoreStoryFromTrashInCloud(uid, story.id));
      setLastOpenedStoryId(story.id);
      showToast(`Restored "${story.title || 'Untitled Story'}"`);
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
    } finally {
      setTrashBusyItemId(null);
    }
  };

  const handleRestoreSection = async (trashed: TrashedSection) => {
    if (trashBusyItemId) return;
    setTrashBusyItemId(trashed.id);
    setGlobalError(null);
    try {
      const result = await trackSync(() =>
        restoreSectionFromTrashInCloud(uid, trashed, allKnownStories),
      );
      showToast(
        result.usedFallbackStory
          ? `Restored section to "${result.restoredStoryTitle}"`
          : `Restored section to "${result.restoredStoryTitle}"`,
      );
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
    } finally {
      setTrashBusyItemId(null);
    }
  };

  const handleStyleChange = async (style: WritingStyle) => {
    if (!activeSession) return;
    setGlobalError(null);
    try {
      await trackSync(() => updateStoryStyleInCloud(uid, activeSession.id, style));
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
    }
  };

  const handleRefinedEndingChange = async (ending: VoiceEnding) => {
    if (!activeSession) return;
    setGlobalError(null);
    try {
      await trackSync(() => updateStoryRefinedEndingInCloud(uid, activeSession.id, ending));
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
    }
  };

  const handleModelChange = async (model: GeminiModel) => {
    if (!activeSession) return;
    setGlobalError(null);
    try {
      await trackSync(() => updateStoryModelInCloud(uid, activeSession.id, model));
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
    }
  };

  const activeRefinedEnding: VoiceEnding = activeSession?.defaultRefinedEnding ?? 'colloquial';

  const handleTranscribeAudio = async (
    staged: StagedAudio,
    mode: ProcessingMode,
    signal: AbortSignal,
  ) => {
    if (!activeSession) return;
    setGlobalError(null);
    const targetStoryId = activeSession.id;
    const targetStyle = activeSession.defaultStyle;
    const targetEnding = activeRefinedEnding;
    const targetModel = activeSession.defaultModel;
    const activeGlossary = (glossaryDraftRef.current || activeSession.glossary || '').trim();
    const previousContext =
      mode === 'summarize_structure'
        ? undefined
        : extractPreviousParagraphContext(orderedSections);

    // 1. Transcribe / polish via server-side Gemini API (returns text + exact usageMetadata)
    const result = await transcribeAudioApi({
      blob: staged.blob,
      filename: staged.filename,
      style: targetStyle,
      refinedEnding: targetEnding,
      model: targetModel,
      mode,
      glossary: activeGlossary || undefined,
      previousContext,
      signal,
    });

    const sectionId = createId('sec');
    const audioId = createId('audio');
    const audioMeta = {
      filename: staged.filename,
      mimeType: staged.mimeType,
      durationSec: staged.durationSec,
      sizeBytes: staged.sizeBytes,
    };

    // 2. Store original audio strictly locally on this device (IndexedDB) — no Firebase Storage upload
    await saveAudioClip(audioId, staged.blob, audioMeta);

    // 3. Immediately save transcribed section + version history + token usage to Cloud Firestore
    const now = new Date().toISOString();
    const initialVersion: SectionVersion = {
      id: createId('ver'),
      text: result.text,
      style: targetStyle,
      refinedEnding: targetEnding,
      model: targetModel,
      mode,
      timestamp: now,
      usage: result.usage,
    };

    const nextSectionCount = sectionsRef.current.length + 1;
    try {
      await trackSync(() =>
        createSectionInCloud(uid, targetStoryId, {
          sectionId,
          order: Date.now(),
          initialVersion,
          audioId,
          audioMeta,
          nextSectionCount,
        }),
      );
    } catch (cloudErr) {
      await deleteAudioClip(audioId).catch(() => undefined);
      throw cloudErr;
    }

    pendingScrollSectionIdRef.current = sectionId;

    const styleDesc = formatCompactStyleLabel(targetStyle, targetEnding);
    showToast(
      mode === 'summarize_structure'
        ? `Structured summary synced (${styleDesc})`
        : `Section synced (${styleDesc})`,
    );
  };

  const handleUpdateSectionContent = useCallback(
    (sectionId: string, nextContent: string) => {
      const targetStoryId = activeSessionIdRef.current;
      setSectionDrafts((prev) => ({ ...prev, [sectionId]: nextContent }));
      sectionDraftsRef.current = { ...sectionDraftsRef.current, [sectionId]: nextContent };
      setSectionSaveStatus((prev) =>
        prev[sectionId] === 'saving' ? prev : { ...prev, [sectionId]: 'saving' },
      );

      const existingTimer = sectionDebounceRefs.current[sectionId];
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }
      sectionDebounceRefs.current[sectionId] = window.setTimeout(() => {
        void flushSectionDraft(sectionId, targetStoryId);
      }, 650);
    },
    [flushSectionDraft],
  );

  const handleFlushSectionContent = useCallback(
    (sectionId: string) => {
      void flushSectionDraft(sectionId);
    },
    [flushSectionDraft],
  );

  const handleSelectSectionVersion = useCallback(
    async (sectionId: string, versionIndex: number) => {
      const targetStoryId = activeSessionIdRef.current;
      if (!targetStoryId) return;
      await flushSectionDraft(sectionId, targetStoryId);

      const target = sectionsRef.current.find((s) => s.id === sectionId);
      if (!target) return;
      const versions = getSectionVersions(target);
      const clamped = Math.max(0, Math.min(versionIndex, versions.length - 1));
      const selected = versions[clamped];

      setGlobalError(null);
      try {
        await trackSync(() =>
          selectSectionVersionInCloud(uid, targetStoryId, sectionId, selected, clamped),
        );
      } catch (err) {
        setGlobalError(formatCloudErrorMessage(err));
      }
    },
    [uid, flushSectionDraft, trackSync],
  );

  const handleSelectSectionVersionSync = useCallback(
    (sectionId: string, versionIndex: number) => {
      void handleSelectSectionVersion(sectionId, versionIndex);
    },
    [handleSelectSectionVersion],
  );

  const handleReprocessStyle = useCallback(
    async (
      section: ManuscriptSection,
      targetStyle: WritingStyle,
      targetEnding?: VoiceEnding,
      source: ReprocessSource = 'text',
      overrideMode?: ProcessingMode,
    ) => {
      const targetStoryId = activeSessionIdRef.current;
      if (!targetStoryId || reprocessingSectionIdRef.current) return;
      // Lock synchronously before any async work to prevent fast double-click duplicate API calls
      reprocessingSectionIdRef.current = section.id;
      setReprocessingSectionId(section.id);
      setGlobalError(null);

      try {
        await flushSectionDraft(section.id, targetStoryId);

        const latestBeforeCall =
          sectionsRef.current.find((s) => s.id === section.id) ?? section;
        const chosenModel = activeSession?.defaultModel ?? 'gemini-2.5-flash';
        const effectiveMode: ProcessingMode =
          overrideMode ?? latestBeforeCall.mode ?? 'full_polish';
        const resolvedEnding: VoiceEnding = targetEnding ?? activeRefinedEnding;
        const currentActiveText = getActiveSectionVersion(latestBeforeCall).text;
        const activeGlossary = (glossaryDraftRef.current || activeSession?.glossary || '').trim();

        let nextText = '';
        let nextUsage = undefined;
        let usedAudio = false;

        if (source === 'audio' && effectiveMode !== 'proofread_only') {
          if (latestBeforeCall.storagePath || latestBeforeCall.audioUrl) {
            const cloudBlob = await downloadSectionAudioBlob(
              latestBeforeCall.storagePath,
              latestBeforeCall.audioUrl,
            );
            if (cloudBlob) {
              const result = await transcribeAudioApi({
                blob: cloudBlob,
                filename: latestBeforeCall.audioMeta?.filename || 'recording.webm',
                style: targetStyle,
                refinedEnding: resolvedEnding,
                model: chosenModel,
                mode: effectiveMode,
                glossary: activeGlossary || undefined,
              });
              nextText = result.text;
              nextUsage = result.usage;
              usedAudio = true;
            }
          }

          if (!usedAudio && latestBeforeCall.audioId) {
            const stored = await getAudioClip(latestBeforeCall.audioId);
            if (stored?.blob) {
              const result = await transcribeAudioApi({
                blob: stored.blob,
                filename: stored.meta.filename,
                style: targetStyle,
                refinedEnding: resolvedEnding,
                model: chosenModel,
                mode: effectiveMode,
                glossary: activeGlossary || undefined,
              });
              nextText = result.text;
              nextUsage = result.usage;
              usedAudio = true;
            }
          }

          if (!usedAudio) {
            throw new Error(
              'Original audio clip is not stored on this device. Try restyling from text instead.',
            );
          }
        } else {
          // Fast, low-cost text-only restyling or strict Proofread Only pass
          const result = await restyleTextApi({
            text: currentActiveText,
            style: targetStyle,
            refinedEnding: resolvedEnding,
            model: chosenModel,
            mode: effectiveMode,
            glossary: activeGlossary || undefined,
          });
          nextText = result.text;
          nextUsage = result.usage;
        }

        const now = new Date().toISOString();
        const nextVersion: SectionVersion = {
          id: createId('ver'),
          text: nextText,
          style: targetStyle,
          refinedEnding: resolvedEnding,
          model: chosenModel,
          mode: effectiveMode,
          timestamp: now,
          usage: nextUsage,
        };

        // Re-read the freshest section state before appending and prune oldest intermediate versions if >= 50
        const freshestSection =
          sectionsRef.current.find((s) => s.id === section.id) ?? latestBeforeCall;
        const existingVersions = getSectionVersions(freshestSection);
        const combinedVersions = [...existingVersions, nextVersion];
        const boundedVersions =
          combinedVersions.length > 50
            ? [combinedVersions[0], ...combinedVersions.slice(-49)]
            : combinedVersions;

        await trackSync(() =>
          appendSectionVersionInCloud(uid, targetStoryId, section.id, boundedVersions),
        );

        const styleDesc = formatCompactStyleLabel(targetStyle, resolvedEnding);
        showToast(
          effectiveMode === 'proofread_only'
            ? `Proofread saved as v${boundedVersions.length}`
            : usedAudio
              ? `Re-listened & saved as v${boundedVersions.length} (${styleDesc})`
              : `Saved as v${boundedVersions.length} (${styleDesc})`,
        );
      } catch (err) {
        setGlobalError(formatCloudErrorMessage(err));
      } finally {
        reprocessingSectionIdRef.current = null;
        setReprocessingSectionId(null);
      }
    },
    [
      uid,
      activeSession?.defaultModel,
      activeSession?.glossary,
      activeRefinedEnding,
      flushSectionDraft,
      trackSync,
      showToast,
    ],
  );

  const copyToClipboard = useCallback(
    async (text: string, label = 'Copied to clipboard') => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(label);
      } catch {
        const temp = document.createElement('textarea');
        temp.value = text;
        temp.style.position = 'fixed';
        temp.style.opacity = '0';
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
        showToast(label);
      }
    },
    [showToast],
  );

  const handleCopySectionText = useCallback(
    (txt: string) => {
      void copyToClipboard(txt, 'Section copied');
    },
    [copyToClipboard],
  );

  const activeSessionWithSections: StorySession | null = useMemo(() => {
    if (!activeSession) return null;
    return {
      ...activeSession,
      title: titleDraft || activeSession.title,
      sections: orderedSections,
    };
  }, [activeSession, titleDraft, orderedSections]);

  const handleCopyFullStory = async () => {
    if (!activeSessionWithSections) return;
    const fullText = compileFullStoryPlainText(activeSessionWithSections);
    if (!fullText) return;
    await copyToClipboard(fullText, 'Full story copied');
    setCopiedFull(true);
    window.setTimeout(() => setCopiedFull(false), 1800);
  };

  const handleExportTxt = () => {
    if (!activeSessionWithSections) return;
    const content = compileFullStoryPlainText(activeSessionWithSections);
    if (!content) return;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    triggerBlobDownload(blob, safeExportFilename(activeSessionWithSections.title, 'txt'));
    showToast('Exported as .txt');
  };

  const handleExportMd = () => {
    if (!activeSessionWithSections) return;
    const content = compileFullStoryMarkdown(activeSessionWithSections);
    if (!content) return;
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    triggerBlobDownload(blob, safeExportFilename(activeSessionWithSections.title, 'md'));
    showToast('Exported as .md');
  };

  const totalCharacters = useMemo(
    () =>
      orderedSections.reduce(
        (acc, s) => acc + countCharacters(getActiveSectionVersion(s).text),
        0,
      ),
    [orderedSections],
  );

  const hasContent = orderedSections.some(
    (s) => getActiveSectionVersion(s).text.trim().length > 0,
  );

  const isSyncing =
    pendingSyncOps > 0 ||
    isManualSyncing ||
    Object.keys(sectionDrafts).length > 0 ||
    glossarySaveStatus === 'saving';

  // Manual header sync button handler (flushes local drafts, re-verifies Firestore, pulses "Synced")
  const handleManualSync = async () => {
    if (isManualSyncing) return;
    setIsManualSyncing(true);
    setGlobalError(null);
    const startedAt = Date.now();

    try {
      // Flush any unsaved title, glossary, or section drafts before syncing
      await flushAllPendingEdits(activeSessionId);

      const { online } = await syncFirestoreConnection({
        uid,
        activeStoryId: activeSessionId || undefined,
        forceReconnect: true,
        verifyServer: true,
      });

      // Keep spin visible briefly so the tap feels crisp and responsive
      const elapsed = Date.now() - startedAt;
      if (elapsed < 450) {
        await new Promise((resolve) => setTimeout(resolve, 450 - elapsed));
      }

      triggerSyncPulse(online ? 'synced' : 'offline');
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
      triggerSyncPulse('offline');
    } finally {
      setIsManualSyncing(false);
    }
  };

  // Build ConfirmDialog copy based on pending action
  const confirmDialogConfig = useMemo(() => {
    if (!pendingConfirm) return null;
    switch (pendingConfirm.kind) {
      case 'trash_story':
        return {
          title: 'Move story to Trash?',
          message: 'Move this story to Trash? You can restore it within 30 days.',
          confirmLabel: 'Move to Trash',
          destructive: true,
        };
      case 'trash_section':
        return {
          title: 'Move section to Trash?',
          message: 'Move this section and its audio to Trash? You can restore it within 30 days.',
          confirmLabel: 'Move to Trash',
          destructive: true,
        };
      case 'delete_story_forever':
        return {
          title: 'Delete story forever?',
          message: 'Permanently delete forever? This cannot be undone.',
          confirmLabel: 'Delete Forever',
          destructive: true,
        };
      case 'delete_section_forever':
        return {
          title: 'Delete section forever?',
          message: 'Permanently delete forever? This cannot be undone.',
          confirmLabel: 'Delete Forever',
          destructive: true,
        };
    }
  }, [pendingConfirm]);

  if (!storiesLoaded) {
    return (
      <div className="safe-top safe-bottom flex h-[100dvh] w-full flex-col items-center justify-center bg-white px-6 text-[#111827]">
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-5 w-5 animate-spin text-[#312E81]" aria-hidden="true" />
          <p className="text-sm font-medium text-[#6B7280]">Loading your cloud stories…</p>
          {globalError && (
            <p className="mt-2 max-w-md rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-4 py-2.5 text-xs text-[#991B1B]">
              {globalError}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-white text-[#111827]">
      <Sidebar
        sessions={activeStories}
        activeSessionId={activeSession?.id ?? ''}
        activeSectionCount={orderedSections.length}
        activeView={activeView}
        trashCount={trashCount}
        hasMoreStories={hasMoreStories}
        isLoadingMoreStories={isLoadingMoreStories}
        isCreatingStory={isCreatingStory}
        isOpen={sidebarOpen}
        userEmail={user.email}
        onSignOut={() => {
          void flushAllPendingEdits(activeSessionId).finally(() => {
            onSignOut().catch(() => undefined);
          });
        }}
        onCloseMobile={() => setSidebarOpen(false)}
        onToggleDesktop={() => setSidebarOpen((prev) => !prev)}
        onSelectSession={handleSelectStory}
        onSelectTrash={handleSelectTrashView}
        onLoadOlderStories={() => {
          void handleLoadOlderStories();
        }}
        onCreateSession={() => {
          void handleCreateSession();
        }}
        onRenameSession={(id, title) => {
          void handleRenameSession(id, title);
        }}
        onDeleteSession={handleRequestTrashStory}
      />

      {/* Main editorial column */}
      <div className="flex min-w-0 flex-1 flex-col bg-white">
        {/* Top document utility bar (safe-top clears iPhone Dynamic Island / status bar) */}
        <header className="safe-top ios-crisp-header relative z-20 shrink-0 border-b border-gray-200 bg-white">
          <div className="flex h-14 items-center justify-between gap-2 px-3 sm:gap-3 sm:px-6">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2.5">
              <div className="flex shrink-0 items-center gap-0.5">
                {!sidebarOpen && (
                  <button
                    type="button"
                    onClick={() => setSidebarOpen(true)}
                    aria-label="Open sidebar"
                    title="Open stories sidebar"
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[#4B5563] transition-colors duration-150 hover:bg-[#F3F4F6] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81]"
                  >
                    <PanelLeft className="h-4 w-4" />
                  </button>
                )}

                <button
                  type="button"
                  disabled={isManualSyncing}
                  onClick={() => {
                    void handleManualSync();
                  }}
                  aria-label="Sync with cloud"
                  title="Sync latest changes from Firebase"
                  className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 hover:bg-[#F3F4F6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81] disabled:cursor-wait sm:h-9 sm:w-9 ${
                    isManualSyncing
                      ? 'text-[#312E81]'
                      : syncPulseState === 'synced'
                        ? 'text-[#16A34A]'
                        : 'text-[#6B7280] hover:text-[#111827]'
                  }`}
                >
                  <RefreshCw className={`h-4 w-4 ${isManualSyncing ? 'animate-spin' : ''}`} />
                </button>
              </div>

              <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                {!sidebarOpen && (
                  <>
                    <div className="inline-flex shrink-0 items-center gap-2">
                      <img
                        src={BRAND_LOGO_URL}
                        alt="SarYay"
                        width={32}
                        height={32}
                        className="h-7 w-7 shrink-0 rounded-full border border-[#E5E7EB] bg-white object-cover sm:h-8 sm:w-8"
                      />
                      <span className="hidden whitespace-nowrap font-semibold tracking-tight text-[#111827] sm:inline">
                        SarYay
                      </span>
                    </div>
                    <span aria-hidden="true" className="hidden text-[#D1D5DB] sm:inline">
                      /
                    </span>
                  </>
                )}
                {activeView === 'story' && activeSession ? (
                  <button
                    type="button"
                    onClick={handleScrollToTop}
                    title="Scroll to top (Title & Glossary)"
                    aria-label="Scroll to top of story"
                    className="-mx-1.5 min-w-0 truncate rounded-md px-1.5 py-1 text-left font-medium text-[#374151] transition-colors duration-150 hover:bg-[#F3F4F6] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA]"
                  >
                    {titleDraft || activeSession.title || 'Untitled Story'}
                  </button>
                ) : (
                  <span className="min-w-0 truncate font-medium text-[#374151]">
                    {activeView === 'trash' ? 'Trash' : 'SarYay'}
                  </span>
                )}

                {/* Minimal Cloud Sync Indicator + Subtle Synced Pulse */}
                <span
                  className={`ml-0.5 shrink-0 items-center gap-1 text-[11px] transition-colors duration-200 ${
                    syncPulseState !== 'idle' || isManualSyncing
                      ? 'inline-flex'
                      : 'hidden sm:inline-flex'
                  } ${
                    syncPulseState === 'synced'
                      ? 'font-medium text-[#16A34A]'
                      : syncPulseState === 'offline'
                        ? 'font-medium text-[#D97706]'
                        : isSyncing
                          ? 'text-[#6B7280]'
                          : 'text-[#9CA3AF]'
                  }`}
                  aria-live="polite"
                >
                  {isSyncing ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>Syncing…</span>
                    </>
                  ) : syncPulseState === 'synced' ? (
                    <>
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-[#16A34A] animate-pulse"
                        aria-hidden="true"
                      />
                      <span>Synced</span>
                    </>
                  ) : syncPulseState === 'offline' ? (
                    <>
                      <span
                        className="h-1.5 w-1.5 rounded-full bg-[#D97706]"
                        aria-hidden="true"
                      />
                      <span>Offline</span>
                    </>
                  ) : (
                    <>
                      <Cloud className="h-3.5 w-3.5" />
                      <span>Synced</span>
                    </>
                  )}
                </span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              {activeView === 'story' && activeSession && (
                <>
                  <button
                    type="button"
                    disabled={!hasContent}
                    onClick={handleCopyFullStory}
                    aria-label={copiedFull ? 'Copied full story' : 'Copy full story'}
                    title="Copy full story"
                    className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-2 text-xs font-medium text-[#374151] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:cursor-not-allowed disabled:opacity-45 sm:h-auto sm:px-3 sm:py-1.5"
                  >
                    {copiedFull ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-[#16A34A]" />
                        <span className="hidden text-[#16A34A] sm:inline">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Copy Full Story</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    disabled={!hasContent}
                    onClick={handleExportTxt}
                    aria-label="Export as .txt"
                    title="Export full story as plain text (.txt)"
                    className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-2 text-xs font-medium text-[#374151] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:cursor-not-allowed disabled:opacity-45 sm:h-auto sm:px-3 sm:py-1.5"
                  >
                    <FileText className="hidden h-3.5 w-3.5 sm:inline" />
                    <span>.txt</span>
                  </button>

                  <button
                    type="button"
                    disabled={!hasContent}
                    onClick={handleExportMd}
                    aria-label="Export as .md"
                    title="Export full session sequentially as Markdown (.md)"
                    className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-2 text-xs font-medium text-[#374151] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:cursor-not-allowed disabled:opacity-45 sm:h-auto sm:px-3 sm:py-1.5"
                  >
                    <FileDown className="hidden h-3.5 w-3.5 sm:inline" />
                    <span className="hidden sm:inline">Export as .md</span>
                    <span className="sm:hidden">.md</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Scrollable main canvas (either Trash Bin view or active Story workspace) */}
        <main
          ref={mainScrollRef}
          className={`flex-1 overflow-y-auto bg-white ${
            activeView === 'story' && activeSession ? 'pb-6' : 'safe-bottom-scroll'
          }`}
        >
          {globalError && (activeView === 'trash' || !activeSession) && (
            <div className="mx-auto max-w-[780px] px-5 pt-6 sm:px-10">
              <div
                role="alert"
                className="flex items-start justify-between gap-3 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-xs text-[#991B1B]"
              >
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" />
                  <p className="min-w-0 flex-1 break-words leading-relaxed [overflow-wrap:anywhere]">
                    {globalError}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setGlobalError(null)}
                  aria-label="Dismiss error"
                  className="shrink-0 rounded p-0.5 text-[#991B1B] hover:bg-[#FEE2E2]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          {activeView === 'trash' ? (
            <TrashBinView
              uid={uid}
              trashedStories={trashedStories}
              trashedSections={trashedSections}
              busyItemId={trashBusyItemId}
              onRestoreStory={(story) => {
                void handleRestoreStory(story);
              }}
              onRequestDeleteStoryForever={(story) =>
                setPendingConfirm({ kind: 'delete_story_forever', story })
              }
              onRestoreSection={(section) => {
                void handleRestoreSection(section);
              }}
              onRequestDeleteSectionForever={(section) =>
                setPendingConfirm({ kind: 'delete_section_forever', section })
              }
              onCopyText={copyToClipboard}
            />
          ) : !activeSession ? (
            <div className="mx-auto flex max-w-[780px] flex-col items-center justify-center px-5 py-20 text-center sm:px-10">
              {activeStories.length > 0 ? (
                <>
                  <p className="text-sm font-medium text-[#374151]">Select a story to open</p>
                  <p className="mt-1 text-xs text-[#6B7280]">
                    Pick any story from the sidebar to load its sections, or start a new one.
                  </p>
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                    {suggestedResumeStory && (
                      <button
                        type="button"
                        onClick={() => handleSelectStory(suggestedResumeStory.id)}
                        className="max-w-[280px] truncate rounded-lg bg-[#312E81] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#27246A]"
                      >
                        Open {suggestedResumeStory.title || 'Untitled Story'}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={isCreatingStory}
                      onClick={() => {
                        void handleCreateSession();
                      }}
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#E5E7EB] bg-white px-4 py-2 text-xs font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB] disabled:cursor-wait disabled:opacity-60"
                    >
                      {isCreatingStory ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#312E81]" />
                          <span>Creating…</span>
                        </>
                      ) : (
                        <span>New Story</span>
                      )}
                    </button>
                    {!sidebarOpen && (
                      <button
                        type="button"
                        onClick={() => setSidebarOpen(true)}
                        className="rounded-lg border border-[#E5E7EB] bg-white px-4 py-2 text-xs font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB]"
                      >
                        Browse Stories
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-[#374151]">No active stories</p>
                  <p className="mt-1 text-xs text-[#6B7280]">
                    Start a new story or restore a deleted story from Trash.
                  </p>
                  <div className="mt-5 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={isCreatingStory}
                      onClick={() => {
                        void handleCreateSession();
                      }}
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#312E81] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#27246A] disabled:cursor-wait disabled:opacity-60"
                    >
                      {isCreatingStory ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span>Creating…</span>
                        </>
                      ) : (
                        <span>New Story</span>
                      )}
                    </button>
                    {trashCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setActiveView('trash')}
                        className="rounded-lg border border-[#E5E7EB] bg-white px-4 py-2 text-xs font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB]"
                      >
                        Open Trash ({trashCount})
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="mx-auto max-w-[780px] px-5 py-6 sm:px-10 sm:py-8">
              {/* Editable story title & minimal metadata (+ subtle cumulative token summary) */}
              <div className="mb-5">
                <input
                  type="text"
                  value={titleDraft}
                  onChange={(e) => handleTitleInputChange(e.target.value)}
                  onBlur={handleTitleInputBlur}
                  placeholder="Untitled Story"
                  aria-label="Story title"
                  className="font-manuscript w-full border-0 bg-transparent p-0 text-2xl font-semibold tracking-tight text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none sm:text-[28px]"
                />

                <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[#6B7280] tabular-nums">
                  {/* 1-Tap Section Outline Jump Popover */}
                  {orderedSections.length > 0 ? (
                    <div ref={outlinePopoverRef} className="relative">
                      <button
                        type="button"
                        onClick={() => setOutlineOpen((prev) => !prev)}
                        aria-expanded={outlineOpen}
                        aria-haspopup="menu"
                        title="Jump to any section in this story"
                        className={`-ml-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81] ${
                          outlineOpen
                            ? 'bg-[#EEF2FF] text-[#312E81]'
                            : 'text-[#4B5563] hover:bg-[#F3F4F6] hover:text-[#111827]'
                        }`}
                      >
                        <span>
                          {orderedSections.length}{' '}
                          {orderedSections.length === 1 ? 'section' : 'sections'}
                        </span>
                        <ChevronDown
                          className={`h-3 w-3 transition-transform duration-150 ${
                            outlineOpen ? 'rotate-180 text-[#312E81]' : 'text-[#9CA3AF]'
                          }`}
                          aria-hidden="true"
                        />
                      </button>

                      {outlineOpen && (
                        <div
                          role="menu"
                          aria-label="Story section outline"
                          className="absolute left-0 top-full z-30 mt-1.5 max-h-72 w-[min(320px,calc(100vw-40px))] overflow-y-auto rounded-xl border border-[#E5E7EB] bg-white py-1.5 shadow-[0_12px_32px_rgba(17,24,39,0.12)]"
                        >
                          <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-[#9CA3AF]">
                            Jump to section
                          </div>
                          {orderedSections.map((sec, idx) => {
                            const previewText = getSectionOutlinePreview(
                              getActiveSectionVersion(sec).text,
                            );
                            return (
                              <button
                                key={sec.id}
                                type="button"
                                role="menuitem"
                                onClick={() => handleJumpToSection(sec.id)}
                                className="flex w-full items-baseline gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[#F8F9FA]"
                              >
                                <span className="shrink-0 font-mono text-[11px] font-semibold text-[#312E81] tabular-nums">
                                  {String(idx + 1).padStart(2, '0')}
                                </span>
                                <span className="font-manuscript min-w-0 flex-1 truncate text-xs text-[#374151]">
                                  {previewText}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span>0 sections</span>
                  )}

                  <span aria-hidden="true">·</span>
                  <span>{totalCharacters.toLocaleString()} characters</span>
                  <span aria-hidden="true" className="text-[#D1D5DB]">
                    ·
                  </span>
                  <button
                    type="button"
                    onClick={() => setGlossaryOpen((prev) => !prev)}
                    aria-expanded={glossaryOpen}
                    className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81] ${
                      glossaryOpen
                        ? 'bg-[#EEF2FF] text-[#312E81]'
                        : glossaryEntryCount > 0
                          ? 'text-[#374151] hover:bg-[#F3F4F6] hover:text-[#111827]'
                          : 'text-[#6B7280] hover:bg-[#F3F4F6] hover:text-[#111827]'
                    }`}
                    title="Manage character names, places, and preferred spellings for this story"
                  >
                    <BookOpen className="h-3 w-3" aria-hidden="true" />
                    <span>Glossary</span>
                    {glossaryEntryCount > 0 && (
                      <span className="text-[11px] text-[#312E81]">({glossaryEntryCount})</span>
                    )}
                    <ChevronDown
                      className={`h-3 w-3 transition-transform duration-150 ${
                        glossaryOpen ? 'rotate-180' : ''
                      }`}
                      aria-hidden="true"
                    />
                  </button>
                  {sessionTokenStats.totalTokens > 0 && (
                    <>
                      <span aria-hidden="true" className="text-[#D1D5DB]">
                        ·
                      </span>
                      <span
                        className="text-[11px] text-[#9CA3AF]"
                        title="Cumulative Gemini token usage and estimated cost for this story session"
                      >
                        {formatSessionTokenSummary(
                          sessionTokenStats.totalTokens,
                          sessionTokenStats.totalCostUsd,
                        )}
                      </span>
                    </>
                  )}
                  {isSyncing && (
                    <span className="inline-flex items-center gap-1 text-[#312E81] sm:hidden">
                      <span aria-hidden="true">·</span>
                      <span>Syncing…</span>
                    </span>
                  )}
                </div>

                {/* Subtle collapsible Story Glossary panel */}
                {glossaryOpen && (
                  <div className="mt-3 rounded-xl border border-[#E5E7EB] bg-[#FAFAFB] px-3.5 py-3">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <label
                        htmlFor="story-glossary-input"
                        className="text-xs font-medium text-[#374151]"
                      >
                        Story Glossary &amp; Preferred Spellings
                      </label>
                      <span
                        className={`text-[11px] ${
                          glossarySaveStatus === 'saving'
                            ? 'text-[#312E81]'
                            : glossarySaveStatus === 'error'
                              ? 'text-[#DC2626]'
                              : 'text-[#9CA3AF]'
                        }`}
                      >
                        {glossarySaveStatus === 'saving'
                          ? 'Saving…'
                          : glossarySaveStatus === 'error'
                            ? 'Save failed'
                            : 'Saved'}
                      </span>
                    </div>
                    <p className="mb-2 text-[11px] leading-relaxed text-[#6B7280]">
                      List recurring character names, places, or Burmese/English spellings (one per
                      line or comma-separated). Automatically injected into Gemini transcription and
                      restyling prompts for this story.
                    </p>
                    <textarea
                      id="story-glossary-input"
                      value={glossaryDraft}
                      onChange={(e) => handleGlossaryInputChange(e.target.value)}
                      onBlur={handleGlossaryInputBlur}
                      rows={3}
                      maxLength={8000}
                      placeholder="e.g. ဦးမင်းသန့် (U Min Thant), မြစ်ကြီးနား, SarYay, အိပ်မက်"
                      className="font-manuscript block w-full resize-y rounded-lg border border-[#E5E7EB] bg-white px-3 py-2 text-base text-[#111827] placeholder:text-[#9CA3AF] focus:border-[#312E81] focus:outline-none sm:text-xs"
                    />
                  </div>
                )}
              </div>

              {/* Loading sections state */}
              {!sectionsLoaded && orderedSections.length === 0 ? (
                <div className="flex items-center gap-2 py-8 text-xs text-[#6B7280]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#312E81]" />
                  <span>Syncing sections…</span>
                </div>
              ) : orderedSections.length === 0 ? (
                <div className="border-t border-[#F3F4F6] py-12 text-center">
                  <p className="text-sm text-[#6B7280]">Your manuscript is ready.</p>
                  <p className="mt-1 text-xs text-[#9CA3AF]">
                    Use the dock below to start recording or upload an audio clip.
                  </p>
                </div>
              ) : (
                /* Manuscript Sections Stream */
                <div className="space-y-6 pb-8">
                  {orderedSections.map((section, idx) => (
                    <div
                      key={section.id}
                      data-section-id={section.id}
                      className="scroll-mt-6"
                    >
                      <SectionBlock
                        section={section}
                        index={idx}
                        activeModel={activeSession.defaultModel}
                        isReprocessing={reprocessingSectionId === section.id}
                        saveStatus={sectionSaveStatus[section.id] ?? 'saved'}
                        onUpdateContent={handleUpdateSectionContent}
                        onFlushContent={handleFlushSectionContent}
                        onSelectVersion={handleSelectSectionVersionSync}
                        onReprocessStyle={handleReprocessStyle}
                        onDeleteSection={handleRequestTrashSection}
                        onCopyText={handleCopySectionText}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </main>

        {/* Always-visible error banner anchored right above the Sticky Bottom Dock when a story is open */}
        {activeView === 'story' && activeSession && globalError && (
          <div className="shrink-0 bg-white px-3 pt-2 sm:px-6">
            <div
              role="alert"
              className="mx-auto flex max-w-3xl items-start justify-between gap-2.5 rounded-xl border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs text-[#991B1B]"
            >
              <div className="flex min-w-0 flex-1 items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" />
                <p className="min-w-0 flex-1 break-words leading-relaxed [overflow-wrap:anywhere]">
                  {globalError}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setGlobalError(null)}
                aria-label="Dismiss error"
                className="shrink-0 rounded p-0.5 text-[#991B1B] hover:bg-[#FEE2E2]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Sleek Sticky Bottom Dictation Dock anchored cleanly to bottom of viewport */}
        {activeView === 'story' && activeSession && (
          <DictationDock
            storyId={activeSession.id}
            storyTitle={titleDraft || activeSession.title}
            style={activeSession.defaultStyle}
            refinedEnding={activeRefinedEnding}
            model={activeSession.defaultModel}
            onStyleChange={(nextStyle) => {
              void handleStyleChange(nextStyle);
            }}
            onRefinedEndingChange={(nextEnding) => {
              void handleRefinedEndingChange(nextEnding);
            }}
            onModelChange={(nextModel) => {
              void handleModelChange(nextModel);
            }}
            onTranscribe={handleTranscribeAudio}
          />
        )}
      </div>

      {/* Mandatory Confirmation Dialog for Soft Delete & Delete Forever */}
      <ConfirmDialog
        open={Boolean(confirmDialogConfig)}
        title={confirmDialogConfig?.title ?? ''}
        message={confirmDialogConfig?.message ?? ''}
        confirmLabel={confirmDialogConfig?.confirmLabel ?? 'Confirm'}
        destructive={confirmDialogConfig?.destructive ?? true}
        busy={confirmBusy}
        onCancel={() => {
          if (!confirmBusy) setPendingConfirm(null);
        }}
        onConfirm={() => {
          void handleConfirmAction();
        }}
      />

      {/* Subtle transient confirmation toast */}
      {toastMessage && (
        <div
          role="status"
          aria-live="polite"
          className={`${
            activeView === 'story' && activeSession ? 'safe-toast-above-dock' : 'safe-toast-bottom'
          } fixed right-4 z-50 rounded-lg bg-[#111827] px-4 py-2.5 text-xs font-medium text-white shadow-sm sm:right-5`}
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
