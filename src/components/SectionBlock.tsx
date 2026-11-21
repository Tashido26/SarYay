import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Headphones,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type {
  GeminiModel,
  ManuscriptSection,
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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [showAudio, setShowAudio] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAudioReprocess, setShowAudioReprocess] = useState(false);
  const [copied, setCopied] = useState(false);

  const versions = getSectionVersions(section);
  const activeVersionIndex = getActiveVersionIndex(section);
  const activeVersion = versions[activeVersionIndex];
  const activeMode = activeVersion.mode ?? section.mode;
  const hasOriginalAudio = Boolean(section.storagePath || section.audioUrl || section.audioId);

  const syncTextareaMinHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Let the CSS Grid mirror compute natural height first, then guard against any script-shaping delta
    el.style.minHeight = '';
    if (el.scrollHeight > el.clientHeight + 1) {
      el.style.minHeight = `${el.scrollHeight + 4}px`;
    }
  }, []);

  useLayoutEffect(() => {
    syncTextareaMinHeight();
  }, [activeVersion.text, activeVersionIndex, syncTextareaMinHeight]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    let rafId: number | null = null;
    const scheduleSync = () => {
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        syncTextareaMinHeight();
      });
    };

    // Re-check when container width changes (e.g. sidebar open/collapse, window resize, orientation change)
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(scheduleSync);
      observer.observe(el);
    }

    // Re-check once web fonts (e.g. Noto Sans Myanmar) finish loading
    let cancelled = false;
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (!cancelled) scheduleSync();
      });
    }

    window.addEventListener('resize', scheduleSync);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', scheduleSync);
      observer?.disconnect();
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [syncTextareaMinHeight]);

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
    if (opt.style !== activeVersion.style) return false;
    if (opt.style === 'refined_flow') {
      return (activeVersion.refinedEnding ?? 'colloquial') === (opt.refinedEnding ?? 'colloquial');
    }
    return true;
  };

  return (
    <article
      className="group border-t border-[#E5E7EB] pt-7 pb-3 first:border-t-0 first:pt-2"
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
                ? 'text-[#4338CA]'
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
          {(section.audioUrl || section.audioId) && section.audioMeta ? (
            <button
              type="button"
              onClick={() => setShowAudio((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] ${
                showAudio
                  ? 'bg-[#EEF2FF] text-[#312E81]'
                  : 'text-[#4B5563] hover:bg-[#F3F4F6] hover:text-[#111827]'
              }`}
              title="Listen to or download original recording"
            >
              <Headphones className="h-3.5 w-3.5" />
              <span>Audio</span>
            </button>
          ) : null}

          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-[#4B5563] transition-colors duration-150 hover:bg-[#F3F4F6] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA]"
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

          {/* Re-process style menu supporting all 3 styles & Refined Flow endings (non-destructive) */}
          <div ref={menuRef} className="relative">
            <button
              type="button"
              disabled={isReprocessing}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((prev) => !prev)}
              title={`Create a new version in another style using ${MODEL_LABELS[activeModel]} (keeps previous versions)`}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-[#4338CA] transition-colors duration-150 hover:bg-[#EEF2FF] hover:text-[#312E81] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:cursor-wait disabled:opacity-60"
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
                className="absolute left-1/2 z-20 mt-1.5 w-56 -translate-x-1/2 rounded-lg border border-[#E5E7EB] bg-white py-1 shadow-sm sm:left-auto sm:right-0 sm:translate-x-0"
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
                        void onReprocessStyle(section, opt.style, opt.refinedEnding, 'text');
                      }}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs transition-colors ${
                        active
                          ? 'bg-[#EEF2FF]/70 font-medium text-[#312E81]'
                          : 'text-[#374151] hover:bg-[#F8F9FA] hover:text-[#111827]'
                      }`}
                    >
                      <span className="whitespace-nowrap">{opt.label}</span>
                      {active ? <Check className="h-3.5 w-3.5 text-[#4338CA]" /> : null}
                    </button>
                  );
                })}

                {hasOriginalAudio && (
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
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1.5 text-xs font-medium text-[#6B7280] transition-colors duration-150 hover:bg-[#FEE2E2] hover:text-[#DC2626] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="sr-only sm:not-sr-only">Delete</span>
          </button>
        </div>
      </div>

      {/* Optional persisted cloud/local audio playback & backup bar */}
      {showAudio && (section.audioUrl || section.audioId) && section.audioMeta ? (
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

      {/* Editable Burmese/English literary prose editor (CSS Grid mirror keeps all lines unclipped) */}
      <div className="grid rounded-lg transition-colors duration-150 focus-within:bg-[#FAFAFC]">
        <div
          aria-hidden="true"
          className="font-manuscript pointer-events-none invisible col-start-1 row-start-1 min-h-[96px] w-full whitespace-pre-wrap break-words rounded-lg border border-transparent px-2.5 pt-2 pb-3 text-[16.5px] [overflow-wrap:break-word]"
        >
          {`${activeVersion.text}\u200B`}
        </div>
        <textarea
          ref={textareaRef}
          value={activeVersion.text}
          onChange={handleTextChange}
          onFocus={syncTextareaMinHeight}
          onBlur={() => {
            syncTextareaMinHeight();
            onFlushContent?.(section.id);
          }}
          disabled={isReprocessing}
          rows={1}
          spellCheck={false}
          aria-label={`Editable prose for section ${index + 1}, version ${activeVersionIndex + 1} of ${versions.length}`}
          placeholder="Your transcribed manuscript prose will appear here…"
          className="font-manuscript col-start-1 row-start-1 block h-full min-h-[96px] w-full resize-none overflow-hidden whitespace-pre-wrap break-words rounded-lg border border-transparent bg-transparent px-2.5 pt-2 pb-3 text-[16.5px] text-[#111827] placeholder:text-[#9CA3AF] [overflow-wrap:break-word] focus:border-[#E5E7EB] focus:outline-none disabled:opacity-60"
        />
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
