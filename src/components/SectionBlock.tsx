import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Headphones,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { GeminiModel, ManuscriptSection, WritingStyle } from '../types.ts';
import { MODEL_LABELS, STYLE_LABELS } from '../types.ts';
import { formatDuration, formatTimestamp } from '../lib/format.ts';
import { AudioPlayerBar } from './AudioPlayerBar.tsx';

interface SectionBlockProps {
  section: ManuscriptSection;
  index: number;
  activeModel: GeminiModel;
  isReprocessing: boolean;
  onUpdateContent: (sectionId: string, nextContent: string) => void;
  onReprocessStyle: (section: ManuscriptSection, targetStyle: WritingStyle) => Promise<void>;
  onDeleteSection: (sectionId: string) => void;
  onCopyText: (text: string) => void;
}

export function SectionBlock({
  section,
  index,
  activeModel,
  isReprocessing,
  onUpdateContent,
  onReprocessStyle,
  onDeleteSection,
  onCopyText,
}: SectionBlockProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [showAudio, setShowAudio] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saveLabel, setSaveLabel] = useState<'Saved' | 'Saving…'>('Saved');
  const saveTimerRef = useRef<number | null>(null);

  const oppositeStyle: WritingStyle = section.style === 'literary' ? 'colloquial' : 'literary';
  const oppositeShort = oppositeStyle === 'literary' ? 'Literary' : 'Colloquial';

  const syncTextareaHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(96, el.scrollHeight)}px`;
  };

  useLayoutEffect(() => {
    syncTextareaHeight();
  }, [section.content]);

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
    onCopyText(section.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <article
      className="group border-t border-[#E5E7EB] pt-7 pb-3 first:border-t-0 first:pt-2"
      aria-label={`Manuscript section ${index + 1}`}
    >
      {/* Quiet unboxed metadata header + section actions */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-y-2 gap-x-4">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-[#6B7280] tabular-nums">
          <span className="font-semibold text-[#111827]">
            Section {String(index + 1).padStart(2, '0')}
          </span>
          <span aria-hidden="true">·</span>
          <span>{STYLE_LABELS[section.style]}</span>
          {section.mode === 'summarize_structure' ? (
            <>
              <span aria-hidden="true">·</span>
              <span>Structured Summary</span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span>{MODEL_LABELS[section.model]}</span>
          {section.audioMeta && section.audioMeta.durationSec > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-[11px]">
                {formatDuration(section.audioMeta.durationSec)}
              </span>
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span>{formatTimestamp(section.updatedAt)}</span>
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

          <button
            type="button"
            disabled={isReprocessing}
            onClick={() => onReprocessStyle(section, oppositeStyle)}
            title={`Re-process this section into ${STYLE_LABELS[oppositeStyle]} using ${MODEL_LABELS[activeModel]}`}
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
                <span>Re-process as {oppositeShort}</span>
              </>
            )}
          </button>

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
          value={section.content}
          onChange={handleTextChange}
          disabled={isReprocessing}
          rows={3}
          spellCheck={false}
          aria-label={`Editable prose for section ${index + 1}`}
          placeholder="Your transcribed manuscript prose will appear here…"
          className="font-manuscript block w-full resize-none overflow-hidden rounded-lg border border-transparent bg-transparent px-1 py-1.5 text-[16.5px] text-[#111827] placeholder:text-[#9CA3AF] focus:border-[#E5E7EB] focus:px-3 focus:outline-none disabled:opacity-60"
        />
      </div>
    </article>
  );
}
