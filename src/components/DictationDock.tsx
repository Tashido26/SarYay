import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronUp,
  Download,
  Loader2,
  Mic,
  Pause,
  Play,
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
  MODEL_LABELS,
  MODEL_SHORT_LABELS,
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
    targetStoryId: string,
  ) => Promise<void>;
}

const ACCEPTED_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.webm', '.ogg'];
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;
const MAX_SILENCE_CHECK_BYTES = 12 * 1024 * 1024; // Avoid decoding huge uploaded lectures into client RAM
const SILENCE_PEAK_THRESHOLD = 0.012; // ~ -38 dBFS minimum peak for audible speech
const SILENCE_RMS_THRESHOLD = 0.0035; // ~ -49 dBFS minimum 100ms frame RMS
const NO_SPEECH_ERROR_MESSAGE =
  'No clear speech detected. Please speak closer to the microphone and try again.';

async function hasAudibleSpeechInBlob(blob: Blob): Promise<boolean> {
  if (typeof window === 'undefined' || blob.size === 0) return true;
  if (blob.size > MAX_SILENCE_CHECK_BYTES) return true;

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return true;

  let ctx: AudioContext | null = null;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    ctx = new AudioCtx();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const channelCount = audioBuffer.numberOfChannels;
    const totalSamples = audioBuffer.length;
    if (channelCount === 0 || totalSamples === 0) return false;

    // Evaluate ~100ms frames with lightweight striding so brief quiet speech passes while dead silence or single mic clicks are caught
    const frameSize = Math.max(1, Math.floor(audioBuffer.sampleRate * 0.1));
    const stride = totalSamples > 240_000 ? 4 : 1;

    let globalPeak = 0;
    let maxFrameRms = 0;
    let audibleFrameCount = 0;

    for (let ch = 0; ch < channelCount; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let start = 0; start < totalSamples; start += frameSize) {
        const end = Math.min(totalSamples, start + frameSize);
        let sumSq = 0;
        let sampleCount = 0;
        for (let i = start; i < end; i += stride) {
          const v = data[i];
          const abs = v < 0 ? -v : v;
          if (abs > globalPeak) globalPeak = abs;
          sumSq += v * v;
          sampleCount++;
        }
        if (sampleCount > 0) {
          const frameRms = Math.sqrt(sumSq / sampleCount);
          if (frameRms > maxFrameRms) maxFrameRms = frameRms;
          if (frameRms >= SILENCE_RMS_THRESHOLD) {
            audibleFrameCount++;
          }
        }
      }
      // Early exit as soon as we confirm clear speech energy in any channel
      if (
        globalPeak >= SILENCE_PEAK_THRESHOLD &&
        maxFrameRms >= SILENCE_RMS_THRESHOLD &&
        audibleFrameCount > 0
      ) {
        return true;
      }
    }

    return (
      globalPeak >= SILENCE_PEAK_THRESHOLD &&
      maxFrameRms >= SILENCE_RMS_THRESHOLD &&
      audibleFrameCount > 0
    );
  } catch {
    // If browser cannot decode this specific audio container client-side, allow upload rather than falsely blocking
    return true;
  } finally {
    if (ctx) {
      ctx.close().catch(() => undefined);
    }
  }
}

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
  const [isPaused, setIsPaused] = useState(false);
  const [canPauseResume, setCanPauseResume] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [stagedAudio, setStagedAudio] = useState<StagedAudio | null>(null);
  const [stagedStoryId, setStagedStoryId] = useState<string | null>(null);
  const [isRecoveredDraft, setIsRecoveredDraft] = useState(false);
  const [hasFailedAttempt, setHasFailedAttempt] = useState(false);
  const [uploadMode, setUploadMode] = useState<ProcessingMode>('full_polish');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isMainTyping, setIsMainTyping] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processedStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const accumulatedDurationMsRef = useRef<number>(0);
  const segmentStartTimeRef = useRef<number>(0);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const isRecordingRef = useRef<boolean>(false);
  const isTranscribingRef = useRef<boolean>(false);
  const isPausedRef = useRef<boolean>(false);
  const storyIdRef = useRef<string>(storyId);
  const stagedStoryIdRef = useRef<string | null>(null);
  const mainBlurTimerRef = useRef<number | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const stagedUrlRef = useRef<string | null>(null);
  const settingsPopoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    storyIdRef.current = storyId;
  }, [storyId]);

  useEffect(() => {
    stagedStoryIdRef.current = stagedStoryId;
  }, [stagedStoryId]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    isTranscribingRef.current = isTranscribing;
  }, [isTranscribing]);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  // Smoothly slide/fade idle dock on mobile (< 1024px) ONLY when typing inside <main> (never Sidebar/Drawers)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isMainEditableTarget = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      if (!el.closest('main')) return false;
      const tag = el.tagName;
      if (tag === 'TEXTAREA') return true;
      if (tag === 'INPUT') {
        const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
        return !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset'].includes(type);
      }
      return el.isContentEditable;
    };

    const handleFocusIn = (e: FocusEvent) => {
      if (window.innerWidth >= 1024) return;
      if (isMainEditableTarget(e.target)) {
        if (mainBlurTimerRef.current !== null) {
          window.clearTimeout(mainBlurTimerRef.current);
          mainBlurTimerRef.current = null;
        }
        setIsMainTyping(true);
      }
    };

    const handleFocusOut = (e: FocusEvent) => {
      if (!isMainEditableTarget(e.target)) return;
      if (mainBlurTimerRef.current !== null) {
        window.clearTimeout(mainBlurTimerRef.current);
      }
      mainBlurTimerRef.current = window.setTimeout(() => {
        mainBlurTimerRef.current = null;
        if (window.innerWidth >= 1024 || !isMainEditableTarget(document.activeElement)) {
          setIsMainTyping(false);
        }
      }, 60);
    };

    const handleResize = () => {
      if (window.innerWidth >= 1024) {
        setIsMainTyping(false);
      }
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      window.removeEventListener('resize', handleResize);
      if (mainBlurTimerRef.current !== null) {
        window.clearTimeout(mainBlurTimerRef.current);
      }
    };
  }, []);

  // Dismiss upward settings popover on outside click or Escape
  useEffect(() => {
    if (!settingsOpen) return;
    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (settingsPopoverRef.current && target && !settingsPopoverRef.current.contains(target)) {
        setSettingsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [settingsOpen]);

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
    if (processedStreamRef.current) {
      for (const track of processedStreamRef.current.getTracks()) {
        track.stop();
      }
      processedStreamRef.current = null;
    }
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }
    releaseScreenWakeLock();
  }, [releaseScreenWakeLock]);

  const clearStagedAudio = useCallback((removeLocalDraft = false) => {
    const draftOwnerStoryId = stagedStoryIdRef.current || storyIdRef.current;
    if (stagedUrlRef.current) {
      URL.revokeObjectURL(stagedUrlRef.current);
      stagedUrlRef.current = null;
    }
    stagedStoryIdRef.current = null;
    setStagedStoryId(null);
    setStagedAudio(null);
    setIsRecoveredDraft(false);
    setHasFailedAttempt(false);
    setErrorMessage(null);
    if (removeLocalDraft && draftOwnerStoryId) {
      void deletePendingDraftAudio(draftOwnerStoryId);
    }
  }, []);

  const loadPendingDraftForStory = useCallback(
    (targetStoryId: string, isCancelled?: () => boolean) => {
      if (!targetStoryId) return;
      void getPendingDraftAudio(targetStoryId).then((draft) => {
        if (
          isCancelled?.() ||
          !draft ||
          !draft.blob ||
          draft.blob.size === 0 ||
          storyIdRef.current !== targetStoryId ||
          isRecordingRef.current ||
          isTranscribingRef.current
        ) {
          return;
        }
        if (stagedUrlRef.current) {
          URL.revokeObjectURL(stagedUrlRef.current);
        }
        const objectUrl = URL.createObjectURL(draft.blob);
        stagedUrlRef.current = objectUrl;
        stagedStoryIdRef.current = targetStoryId;
        setStagedStoryId(targetStoryId);
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
    },
    [],
  );

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
    // Never wipe staged audio or recovery state while actively recording or transcribing
    if (isRecordingRef.current || isTranscribingRef.current) return;

    if (stagedUrlRef.current) {
      URL.revokeObjectURL(stagedUrlRef.current);
      stagedUrlRef.current = null;
    }
    stagedStoryIdRef.current = null;
    setStagedStoryId(null);
    setStagedAudio(null);
    setIsRecoveredDraft(false);
    setHasFailedAttempt(false);
    setErrorMessage(null);
    setSettingsOpen(false);

    if (!storyId) return;
    loadPendingDraftForStory(storyId, () => cancelled);

    return () => {
      cancelled = true;
    };
  }, [storyId, loadPendingDraftForStory]);

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

  // Draw live microphone waveform on canvas while recording (flattens calmly when paused)
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

      const barCount = Math.min(44, Math.max(16, Math.floor(width / 6)));
      const barWidth = 2.5;
      const gap = (width - barCount * barWidth) / Math.max(1, barCount - 1);
      const centerY = height / 2;

      if (isPausedRef.current) {
        ctx.fillStyle = '#D1D5DB';
        for (let i = 0; i < barCount; i++) {
          const barHeight = 3;
          const x = i * (barWidth + gap);
          const y = centerY - barHeight / 2;
          ctx.beginPath();
          ctx.roundRect(x, y, barWidth, barHeight, 1.5);
          ctx.fill();
        }
        return;
      }

      analyser.getByteFrequencyData(dataArray);

      for (let i = 0; i < barCount; i++) {
        const binIndex = Math.min(
          bufferLength - 1,
          Math.floor((i / barCount) * (bufferLength * 0.75)),
        );
        const amplitude = dataArray[binIndex] / 255;
        const barHeight = Math.max(3, amplitude * (height - 4));
        const x = i * (barWidth + gap);
        const y = centerY - barHeight / 2;

        ctx.fillStyle = amplitude > 0.12 ? '#312E81' : '#CBD5E1';
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
    setSettingsOpen(false);

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

      // Route microphone through lightweight Web Audio speech clarity chain:
      // 85Hz high-pass filter (cuts rumble/fan hum) -> gentle +4dB gain -> soft-knee DynamicsCompressorNode (lifts quiet/whispered speech without clipping)
      let recordingStream: MediaStream = stream;
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const audioCtx = new AudioCtx();
          if (audioCtx.state === 'suspended') {
            await audioCtx.resume().catch(() => undefined);
          }
          const source = audioCtx.createMediaStreamSource(stream);

          const highPass = audioCtx.createBiquadFilter();
          highPass.type = 'highpass';
          highPass.frequency.value = 85;
          highPass.Q.value = 0.707;

          const inputGain = audioCtx.createGain();
          inputGain.gain.value = 1.6; // ~+4 dB gentle lift for quiet/whispered speech

          const compressor = audioCtx.createDynamicsCompressor();
          compressor.threshold.value = -24;
          compressor.knee.value = 24;
          compressor.ratio.value = 4;
          compressor.attack.value = 0.005;
          compressor.release.value = 0.22;

          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 128;
          analyser.smoothingTimeConstant = 0.78;

          source.connect(highPass);
          highPass.connect(inputGain);
          inputGain.connect(compressor);
          compressor.connect(analyser);

          if (typeof audioCtx.createMediaStreamDestination === 'function') {
            const destination = audioCtx.createMediaStreamDestination();
            compressor.connect(destination);
            if (destination.stream.getAudioTracks().length > 0) {
              processedStreamRef.current = destination.stream;
              recordingStream = destination.stream;
            }
          }

          audioContextRef.current = audioCtx;
          analyserRef.current = analyser;
        }
      } catch {
        // Fallback seamlessly to raw microphone stream if Web Audio processing is unsupported
        recordingStream = stream;
      }

      const appleSafari = isAppleSafariBrowser();
      const mimeType = pickSupportedRecorderMime();
      let recorder: MediaRecorder;
      try {
        recorder = mimeType
          ? new MediaRecorder(recordingStream, { mimeType })
          : new MediaRecorder(recordingStream);
      } catch {
        recorder = new MediaRecorder(recordingStream);
      }
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      setCanPauseResume(
        typeof recorder.pause === 'function' && typeof recorder.resume === 'function',
      );

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      const recordingStoryId = storyIdRef.current;

      recorder.onstop = async () => {
        const totalMs = isPausedRef.current
          ? accumulatedDurationMsRef.current
          : accumulatedDurationMsRef.current + Math.max(0, Date.now() - segmentStartTimeRef.current);
        const recordedDuration = Math.max(1, totalMs / 1000);

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
        setIsPaused(false);

        if (blob.size === 0) {
          setErrorMessage('No audio data was captured. Please check your microphone input.');
          return;
        }

        const measuredDuration = await getAudioDuration(blob, recordedDuration);
        const filename = buildRecordingFilename(storyTitle, resolvedMime);
        const objectUrl = URL.createObjectURL(blob);
        stagedUrlRef.current = objectUrl;

        // Immediately back up the finished recording to IndexedDB under its originating story
        void savePendingDraftAudio(
          recordingStoryId,
          blob,
          {
            filename,
            mimeType: resolvedMime,
            durationSec: measuredDuration,
            sizeBytes: blob.size,
          },
          'recording',
        );

        if (storyIdRef.current !== recordingStoryId) {
          URL.revokeObjectURL(objectUrl);
          stagedUrlRef.current = null;
          loadPendingDraftForStory(storyIdRef.current);
          return;
        }

        stagedStoryIdRef.current = recordingStoryId;
        setStagedStoryId(recordingStoryId);
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
        setIsPaused(false);
        setErrorMessage('Recording encountered an audio error. Please try again.');
      };

      // Continuous capture — never stops on silence until Stop Recording is clicked.
      // Omit timeslice on MP4/AAC & Apple Safari so iOS emits a single complete, seekable MP4 container.
      accumulatedDurationMsRef.current = 0;
      segmentStartTimeRef.current = Date.now();
      setElapsedSeconds(0);
      setIsPaused(false);
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
        if (isPausedRef.current) return;
        const currentMs =
          accumulatedDurationMsRef.current + Math.max(0, Date.now() - segmentStartTimeRef.current);
        setElapsedSeconds(currentMs / 1000);
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

  const handleTogglePauseResume = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || !isRecording) return;

    try {
      if (recorder.state === 'recording' && typeof recorder.pause === 'function') {
        recorder.pause();
        accumulatedDurationMsRef.current += Math.max(0, Date.now() - segmentStartTimeRef.current);
        setElapsedSeconds(accumulatedDurationMsRef.current / 1000);
        if (audioContextRef.current && audioContextRef.current.state === 'running') {
          audioContextRef.current.suspend().catch(() => undefined);
        }
        isPausedRef.current = true;
        setIsPaused(true);
      } else if (recorder.state === 'paused' && typeof recorder.resume === 'function') {
        recorder.resume();
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
          audioContextRef.current.resume().catch(() => undefined);
        }
        segmentStartTimeRef.current = Date.now();
        isPausedRef.current = false;
        setIsPaused(false);
      }
    } catch {
      setErrorMessage('Pause/Resume is not supported for this audio format on this device.');
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
    setSettingsOpen(false);

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
    const uploadStoryId = storyIdRef.current;
    const duration = await getAudioDuration(file, 0);
    const resolvedMime = file.type || 'audio/mpeg';
    const objectUrl = URL.createObjectURL(file);
    stagedUrlRef.current = objectUrl;

    void savePendingDraftAudio(
      uploadStoryId,
      file,
      {
        filename: file.name,
        mimeType: resolvedMime,
        durationSec: duration,
        sizeBytes: file.size,
      },
      'upload',
    );

    if (storyIdRef.current !== uploadStoryId) {
      URL.revokeObjectURL(objectUrl);
      stagedUrlRef.current = null;
      loadPendingDraftForStory(storyIdRef.current);
      return;
    }

    stagedStoryIdRef.current = uploadStoryId;
    setStagedStoryId(uploadStoryId);
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
    if (!stagedAudio || isTranscribingRef.current) return;
    const targetStoryId = stagedStoryIdRef.current || storyIdRef.current;
    if (!targetStoryId) return;

    setErrorMessage(null);
    setSettingsOpen(false);
    isTranscribingRef.current = true;
    setIsTranscribing(true);

    // Pre-upload silence / low-audio guard: avoid charging Gemini tokens on silent or inaudible clips
    const hasSpeech = await hasAudibleSpeechInBlob(stagedAudio.blob);
    if (!hasSpeech) {
      isTranscribingRef.current = false;
      setIsTranscribing(false);
      if (storyIdRef.current !== targetStoryId) {
        clearStagedAudio(false);
        if (storyIdRef.current) {
          loadPendingDraftForStory(storyIdRef.current);
        }
      } else {
        setHasFailedAttempt(false);
        setErrorMessage(NO_SPEECH_ERROR_MESSAGE);
      }
      return;
    }

    const effectiveMode: ProcessingMode =
      stagedAudio.source === 'upload' ? uploadMode : 'full_polish';
    const controller = new AbortController();
    abortControllerRef.current = controller;

    let switchedStoriesDuringRun = false;
    try {
      await onTranscribe(stagedAudio, effectiveMode, controller.signal, targetStoryId);
      // Only delete local IndexedDB draft backup after Firestore confirms the section save
      await deletePendingDraftAudio(targetStoryId);
      clearStagedAudio(false);
      switchedStoriesDuringRun = storyIdRef.current !== targetStoryId;
    } catch (err) {
      switchedStoriesDuringRun = storyIdRef.current !== targetStoryId;
      if (switchedStoriesDuringRun) {
        // User navigated to another story mid-transcription: keep Story A's draft safely in IndexedDB
        // so it recovers when returning to Story A, and never show Story A's Retry card on Story B.
        clearStagedAudio(false);
      } else if ((err as { name?: string })?.name === 'AbortError') {
        setErrorMessage('Canceled. Your audio is still backed up locally below.');
      } else {
        setHasFailedAttempt(true);
        const msg =
          err instanceof Error
            ? formatCloudErrorMessage(err)
            : 'Transcription failed. Please try again.';
        setErrorMessage(msg);
      }
    } finally {
      abortControllerRef.current = null;
      isTranscribingRef.current = false;
      setIsTranscribing(false);
      if (switchedStoriesDuringRun && storyIdRef.current) {
        loadPendingDraftForStory(storyIdRef.current);
      }
    }
  };

  const handleCancelTranscription = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  // Strictly bind staged audio & retry UI to its originating story unless actively transcribing
  const visibleStagedAudio =
    stagedAudio && (isTranscribing || !stagedStoryId || stagedStoryId === storyId)
      ? stagedAudio
      : null;
  const isUploadSummary =
    visibleStagedAudio?.source === 'upload' && uploadMode === 'summarize_structure';
  const mobileStyleText =
    style === 'refined_flow'
      ? refinedEnding === 'literary'
        ? 'Refined Lit'
        : 'Refined Spk'
      : STYLE_SHORT_LABELS[style];
  const desktopStyleText =
    style === 'refined_flow'
      ? `Refined (${refinedEnding === 'literary' ? 'Literary' : 'Spoken'})`
      : STYLE_SHORT_LABELS[style];
  const compactModelText = MODEL_SHORT_LABELS[model];
  const collapseIdleForMainTyping =
    isMainTyping &&
    !isRecording &&
    !visibleStagedAudio &&
    !isTranscribing &&
    !settingsOpen &&
    !errorMessage;

  const renderSettingsTriggerAndPopover = (compactWidthClass = 'max-w-[46%] sm:max-w-none') => (
    <div ref={settingsPopoverRef} className={`relative min-w-0 ${compactWidthClass}`}>
      {settingsOpen && (
        <div
          role="dialog"
          aria-label="Dictation style and model settings"
          className="absolute bottom-full left-0 z-50 mb-2.5 w-[min(336px,calc(100vw-24px))] rounded-2xl border border-[#E5E7EB] bg-white p-3.5 shadow-[0_12px_36px_rgba(17,24,39,0.14)]"
        >
          <div className="space-y-3">
            {/* Writing Style */}
            <div>
              <p className="mb-1.5 text-[11px] font-medium text-[#6B7280]">Writing style</p>
              <div
                role="radiogroup"
                aria-label="Output writing style"
                className="grid grid-cols-3 rounded-lg bg-[#F3F4F6] p-0.5"
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
                      className={`whitespace-nowrap rounded-md px-2 py-1.5 text-xs font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#312E81] disabled:opacity-60 ${
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
              <p className="mt-1.5 text-[11px] leading-snug text-[#6B7280]">
                {STYLE_DESCRIPTIONS[style]}
              </p>
            </div>

            {/* Refined Flow voice endings (Spoken / Literary) */}
            {style === 'refined_flow' && (
              <div>
                <p className="mb-1.5 text-[11px] font-medium text-[#6B7280]">Voice endings</p>
                <div
                  role="radiogroup"
                  aria-label="Refined Flow voice endings"
                  className="grid grid-cols-2 rounded-lg bg-[#F3F4F6] p-0.5"
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
                        className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#312E81] disabled:opacity-60 ${
                          active
                            ? 'bg-white text-[#312E81] shadow-xs'
                            : 'text-[#4B5563] hover:text-[#111827]'
                        }`}
                      >
                        {ending === 'colloquial' ? 'Spoken' : 'Literary'}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Gemini Model (Flash / Pro) */}
            <div className="border-t border-[#F3F4F6] pt-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium text-[#6B7280]">Model</p>
                <div
                  role="radiogroup"
                  aria-label="Gemini model"
                  className="inline-flex items-center rounded-lg bg-[#F3F4F6] p-0.5"
                >
                  {(['gemini-2.5-flash', 'gemini-2.5-pro'] as GeminiModel[]).map((option) => {
                    const active = model === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={isTranscribing}
                        title={MODEL_LABELS[option]}
                        onClick={() => onModelChange(option)}
                        className={`whitespace-nowrap rounded-md px-3 py-1 text-xs font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#312E81] disabled:opacity-60 ${
                          active
                            ? 'bg-white text-[#312E81] shadow-xs'
                            : 'text-[#4B5563] hover:text-[#111827]'
                        }`}
                      >
                        {MODEL_SHORT_LABELS[option]}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        disabled={isTranscribing}
        aria-expanded={settingsOpen}
        aria-haspopup="dialog"
        onClick={() => setSettingsOpen((prev) => !prev)}
        title={`${formatStyleWithEnding(style, refinedEnding)} · ${MODEL_LABELS[model]} — Tap to change`}
        className={`inline-flex h-10 max-w-full items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81] disabled:opacity-60 sm:gap-1.5 sm:px-3 ${
          settingsOpen
            ? 'border-[#312E81]/35 bg-[#EEF2FF] text-[#312E81]'
            : 'border-[#E5E7EB] bg-[#F8F9FA] text-[#374151] hover:border-[#D1D5DB] hover:bg-[#F3F4F6] hover:text-[#111827]'
        }`}
      >
        <span className="whitespace-nowrap sm:hidden">
          {mobileStyleText} · {compactModelText}
        </span>
        <span className="hidden truncate whitespace-nowrap sm:inline">
          {desktopStyleText} · {compactModelText}
        </span>
        <ChevronUp
          className={`h-3.5 w-3.5 shrink-0 text-[#6B7280] transition-transform duration-150 ${
            settingsOpen ? 'rotate-180 text-[#312E81]' : ''
          }`}
          aria-hidden="true"
        />
      </button>
    </div>
  );

  return (
    <div
      className={`ios-crisp-dock safe-bottom-dock w-full border-t border-[#E5E7EB] bg-white px-3 pt-2 shadow-[0_-4px_20px_rgba(17,24,39,0.05)] transition-[opacity,transform] duration-150 sm:border-t-0 sm:bg-white sm:px-6 sm:pt-2 sm:shadow-none ${
        collapseIdleForMainTyping
          ? 'pointer-events-none translate-y-full opacity-0 lg:pointer-events-auto lg:translate-y-0 lg:opacity-100'
          : 'translate-y-0 opacity-100'
      }`}
    >
      <section
        aria-label="Voice dictation and audio upload dock"
        onDragOver={(e) => {
          e.preventDefault();
          if (!isRecording && !isTranscribing) setIsDraggingOver(true);
        }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={handleDrop}
        className={`mx-auto max-w-3xl transition-colors duration-150 sm:rounded-2xl sm:border sm:px-3.5 sm:py-2.5 sm:shadow-[0_4px_24px_rgba(17,24,39,0.07)] ${
          isDraggingOver
            ? 'sm:border-[#312E81] bg-[#EEF2FF]/40'
            : 'sm:border-[#E5E7EB] bg-white'
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

        {errorMessage && (
          <div
            role="alert"
            className="mb-2.5 flex items-start justify-between gap-2.5 overflow-hidden rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs text-[#991B1B]"
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
          /* Active Recording State: expands smoothly in place with live waveform, timer, Pause/Resume & Stop */
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    isPaused ? 'bg-[#D97706]' : 'bg-[#DC2626]'
                  }`}
                  aria-hidden="true"
                />
                <span
                  className={`text-xs font-semibold whitespace-nowrap ${
                    isPaused ? 'text-[#B45309]' : 'text-[#DC2626]'
                  }`}
                >
                  {isPaused ? 'Paused' : 'Recording'}
                </span>
                <span className="font-mono text-xs font-medium tabular-nums text-[#111827]">
                  {formatDuration(elapsedSeconds)}
                </span>
              </div>

              <div className="min-w-[96px] flex-1 rounded-lg border border-[#E5E7EB] bg-[#F8F9FA] px-2.5 py-1">
                <canvas
                  ref={waveformCanvasRef}
                  className="block h-6 w-full"
                  aria-label="Live audio input waveform"
                />
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {canPauseResume && (
                <button
                  type="button"
                  onClick={handleTogglePauseResume}
                  className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-[#E5E7EB] bg-white px-3.5 text-xs font-medium text-[#374151] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81] sm:flex-initial"
                >
                  {isPaused ? (
                    <>
                      <Play className="h-3.5 w-3.5 fill-current text-[#312E81]" />
                      <span>Resume</span>
                    </>
                  ) : (
                    <>
                      <Pause className="h-3.5 w-3.5" />
                      <span>Pause</span>
                    </>
                  )}
                </button>
              )}

              <button
                type="button"
                onClick={stopRecording}
                className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-[#DC2626] px-4 text-xs font-medium text-white transition-colors duration-150 hover:bg-[#B91C1C] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#DC2626] sm:flex-initial"
              >
                <Square className="h-3 w-3 fill-current" />
                <span>Stop Recording</span>
              </button>
            </div>
          </div>
        ) : visibleStagedAudio ? (
          /* Staged Audio State: compact preview player, settings pill, Discard & Transcribe & Polish */
          <div className="space-y-2.5">
            {(isRecoveredDraft || hasFailedAttempt) && !isTranscribing && (
              <div
                role="status"
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#E5E7EB] bg-[#F8F9FA] px-3 py-2 text-xs text-[#374151]"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[#312E81]" aria-hidden="true" />
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
              directBlob={visibleStagedAudio.blob}
              directUrl={visibleStagedAudio.url}
              meta={{
                filename: visibleStagedAudio.filename,
                mimeType: visibleStagedAudio.mimeType,
                durationSec: visibleStagedAudio.durationSec,
                sizeBytes: visibleStagedAudio.sizeBytes,
              }}
              compact
            />

            {visibleStagedAudio.source === 'upload' && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-[#6B7280]">Upload mode</span>
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
                        className={`whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81] disabled:opacity-60 ${
                          active
                            ? 'bg-white text-[#312E81] shadow-xs'
                            : 'text-[#4B5563] hover:text-[#111827]'
                        }`}
                      >
                        {option === 'full_polish' ? 'Full Polish' : 'Summarize'}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              {renderSettingsTriggerAndPopover('max-w-[44%] sm:max-w-none')}

              <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
                {!isTranscribing && (
                  <button
                    type="button"
                    onClick={() => clearStagedAudio(true)}
                    className="inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-xl px-2.5 text-xs font-medium text-[#6B7280] transition-colors hover:bg-[#F3F4F6] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81]"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    <span>Discard</span>
                  </button>
                )}

                {isTranscribing && (
                  <button
                    type="button"
                    onClick={handleCancelTranscription}
                    className="inline-flex h-10 items-center whitespace-nowrap rounded-xl border border-[#E5E7EB] bg-white px-3 text-xs font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB]"
                  >
                    Cancel
                  </button>
                )}

                <button
                  type="button"
                  disabled={isTranscribing}
                  onClick={handleTranscribeClick}
                  title={`Process with ${formatStyleWithEnding(style, refinedEnding)} (${MODEL_LABELS[model]})`}
                  className="inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-xl bg-[#312E81] px-3.5 text-xs font-medium text-white transition-colors duration-150 hover:bg-[#27246A] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81] disabled:cursor-wait disabled:opacity-80 sm:px-4"
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
          /* Default Idle State: compact single clean row */
          <div className="flex items-center justify-between gap-2">
            {renderSettingsTriggerAndPopover('max-w-[44%] sm:max-w-none')}

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={startRecording}
                className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-[#312E81] px-3.5 text-xs font-medium text-white transition-colors duration-150 hover:bg-[#27246A] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81] sm:gap-2 sm:px-4 sm:text-[13px]"
              >
                <Mic className="h-4 w-4 shrink-0" />
                <span>Start Recording</span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Upload audio file"
                title="Upload audio file (MP3, WAV, M4A, WEBM, OGG)"
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-[#E5E7EB] bg-white text-xs font-medium text-[#374151] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#312E81] sm:w-auto sm:px-3.5"
              >
                <Upload className="h-4 w-4 shrink-0" />
                <span className="hidden sm:inline">Upload</span>
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
