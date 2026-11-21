import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { formatDuration, formatTimestamp } from '../lib/format.ts';
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
  onUpdateContent: (sectionId: string, nextContent: string) => void;
  onSelectVersion: (sectionId: string, versionIndex: number) => void;
  onReprocessStyle: (
    section: ManuscriptSection,
    targetStyle: WritingStyle,
    targetEnding?: VoiceEnding,
  ) => Promise<void>;
  onDeleteSection: (sectionId: string) => void;
  onCopyText: (text: string) => void;
}

export function SectionBlock({
  section,
  index,
  activeModel,
  isReprocessing,
  onUpdateContent,
  onSelectVersion,
  onReprocessStyle,
  onDeleteSection,
  onCopyText,
}: SectionBlockProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [showAudio, setShowAudio] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saveLabel, setSaveLabel] = useState<'Saved' | 'Saving…'>('Saved');
  const saveTimerRef = useRef<number | null>(null);

  const versions = getSectionVersions(section);
  const activeVersionIndex = getActiveVersionIndex(section);
  const activeVersion = versions[activeVersionIndex];
  const activeMode = activeVersion.mode ?? section.mode;

  const syncTextareaHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(96, el.scrollHeight)}px`;
  };

  useLayoutEffect(() => {
    syncTextareaHeight();
  }, [activeVersion.text, activeVersionIndex]);

  useEffect(() => {
    const onResize = () => syncTextareaHeight();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
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
    const value = e.target.value;
    setSaveLabel('Saving…');
    onUpdateContent(section.id, value);
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      setSaveLabel('Saved');
    }, 350);
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
                className="inline-flex h-5 w-5 items-center justify-center rounded-l-[5px] text-[#4B5563] transition-colors hover:bg-white hover:text-[#111827] disabled:cursor-not-allowed disabled:opacity-35"
              >
                <ChevronLeft className="h-3 w-3" />
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
                className="inline-flex h-5 w-5 items-center justify-center rounded-r-[5px] text-[#4B5563] transition-colors hover:bg-white hover:text-[#111827] disabled:cursor-not-allowed disabled:opacity-35"
              >
                <ChevronRight className="h-3 w-3" />
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
          <span className={saveLabel === 'Saving…' ? 'text-[#4338CA]' : 'text-[#6B7280]'}>
            {saveLabel}
          </span>
        </div>

        {/* Section controls */}
        <div className="flex flex-wrap items-center gap-1">
          {section.audioId && section.audioMeta ? (
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
                  <span>Re-process Style</span>
                  <ChevronDown className="h-3 w-3 opacity-75" />
                </>
              )}
            </button>

            {menuOpen && !isReprocessing && (
              <div
                role="menu"
                className="absolute right-0 z-20 mt-1.5 w-52 rounded-lg border border-[#E5E7EB] bg-white py-1 shadow-sm"
              >
                {REPROCESS_OPTIONS.map((opt) => {
                  const active = isCurrentOption(opt);
                  return (
                    <button
                      key={`${opt.style}-${opt.refinedEnding ?? 'default'}`}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onReprocessStyle(section, opt.style, opt.refinedEnding);
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
              </div>
            )}
          </div>

          {confirmDelete ? (
            <div className="ml-1 inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  onDeleteSection(section.id);
                  setConfirmDelete(false);
                }}
                className="whitespace-nowrap rounded-md bg-[#DC2626] px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-[#B91C1C]"
              >
                Confirm Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="whitespace-nowrap rounded-md border border-[#E5E7EB] bg-white px-2 py-1 text-xs font-medium text-[#4B5563] transition-colors hover:bg-[#F9FAFB]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={isReprocessing}
              onClick={() => setConfirmDelete(true)}
              aria-label={`Delete section ${index + 1}`}
              title="Delete section"
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-1.5 text-xs font-medium text-[#6B7280] transition-colors duration-150 hover:bg-[#FEE2E2] hover:text-[#DC2626] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="sr-only sm:not-sr-only">Delete</span>
            </button>
          )}
        </div>
      </div>

      {/* Optional persisted audio playback & backup bar */}
      {showAudio && section.audioId && section.audioMeta ? (
        <div className="mb-4">
          <AudioPlayerBar audioId={section.audioId} meta={section.audioMeta} compact />
        </div>
      ) : null}

      {/* Editable Burmese/English literary prose editor */}
      <div className="rounded-lg transition-colors duration-150 focus-within:bg-[#FAFAFC]">
        <textarea
          ref={textareaRef}
          value={activeVersion.text}
          onChange={handleTextChange}
          disabled={isReprocessing}
          rows={3}
          spellCheck={false}
          aria-label={`Editable prose for section ${index + 1}, version ${activeVersionIndex + 1} of ${versions.length}`}
          placeholder="Your transcribed manuscript prose will appear here…"
          className="font-manuscript block w-full resize-none overflow-hidden rounded-lg border border-transparent bg-transparent px-1 py-1.5 text-[16.5px] text-[#111827] placeholder:text-[#9CA3AF] focus:border-[#E5E7EB] focus:px-3 focus:outline-none disabled:opacity-60"
        />
      </div>
    </article>
  );
}
