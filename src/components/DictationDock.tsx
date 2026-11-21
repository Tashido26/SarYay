import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Loader2,
  Mic,
  RotateCcw,
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
  STYLE_LABELS,
  formatStyleWithEnding,
} from '../types.ts';
import {
  buildRecordingFilename,
  formatDuration,
  getAudioDuration,
} from '../lib/format.ts';
import { AudioPlayerBar } from './AudioPlayerBar.tsx';

interface DictationDockProps {
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
  hasSections: boolean;
}

const ACCEPTED_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.webm', '.ogg'];
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

function pickSupportedRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
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
  storyTitle,
  style,
  refinedEnding,
  model,
  onStyleChange,
  onRefinedEndingChange,
  onModelChange,
  onTranscribe,
  hasSections,
}: DictationDockProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [stagedAudio, setStagedAudio] = useState<StagedAudio | null>(null);
  const [uploadMode, setUploadMode] = useState<ProcessingMode>('full_polish');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerIntervalRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const stagedUrlRef = useRef<string | null>(null);

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
  }, []);

  const clearStagedAudio = useCallback(() => {
    if (stagedUrlRef.current) {
      URL.revokeObjectURL(stagedUrlRef.current);
      stagedUrlRef.current = null;
    }
    setStagedAudio(null);
    setErrorMessage(null);
  }, []);

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

      const barCount = Math.min(48, Math.max(20, Math.floor(width / 7)));
      const barWidth = 3;
      const gap = (width - barCount * barWidth) / Math.max(1, barCount - 1);
      const centerY = height / 2;

      for (let i = 0; i < barCount; i++) {
        const binIndex = Math.min(bufferLength - 1, Math.floor((i / barCount) * (bufferLength * 0.75)));
        const amplitude = dataArray[binIndex] / 255;
        const barHeight = Math.max(3, amplitude * (height - 6));
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
      setErrorMessage('Microphone recording is not supported in this browser. You can upload an audio file instead.');
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      setErrorMessage('MediaRecorder API is unavailable in this browser. Please upload an audio file instead.');
      return;
    }

    clearStagedAudio();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      mediaStreamRef.current = stream;

      // Setup Web Audio AnalyserNode purely for live visual feedback (never auto-stops on silence)
      try {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const audioCtx = new AudioCtx();
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 128;
          analyser.smoothingTimeConstant = 0.78;
          source.connect(analyser);
          audioContextRef.current = audioCtx;
          analyserRef.current = analyser;
        }
      } catch {
        // Waveform visualization is optional; recording continues cleanly without it
      }

      const mimeType = pickSupportedRecorderMime();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const recordedDuration = Math.max(1, (Date.now() - startTimeRef.current) / 1000);
        const resolvedMime = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: resolvedMime });
        chunksRef.current = [];
        stopWaveformAndTracks();
        setIsRecording(false);

        if (blob.size === 0) {
          setErrorMessage('No audio data was captured. Please check your microphone input and try again.');
          return;
        }

        const measuredDuration = await getAudioDuration(blob, recordedDuration);
        const objectUrl = URL.createObjectURL(blob);
        stagedUrlRef.current = objectUrl;

        setStagedAudio({
          blob,
          url: objectUrl,
          filename: buildRecordingFilename(storyTitle, resolvedMime),
          mimeType: resolvedMime,
          durationSec: measuredDuration,
          sizeBytes: blob.size,
          source: 'recording',
        });
      };

      recorder.onerror = () => {
        stopWaveformAndTracks();
        setIsRecording(false);
        setErrorMessage('Recording encountered an audio hardware error. Please try again.');
      };

      // Record continuously with 1-second chunk intervals until user explicitly clicks Stop Recording.
      // No silence detection or auto-cutoff is ever applied.
      startTimeRef.current = Date.now();
      setElapsedSeconds(0);
      recorder.start(1000);
      setIsRecording(true);

      timerIntervalRef.current = window.setInterval(() => {
        setElapsedSeconds((Date.now() - startTimeRef.current) / 1000);
      }, 250);
    } catch (err) {
      stopWaveformAndTracks();
      const domErr = err as { name?: string };
      if (domErr?.name === 'NotAllowedError' || domErr?.name === 'PermissionDeniedError') {
        setErrorMessage(
          'Microphone permission was denied. Please allow microphone access in your browser settings, or upload an audio file.',
        );
      } else if (domErr?.name === 'NotFoundError') {
        setErrorMessage('No microphone was detected on this device. You can upload an audio file instead.');
      } else {
        setErrorMessage('Could not access microphone. Please check your audio device settings.');
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
      setErrorMessage('Unsupported file format. Please upload an MP3, WAV, M4A, WEBM, or OGG audio file.');
      return;
    }

    if (file.size === 0) {
      setErrorMessage('The selected audio file is empty.');
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      setErrorMessage('Audio file is larger than 60 MB. Please split or compress the recording first.');
      return;
    }

    clearStagedAudio();
    const duration = await getAudioDuration(file, 0);
    const objectUrl = URL.createObjectURL(file);
    stagedUrlRef.current = objectUrl;

    setStagedAudio({
      blob: file,
      url: objectUrl,
      filename: file.name,
      mimeType: file.type || 'audio/mpeg',
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

  const handleTranscribeClick = async () => {
    if (!stagedAudio || isTranscribing) return;
    setErrorMessage(null);
    setIsTranscribing(true);

    const effectiveMode: ProcessingMode =
      stagedAudio.source === 'upload' ? uploadMode : 'full_polish';
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      await onTranscribe(stagedAudio, effectiveMode, controller.signal);
      clearStagedAudio();
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        setErrorMessage('Processing canceled. Your audio file is still staged below.');
      } else {
        const msg = err instanceof Error ? err.message : 'Transcription failed. Please try again.';
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

  return (
    <section
      aria-label="Voice dictation and audio upload studio"
      onDragOver={(e) => {
        e.preventDefault();
        if (!isRecording && !isTranscribing) setIsDraggingOver(true);
      }}
      onDragLeave={() => setIsDraggingOver(false)}
      onDrop={handleDrop}
      className={`rounded-xl border transition-colors duration-150 ${
        isDraggingOver
          ? 'border-[#4338CA] bg-[#EEF2FF]/40'
          : 'border-[#E5E7EB] bg-white'
      }`}
    >
      {/* Pre-configured style & model toolbar above recorder */}
      <div className="flex flex-col gap-3 border-b border-[#E5E7EB] px-5 py-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="radiogroup"
            aria-label="Output writing style"
            className="inline-flex flex-wrap items-center gap-0.5 rounded-lg bg-[#F3F4F6] p-1"
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
                  className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:opacity-60 ${
                    active
                      ? 'bg-white text-[#312E81] shadow-xs'
                      : 'text-[#4B5563] hover:text-[#111827]'
                  }`}
                >
                  {STYLE_LABELS[option]}
                </button>
              );
            })}
          </div>
        </div>

        <div
          role="radiogroup"
          aria-label="Gemini model"
          className="inline-flex w-fit items-center rounded-lg bg-[#F3F4F6] p-1"
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
                onClick={() => onModelChange(option)}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:opacity-60 ${
                  active
                    ? 'bg-white text-[#312E81] shadow-xs'
                    : 'text-[#4B5563] hover:text-[#111827]'
                }`}
              >
                {MODEL_LABELS[option]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Style nuance caption & optional Refined Flow endings selector */}
      <div className="flex flex-col gap-2.5 border-b border-[#F3F4F6] bg-[#FAFAFB] px-5 py-2.5 text-xs text-[#6B7280] sm:flex-row sm:items-center sm:justify-between">
        <p className="leading-relaxed">
          <span className="font-medium text-[#374151]">{STYLE_LABELS[style]}:</span>{' '}
          {STYLE_DESCRIPTIONS[style]}
        </p>

        {style === 'refined_flow' && (
          <div className="flex shrink-0 items-center gap-2">
            <span className="whitespace-nowrap text-[11px] font-medium text-[#4B5563]">
              Voice Endings:
            </span>
            <div
              role="radiogroup"
              aria-label="Refined Flow voice endings"
              className="inline-flex items-center rounded-md bg-[#ECEEF1] p-0.5"
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
                    className={`whitespace-nowrap rounded px-2.5 py-1 text-[11px] font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#4338CA] disabled:opacity-60 ${
                      active
                        ? 'bg-white text-[#312E81] shadow-xs'
                        : 'text-[#4B5563] hover:text-[#111827]'
                    }`}
                  >
                    {ending === 'colloquial' ? 'Colloquial' : 'Literary'}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Main recorder / staging body */}
      <div className="p-5">
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp3,.wav,.m4a,.webm,.ogg,audio/*"
          onChange={handleFileInputChange}
          className="hidden"
          aria-hidden="true"
        />

        {/* Error feedback */}
        {errorMessage && (
          <div
            role="alert"
            className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-4 py-3 text-xs text-[#991B1B]"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626]" />
              <p className="leading-relaxed">{errorMessage}</p>
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

        {/* STATE 1: Active Continuous Recording */}
        {isRecording ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#DC2626]" aria-hidden="true" />
                <span className="text-sm font-semibold text-[#DC2626]">Recording</span>
                <span aria-hidden="true" className="text-[#D1D5DB]">·</span>
                <span className="font-mono text-sm font-medium tabular-nums text-[#111827]">
                  {formatDuration(elapsedSeconds)}
                </span>
              </div>

              <button
                type="button"
                onClick={stopRecording}
                className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-[#DC2626] px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-[#B91C1C] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#DC2626]"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                <span>Stop Recording</span>
              </button>
            </div>

            {/* Live microphone waveform canvas */}
            <div className="rounded-lg border border-[#E5E7EB] bg-[#F8F9FA] px-4 py-3">
              <canvas
                ref={waveformCanvasRef}
                className="block h-12 w-full"
                aria-label="Live audio input waveform"
              />
            </div>

            <p className="text-xs text-[#6B7280]">
              Continuous capture is active — pause silently for as long as you need to think. Recording will only stop when you click Stop Recording.
            </p>
          </div>
        ) : stagedAudio ? (
          /* STATE 2: Staged Audio Preview, Backup & Transcribe */
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-[#374151]">
                {stagedAudio.source === 'recording' ? 'Recorded Audio Ready' : 'Uploaded Audio Ready'}
              </p>
              {!isTranscribing && (
                <button
                  type="button"
                  onClick={clearStagedAudio}
                  className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-[#6B7280] transition-colors hover:text-[#111827]"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Discard &amp; Record New</span>
                </button>
              )}
            </div>

            <AudioPlayerBar
              directBlob={stagedAudio.blob}
              directUrl={stagedAudio.url}
              meta={{
                filename: stagedAudio.filename,
                mimeType: stagedAudio.mimeType,
                durationSec: stagedAudio.durationSec,
                sizeBytes: stagedAudio.sizeBytes,
              }}
            />

            {/* Optional output mode selector for uploaded audio files */}
            {stagedAudio.source === 'upload' && (
              <div className="rounded-lg border border-[#E5E7EB] bg-[#FAFAFB] px-4 py-3">
                <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-xs font-medium text-[#374151] whitespace-nowrap">
                    Upload Output Mode
                  </span>
                  <div
                    role="radiogroup"
                    aria-label="Uploaded audio processing mode"
                    className="inline-flex w-fit items-center rounded-lg bg-[#ECEEF1] p-1"
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
                          onClick={() => setUploadMode(option)}
                          className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:opacity-60 ${
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
                </div>
                <p className="mt-2 text-xs text-[#6B7280]">{MODE_DESCRIPTIONS[uploadMode]}</p>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p className="text-xs text-[#6B7280]">
                {isTranscribing
                  ? stagedAudio.source === 'upload' && uploadMode === 'summarize_structure'
                    ? `Summarizing and structuring audio into ${formatStyleWithEnding(style, refinedEnding)} with ${MODEL_LABELS[model]}…`
                    : `Processing audio into ${formatStyleWithEnding(style, refinedEnding)} with ${MODEL_LABELS[model]}…`
                  : 'Play back or download your backup above before processing.'}
              </p>

              <div className="flex items-center gap-2.5">
                {isTranscribing ? (
                  <button
                    type="button"
                    onClick={handleCancelTranscription}
                    className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-4 py-2.5 text-sm font-medium text-[#374151] transition-colors hover:bg-[#F9FAFB]"
                  >
                    <span>Cancel</span>
                  </button>
                ) : null}

                <button
                  type="button"
                  disabled={isTranscribing}
                  onClick={handleTranscribeClick}
                  className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-[#4338CA] px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-[#3730A3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:cursor-wait disabled:opacity-80"
                >
                  {isTranscribing ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>
                        {stagedAudio.source === 'upload' && uploadMode === 'summarize_structure'
                          ? 'Summarizing…'
                          : 'Transcribing…'}
                      </span>
                    </>
                  ) : (
                    <>
                      <Wand2 className="h-4 w-4" />
                      <span>
                        {stagedAudio.source === 'upload' && uploadMode === 'summarize_structure'
                          ? 'Summarize & Structure'
                          : 'Transcribe & Polish'}
                      </span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* STATE 3: Ready to Dictate or Upload */
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-[#111827]">
                {hasSections ? 'Continue with a new section' : 'Dictate or upload your voice note'}
              </h2>
              <p className="text-xs leading-relaxed text-[#6B7280]">
                Speak naturally in Burmese or mixed English with zero silence cutoff, or drop an MP3, WAV, M4A, WEBM, or OGG file here.
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={startRecording}
                className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-[#4338CA] px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-[#3730A3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA]"
              >
                <Mic className="h-4 w-4 shrink-0" />
                <span>Start Recording</span>
              </button>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-[#E5E7EB] bg-white px-4 py-2.5 text-sm font-medium text-[#374151] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA]"
              >
                <Upload className="h-4 w-4 shrink-0" />
                <span>Upload Audio</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
