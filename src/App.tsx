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
  deleteSectionInCloud,
  deleteStoryInCloud,
  downloadSectionAudioBlob,
  formatCloudErrorMessage,
  renameStoryInCloud,
  selectSectionVersionInCloud,
  subscribeToSections,
  subscribeToStories,
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

const LEGACY_SESSIONS_KEY = 'sarpay_studio_sessions_v1';
const MIGRATED_FLAG_KEY = 'sarpay_studio_cloud_migrated_v1';

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

  const [stories, setStories] = useState<StorySession[]>([]);
  const [storiesLoaded, setStoriesLoaded] = useState(false);
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
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [copiedFull, setCopiedFull] = useState(false);

  const toastTimeoutRef = useRef<number | null>(null);
  const bootstrappedRef = useRef<boolean>(false);

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

  // Keep refs updated
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
    setStoriesLoaded(false);

    const unsubscribe = subscribeToStories(
      uid,
      async (cloudStories) => {
        setStories(cloudStories);
        setStoriesLoaded(true);

        if (cloudStories.length === 0 && !bootstrappedRef.current) {
          bootstrappedRef.current = true;
          try {
            await trackSync(async () => {
              // One-time import of existing localStorage stories if present and not yet migrated
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

        if (cloudStories.length > 0) {
          setActiveSessionId((prevId) => {
            if (prevId && cloudStories.some((s) => s.id === prevId)) {
              return prevId;
            }
            return cloudStories[0].id;
          });
        }
      },
      (err) => {
        setStoriesLoaded(true);
        setGlobalError(formatCloudErrorMessage(err));
      },
    );

    return () => unsubscribe();
  }, [uid, showToast, trackSync]);

  // Real-time Firestore listener for active story's sections
  useEffect(() => {
    if (!activeSessionId) {
      setSections([]);
      setSectionsLoaded(true);
      return;
    }

    setSectionsLoaded(false);
    // Clear stale local drafts when switching stories
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
    () => stories.find((s) => s.id === activeSessionId) ?? stories[0] ?? null,
    [stories, activeSessionId],
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

      // Clear draft buffer once write starts (optimistically keep latest in Firestore snapshot)
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

  const handleDeleteSession = async (id: string) => {
    setGlobalError(null);
    try {
      await trackSync(() => deleteStoryInCloud(uid, id));
      showToast('Story deleted from cloud');
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
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

    // 1. Transcribe / polish via server-side Gemini API
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

    // 2. Upload original audio to Firebase Storage at users/{uid}/audio/{storyId}/{sectionId}.{ext}
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
      // Preserve audio locally in IndexedDB as fallback so the user never loses a recording
      fallbackAudioId = createId('audio');
      await saveAudioClip(fallbackAudioId, staged.blob, audioMeta).catch(() => undefined);
      setGlobalError(
        `Text synced to Firestore, but Firebase Storage audio upload failed (${formatCloudErrorMessage(uploadErr)}). A temporary local backup was saved on this device.`,
      );
    } finally {
      setIsUploadingAudio(false);
    }

    // 3. Save section + initial version history in Cloud Firestore
    const now = new Date().toISOString();
    const initialVersion: SectionVersion = {
      id: createId('ver'),
      text: result.text,
      style: targetStyle,
      refinedEnding: targetEnding,
      model: targetModel,
      mode,
      timestamp: now,
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
    // Flush any pending edits on the current version before switching
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
      let usedAudio = false;

      // 1. Prefer original audio stored in Firebase Storage (works from any device)
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
          usedAudio = true;
        }
      }

      // 2. Fallback to local IndexedDB audio if present
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
          usedAudio = true;
        }
      }

      // 3. Fallback to text restyling
      if (!usedAudio) {
        const result = await restyleTextApi({
          text: currentActiveText,
          style: targetStyle,
          refinedEnding: resolvedEnding,
          model: chosenModel,
          mode: sectionMode,
        });
        nextText = result.text;
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

  const handleDeleteSection = async (sectionId: string) => {
    if (!activeSession) return;
    setGlobalError(null);
    const target = sectionsRef.current.find((s) => s.id === sectionId);
    const nextSectionCount = Math.max(0, sectionsRef.current.length - 1);

    if (target?.audioId) {
      deleteAudioClip(target.audioId).catch(() => undefined);
    }

    try {
      await trackSync(() =>
        deleteSectionInCloud(
          uid,
          activeSession.id,
          sectionId,
          target?.storagePath,
          nextSectionCount,
        ),
      );
      showToast('Section deleted');
    } catch (err) {
      setGlobalError(formatCloudErrorMessage(err));
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

  if (!storiesLoaded || !activeSession) {
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
        sessions={stories}
        activeSessionId={activeSession.id}
        activeSectionCount={orderedSections.length}
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
          setGlobalError(null);
        }}
        onCreateSession={() => {
          void handleCreateSession();
        }}
        onRenameSession={(id, title) => {
          void handleRenameSession(id, title);
        }}
        onDeleteSession={(id) => {
          void handleDeleteSession(id);
        }}
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
                  <span className="hidden whitespace-nowrap font-semibold tracking-tight text-[#111827] sm:inline">
                    SarYay
                  </span>
                  <span aria-hidden="true" className="hidden text-[#D1D5DB] sm:inline">
                    /
                  </span>
                </>
              )}
              <span className="truncate font-medium text-[#374151]">
                {titleDraft || activeSession.title || 'Untitled Story'}
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

        {/* Scrollable editorial manuscript canvas */}
        <main className="flex-1 overflow-y-auto bg-white">
          <div className="mx-auto max-w-[780px] px-5 py-6 sm:px-10 sm:py-8">
            {/* Editable story title & minimal metadata */}
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

              <div className="mt-1.5 flex items-center gap-1.5 text-xs text-[#6B7280] tabular-nums">
                <span>
                  {orderedSections.length}{' '}
                  {orderedSections.length === 1 ? 'section' : 'sections'}
                </span>
                <span aria-hidden="true">·</span>
                <span>{totalCharacters.toLocaleString()} characters</span>
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

            {/* Global error banner (e.g., cloud sync, storage, or re-processing error) */}
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

            {/* Manuscript Sections Stream (oldest to newest as spoken, directly below recorder) */}
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
                    onDeleteSection={(secId) => {
                      void handleDeleteSection(secId);
                    }}
                    onCopyText={(txt) => copyToClipboard(txt, 'Section copied')}
                  />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

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
