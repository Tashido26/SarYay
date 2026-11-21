import { useEffect, useRef, useState } from 'react';
import { Download, Pause, Play, Volume2 } from 'lucide-react';
import type { AudioMeta } from '../types.ts';
import { getAudioClip } from '../lib/audioDb.ts';
import { formatDuration, formatFileSize, triggerBlobDownload } from '../lib/format.ts';

interface AudioPlayerBarProps {
  /** Direct blob + object URL for staged audio before saving to IndexedDB */
  directBlob?: Blob;
  directUrl?: string;
  /** IndexedDB audio clip ID for persisted section audio */
  audioId?: string;
  meta: AudioMeta;
  compact?: boolean;
}

export function AudioPlayerBar({
  directBlob,
  directUrl,
  audioId,
  meta,
  compact = false,
}: AudioPlayerBarProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(directUrl ?? null);
  const [resolvedBlob, setResolvedBlob] = useState<Blob | null>(directBlob ?? null);
  const [loadingClip, setLoadingClip] = useState<boolean>(!directUrl && Boolean(audioId));
  const [missingClip, setMissingClip] = useState<boolean>(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(meta.durationSec || 0);

  useEffect(() => {
    if (directUrl && directBlob) {
      setResolvedUrl(directUrl);
      setResolvedBlob(directBlob);
      setLoadingClip(false);
      setMissingClip(false);
      setDuration(meta.durationSec || 0);
      setCurrentTime(0);
      setIsPlaying(false);
      return;
    }

    if (!audioId) {
      setLoadingClip(false);
      setMissingClip(true);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;
    setLoadingClip(true);
    setMissingClip(false);

    getAudioClip(audioId).then((record) => {
      if (cancelled) return;
      if (!record) {
        setMissingClip(true);
        setLoadingClip(false);
        return;
      }
      createdUrl = URL.createObjectURL(record.blob);
      setResolvedBlob(record.blob);
      setResolvedUrl(createdUrl);
      setDuration(record.meta.durationSec || meta.durationSec || 0);
      setLoadingClip(false);
    });

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [audioId, directBlob, directUrl, meta.durationSec]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime || 0);
    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    };
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };
    const onPause = () => setIsPlaying(false);
    const onPlay = () => setIsPlaying(true);

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('play', onPlay);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('play', onPlay);
    };
  }, [resolvedUrl]);

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio || !resolvedUrl) return;
    if (isPlaying) {
      audio.pause();
    } else {
      try {
        await audio.play();
      } catch (err) {
        console.warn('Audio playback blocked or failed:', err);
      }
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(e.target.value);
    setCurrentTime(next);
    if (audioRef.current) {
      audioRef.current.currentTime = next;
    }
  };

  const handleDownload = () => {
    if (!resolvedBlob) return;
    triggerBlobDownload(resolvedBlob, meta.filename || 'recording.webm');
  };

  if (loadingClip) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-[#E5E7EB] bg-[#F8F9FA] px-3.5 py-2.5 text-xs text-[#6B7280]">
        <Volume2 className="h-4 w-4 shrink-0 text-[#9CA3AF]" />
        <span>Loading saved audio clip…</span>
      </div>
    );
  }

  if (missingClip || !resolvedUrl) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-[#E5E7EB] bg-[#F8F9FA] px-3.5 py-2.5 text-xs text-[#6B7280]">
        <Volume2 className="h-4 w-4 shrink-0 text-[#9CA3AF]" />
        <span>Original audio clip is no longer in local browser storage.</span>
      </div>
    );
  }

  const maxSeek = duration > 0 ? duration : Math.max(currentTime, 1);

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-lg border border-[#E5E7EB] bg-[#F8F9FA] ${
        compact ? 'px-3 py-2' : 'px-4 py-3'
      }`}
    >
      <audio ref={audioRef} src={resolvedUrl} preload="metadata" />

      <button
        type="button"
        onClick={togglePlay}
        aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#4338CA] text-white transition-colors duration-150 hover:bg-[#3730A3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA]"
      >
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>

      <div className="min-w-[160px] flex-1">
        <div className="mb-1 flex items-center justify-between gap-2 text-xs text-[#6B7280]">
          <span className="truncate font-medium text-[#374151]" title={meta.filename}>
            {meta.filename}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-[#6B7280]">
            {formatDuration(currentTime)} / {formatDuration(duration)}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={maxSeek}
          step={0.1}
          value={Math.min(currentTime, maxSeek)}
          onChange={handleSeek}
          aria-label="Audio playback position"
          className="audio-scrubber block w-full"
        />
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <span className="hidden text-xs tabular-nums text-[#6B7280] sm:inline">
          {formatFileSize(meta.sizeBytes)}
        </span>
        <button
          type="button"
          onClick={handleDownload}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[#E5E7EB] bg-white px-3 py-1.5 text-xs font-medium text-[#374151] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA]"
          title="Download audio backup locally"
        >
          <Download className="h-3.5 w-3.5" />
          <span>Download Audio</span>
        </button>
      </div>
    </div>
  );
}
