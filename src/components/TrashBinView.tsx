import { useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  Headphones,
  Loader2,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type { ManuscriptSection, StorySession, TrashedSection } from '../types.ts';
import { formatCompactStyleLabel, getActiveSectionVersion } from '../types.ts';
import { hasAudioClip } from '../lib/audioDb.ts';
import { fetchStorySectionsOnce } from '../lib/cloudStore.ts';
import {
  formatDuration,
  formatTimestamp,
  getTrashDaysRemaining,
} from '../lib/format.ts';
import { AudioPlayerBar } from './AudioPlayerBar.tsx';

interface TrashBinViewProps {
  uid: string;
  trashedStories: StorySession[];
  trashedSections: TrashedSection[];
  busyItemId: string | null;
  onRestoreStory: (story: StorySession) => void;
  onRequestDeleteStoryForever: (story: StorySession) => void;
  onRestoreSection: (section: TrashedSection) => void;
  onRequestDeleteSectionForever: (section: TrashedSection) => void;
  onCopyText: (text: string, label?: string) => void;
}

export function TrashBinView({
  uid,
  trashedStories,
  trashedSections,
  busyItemId,
  onRestoreStory,
  onRequestDeleteStoryForever,
  onRestoreSection,
  onRequestDeleteSectionForever,
  onCopyText,
}: TrashBinViewProps) {
  const [expandedStoryId, setExpandedStoryId] = useState<string | null>(null);
  const [storySectionsMap, setStorySectionsMap] = useState<Record<string, ManuscriptSection[]>>({});
  const [loadingStoryId, setLoadingStoryId] = useState<string | null>(null);
  const [openAudioId, setOpenAudioId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [localAudioMap, setLocalAudioMap] = useState<Record<string, boolean>>({});

  const totalCount = trashedStories.length + trashedSections.length;

  useEffect(() => {
    const candidateIds = new Set<string>();
    for (const sec of trashedSections) {
      if (!sec.audioUrl && !sec.storagePath && sec.audioId) {
        candidateIds.add(sec.audioId);
      }
    }
    for (const list of Object.values(storySectionsMap)) {
      for (const sec of list) {
        if (!sec.audioUrl && !sec.storagePath && sec.audioId) {
          candidateIds.add(sec.audioId);
        }
      }
    }
    const unchecked = Array.from(candidateIds).filter((id) => localAudioMap[id] === undefined);
    if (unchecked.length === 0) return;

    let cancelled = false;
    void Promise.all(
      unchecked.map(async (id) => [id, await hasAudioClip(id)] as const),
    ).then((entries) => {
      if (cancelled) return;
      setLocalAudioMap((prev) => {
        const next = { ...prev };
        for (const [id, exists] of entries) {
          next[id] = exists;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [trashedSections, storySectionsMap, localAudioMap]);

  const handleToggleStoryPreview = async (storyId: string) => {
    if (expandedStoryId === storyId) {
      setExpandedStoryId(null);
      return;
    }
    setExpandedStoryId(storyId);
    if (!storySectionsMap[storyId]) {
      setLoadingStoryId(storyId);
      try {
        const fetched = await fetchStorySectionsOnce(uid, storyId);
        setStorySectionsMap((prev) => ({ ...prev, [storyId]: fetched }));
      } catch (err) {
        console.warn('Could not load trashed story preview:', err);
      } finally {
        setLoadingStoryId(null);
      }
    }
  };

  const handleCopy = (id: string, text: string, label = 'Copied from Trash') => {
    onCopyText(text, label);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1800);
  };

  const formatDaysLeft = (deletedAt: string | null | undefined) => {
    const days = getTrashDaysRemaining(deletedAt);
    if (days <= 0) return 'Expiring soon';
    return days === 1 ? '1 day left' : `${days} days left`;
  };

  return (
    <div className="mx-auto max-w-[780px] px-5 py-6 sm:px-10 sm:py-8">
      <div className="mb-6 border-b border-[#E5E7EB] pb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[#111827] sm:text-2xl">
              Trash
            </h1>
            <p className="mt-1 text-xs text-[#6B7280] tabular-nums">
              {totalCount === 0
                ? 'Empty · Items stay for 30 days before permanent removal'
                : `${totalCount} ${totalCount === 1 ? 'item' : 'items'} · Automatically deleted after 30 days`}
            </p>
          </div>
        </div>
      </div>

      {totalCount === 0 ? (
        <div className="rounded-xl border border-[#E5E7EB] bg-[#FAFAFC] px-6 py-12 text-center">
          <Trash2 className="mx-auto h-6 w-6 text-[#9CA3AF]" aria-hidden="true" />
          <p className="mt-3 text-sm font-medium text-[#374151]">Trash is empty</p>
          <p className="mt-1 text-xs text-[#6B7280]">
            Deleted stories and sections remain recoverable here for 30 days.
          </p>
        </div>
      ) : (
        <div className="space-y-8 pb-16">
          {/* Trashed Stories */}
          {trashedStories.length > 0 && (
            <section aria-label="Trashed stories">
              <h2 className="mb-3 text-xs font-medium text-[#6B7280]">
                Stories ({trashedStories.length})
              </h2>
              <div className="space-y-3">
                {trashedStories.map((story) => {
                  const isBusy = busyItemId === story.id;
                  const isExpanded = expandedStoryId === story.id;
                  const previewSections = storySectionsMap[story.id];
                  const isLoadingPreview = loadingStoryId === story.id;

                  return (
                    <div
                      key={story.id}
                      className="rounded-xl border border-[#E5E7EB] bg-white p-4"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 sm:flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <FileText
                              className="h-4 w-4 shrink-0 text-[#6B7280]"
                              aria-hidden="true"
                            />
                            <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[#111827]">
                              {story.title || 'Untitled Story'}
                            </h3>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#6B7280] tabular-nums">
                            <span className="whitespace-nowrap">
                              {story.sectionCount ?? 0}{' '}
                              {(story.sectionCount ?? 0) === 1 ? 'section' : 'sections'}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="whitespace-nowrap font-medium text-[#B45309]">
                              {formatDaysLeft(story.deletedAt)}
                            </span>
                            {story.deletedAt ? (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="whitespace-nowrap">
                                  Deleted {formatTimestamp(story.deletedAt)}
                                </span>
                              </>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
                          <button
                            type="button"
                            onClick={() => {
                              void handleToggleStoryPreview(story.id);
                            }}
                            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-[#E5E7EB] bg-white px-2.5 py-1.5 text-xs font-medium text-[#4B5563] transition-colors hover:bg-[#F9FAFB] hover:text-[#111827]"
                          >
                            <span>{isExpanded ? 'Hide' : 'Preview'}</span>
                            {isExpanded ? (
                              <ChevronUp className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => onRestoreStory(story)}
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[#E5E7EB] bg-white px-2.5 py-1.5 text-xs font-medium text-[#312E81] transition-colors hover:border-[#C7D2FE] hover:bg-[#EEF2FF] disabled:opacity-50"
                          >
                            {isBusy ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5" />
                            )}
                            <span>Restore</span>
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => onRequestDeleteStoryForever(story)}
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-[#DC2626] transition-colors hover:bg-[#FEE2E2] disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Delete Forever</span>
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="mt-4 border-t border-[#E5E7EB] pt-3">
                          {isLoadingPreview ? (
                            <div className="flex items-center gap-2 py-2 text-xs text-[#6B7280]">
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-[#312E81]" />
                              <span>Loading sections…</span>
                            </div>
                          ) : !previewSections || previewSections.length === 0 ? (
                            <p className="text-xs text-[#6B7280]">
                              This story has no active sections.
                            </p>
                          ) : (
                            <div className="space-y-4">
                              {previewSections.map((sec, idx) => {
                                const activeVer = getActiveSectionVersion(sec);
                                const audioOpen = openAudioId === `story_${sec.id}`;
                                const copyKey = `story_${sec.id}`;
                                const hasCloudAudio = Boolean(sec.audioUrl || sec.storagePath);
                                const canPlayAudio =
                                  Boolean(sec.audioMeta) &&
                                  (hasCloudAudio ||
                                    Boolean(sec.audioId && localAudioMap[sec.audioId] === true));
                                const isOtherDeviceAudio =
                                  !hasCloudAudio &&
                                  Boolean(sec.audioId) &&
                                  localAudioMap[sec.audioId!] === false;
                                return (
                                  <div
                                    key={sec.id}
                                    className="rounded-lg border border-[#F3F4F6] bg-[#FAFAFC] p-3"
                                  >
                                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[#6B7280]">
                                      <div className="flex items-center gap-1.5">
                                        <span className="font-semibold text-[#111827]">
                                          Section {String(idx + 1).padStart(2, '0')}
                                        </span>
                                        <span aria-hidden="true">·</span>
                                        <span>
                                          {formatCompactStyleLabel(
                                            activeVer.style,
                                            activeVer.refinedEnding,
                                          )}
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-1">
                                        {canPlayAudio ? (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              setOpenAudioId(audioOpen ? null : `story_${sec.id}`)
                                            }
                                            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-[#4B5563] hover:bg-[#ECEEF1] hover:text-[#111827]"
                                          >
                                            <Headphones className="h-3.5 w-3.5" />
                                            <span>Audio</span>
                                          </button>
                                        ) : isOtherDeviceAudio ? (
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
                                          onClick={() => handleCopy(copyKey, activeVer.text)}
                                          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-[#4B5563] hover:bg-[#ECEEF1] hover:text-[#111827]"
                                        >
                                          {copiedId === copyKey ? (
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
                                      </div>
                                    </div>

                                    {audioOpen && canPlayAudio && sec.audioMeta ? (
                                      <div className="mb-3">
                                        <AudioPlayerBar
                                          audioUrl={sec.audioUrl}
                                          storagePath={sec.storagePath}
                                          audioId={sec.audioId}
                                          meta={sec.audioMeta}
                                          compact
                                        />
                                      </div>
                                    ) : null}

                                    <p className="font-manuscript whitespace-pre-wrap text-[15px] text-[#111827]">
                                      {activeVer.text}
                                    </p>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Trashed Individual Sections */}
          {trashedSections.length > 0 && (
            <section aria-label="Trashed sections">
              <h2 className="mb-3 text-xs font-medium text-[#6B7280]">
                Sections ({trashedSections.length})
              </h2>
              <div className="space-y-3">
                {trashedSections.map((sec) => {
                  const isBusy = busyItemId === sec.id;
                  const activeVer = getActiveSectionVersion(sec);
                  const hasCloudAudio = Boolean(sec.audioUrl || sec.storagePath);
                  const canPlayAudio =
                    Boolean(sec.audioMeta) &&
                    (hasCloudAudio || Boolean(sec.audioId && localAudioMap[sec.audioId] === true));
                  const isOtherDeviceAudio =
                    !hasCloudAudio && Boolean(sec.audioId) && localAudioMap[sec.audioId!] === false;
                  const audioOpen = openAudioId === sec.id;

                  return (
                    <div
                      key={sec.id}
                      className="rounded-xl border border-[#E5E7EB] bg-white p-4"
                    >
                      <div className="mb-3 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                        <div className="min-w-0 sm:flex-1">
                          <h3 className="truncate text-sm font-semibold text-[#111827]">
                            From: {sec.parentStoryTitle || 'Untitled Story'}
                          </h3>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#6B7280] tabular-nums">
                            <span className="whitespace-nowrap">
                              {formatCompactStyleLabel(activeVer.style, activeVer.refinedEnding)}
                            </span>
                            {sec.audioMeta && sec.audioMeta.durationSec > 0 ? (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="whitespace-nowrap font-mono text-[11px]">
                                  {formatDuration(sec.audioMeta.durationSec)}
                                </span>
                              </>
                            ) : null}
                            <span aria-hidden="true">·</span>
                            <span className="whitespace-nowrap font-medium text-[#B45309]">
                              {formatDaysLeft(sec.deletedAt)}
                            </span>
                            {sec.deletedAt ? (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="whitespace-nowrap">
                                  Deleted {formatTimestamp(sec.deletedAt)}
                                </span>
                              </>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:justify-end">
                          {canPlayAudio ? (
                            <button
                              type="button"
                              onClick={() => setOpenAudioId(audioOpen ? null : sec.id)}
                              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                                audioOpen
                                  ? 'bg-[#EEF2FF] text-[#312E81]'
                                  : 'text-[#4B5563] hover:bg-[#F3F4F6] hover:text-[#111827]'
                              }`}
                            >
                              <Headphones className="h-3.5 w-3.5" />
                              <span>Audio</span>
                            </button>
                          ) : isOtherDeviceAudio ? (
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
                            onClick={() => handleCopy(sec.id, activeVer.text)}
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-[#4B5563] transition-colors hover:bg-[#F3F4F6] hover:text-[#111827]"
                          >
                            {copiedId === sec.id ? (
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
                            disabled={isBusy}
                            onClick={() => onRestoreSection(sec)}
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[#E5E7EB] bg-white px-2.5 py-1.5 text-xs font-medium text-[#312E81] transition-colors hover:border-[#C7D2FE] hover:bg-[#EEF2FF] disabled:opacity-50"
                          >
                            {isBusy ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3.5 w-3.5" />
                            )}
                            <span>Restore</span>
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => onRequestDeleteSectionForever(sec)}
                            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium text-[#DC2626] transition-colors hover:bg-[#FEE2E2] disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Delete Forever</span>
                          </button>
                        </div>
                      </div>

                      {audioOpen && canPlayAudio && sec.audioMeta ? (
                        <div className="mb-3">
                          <AudioPlayerBar
                            audioUrl={sec.audioUrl}
                            storagePath={sec.storagePath}
                            audioId={sec.audioId}
                            meta={sec.audioMeta}
                            compact
                          />
                        </div>
                      ) : null}

                      <p className="font-manuscript whitespace-pre-wrap text-[15.5px] text-[#111827]">
                        {activeVer.text}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
