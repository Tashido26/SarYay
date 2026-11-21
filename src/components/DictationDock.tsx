import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Download,
  Loader2,
  Mic,
  RotateCcw,
  ShieldCheck,
  Square,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import type {
  GeminiModel,
  ProcessingMode,
  StagedAudio,
  VoiceEnding,
  WritingStyle,
} from '../types.ts';
import {
  ENDING_LABELS,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  MODEL_LABELS,
  STYLE_DESCRIPTIONS,
  STYLE_SHORT_LABELS,
  formatStyleWithEnding,
} from '../types.ts';
import {
  buildRecordingFilename,
  formatDuration,
  getAudioDuration,
  triggerBlobDownload,
} from '../lib/format.ts';
import {
  deletePendingDraftAudio,
  getPendingDraftAudio,
  savePendingDraftAudio,
} from '../lib/audioDb.ts';
import { formatCloudErrorMessage } from '../lib/cloudStore.ts';
import { AudioPlayerBar } from './AudioPlayerBar.tsx';

interface WakeLockSentinelLike {
  released?: boolean;
  release: () => Promise<void>;
}

interface DictationDockProps {
  storyId: string;
  storyTitle: string;
  style: WritingStyle;
  refinedEnding: VoiceEnding;
  model: GeminiModel;
  onStyleChange: (style: WritingStyle) => void;
  onRefinedEndingChange: (ending: VoiceEnding) => void;
  onModelChange: (model: GeminiModel) => void;
  onTranscribe: (
    audio: StagedAudio,
    mode: ProcessingMode,
    signal: AbortSignal,
  ) => Promise<void>;
}

const ACCEPTED_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.webm', '.ogg'];
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

function isAppleSafariBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg/.test(ua);
  return isIOS || isSafari;
}

function pickSupportedRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  const appleSafari = isAppleSafariBrowser();
  // On iOS/Safari, prefer native MP4/AAC containers so recorded blobs play reliably on iPhone & Mac
  const candidates = appleSafari
    ? [
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4',
        'audio/aac',
        'audio/webm;codecs=opus',
        'audio/webm',
      ]
    : [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4',
        'audio/aac',
        'audio/ogg;codecs=opus',
      ];
  for (const mime of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    } catch {
      // Ignore invalid MIME query on older WebKit builds
    }
  }
  return '';
}

function isSupportedAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true;
  const lower = file.name.toLowerCase();
  return ACCEPTED_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function DictationDock({
  storyId,
  storyTitle,
  style,
  refinedEnding,
  model,
  onStyleChange,
  onRefinedEndingChange,
  onModelChange,
  onTranscribe,
}: DictationDockProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [stagedAudio, setStagedAudio] = useState<StagedAudio | null>(null);
  const [isRecoveredDraft, setIsRecoveredDraft] = useState(false);
  const [hasFailedAttempt, setHasFailedAttempt] = useState(false);
  const [uploadMode, setUploadMode] = useState<ProcessingMode>('full_polish');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const isRecordingRef = useRef<boolean>(false);
  const storyIdRef = useRef<string>(storyId);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const stagedUrlRef = useRef<string | null>(null);

  useEffect(() => {
    storyIdRef.current = storyId;
  }, [storyId]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  const requestScreenWakeLock = useCallback(async () => {
    if (typeof navigator === 'undefined') return;
    const wakeLockApi = (
      navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
      }
    ).wakeLock;
    if (!wakeLockApi?.request) return;
    try {
      if (wakeLockRef.current && !wakeLockRef.current.released) return;
      wakeLockRef.current = await wakeLockApi.request('screen');
    } catch {
      // Wake Lock is best-effort (may be unavailable in low-power mode or unsupported browsers)
    }
  }, []);

  const releaseScreenWakeLock = useCallback(() => {
    const sentinel = wakeLockRef.current;
    wakeLockRef.current = null;
    if (sentinel) {
      sentinel.release().catch(() => undefined);
    }
  }, []);

  const stopWaveformAndTracks = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (timerIntervalRef.current !== null) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }
    releaseScreenWakeLock();
  }, [releaseScreenWakeLock]);

  const clearStagedAudio = useCallback((removeLocalDraft = false) => {
    if (stagedUrlRef.current) {
      URL.revokeObjectURL(stagedUrlRef.current);
      stagedUrlRef.current = null;
    }
    setStagedAudio(null);
    setIsRecoveredDraft(false);
    setHasFailedAttempt(false);
    setErrorMessage(null);
    if (removeLocalDraft && storyIdRef.current) {
      void deletePendingDraftAudio(storyIdRef.current);
    }
  }, []);

  // Re-acquire Screen Wake Lock if user switches back to Safari/PWA mid-recording
  useEffect(() => {
    if (!isRecording) return;
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && isRecordingRef.current) {
        void requestScreenWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [isRecording, requestScreenWakeLock]);

  // Warn before accidental refresh/close while recording or while unsent audio is staged
  useEffect(() => {
    if (!isRecording && !stagedAudio && !isTranscribing) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isRecording, stagedAudio, isTranscribing]);

  // Restore any unsent local IndexedDB audio draft for the opened story
  useEffect(() => {
    let cancelled = false;
    if (isRecordingRef.current) return;

    if (stagedUrlRef.current) {
      URL.revokeObjectURL(stagedUrlRef.current);
      stagedUrlRef.current = null;
    }
    setStagedAudio(null);
    setIsRecoveredDraft(false);
    setHasFailedAttempt(false);
    setErrorMessage(null);

    if (!storyId) return;

    void getPendingDraftAudio(storyId).then((draft) => {
      if (cancelled || !draft || !draft.blob || draft.blob.size === 0 || isRecordingRef.current) {
        return;
      }
      const objectUrl = URL.createObjectURL(draft.blob);
      stagedUrlRef.current = objectUrl;
      setStagedAudio({
        blob: draft.blob,
        url: objectUrl,
        filename: draft.meta.filename,
        mimeType: draft.meta.mimeType || draft.blob.type || 'audio/webm',
        durationSec: draft.meta.durationSec,
        sizeBytes: draft.meta.sizeBytes || draft.blob.size,
        source: draft.source ?? 'recording',
      });
      setIsRecoveredDraft(true);
    });

    return () => {
      cancelled = true;
    };
  }, [storyId]);

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // Ignore teardown errors
        }
      }
      stopWaveformAndTracks();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (stagedUrlRef.current) {
        URL.revokeObjectURL(stagedUrlRef.current);
      }
    };
  }, [stopWaveformAndTracks]);

  // Draw live microphone waveform on canvas while recording
  useEffect(() => {
    if (!isRecording) return;
    const canvas = waveformCanvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const renderFrame = () => {
      animationFrameRef.current = requestAnimationFrame(renderFrame);
      analyser.getByteFrequencyData(dataArray);

      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const barCount = Math.min(44, Math.max(18, Math.floor(width / 6)));
      const barWidth = 2.5;
      const gap = (width - barCount * barWidth) / Math.max(1, barCount - 1);
      const centerY = height / 2;

      for (let i = 0; i < barCount; i++) {
        const binIndex = Math.min(
          bufferLength - 1,
          Math.floor((i / barCount) * (bufferLength * 0.75)),
        );
        const amplitude = dataArray[binIndex] / 255;
        const barHeight = Math.max(3, amplitude * (height - 4));
        const x = i * (barWidth + gap);
        const y = centerY - barHeight / 2;

        ctx.fillStyle = amplitude > 0.12 ? '#4338CA' : '#CBD5E1';
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, 1.5);
        ctx.fill();
      }
    };

    renderFrame();

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [isRecording]);

  const startRecording = async () => {
    setErrorMessage(null);

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setErrorMessage('Microphone recording is not supported in this browser.');
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      setErrorMessage('MediaRecorder API is unavailable in this browser.');
      return;
    }

    clearStagedAudio(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      mediaStreamRef.current = stream;

      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const audioCtx = new AudioCtx();
          if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => undefined);
          }
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 128;
          analyser.smoothingTimeConstant = 0.78;
          source.connect(analyser);
          audioContextRef.current = audioCtx;
          analyserRef.current = analyser;
        }
      } catch {
        // Optional waveform
      }

      const appleSafari = isAppleSafariBrowser();
      const mimeType = pickSupportedRecorderMime();
      let recorder: MediaRecorder;
      try {
        recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
      } catch {
        recorder = new MediaRecorder(stream);
      }
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const recordedDuration = Math.max(1, (Date.now() - startTimeRef.current) / 1000);
        const firstChunkType = chunksRef.current.find((c) => c.type)?.type || '';
        const resolvedMime =
          recorder.mimeType ||
          firstChunkType ||
          mimeType ||
          (appleSafari ? 'audio/mp4' : 'audio/webm');
        const blob = new Blob(chunksRef.current, { type: resolvedMime });
        chunksRef.current = [];
        stopWaveformAndTracks();
        setIsRecording(false);

        if (blob.size === 0) {
          setErrorMessage('No audio data was captured. Please check your microphone input.');
          return;
        }

        const measuredDuration = await getAudioDuration(blob, recordedDuration);
        const filename = buildRecordingFilename(storyTitle, resolvedMime);
        const objectUrl = URL.createObjectURL(blob);
        stagedUrlRef.current = objectUrl;

        // Immediately back up the finished recording to IndexedDB before transcription starts
        void savePendingDraftAudio(
          storyIdRef.current,
          blob,
          {
            filename,
            mimeType: resolvedMime,
            durationSec: measuredDuration,
            sizeBytes: blob.size,
          },
          'recording',
        );

        setIsRecoveredDraft(false);
        setHasFailedAttempt(false);
        setStagedAudio({
          blob,
          url: objectUrl,
          filename,
          mimeType: resolvedMime,
          durationSec: measuredDuration,
          sizeBytes: blob.size,
          source: 'recording',
        });
      };

      recorder.onerror = () => {
        stopWaveformAndTracks();
        setIsRecording(false);
        setErrorMessage('Recording encountered an audio error. Please try again.');
      };

      // Continuous capture — never stops on silence until Stop Recording is clicked.
      // Omit timeslice on MP4/AAC & Apple Safari so iOS emits a single complete, seekable MP4 container.
      startTimeRef.current = Date.now();
      setElapsedSeconds(0);
      const isMp4OrApple =
        appleSafari ||
        (recorder.mimeType || mimeType).toLowerCase().includes('mp4') ||
        (recorder.mimeType || mimeType).toLowerCase().includes('aac');
      if (isMp4OrApple) {
        recorder.start();
      } else {
        recorder.start(1000);
      }
      setIsRecording(true);
      void requestScreenWakeLock();

      timerIntervalRef.current = window.setInterval(() => {
        setElapsedSeconds((Date.now() - startTimeRef.current) / 1000);
      }, 250);
    } catch (err) {
      stopWaveformAndTracks();
      const domErr = err as { name?: string };
      if (domErr?.name === 'NotAllowedError' || domErr?.name === 'PermissionDeniedError') {
        setErrorMessage('Microphone permission denied. Allow microphone access or upload an audio file.');
      } else if (domErr?.name === 'NotFoundError') {
        setErrorMessage('No microphone detected. You can upload an audio file instead.');
      } else {
        setErrorMessage('Could not access microphone.');
      }
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  };

  const stageUploadedFile = async (file: File) => {
    setErrorMessage(null);

    if (!isSupportedAudioFile(file)) {
      setErrorMessage('Unsupported file format. Use MP3, WAV, M4A, WEBM, or OGG.');
      return;
    }

    if (file.size === 0) {
      setErrorMessage('The selected audio file is empty.');
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      setErrorMessage('Audio file exceeds the 60 MB limit.');
      return;
    }

    clearStagedAudio(true);
    const duration = await getAudioDuration(file, 0);
    const resolvedMime = file.type || 'audio/mpeg';
    const objectUrl = URL.createObjectURL(file);
    stagedUrlRef.current = objectUrl;

    void savePendingDraftAudio(
      storyIdRef.current,
      file,
      {
        filename: file.name,
        mimeType: resolvedMime,
        durationSec: duration,
        sizeBytes: file.size,
      },
      'upload',
    );

    setIsRecoveredDraft(false);
    setHasFailedAttempt(false);
    setStagedAudio({
      blob: file,
      url: objectUrl,
      filename: file.name,
      mimeType: resolvedMime,
      durationSec: duration,
      sizeBytes: file.size,
      source: 'upload',
    });
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await stageUploadedFile(file);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (isRecording || isTranscribing) return;
    const file = e.dataTransfer.files?.[0];
    if (file) {
      await stageUploadedFile(file);
    }
  };

  const handleDownloadStagedRaw = () => {
    if (!stagedAudio) return;
    triggerBlobDownload(stagedAudio.blob, stagedAudio.filename);
  };

  const handleTranscribeClick = async () => {
    if (!stagedAudio || isTranscribing) return;
    setErrorMessage(null);
    setIsTranscribing(true);

    const effectiveMode: ProcessingMode =
      stagedAudio.source === 'upload' ? uploadMode : 'full_polish';
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const targetStoryId = storyIdRef.current;

    try {
      await onTranscribe(stagedAudio, effectiveMode, controller.signal);
      // Only delete local IndexedDB draft backup after Firestore confirms the section save
      await deletePendingDraftAudio(targetStoryId);
      clearStagedAudio(false);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setErrorMessage('Canceled. Your audio is still backed up locally below.');
      } else {
        setHasFailedAttempt(true);
        const msg = err instanceof Error ? formatCloudErrorMessage(err) : 'Transcription failed. Please try again.';
        setErrorMessage(msg);
      }
    } finally {
      abortControllerRef.current = null;
      setIsTranscribing(false);
    }
  };

  const handleCancelTranscription = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const isUploadSummary = stagedAudio?.source === 'upload' && uploadMode === 'summarize_structure';

  return (
    <section
      aria-label="Voice dictation and audio upload"
      onDragOver={(e) => {
        e.preventDefault();
        if (!isRecording && !isTranscribing) setIsDraggingOver(true);
      }}
      onDragLeave={() => setIsDraggingOver(false)}
      onDrop={handleDrop}
      className={`rounded-xl border transition-colors duration-150 ${
        isDraggingOver ? 'border-[#4338CA] bg-[#EEF2FF]/35' : 'border-[#E5E7EB] bg-white'
      }`}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".mp3,.wav,.m4a,.webm,.ogg,audio/*"
        onChange={handleFileInputChange}
        className="hidden"
        aria-hidden="true"
      />

      {/* Sleek compact toolbar: Style selector + Refined endings (when active) + compact Flash/Pro switch */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#F3F4F6] px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="radiogroup"
            aria-label="Output writing style"
            className="inline-flex items-center rounded-lg bg-[#F3F4F6] p-0.5"
          >
            {(['colloquial', 'literary', 'refined_flow'] as WritingStyle[]).map((option) => {
              const active = style === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={isTranscribing}
                  title={STYLE_DESCRIPTIONS[option]}
                  onClick={() => onStyleChange(option)}
                  className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:opacity-60 ${
                    active
                      ? 'bg-white text-[#312E81] shadow-xs'
                      : 'text-[#4B5563] hover:text-[#111827]'
                  }`}
                >
                  {STYLE_SHORT_LABELS[option]}
                </button>
              );
            })}
          </div>

          {style === 'refined_flow' && (
            <div
              role="radiogroup"
              aria-label="Refined Flow voice endings"
              className="inline-flex items-center rounded-lg border border-[#E5E7EB] bg-[#FAFAFB] p-0.5"
            >
              {(['colloquial', 'literary'] as VoiceEnding[]).map((ending) => {
                const active = refinedEnding === ending;
                return (
                  <button
                    key={ending}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={isTranscribing}
                    title={ENDING_LABELS[ending]}
                    onClick={() => onRefinedEndingChange(ending)}
                    className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4338CA] disabled:opacity-60 ${
                      active
                        ? 'bg-white text-[#312E81] shadow-xs'
                        : 'text-[#6B7280] hover:text-[#111827]'
                    }`}
                  >
                    {ending === 'colloquial' ? 'Spoken' : 'Literary'}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Sleek compact Flash / Pro switch */}
        <div
          role="radiogroup"
          aria-label="Gemini model"
          className="inline-flex items-center rounded-lg bg-[#F3F4F6] p-0.5"
        >
          {(['gemini-2.5-flash', 'gemini-2.5-pro'] as GeminiModel[]).map((option) => {
            const active = model === option;
            const shortLabel = option === 'gemini-2.5-flash' ? 'Flash' : 'Pro';
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={isTranscribing}
                title={MODEL_LABELS[option]}
                onClick={() => onModelChange(option)}
                className={`whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:opacity-60 ${
                  active
                    ? 'bg-white text-[#312E81] shadow-xs'
                    : 'text-[#4B5563] hover:text-[#111827]'
                }`}
              >
                {shortLabel}
              </button>
            );
          })}
        </div>
      </div>

      {/* Compact action / recording / staged body */}
      <div className="px-4 py-3.5">
        {errorMessage && (
          <div
            role="alert"
            className="mb-3 flex items-start justify-between gap-2.5 overflow-hidden rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-2.5 text-xs text-[#991B1B]"
          >
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#DC2626]" />
              <p className="min-w-0 flex-1 break-words leading-relaxed [overflow-wrap:anywhere]">
                {errorMessage}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              aria-label="Dismiss error"
              className="shrink-0 rounded p-0.5 text-[#991B1B] hover:bg-[#FEE2E2]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {isRecording ? (
          /* Active Continuous Recording (compact single-focus row) */
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex shrink-0 items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full bg-[#DC2626]"
                aria-hidden="true"
              />
              <span className="text-xs font-semibold text-[#DC2626]">Recording</span>
              <span className="font-mono text-xs font-medium tabular-nums text-[#111827]">
                {formatDuration(elapsedSeconds)}
              </span>
            </div>

            <div className="min-w-[120px] flex-1 rounded-md border border-[#E5E7EB] bg-[#F8F9FA] px-3 py-1.5">
              <canvas
                ref={waveformCanvasRef}
                className="block h-6 w-full"
                aria-label="Live audio input waveform"
              />
            </div>

            <button
              type="button"
              onClick={stopRecording}
              className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-[#DC2626] px-4 py-2 text-xs font-medium text-white transition-colors duration-150 hover:bg-[#B91C1C] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#DC2626]"
            >
              <Square className="h-3 w-3 fill-current" />
              <span>Stop Recording</span>
            </button>
          </div>
        ) : stagedAudio ? (
          /* Staged Audio Preview, Recovery Banner (if restored/interrupted), Upload Mode & Transcribe */
          <div className="space-y-3">
            {(isRecoveredDraft || hasFailedAttempt) && !isTranscribing && (
              <div
                role="status"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#E5E7EB] bg-[#F8F9FA] px-3 py-2 text-xs text-[#374151]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[#4338CA]" aria-hidden="true" />
                  <span className="leading-snug">
                    {hasFailedAttempt
                      ? 'Audio safely backed up on this device. Retry when ready or download a copy.'
                      : 'Recovered unsent recording backed up on this device.'}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleTranscribeClick}
                    className="inline-flex items-center gap-1 rounded-md border border-[#D1D5DB] bg-white px-2.5 py-1 text-[11px] font-medium text-[#312E81] transition-colors hover:bg-[#EEF2FF]"
                  >
                    <RotateCcw className="h-3 w-3" />
                    <span>Retry</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadStagedRaw}
                    className="inline-flex items-center gap-1 rounded-md border border-[#E5E7EB] bg-white px-2.5 py-1 text-[11px] font-medium text-[#4B5563] transition-colors hover:bg-[#F3F4F6] hover:text-[#111827]"
                  >
                    <Download className="h-3 w-3" />
                    <span>Download Raw Audio</span>
                  </button>
                </div>
              </div>
            )}

            <AudioPlayerBar
              directBlob={stagedAudio.blob}
              directUrl={stagedAudio.url}
              meta={{
                filename: stagedAudio.filename,
                mimeType: stagedAudio.mimeType,
                durationSec: stagedAudio.durationSec,
                sizeBytes: stagedAudio.sizeBytes,
              }}
              compact
            />

            <div className="flex flex-wrap items-center justify-between gap-2.5">
              {stagedAudio.source === 'upload' ? (
                <div
                  role="radiogroup"
                  aria-label="Uploaded audio output mode"
                  className="inline-flex items-center rounded-lg bg-[#F3F4F6] p-0.5"
                >
                  {(['full_polish', 'summarize_structure'] as ProcessingMode[]).map((option) => {
                    const active = uploadMode === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={isTranscribing}
                        title={MODE_DESCRIPTIONS[option]}
                        onClick={() => setUploadMode(option)}
                        className={`whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:opacity-60 ${
                          active
                            ? 'bg-white text-[#312E81] shadow-xs'
                            : 'text-[#4B5563] hover:text-[#111827]'
                        }`}
                      >
                        {MODE_LABELS[option]}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <button
                  type="button"
                  disabled={isTranscribing}
                  onClick={() => clearStagedAudio(true)}
                  className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-[#6B7280] transition-colors hover:text-[#111827] disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Discard</span>
                </button>
              )}

              <div className="ml-auto flex items-center gap-2">
                {stagedAudio.source === 'upload' && !isTranscribing && (
                  <button
                    type="button"
                    onClick={() => clearStagedAudio(true)}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-xs font-medium text-[#6B7280] transition-colors hover:bg-[#F3F4F6] hover:text-[#111827]"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Discard</span>
                  </button>
                )}

                {isTranscribing && (
                  <button
                    type="button"
                    onClick={handleCancelTranscription}
                    className="inline-flex items-center whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-3 py-2 text-xs font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB]"
                  >
                    Cancel
                  </button>
                )}

                <button
                  type="button"
                  disabled={isTranscribing}
                  onClick={handleTranscribeClick}
                  title={`Process with ${formatStyleWithEnding(style, refinedEnding)} (${MODEL_LABELS[model]})`}
                  className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-[#4338CA] px-4 py-2 text-xs font-medium text-white transition-colors duration-150 hover:bg-[#3730A3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:cursor-wait disabled:opacity-80"
                >
                  {isTranscribing ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>{isUploadSummary ? 'Summarizing…' : 'Transcribing…'}</span>
                    </>
                  ) : (
                    <>
                      <Wand2 className="h-3.5 w-3.5" />
                      <span>
                        {isUploadSummary ? 'Summarize & Structure' : 'Transcribe & Polish'}
                      </span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* Idle: Clean side-by-side touch-friendly action buttons */
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={startRecording}
              className="inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[#4338CA] px-4 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-[#3730A3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] sm:flex-initial sm:py-2"
            >
              <Mic className="h-4 w-4 shrink-0" />
              <span>Start Recording</span>
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-4 py-2.5 text-sm font-medium text-[#374151] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] sm:flex-initial sm:py-2"
            >
              <Upload className="h-4 w-4 shrink-0" />
              <span>Upload Audio</span>
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
