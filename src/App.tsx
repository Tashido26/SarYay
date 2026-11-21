import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  FileDown,
  FileText,
  Mic,
  PanelLeft,
  X,
} from 'lucide-react';
import type {
  GeminiModel,
  ManuscriptSection,
  ProcessingMode,
  StagedAudio,
  StorySession,
  WritingStyle,
} from './types.ts';
import { MODEL_LABELS, STYLE_LABELS } from './types.ts';
import { deleteAudioClip, deleteAudioClips, getAudioClip, saveAudioClip } from './lib/audioDb.ts';
import { restyleTextApi, transcribeAudioApi } from './lib/api.ts';
import {
  compileFullStoryMarkdown,
  compileFullStoryPlainText,
  countCharacters,
  safeExportFilename,
  triggerBlobDownload,
} from './lib/format.ts';
import {
  createId,
  createNewSession,
  loadActiveSessionId,
  loadSessions,
  loadSidebarOpen,
  saveActiveSessionId,
  saveSessions,
  saveSidebarOpen,
} from './lib/storage.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { DictationDock } from './components/DictationDock.tsx';
import { SectionBlock } from './components/SectionBlock.tsx';

export default function App() {
  const [sessions, setSessions] = useState<StorySession[]>(() => loadSessions());
  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    const initial = loadSessions();
    const savedId = loadActiveSessionId(initial[0].id);
    return initial.some((s) => s.id === savedId) ? savedId : initial[0].id;
  });
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      return false;
    }
    return loadSidebarOpen();
  });

  const [reprocessingSectionId, setReprocessingSectionId] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [copiedFull, setCopiedFull] = useState(false);

  const toastTimeoutRef = useRef<number | null>(null);
  const dockAnchorRef = useRef<HTMLDivElement | null>(null);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimeoutRef.current !== null) {
      window.clearTimeout(toastTimeoutRef.current);
    }
    toastTimeoutRef.current = window.setTimeout(() => {
      setToastMessage(null);
    }, 2600);
  }, []);

  useEffect(() => {
    saveSessions(sessions);
  }, [sessions]);

  useEffect(() => {
    saveActiveSessionId(activeSessionId);
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
    };
  }, []);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? sessions[0],
    [sessions, activeSessionId],
  );

  const updateActiveSession = useCallback(
    (updater: (session: StorySession) => StorySession) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === activeSession.id
            ? { ...updater(session), updatedAt: new Date().toISOString() }
            : session,
        ),
      );
    },
    [activeSession.id],
  );

  const handleCreateSession = () => {
    const next = createNewSession(
      activeSession.defaultStyle,
      activeSession.defaultModel,
      'Untitled Story',
    );
    setSessions((prev) => [next, ...prev]);
    setActiveSessionId(next.id);
    setGlobalError(null);
  };

  const handleRenameSession = (id: string, title: string) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, title, updatedAt: new Date().toISOString() } : s,
      ),
    );
  };

  const handleDeleteSession = (id: string) => {
    const target = sessions.find((s) => s.id === id);
    if (target) {
      const audioIds = target.sections
        .map((sec) => sec.audioId)
        .filter((aid): aid is string => Boolean(aid));
      deleteAudioClips(audioIds).catch(() => undefined);
    }

    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      if (remaining.length === 0) {
        const fresh = createNewSession();
        setActiveSessionId(fresh.id);
        return [fresh];
      }
      if (id === activeSessionId) {
        setActiveSessionId(remaining[0].id);
      }
      return remaining;
    });
    showToast('Story deleted');
  };

  const handleStyleChange = (style: WritingStyle) => {
    updateActiveSession((session) => ({ ...session, defaultStyle: style }));
  };

  const handleModelChange = (model: GeminiModel) => {
    updateActiveSession((session) => ({ ...session, defaultModel: model }));
  };

  const handleTranscribeAudio = async (
    staged: StagedAudio,
    mode: ProcessingMode,
    signal: AbortSignal,
  ) => {
    setGlobalError(null);
    const targetStyle = activeSession.defaultStyle;
    const targetModel = activeSession.defaultModel;

    const result = await transcribeAudioApi({
      blob: staged.blob,
      filename: staged.filename,
      style: targetStyle,
      model: targetModel,
      mode,
      signal,
    });

    const audioId = createId('audio');
    const audioMeta = {
      filename: staged.filename,
      mimeType: staged.mimeType,
      durationSec: staged.durationSec,
      sizeBytes: staged.sizeBytes,
    };

    // Persist original audio locally in IndexedDB for replay, backup download, and future re-processing
    await saveAudioClip(audioId, staged.blob, audioMeta);

    const now = new Date().toISOString();
    const newSection: ManuscriptSection = {
      id: createId('sec'),
      content: result.text,
      style: targetStyle,
      model: targetModel,
      mode,
      audioId,
      audioMeta,
      createdAt: now,
      updatedAt: now,
    };

    updateActiveSession((session) => ({
      ...session,
      sections: [...session.sections, newSection],
    }));

    showToast(
      mode === 'summarize_structure'
        ? `Structured summary added (${STYLE_LABELS[targetStyle]})`
        : `Section added (${STYLE_LABELS[targetStyle]})`,
    );
  };

  const handleUpdateSectionContent = (sectionId: string, nextContent: string) => {
    const now = new Date().toISOString();
    updateActiveSession((session) => ({
      ...session,
      sections: session.sections.map((sec) =>
        sec.id === sectionId ? { ...sec, content: nextContent, updatedAt: now } : sec,
      ),
    }));
  };

  const handleReprocessStyle = async (section: ManuscriptSection, targetStyle: WritingStyle) => {
    if (reprocessingSectionId) return;
    setGlobalError(null);
    setReprocessingSectionId(section.id);
    const chosenModel = activeSession.defaultModel;
    const sectionMode: ProcessingMode = section.mode ?? 'full_polish';

    try {
      let nextText = '';
      let usedAudio = false;

      if (section.audioId) {
        const stored = await getAudioClip(section.audioId);
        if (stored?.blob) {
          const result = await transcribeAudioApi({
            blob: stored.blob,
            filename: stored.meta.filename,
            style: targetStyle,
            model: chosenModel,
            mode: sectionMode,
          });
          nextText = result.text;
          usedAudio = true;
        }
      }

      if (!usedAudio) {
        const result = await restyleTextApi({
          text: section.content,
          style: targetStyle,
          model: chosenModel,
          mode: sectionMode,
        });
        nextText = result.text;
      }

      const now = new Date().toISOString();
      updateActiveSession((session) => ({
        ...session,
        sections: session.sections.map((sec) =>
          sec.id === section.id
            ? {
                ...sec,
                content: nextText,
                style: targetStyle,
                model: chosenModel,
                updatedAt: now,
              }
            : sec,
        ),
      }));

      showToast(
        usedAudio
          ? `Re-transcribed from audio in ${STYLE_LABELS[targetStyle]}`
          : `Converted to ${STYLE_LABELS[targetStyle]}`,
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Could not re-process this section. Please try again.';
      setGlobalError(msg);
    } finally {
      setReprocessingSectionId(null);
    }
  };

  const handleDeleteSection = (sectionId: string) => {
    const target = activeSession.sections.find((s) => s.id === sectionId);
    if (target?.audioId) {
      deleteAudioClip(target.audioId).catch(() => undefined);
    }
    updateActiveSession((session) => ({
      ...session,
      sections: session.sections.filter((s) => s.id !== sectionId),
    }));
    showToast('Section deleted');
  };

  const copyToClipboard = async (text: string, label = 'Copied to clipboard') => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(label);
    } catch {
      // Fallback copy method inside restricted iframes
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

  const handleCopyFullStory = async () => {
    const fullText = compileFullStoryPlainText(activeSession);
    if (!fullText) return;
    await copyToClipboard(fullText, 'Full story copied');
    setCopiedFull(true);
    window.setTimeout(() => setCopiedFull(false), 1800);
  };

  const handleExportTxt = () => {
    const content = compileFullStoryPlainText(activeSession);
    if (!content) return;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    triggerBlobDownload(blob, safeExportFilename(activeSession.title, 'txt'));
    showToast('Exported as .txt');
  };

  const handleExportMd = () => {
    const content = compileFullStoryMarkdown(activeSession);
    if (!content) return;
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    triggerBlobDownload(blob, safeExportFilename(activeSession.title, 'md'));
    showToast('Exported as .md');
  };

  const totalCharacters = useMemo(
    () => activeSession.sections.reduce((acc, s) => acc + countCharacters(s.content), 0),
    [activeSession.sections],
  );

  const hasContent = activeSession.sections.some((s) => s.content.trim().length > 0);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white text-[#111827]">
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSession.id}
        isOpen={sidebarOpen}
        onCloseMobile={() => setSidebarOpen(false)}
        onToggleDesktop={() => setSidebarOpen((prev) => !prev)}
        onSelectSession={(id) => {
          setActiveSessionId(id);
          setGlobalError(null);
        }}
        onCreateSession={handleCreateSession}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
      />

      {/* Main editorial column */}
      <div className="flex min-w-0 flex-1 flex-col bg-white">
        {/* Top document utility bar */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[#E5E7EB] bg-white px-4 sm:px-6">
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

            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm">
                {!sidebarOpen && (
                  <>
                    <span className="hidden font-semibold tracking-tight text-[#111827] sm:inline whitespace-nowrap">
                      Sarpay Studio
                    </span>
                    <span aria-hidden="true" className="hidden text-[#D1D5DB] sm:inline">/</span>
                  </>
                )}
                <span className="truncate font-medium text-[#374151]">
                  {activeSession.title || 'Untitled Story'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {activeSession.sections.length >= 2 && (
              <button
                type="button"
                onClick={() =>
                  dockAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }
                className="hidden items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium text-[#4338CA] transition-colors duration-150 hover:bg-[#EEF2FF] md:inline-flex"
              >
                <Mic className="h-3.5 w-3.5" />
                <span>New Recording</span>
              </button>
            )}

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
              title="Export full story as Markdown (.md)"
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-3 py-1.5 text-xs font-medium text-[#374151] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <FileDown className="h-3.5 w-3.5" />
              <span>.md</span>
            </button>
          </div>
        </header>

        {/* Scrollable editorial manuscript canvas */}
        <main className="flex-1 overflow-y-auto bg-white">
          <div className="mx-auto max-w-[780px] px-5 py-8 sm:px-10 sm:py-12">
            {/* Editable story title & quiet unboxed metadata */}
            <div className="mb-8">
              <input
                type="text"
                value={activeSession.title}
                onChange={(e) =>
                  handleRenameSession(activeSession.id, e.target.value)
                }
                onBlur={(e) => {
                  if (!e.target.value.trim()) {
                    handleRenameSession(activeSession.id, 'Untitled Story');
                  }
                }}
                placeholder="Untitled Story"
                aria-label="Story title"
                className="font-manuscript w-full border-0 bg-transparent p-0 text-2xl font-semibold tracking-tight text-[#111827] placeholder:text-[#9CA3AF] focus:outline-none sm:text-[30px]"
              />

              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#6B7280] tabular-nums">
                <span>
                  {activeSession.sections.length}{' '}
                  {activeSession.sections.length === 1 ? 'section' : 'sections'}
                </span>
                <span aria-hidden="true">·</span>
                <span>{totalCharacters.toLocaleString()} characters</span>
                <span aria-hidden="true">·</span>
                <span>Default: {STYLE_LABELS[activeSession.defaultStyle]}</span>
                <span aria-hidden="true">·</span>
                <span>{MODEL_LABELS[activeSession.defaultModel]}</span>
              </div>
            </div>

            {/* Global error banner (e.g., re-processing error) */}
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

            {/* Manuscript Sections Stream */}
            {activeSession.sections.length > 0 && (
              <div className="mb-10 space-y-6">
                {activeSession.sections.map((section, idx) => (
                  <SectionBlock
                    key={section.id}
                    section={section}
                    index={idx}
                    activeModel={activeSession.defaultModel}
                    isReprocessing={reprocessingSectionId === section.id}
                    onUpdateContent={handleUpdateSectionContent}
                    onReprocessStyle={handleReprocessStyle}
                    onDeleteSection={handleDeleteSection}
                    onCopyText={(txt) => copyToClipboard(txt, 'Section copied')}
                  />
                ))}
              </div>
            )}

            {/* Dictation & Upload Studio Dock */}
            <div ref={dockAnchorRef} className="pb-16">
              <DictationDock
                storyTitle={activeSession.title}
                style={activeSession.defaultStyle}
                model={activeSession.defaultModel}
                onStyleChange={handleStyleChange}
                onModelChange={handleModelChange}
                onTranscribe={handleTranscribeAudio}
                hasSections={activeSession.sections.length > 0}
              />

              {/* Subtle guidance when story is empty */}
              {activeSession.sections.length === 0 && (
                <div className="mt-8 grid gap-6 border-t border-[#F3F4F6] pt-7 sm:grid-cols-3">
                  <div>
                    <h3 className="text-xs font-semibold text-[#111827]">No silence cutoffs</h3>
                    <p className="mt-1 text-xs leading-relaxed text-[#6B7280]">
                      Pause for 10 or 30 seconds mid-sentence to gather your thoughts—capture stays active until you press Stop.
                    </p>
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-[#111827]">Faithful literary polish</h3>
                    <p className="mt-1 text-xs leading-relaxed text-[#6B7280]">
                      Removes spoken fillers and fixes Burmese spelling and punctuation without summarizing or omitting any scene.
                    </p>
                  </div>
                  <div>
                    <h3 className="text-xs font-semibold text-[#111827]">Local audio safety</h3>
                    <p className="mt-1 text-xs leading-relaxed text-[#6B7280]">
                      Every clip stays saved in your browser for playback, backup download, and one-click style re-processing.
                    </p>
                  </div>
                </div>
              )}
            </div>
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
