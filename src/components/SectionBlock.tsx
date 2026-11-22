import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Headphones,
  Loader2,
  RefreshCw,
  SpellCheck,
  Trash2,
} from 'lucide-react';
import type {
  GeminiModel,
  ManuscriptSection,
  ProcessingMode,
  ReprocessSource,
  SectionSaveStatus,
  VoiceEnding,
  WritingStyle,
} from '../types.ts';
import {
  MODEL_LABELS,
  MODEL_SHORT_LABELS,
  formatCompactStyleLabel,
  getActiveVersionIndex,
  getSectionVersions,
} from '../types.ts';
import { hasAudioClip } from '../lib/audioDb.ts';
import {
  formatDuration,
  formatTimestamp,
  formatTokenUsageCompact,
} from '../lib/format.ts';
import { AudioPlayerBar } from './AudioPlayerBar.tsx';

interface ReprocessOption {
  label: string;
  style: WritingStyle;
  refinedEnding?: VoiceEnding;
}

const REPROCESS_OPTIONS: ReprocessOption[] = [
  { label: 'Colloquial', style: 'colloquial' },
  { label: 'Literary', style: 'literary' },
  { label: 'Refined Flow · Colloquial', style: 'refined_flow', refinedEnding: 'colloquial' },
  { label: 'Refined Flow · Literary', style: 'refined_flow', refinedEnding: 'literary' },
];

function getCaretOffsetFromPoint(
  container: HTMLElement,
  clientX: number,
  clientY: number,
  maxLength: number,
): number | null {
  if (typeof document === 'undefined') return null;
  try {
    let targetNode: Node | null = null;
    let targetOffset = 0;

    const docWithCaret = document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };

    if (typeof docWithCaret.caretRangeFromPoint === 'function') {
      const range = docWithCaret.caretRangeFromPoint(clientX, clientY);
      if (range) {
        targetNode = range.startContainer;
        targetOffset = range.startOffset;
      }
    } else if (typeof docWithCaret.caretPositionFromPoint === 'function') {
      const pos = docWithCaret.caretPositionFromPoint(clientX, clientY);
      if (pos) {
        targetNode = pos.offsetNode;
        targetOffset = pos.offset;
      }
    }

    if (!targetNode || !container.contains(targetNode)) return null;

    const preRange = document.createRange();
    preRange.selectNodeContents(container);
    preRange.setEnd(targetNode, targetOffset);
    const offset = preRange.toString().replace(/\u200B/g, '').length;
    return Math.max(0, Math.min(offset, maxLength));
  } catch {
    return null;
  }
}

interface SectionBlockProps {
  section: ManuscriptSection;
  index: number;
  activeModel: GeminiModel;
  isReprocessing: boolean;
  saveStatus?: SectionSaveStatus;
  onUpdateContent: (sectionId: string, nextContent: string) => void;
  onFlushContent?: (sectionId: string) => void;
  onSelectVersion: (sectionId: string, versionIndex: number) => void;
  onReprocessStyle: (
    section: ManuscriptSection,
    targetStyle: WritingStyle,
    targetEnding?: VoiceEnding,
    source?: ReprocessSource,
    overrideMode?: ProcessingMode,
  ) => Promise<void>;
  onDeleteSection: (sectionId: string) => void;
  onCopyText: (text: string) => void;
}

