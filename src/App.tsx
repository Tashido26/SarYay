import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertCircle,
  Check,
  Cloud,
  CloudUpload,
  Copy,
  FileDown,
  FileText,
  Loader2,
  LogOut,
  PanelLeft,
  X,
} from 'lucide-react';
import type {
  GeminiModel,
  ManuscriptSection,
  ProcessingMode,
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
  appendSectionVersionInCloud,
  createSectionInCloud,
  createStoryInCloud,
  downloadSectionAudioBlob,
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
  subscribeToSections,
  subscribeToStories,
  subscribeToTrashedSections,
  updateSectionContentInCloud,
  updateStoryModelInCloud,
  updateStoryRefinedEndingInCloud,
  updateStoryStyleInCloud,
  uploadSectionAudio,
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

  const [allStories, setAllStories] = useState<StorySession[]>([]);
  const [storiesLoaded, setStoriesLoaded] = useState(false);
  const [trashedSections, setTrashedSections] = useState<TrashedSection[]>([]);
  const [trashedSectionsLoaded, setTrashedSectionsLoaded] = useState(false);

  const [activeView, setActiveView] = useState<'story' | 'trash'>('story');
  const [activeSessionId, setActiveSessionId] = useState<string>(() => loadActiveSessionId(''));
  const [sections, setSections] = useState<ManuscriptSection[]>([]);
  const [sectionsLoaded, setSectionsLoaded] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      return false;
    }
    return loadSidebarOpen();
  });

  // Instant local editing buffers (debounced to Firestore)
  const [titleDraft, setTitleDraft] = useState<string>('');
  const titleDirtyRef = useRef<boolean>(false);
  const titleDebounceRef = useRef<number | null>(null);

  const [sectionDrafts, setSectionDrafts] = useState<Record<string, string>>({});
  const sectionDraftsRef = useRef<Record<string, string>>({});
  const sectionDebounceRefs = useRef<Record<string, number>>({});
  const sectionsRef = useRef<ManuscriptSection[]>([]);

  const [pendingSyncOps, setPendingSyncOps] = useState(0);
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);
  const [reprocessingSectionId, setReprocessingSectionId] = useState<string | null>(null);
  const [trashBusyItemId, setTrashBusyItemId] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmAction | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [copiedFull, setCopiedFull] = useState(false);

  const toastTimeoutRef = useRef<number | null>(null);
  const bootstrappedRef = useRef<boolean>(false);
  const initialPurgeRanRef = useRef<boolean>(false);

  const activeStories = useMemo(
    () => allStories.filter((s) => !s.isDeleted),
    [allStories],
  );
  const trashedStories = useMemo(
    () =>
      allStories
        .filter((s) => s.isDeleted)
        .sort(
          (a, b) =>
            Date.parse(b.deletedAt || b.updatedAt) - Date.parse(a.deletedAt || a.updatedAt),
        ),
    [allStories],
  );

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
      if (titleDebounceRef.current !== null) {
        window.clearTimeout(titleDebounceRef.current);
      }
      for (const timerId of Object.values(sectionDebounceRefs.current)) {
        window.clearTimeout(timerId);
      }
    };
  }, []);

  // Real-time Firestore listener for all stories under users/{uid}/stories
  useEffect(() => {
    bootstrappedRef.current = false;
    initialPurgeRanRef.current = false;
    setStoriesLoaded(false);

    const unsubscribe = subscribeToStories(
      uid,
      async (cloudStories) => {
        setAllStories(cloudStories);
        setStoriesLoaded(true);

        const nonDeleted = cloudStories.filter((s) => !s.isDeleted);

        if (cloudStories.length === 0 && !bootstrappedRef.current) {
          bootstrappedRef.current = true;
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

                      const legacySections = sortSectionsChronologically(
                        legacyStory.sections || [],
                      );
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
                await createStoryInCloud(uid, {
                  storyId: freshId,
                  title: 'Untitled Story',
                  defaultStyle: 'colloquial',
                  defaultRefinedEnding: 'colloquial',
                  defaultModel: 'gemini-2.5-flash',
                });
                setActiveSessionId(freshId);
              }
            });
          } catch (err) {
            setGlobalError(formatCloudErrorMessage(err));
          }
          return;
        }

        if (nonDeleted.length > 0) {
          setActiveSessionId((prevId) => {
            if (prevId && nonDeleted.some((s) => s.id === prevId)) {
              return prevId;
            }
            return nonDeleted[0].id;
          });
        } else {
          setActiveSessionId('');
        }
      },
      (err) => {
        setStoriesLoaded(true);
        setGlobalError(formatCloudErrorMessage(err));
      },
    );

    return () => unsubscribe();
  }, [uid, showToast, trackSync]);

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
    const allIds = new Set(allStories.map((s) => s.id));
    const purged = await purgeExpiredTrashInCloud(uid, trashedStories, trashedSections, allIds);
    if (purged > 0) {
      showToast(
        `Auto-cleaned ${purged} expired Trash ${purged === 1 ? 'item' : 'items'} (> 30 days)`,
      );
    }
  }, [uid, allStories, trashedStories, trashedSections, showToast]);

  // Run automatic 30-day cleanup on initial app load once Trash data arrives
  useEffect(() => {
    if (!storiesLoaded || !trashedSectionsLoaded) return;
    if (initialPurgeRanRef.current) return;
    initialPurgeRanRef.current = true;
    void runExpiredTrashCleanup();
  }, [storiesLoaded, trashedSectionsLoaded, runExpiredTrashCleanup]);

  // Also run automatic 30-day cleanup whenever the user opens the Trash view
  useEffect(() => {
    if (activeView === 'trash' && storiesLoaded && trashedSectionsLoaded) {
      void runExpiredTrashCleanup();
    }
  }, [activeView, storiesLoaded, trashedSectionsLoaded, runExpiredTrashCleanup]);

  // Real-time Firestore listener for active story's active (non-deleted) sections
  useEffect(() => {
    if (!activeSessionId) {
      setSections([]);
      setSectionsLoaded(true);
      return;
    }

    setSectionsLoaded(false);
    for (const timerId of Object.values(sectionDebounceRefs.current)) {
      window.clearTimeout(timerId);
    }
    sectionDebounceRefs.current = {};
    setSectionDrafts({});

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
  }, [uid, activeSessionId]);

  const activeSession = useMemo(
    () => activeStories.find((s) => s.id === activeSessionId) ?? activeStories[0] ?? null,
    [activeStories, activeSessionId],
  );

  // Sync local title input with remote Firestore title when not actively editing
  useEffect(() => {
    if (!activeSession) return;
    if (!titleDirtyRef.current) {
      setTitleDraft(activeSession.title);
    }
  }, [activeSession?.id, activeSession?.title]);

  // Merge any in-flight local typing drafts into displayed sections
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
    async (sectionId: string) => {
      const pendingTimer = sectionDebounceRefs.current[sectionId];
      if (pendingTimer !== undefined) {
        window.clearTimeout(pendingTimer);
        delete sectionDebounceRefs.current[sectionId];
      }

      const draftText = sectionDraftsRef.current[sectionId];
      if (draftText === undefined || !activeSessionId) return;

      const targetSection = sectionsRef.current.find((s) => s.id === sectionId);
      if (!targetSection) return;

      const now = new Date().toISOString();
      const versions = getSectionVersions(targetSection);
      const activeIdx = getActiveVersionIndex(targetSection);
      const updatedVersions = versions.map((v, idx) =>
        idx === activeIdx ? { ...v, text: draftText, timestamp: now } : v,
      );

      setSectionDrafts((prev) => {
        if (prev[sectionId] !== draftText) return prev;
        const copy = { ...prev };
        delete copy[sectionId];
        return copy;
      });

      try {
        await trackSync(() =>
          updateSectionContentInCloud(uid, activeSessionId, sectionId, draftText, updatedVersions),
        );
      } catch (err) {
        setGlobalError(formatCloudErrorMessage(err));
      }
    },
    [uid, activeSessionId, trackSync],
  );

  const handleCreateSession = async () => {
    setGlobalError(null);
    const freshId = createId('story');
    try {
      await trackSync(() =>
        createStoryInCloud(uid, {
          storyId: freshId,
          title: 'Untitled Story',
          defaultStyle: activeSession?.defaultStyle ?? 'colloquial',
          defaultRefinedEnding: activeSession?.defaultRefinedEnding ?? 'colloquial',
          defaultModel: activeSession?.defaultModel ?? 'gemini-2.5-flash',
        }),
      );
      titleDirtyRef.current = false;
      setActiveSessionId(freshId);
      setActiveView('story');
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
    }
  };

  const handleRenameSession = async (id: string, title: string) => {
    setGlobalError(null);
    const clean = title.trim() || 'Untitled Story';
    try {
      await trackSync(() => renameStoryInCloud(uid, id, clean));
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
    }
  };

  const handleTitleInputChange = (nextTitle: string) => {
    if (!activeSession) return;
    titleDirtyRef.current = true;
    setTitleDraft(nextTitle);

    if (titleDebounceRef.current !== null) {
      window.clearTimeout(titleDebounceRef.current);
    }
    const targetStoryId = activeSession.id;
    titleDebounceRef.current = window.setTimeout(() => {
      titleDebounceRef.current = null;
      titleDirtyRef.current = false;
      void handleRenameSession(targetStoryId, nextTitle);
    }, 550);
  };

  const handleTitleInputBlur = () => {
    if (!activeSession) return;
    if (titleDebounceRef.current !== null) {
      window.clearTimeout(titleDebounceRef.current);
      titleDebounceRef.current = null;
    }
    const clean = titleDraft.trim() || 'Untitled Story';
    setTitleDraft(clean);
    if (titleDirtyRef.current || clean !== activeSession.title) {
      titleDirtyRef.current = false;
      void handleRenameSession(activeSession.id, clean);
    }
  };

  // Mandatory confirmation triggers (never delete immediately!)
  const handleRequestTrashStory = (storyId: string) => {
    const story = activeStories.find((s) => s.id === storyId);
    if (!story) return;
    setPendingConfirm({ kind: 'trash_story', story });
  };

  const handleRequestTrashSection = (sectionId: string) => {
    const section = sectionsRef.current.find((s) => s.id === sectionId);
    if (!section) return;
    setPendingConfirm({ kind: 'trash_section', section });
  };

  const handleConfirmAction = async () => {
    if (!pendingConfirm || confirmBusy) return;
    setConfirmBusy(true);
    setGlobalError(null);

    try {
      if (pendingConfirm.kind === 'trash_story') {
        await trackSync(() => moveStoryToTrashInCloud(uid, pendingConfirm.story.id));
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
        setTrashBusyItemId(pendingConfirm.story.id);
        await trackSync(() => permanentlyDeleteStoryInCloud(uid, pendingConfirm.story.id));
        showToast('Story permanently deleted');
      } else if (pendingConfirm.kind === 'delete_section_forever') {
        setTrashBusyItemId(pendingConfirm.section.id);
        const parentExists = allStories.some((s) => s.id === pendingConfirm.section.parentStoryId);
        if (pendingConfirm.section.audioId) {
          deleteAudioClip(pendingConfirm.section.audioId).catch(() => undefined);
        }
        await trackSync(() =>
          permanentlyDeleteSectionFromTrashInCloud(uid, pendingConfirm.section, parentExists),
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
      setActiveSessionId(story.id);
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
        restoreSectionFromTrashInCloud(uid, trashed, allStories),
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

    // 1. Transcribe / polish via server-side Gemini API (returns text + exact usageMetadata)
    const result = await transcribeAudioApi({
      blob: staged.blob,
      filename: staged.filename,
      style: targetStyle,
      refinedEnding: targetEnding,
      model: targetModel,
      mode,
      signal,
    });

    const sectionId = createId('sec');
    const audioMeta = {
      filename: staged.filename,
      mimeType: staged.mimeType,
      durationSec: staged.durationSec,
      sizeBytes: staged.sizeBytes,
    };

    // 2. Upload original audio to Firebase Storage
    let audioUrl: string | undefined;
    let storagePath: string | undefined;
    let fallbackAudioId: string | undefined;

    setIsUploadingAudio(true);
    try {
      const uploaded = await uploadSectionAudio({
        uid,
        storyId: targetStoryId,
        sectionId,
        blob: staged.blob,
        mimeType: staged.mimeType,
        filename: staged.filename,
      });
      audioUrl = uploaded.audioUrl;
      storagePath = uploaded.storagePath;
    } catch (uploadErr) {
      fallbackAudioId = createId('audio');
      await saveAudioClip(fallbackAudioId, staged.blob, audioMeta).catch(() => undefined);
      setGlobalError(
        `Text synced to Firestore, but Firebase Storage audio upload failed (${formatCloudErrorMessage(uploadErr)}). A temporary local backup was saved on this device.`,
      );
    } finally {
      setIsUploadingAudio(false);
    }

    // 3. Save section + initial version history + token usage in Cloud Firestore
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
    await trackSync(() =>
      createSectionInCloud(uid, targetStoryId, {
        sectionId,
        order: Date.now(),
        initialVersion,
        audioUrl,
        storagePath,
        audioId: fallbackAudioId,
        audioMeta,
        nextSectionCount,
      }),
    );

    const styleDesc = formatCompactStyleLabel(targetStyle, targetEnding);
    showToast(
      mode === 'summarize_structure'
        ? `Structured summary synced (${styleDesc})`
        : `Section synced (${styleDesc})`,
    );
  };

  const handleUpdateSectionContent = (sectionId: string, nextContent: string) => {
    setSectionDrafts((prev) => ({ ...prev, [sectionId]: nextContent }));
    sectionDraftsRef.current = { ...sectionDraftsRef.current, [sectionId]: nextContent };

    const existingTimer = sectionDebounceRefs.current[sectionId];
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }
    sectionDebounceRefs.current[sectionId] = window.setTimeout(() => {
      void flushSectionDraft(sectionId);
    }, 650);
  };

  const handleSelectSectionVersion = async (sectionId: string, versionIndex: number) => {
    if (!activeSession) return;
    await flushSectionDraft(sectionId);

    const target = sectionsRef.current.find((s) => s.id === sectionId);
    if (!target) return;
    const versions = getSectionVersions(target);
    const clamped = Math.max(0, Math.min(versionIndex, versions.length - 1));
    const selected = versions[clamped];

    setGlobalError(null);
    try {
      await trackSync(() =>
        selectSectionVersionInCloud(uid, activeSession.id, sectionId, selected, clamped),
      );
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
    }
  };

  const handleReprocessStyle = async (
    section: ManuscriptSection,
    targetStyle: WritingStyle,
    targetEnding?: VoiceEnding,
  ) => {
    if (!activeSession || reprocessingSectionId) return;
    await flushSectionDraft(section.id);

    setGlobalError(null);
    setReprocessingSectionId(section.id);
    const chosenModel = activeSession.defaultModel;
    const sectionMode: ProcessingMode = section.mode ?? 'full_polish';
    const resolvedEnding: VoiceEnding = targetEnding ?? activeRefinedEnding;
    const currentActiveText = getActiveSectionVersion(section).text;

    try {
      let nextText = '';
      let nextUsage = undefined;
      let usedAudio = false;

      if (section.storagePath || section.audioUrl) {
        const cloudBlob = await downloadSectionAudioBlob(section.storagePath, section.audioUrl);
        if (cloudBlob) {
          const result = await transcribeAudioApi({
            blob: cloudBlob,
            filename: section.audioMeta?.filename || 'recording.webm',
            style: targetStyle,
            refinedEnding: resolvedEnding,
            model: chosenModel,
            mode: sectionMode,
          });
          nextText = result.text;
          nextUsage = result.usage;
          usedAudio = true;
        }
      }

      if (!usedAudio && section.audioId) {
        const stored = await getAudioClip(section.audioId);
        if (stored?.blob) {
          const result = await transcribeAudioApi({
            blob: stored.blob,
            filename: stored.meta.filename,
            style: targetStyle,
            refinedEnding: resolvedEnding,
            model: chosenModel,
            mode: sectionMode,
          });
          nextText = result.text;
          nextUsage = result.usage;
          usedAudio = true;
        }
      }

      if (!usedAudio) {
        const result = await restyleTextApi({
          text: currentActiveText,
          style: targetStyle,
          refinedEnding: resolvedEnding,
          model: chosenModel,
          mode: sectionMode,
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
        mode: sectionMode,
        timestamp: now,
        usage: nextUsage,
      };

      const existingVersions = getSectionVersions(section);
      const nextVersions = [...existingVersions, nextVersion];

      await trackSync(() =>
        appendSectionVersionInCloud(uid, activeSession.id, section.id, nextVersions),
      );

      const styleDesc = formatCompactStyleLabel(targetStyle, resolvedEnding);
      showToast(`Saved as v${nextVersions.length} (${styleDesc})`);
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
    } finally {
      setReprocessingSectionId(null);
    }
  };

  const copyToClipboard = async (text: string, label = 'Copied to clipboard') => {
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
  };

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

  const isSyncing = pendingSyncOps > 0 || Object.keys(sectionDrafts).length > 0;

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
      <div className="flex h-screen w-full flex-col items-center justify-center bg-white px-6 text-[#111827]">
        <div className="flex flex-col items-center gap-3 text-center">
          <Loader2 className="h-5 w-5 animate-spin text-[#4338CA]" aria-hidden="true" />
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
    <div className="flex h-screen w-full overflow-hidden bg-white text-[#111827]">
      <Sidebar
        sessions={activeStories}
        activeSessionId={activeSession?.id ?? ''}
        activeSectionCount={orderedSections.length}
        activeView={activeView}
        trashCount={trashCount}
        isOpen={sidebarOpen}
        userEmail={user.email}
        onSignOut={() => {
          onSignOut().catch(() => undefined);
        }}
        onCloseMobile={() => setSidebarOpen(false)}
        onToggleDesktop={() => setSidebarOpen((prev) => !prev)}
        onSelectSession={(id) => {
          titleDirtyRef.current = false;
          setActiveSessionId(id);
          setActiveView('story');
          setGlobalError(null);
        }}
        onSelectTrash={() => {
          setActiveView('trash');
          setGlobalError(null);
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
        {/* Top document utility bar */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[#E5E7EB] bg-white px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {!sidebarOpen && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Open sidebar"
                title="Open stories sidebar"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[#4B5563] transition-colors duration-150 hover:bg-[#F3F4F6] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA]"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
            )}

            <div className="flex min-w-0 items-center gap-2 text-sm">
              {!sidebarOpen && (
                <>
                  <div className="inline-flex shrink-0 items-center gap-2">
                    <img
                      src={BRAND_LOGO_URL}
                      alt="SarYay"
                      width={32}
                      height={32}
                      className="h-8 w-8 shrink-0 rounded-full border border-[#E5E7EB] bg-white object-cover"
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
              <span className="truncate font-medium text-[#374151]">
                {activeView === 'trash'
                  ? 'Trash'
                  : titleDraft || activeSession?.title || 'Untitled Story'}
              </span>

              {/* Minimal Cloud Sync / Upload Indicator */}
              <span
                className={`ml-1 hidden shrink-0 items-center gap-1 text-[11px] sm:inline-flex ${
                  isUploadingAudio
                    ? 'font-medium text-[#4338CA]'
                    : isSyncing
                      ? 'text-[#6B7280]'
                      : 'text-[#9CA3AF]'
                }`}
                aria-live="polite"
              >
                {isUploadingAudio ? (
                  <>
                    <CloudUpload className="h-3.5 w-3.5 animate-pulse" />
                    <span>Uploading audio…</span>
                  </>
                ) : isSyncing ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>Syncing…</span>
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

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {activeView === 'story' && activeSession && (
              <>
                <button
                  type="button"
                  disabled={!hasContent}
                  onClick={handleCopyFullStory}
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-3 py-1.5 text-xs font-medium text-[#374151] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {copiedFull ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-[#16A34A]" />
                      <span className="text-[#16A34A]">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Copy Full Story</span>
                      <span className="sm:hidden">Copy</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  disabled={!hasContent}
                  onClick={handleExportTxt}
                  title="Export full story as plain text (.txt)"
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-3 py-1.5 text-xs font-medium text-[#374151] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <FileText className="h-3.5 w-3.5" />
                  <span>.txt</span>
                </button>

                <button
                  type="button"
                  disabled={!hasContent}
                  onClick={handleExportMd}
                  title="Export full session sequentially as Markdown (.md)"
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-3 py-1.5 text-xs font-medium text-[#374151] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <FileDown className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Export as .md</span>
                  <span className="sm:hidden">.md</span>
                </button>
              </>
            )}

            {!sidebarOpen && (
              <button
                type="button"
                onClick={() => {
                  onSignOut().catch(() => undefined);
                }}
                title={`Sign out (${user.email ?? 'Account'})`}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-2.5 py-1.5 text-xs font-medium text-[#6B7280] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA]"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span className="hidden md:inline">Sign Out</span>
              </button>
            )}
          </div>
        </header>

        {/* Scrollable main canvas (either Trash Bin view or active Story workspace) */}
        <main className="flex-1 overflow-y-auto bg-white">
          {globalError && activeView === 'trash' && (
            <div className="mx-auto max-w-[780px] px-5 pt-6 sm:px-10">
              <div
                role="alert"
                className="flex items-start justify-between gap-3 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-xs text-[#991B1B]"
              >
                <div className="flex items-start gap-2.5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" />
                  <p className="leading-relaxed">{globalError}</p>
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
              <p className="text-sm font-medium text-[#374151]">No active stories</p>
              <p className="mt-1 text-xs text-[#6B7280]">
                Start a new story or restore a deleted story from Trash.
              </p>
              <div className="mt-5 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void handleCreateSession();
                  }}
                  className="rounded-lg bg-[#4338CA] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#3730A3]"
                >
                  New Story
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

                <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-[#6B7280] tabular-nums">
                  <span>
                    {orderedSections.length}{' '}
                    {orderedSections.length === 1 ? 'section' : 'sections'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{totalCharacters.toLocaleString()} characters</span>
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
                  {(isUploadingAudio || isSyncing) && (
                    <span className="inline-flex items-center gap-1 text-[#4338CA] sm:hidden">
                      <span aria-hidden="true">·</span>
                      <span>{isUploadingAudio ? 'Uploading audio…' : 'Syncing…'}</span>
                    </span>
                  )}
                </div>
              </div>

              {/* Compact Dictation & Upload Bar */}
              <div className="mb-7">
                <DictationDock
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
              </div>

              {/* Global error banner */}
              {globalError && (
                <div
                  role="alert"
                  className="mb-6 flex items-start justify-between gap-3 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-xs text-[#991B1B]"
                >
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" />
                    <p className="leading-relaxed">{globalError}</p>
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
              )}

              {/* Loading sections state */}
              {!sectionsLoaded && orderedSections.length === 0 ? (
                <div className="flex items-center gap-2 py-8 text-xs text-[#6B7280]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#4338CA]" />
                  <span>Syncing sections…</span>
                </div>
              ) : null}

              {/* Manuscript Sections Stream */}
              {orderedSections.length > 0 && (
                <div className="space-y-6 pb-16">
                  {orderedSections.map((section, idx) => (
                    <SectionBlock
                      key={section.id}
                      section={section}
                      index={idx}
                      activeModel={activeSession.defaultModel}
                      isReprocessing={reprocessingSectionId === section.id}
                      onUpdateContent={handleUpdateSectionContent}
                      onFlushContent={(secId) => {
                        void flushSectionDraft(secId);
                      }}
                      onSelectVersion={(secId, versionIdx) => {
                        void handleSelectSectionVersion(secId, versionIdx);
                      }}
                      onReprocessStyle={handleReprocessStyle}
                      onDeleteSection={handleRequestTrashSection}
                      onCopyText={(txt) => copyToClipboard(txt, 'Section copied')}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </main>
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
          className="fixed bottom-5 right-5 z-50 rounded-lg bg-[#111827] px-4 py-2.5 text-xs font-medium text-white shadow-sm"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