export const SectionBlock = memo(function SectionBlock({
  section,
  index,
  activeModel,
  isReprocessing,
  saveStatus = 'saved',
  onUpdateContent,
  onFlushContent,
  onSelectVersion,
  onReprocessStyle,
  onDeleteSection,
  onCopyText,
}: SectionBlockProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastMeasuredWidthRef = useRef<number>(0);
  const pointerDownRef = useRef<boolean>(false);
  const exitEditRafRef = useRef<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [showAudio, setShowAudio] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuOpensUpward, setMenuOpensUpward] = useState(false);
  const [showAudioReprocess, setShowAudioReprocess] = useState(false);
  const [copied, setCopied] = useState(false);
  const [localAudioAvailable, setLocalAudioAvailable] = useState<boolean | null>(() =>
    section.storagePath || section.audioUrl ? true : section.audioId ? null : false,
  );

  const versions = getSectionVersions(section);
  const activeVersionIndex = getActiveVersionIndex(section);
  const activeVersion = versions[activeVersionIndex];
  const activeMode = activeVersion.mode ?? section.mode;
  const hasCloudAudio = Boolean(section.storagePath || section.audioUrl);
  const hasAnyAudioReference = hasCloudAudio || Boolean(section.audioId);
  const canUseAudioOnThisDevice = hasCloudAudio || localAudioAvailable === true;
  const isAudioOnOtherDevice =
    !hasCloudAudio && Boolean(section.audioId) && localAudioAvailable === false;

  // Check IndexedDB presence for local-first audio clips so cross-device sections never show broken buttons
  useEffect(() => {
    if (hasCloudAudio) {
      setLocalAudioAvailable(true);
      return;
    }
    if (!section.audioId) {
      setLocalAudioAvailable(false);
      return;
    }
    let cancelled = false;
    void hasAudioClip(section.audioId).then((exists) => {
      if (!cancelled) {
        setLocalAudioAvailable(exists);
        if (!exists) setShowAudio(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [hasCloudAudio, section.audioId]);

  const syncTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;

    // Preserve native window scroll position so collapsing height to 0px for measurement never jumps the viewport
    const savedScrollY = window.scrollY;
    const savedScrollX = window.scrollX;

    el.style.minHeight = '';
    el.style.height = '0px';

    const computed = window.getComputedStyle(el);
    const borderY =
      (parseFloat(computed.borderTopWidth) || 0) + (parseFloat(computed.borderBottomWidth) || 0);
    const nextHeight = Math.max(Math.ceil(el.scrollHeight + borderY), 64);

    el.style.height = `${nextHeight}px`;
    if (el.scrollTop !== 0) {
      el.scrollTop = 0;
    }

    if (window.scrollY !== savedScrollY) {
      window.scrollTo({ top: savedScrollY, left: savedScrollX, behavior: 'instant' as ScrollBehavior });
    }
  }, []);

  useLayoutEffect(() => {
    if (!isEditing) return;
    syncTextareaHeight();
  }, [isEditing, activeVersion.text, activeVersionIndex, syncTextareaHeight]);

  useEffect(() => {
    if (isReprocessing && isEditing) {
      setIsEditing(false);
    }
  }, [isReprocessing, isEditing]);

  useEffect(() => {
    return () => {
      if (exitEditRafRef.current !== null) {
        window.cancelAnimationFrame(exitEditRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isEditing) return;
    const el = textareaRef.current;
    if (!el) return;

    let rafId: number | null = null;
    const scheduleSync = () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        syncTextareaHeight();
      });
    };

    // Observe the parent container width only so height updates never re-trigger ResizeObserver loops
    const observeTarget = el.parentElement ?? el;
    lastMeasuredWidthRef.current = Math.round(observeTarget.getBoundingClientRect().width);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const nextWidth = Math.round(entry.contentRect.width);
        if (nextWidth > 0 && nextWidth !== lastMeasuredWidthRef.current) {
          lastMeasuredWidthRef.current = nextWidth;
          scheduleSync();
        }
      });
      observer.observe(observeTarget);
    }

    // Re-measure accurately once web fonts (e.g. Noto Sans Myanmar) finish loading
    let cancelled = false;
    const fontSet = typeof document !== 'undefined' ? document.fonts : undefined;
    if (fontSet?.ready) {
      void fontSet.ready.then(() => {
        if (!cancelled) scheduleSync();
      });
    }
    fontSet?.addEventListener?.('loadingdone', scheduleSync);

    window.addEventListener('resize', scheduleSync);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', scheduleSync);
      fontSet?.removeEventListener?.('loadingdone', scheduleSync);
      observer?.disconnect();
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [isEditing, syncTextareaHeight]);

  const enterEditModeSync = useCallback(
    (caretOffset: number | null) => {
      if (isReprocessing) return;
      if (exitEditRafRef.current !== null) {
        window.cancelAnimationFrame(exitEditRafRef.current);
        exitEditRafRef.current = null;
      }

      // Synchronous flushSync keeps textarea.focus() inside the user tap gesture so iOS opens the keyboard on 1st tap
      flushSync(() => {
        setIsEditing(true);
      });

      const ta = textareaRef.current;
      if (!ta) return;

      syncTextareaHeight();
      try {
        ta.focus({ preventScroll: true });
      } catch {
        ta.focus();
      }
      if (caretOffset !== null) {
        try {
          ta.setSelectionRange(caretOffset, caretOffset);
        } catch {
          // Ignore selection errors if element is not selectable
        }
      }
    },
    [isReprocessing, syncTextareaHeight],
  );

  const handleReadSurfaceClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      pointerDownRef.current = false;
      if (isReprocessing) return;
      // Do not hijack drag-selection or long-press text copy
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().length > 0) {
        return;
      }
      const offset = getCaretOffsetFromPoint(
        e.currentTarget,
        e.clientX,
        e.clientY,
        activeVersion.text.length,
      );
      enterEditModeSync(offset);
    },
    [isReprocessing, activeVersion.text.length, enterEditModeSync],
  );

  const handleReadSurfaceFocus = useCallback(() => {
    // Only auto-enter edit mode on keyboard Tab focus (mouse/touch taps are handled by onClick with exact caret offset)
    if (pointerDownRef.current || isReprocessing) return;
    enterEditModeSync(activeVersion.text.length);
  }, [isReprocessing, activeVersion.text.length, enterEditModeSync]);

  const handleTextareaBlur = useCallback(() => {
    syncTextareaHeight();
    onFlushContent?.(section.id);
    // Defer unmounting textarea by 1 frame so document focusout listeners still see the blurred textarea inside <main>
    if (exitEditRafRef.current !== null) {
      window.cancelAnimationFrame(exitEditRafRef.current);
    }
    exitEditRafRef.current = window.requestAnimationFrame(() => {
      exitEditRafRef.current = null;
      if (document.activeElement !== textareaRef.current) {
        setIsEditing(false);
      }
    });
  }, [onFlushContent, section.id, syncTextareaHeight]);

  useEffect(() => {
    if (!menuOpen) {
      setShowAudioReprocess(false);
      return;
    }
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onUpdateContent(section.id, e.target.value);
  };

  const handleCopy = () => {
    onCopyText(activeVersion.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const isCurrentOption = (opt: ReprocessOption) => {
    if (activeMode === 'proofread_only') return false;
    if (opt.style !== activeVersion.style) return false;
    if (opt.style === 'refined_flow') {
      return (activeVersion.refinedEnding ?? 'colloquial') === (opt.refinedEnding ?? 'colloquial');
    }
    return true;
  };

  const handleToggleMenu = () => {
    setMenuOpen((prev) => {
      const next = !prev;
      if (next && menuTriggerRef.current && typeof window !== 'undefined') {
        const rect = menuTriggerRef.current.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        setMenuOpensUpward(spaceBelow < 320 && spaceAbove > spaceBelow);
      }
      return next;
    });
  };

  return (
    <article
      className="group border-t border-[#E5E7EB] pt-7 pb-1 first:border-t-0 first:pt-2"
      aria-label={`Manuscript section ${index + 1}`}
    >
      {/* Quiet unboxed metadata header + version switcher + section actions */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-y-2 gap-x-4">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-[#6B7280] tabular-nums">
          <span className="font-semibold text-[#111827]">
            Section {String(index + 1).padStart(2, '0')}
          </span>

          {versions.length > 1 && (
            <div
              role="group"
              aria-label="Version history"
              className="mx-0.5 inline-flex items-center rounded-md border border-[#E5E7EB] bg-[#F8F9FA] text-[11px] font-medium text-[#374151]"
            >
              <button
                type="button"
                disabled={activeVersionIndex <= 0 || isReprocessing}
                onClick={() => onSelectVersion(section.id, activeVersionIndex - 1)}
                aria-label="Previous version"
                title="Previous version"
                className="inline-flex h-7 w-7 items-center justify-center rounded-l-[5px] text-[#4B5563] transition-colors hover:bg-white hover:text-[#111827] disabled:cursor-not-allowed disabled:opacity-35 sm:h-5 sm:w-5"
              >
                <ChevronLeft className="h-3.5 w-3.5 sm:h-3 sm:w-3" />
              </button>
              <span
                className="select-none px-1.5 text-[11px] font-medium text-[#111827]"
                title={`Viewing version ${activeVersionIndex + 1} of ${versions.length}`}
              >
                {activeVersionIndex + 1} / {versions.length}
              </span>
              <button
                type="button"
                disabled={activeVersionIndex >= versions.length - 1 || isReprocessing}
                onClick={() => onSelectVersion(section.id, activeVersionIndex + 1)}
                aria-label="Next version"
                title="Next version"
                className="inline-flex h-7 w-7 items-center justify-center rounded-r-[5px] text-[#4B5563] transition-colors hover:bg-white hover:text-[#111827] disabled:cursor-not-allowed disabled:opacity-35 sm:h-5 sm:w-5"
              >
                <ChevronRight className="h-3.5 w-3.5 sm:h-3 sm:w-3" />
              </button>
            </div>
          )}

          <span aria-hidden="true">·</span>
          <span className="font-medium text-[#374151]">
            {formatCompactStyleLabel(activeVersion.style, activeVersion.refinedEnding)}
          </span>
          {activeMode === 'summarize_structure' ? (
            <>
              <span aria-hidden="true">·</span>
              <span>Summary</span>
            </>
          ) : activeMode === 'proofread_only' ? (
            <>
              <span aria-hidden="true">·</span>
              <span>Proofread</span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span title={MODEL_LABELS[activeVersion.model]}>
            {MODEL_SHORT_LABELS[activeVersion.model]}
          </span>
          {section.audioMeta && section.audioMeta.durationSec > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-[11px]">
                {formatDuration(section.audioMeta.durationSec)}
              </span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span>{formatTimestamp(activeVersion.timestamp)}</span>
          <span aria-hidden="true">·</span>
          <span
            className={
              saveStatus === 'saving'
                ? 'text-[#312E81]'
                : saveStatus === 'error'
                  ? 'text-[#DC2626]'
                  : 'text-[#6B7280]'
            }
          >
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Save failed' : 'Saved'}
          </span>
        </div>

        {/* Section controls */}
        <div className="flex flex-wrap items-center gap-1">
          {canUseAudioOnThisDevice && hasAnyAudioReference && section.audioMeta ? (
            <button
              type="button"
              onClick={() => setShowAudio((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81] ${
                showAudio
                  ? 'bg-[#EEF2FF] text-[#312E81]'
                  : 'text-[#4B5563] hover:bg-[#F3F4F6] hover:text-[#111827]'
              }`}
              title="Listen to or download original recording"
            >
              <Headphones className="h-3.5 w-3.5" />
              <span>Audio</span>
            </button>
          ) : isAudioOnOtherDevice ? (
            <span
              className="inline-flex items-center gap-1 whitespace-nowrap px-2 py-1 text-[11px] text-[#9CA3AF]"
              title="Original audio is stored locally on the device used to record this section"
            >
              <Headphones className="h-3 w-3 opacity-70" aria-hidden="true" />
              <span>Local audio on other device</span>
            </span>
          ) : null}

          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-[#4B5563] transition-colors duration-150 hover:bg-[#F3F4F6] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81]"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-[#16A34A]" />
                <span className="text-[#16A34A]">Copied</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>Copy</span>
              </>
            )}
          </button>

          {/* Re-process style menu supporting all 3 styles, Proofread Only, & Refined Flow endings */}
          <div ref={menuRef} className="relative">
            <button
              ref={menuTriggerRef}
              type="button"
              disabled={isReprocessing}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={handleToggleMenu}
              title={`Create a new version in another style or proofread using ${MODEL_LABELS[activeModel]} (keeps previous versions)`}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-[#312E81] transition-colors duration-150 hover:bg-[#EEF2FF] hover:text-[#27246A] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81] disabled:cursor-wait disabled:opacity-60"
            >
              {isReprocessing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Re-processing…</span>
                </>
              ) : (
                <>
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span className="sm:hidden">Re-process</span>
                  <span className="hidden sm:inline">Re-process Style</span>
                  <ChevronDown className="h-3 w-3 opacity-75" />
                </>
              )}
            </button>

            {menuOpen && !isReprocessing && (
              <div
                role="menu"
                className={`absolute left-1/2 z-20 w-56 -translate-x-1/2 rounded-lg border border-[#E5E7EB] bg-white py-1 shadow-[0_10px_30px_rgba(17,24,39,0.12)] sm:left-auto sm:right-0 sm:translate-x-0 ${
                  menuOpensUpward ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
                }`}
              >
                <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-[#9CA3AF]">
                  Restyle text (fast)
                </div>
                {REPROCESS_OPTIONS.map((opt) => {
                  const active = isCurrentOption(opt);
                  return (
                    <button
                      key={`text-${opt.style}-${opt.refinedEnding ?? 'default'}`}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        void onReprocessStyle(
                          section,
                          opt.style,
                          opt.refinedEnding,
                          'text',
                          undefined,
                        );
                      }}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs transition-colors ${
                        active
                          ? 'bg-[#EEF2FF]/70 font-medium text-[#312E81]'
                          : 'text-[#374151] hover:bg-[#F8F9FA] hover:text-[#111827]'
                      }`}
                    >
                      <span className="whitespace-nowrap">{opt.label}</span>
                      {active ? <Check className="h-3.5 w-3.5 text-[#312E81]" /> : null}
                    </button>
                  );
                })}

                <div className="mt-1 border-t border-[#F3F4F6] pt-1">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void onReprocessStyle(
                        section,
                        activeVersion.style,
                        activeVersion.refinedEnding,
                        'text',
                        'proofread_only',
                      );
                    }}
                    className={`flex w-full items-start justify-between gap-2 px-3 py-2 text-left transition-colors ${
                      activeMode === 'proofread_only'
                        ? 'bg-[#EEF2FF]/70 text-[#312E81]'
                        : 'text-[#374151] hover:bg-[#F8F9FA] hover:text-[#111827]'
                    }`}
                  >
                    <span className="flex items-start gap-2">
                      <SpellCheck
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#312E81]"
                        aria-hidden="true"
                      />
                      <span>
                        <span className="block text-xs font-medium">Proofread Only</span>
                        <span className="block text-[10px] leading-tight text-[#6B7280]">
                          Spelling, ၊ ။ &amp; spacing only
                        </span>
                      </span>
                    </span>
                    {activeMode === 'proofread_only' ? (
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#312E81]" />
                    ) : null}
                  </button>
                </div>

                {canUseAudioOnThisDevice && hasAnyAudioReference && (
                  <div className="mt-1 border-t border-[#F3F4F6] pt-1">
                    <button
                      type="button"
                      onClick={() => setShowAudioReprocess((prev) => !prev)}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-[#4B5563] transition-colors hover:bg-[#F8F9FA] hover:text-[#111827]"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <Headphones className="h-3.5 w-3.5 text-[#6B7280]" aria-hidden="true" />
                        <span>Re-listen to Audio</span>
                      </span>
                      <ChevronDown
                        className={`h-3 w-3 text-[#9CA3AF] transition-transform duration-150 ${
                          showAudioReprocess ? 'rotate-180' : ''
                        }`}
                      />
                    </button>

                    {showAudioReprocess && (
                      <div className="border-t border-[#F3F4F6] bg-[#FAFAFB] py-1">
                        {REPROCESS_OPTIONS.map((opt) => (
                          <button
                            key={`audio-${opt.style}-${opt.refinedEnding ?? 'default'}`}
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuOpen(false);
                              void onReprocessStyle(
                                section,
                                opt.style,
                                opt.refinedEnding,
                                'audio',
                                undefined,
                              );
                            }}
                            className="flex w-full items-center justify-between px-3.5 py-1.5 text-left text-[11px] text-[#4B5563] transition-colors hover:bg-[#EEF2FF]/60 hover:text-[#312E81]"
                          >
                            <span className="whitespace-nowrap">{opt.label}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            disabled={isReprocessing}
            onClick={() => onDeleteSection(section.id)}
            aria-label={`Move section ${index + 1} to Trash`}
            title="Move section to Trash"
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1.5 text-xs font-medium text-[#6B7280] transition-colors duration-150 hover:bg-[#FEE2E2] hover:text-[#DC2626] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81] disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="sr-only sm:not-sr-only">Delete</span>
          </button>
        </div>
      </div>

      {/* Optional persisted cloud/local audio playback & backup bar */}
      {showAudio && canUseAudioOnThisDevice && hasAnyAudioReference && section.audioMeta ? (
        <div className="mb-4">
          <AudioPlayerBar
            audioUrl={section.audioUrl}
            storagePath={section.storagePath}
            audioId={section.audioId}
            meta={section.audioMeta}
            compact
          />
        </div>
      ) : null}

      {/* Prose reader/editor: plain DOM text while scrolling prevents iOS WebKit tall-textarea clipping & blank bottom voids; 1-tap swaps synchronously to auto-sized textarea */}
      <div className="rounded-lg transition-colors duration-150 focus-within:bg-[#FAFAFC]">
        {isEditing && !isReprocessing ? (
          <textarea
            ref={textareaRef}
            value={activeVersion.text}
            onChange={handleTextChange}
            onFocus={syncTextareaHeight}
            onBlur={handleTextareaBlur}
            disabled={isReprocessing}
            rows={1}
            spellCheck={false}
            aria-label={`Editable prose for section ${index + 1}, version ${activeVersionIndex + 1} of ${versions.length}`}
            placeholder="Your transcribed manuscript prose will appear here…"
            className="font-manuscript box-border block w-full resize-none overflow-hidden whitespace-pre-wrap break-words rounded-lg border border-[#E5E7EB] bg-[#FAFAFC] px-2.5 pt-2 pb-2 text-[16.5px] text-[#111827] placeholder:text-[#9CA3AF] [overflow-wrap:break-word] focus:outline-none disabled:opacity-60"
          />
        ) : (
          <div
            role="textbox"
            aria-multiline="true"
            aria-label={`Editable prose for section ${index + 1}, version ${activeVersionIndex + 1} of ${versions.length}. Tap or click to edit.`}
            tabIndex={isReprocessing ? -1 : 0}
            onPointerDown={() => {
              pointerDownRef.current = true;
            }}
            onPointerCancel={() => {
              pointerDownRef.current = false;
            }}
            onClick={handleReadSurfaceClick}
            onFocus={handleReadSurfaceFocus}
            onBlur={() => {
              pointerDownRef.current = false;
            }}
            className={`font-manuscript box-border block w-full cursor-text select-text whitespace-pre-wrap break-words rounded-lg border border-transparent bg-transparent px-2.5 pt-2 pb-2 text-[16.5px] [overflow-wrap:break-word] focus:outline-none ${
              isReprocessing ? 'pointer-events-none opacity-60' : ''
            } ${activeVersion.text ? 'text-[#111827]' : 'min-h-[64px] text-[#9CA3AF]'}`}
          >
            {activeVersion.text
              ? activeVersion.text.endsWith('\n')
                ? `${activeVersion.text}\u200B`
                : activeVersion.text
              : 'Your transcribed manuscript prose will appear here…'}
          </div>
        )}
      </div>

      {/* Subtle, low-contrast per-version token usage & estimated cost */}
      {activeVersion.usage && activeVersion.usage.totalTokens > 0 ? (
        <div className="mt-1 flex justify-end">
          <span
            className="select-none text-[11px] text-[#9CA3AF] tabular-nums"
            title={`Input: ${activeVersion.usage.inputTokens.toLocaleString()} · Output: ${activeVersion.usage.outputTokens.toLocaleString()} tokens`}
          >
            {formatTokenUsageCompact(activeVersion.usage)}
          </span>
        </div>
      ) : null}
    </article>
  );
});
