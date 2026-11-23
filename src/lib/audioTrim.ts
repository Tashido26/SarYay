export interface AudioCompactionResult {
  blob: Blob;
  mimeType: string;
  durationSec: number;
  originalDurationSec: number;
  trimmedSilenceSec: number;
  wasCompacted: boolean;
}

const TARGET_SAMPLE_RATE = 16_000;
const FRAME_DURATION_SEC = 0.025; // 25ms RMS analysis windows
const PRE_ROLL_SEC = 0.15; // Preserve 150ms before speech starts
const TRAILING_TAIL_SEC = 0.25; // Preserve 250ms after final speech ends
const MAX_PRESERVED_PAUSE_SEC = 0.8; // Trim pauses longer than 0.8s down to 0.8s
const PAUSE_HALF_SEC = MAX_PRESERVED_PAUSE_SEC / 2; // 0.4s tail + 0.4s pre-roll = 0.8s natural pause
const SPLICE_FADE_SEC = 0.012; // 12ms smooth cosine fade at cut boundaries (zero clicks)
const MIN_CLIP_DURATION_SEC = 1.5;
const MIN_TRIM_TO_APPLY_SEC = 2.0;
const SIGNIFICANT_TRIM_SEC = 5.0;
const MAX_CLIENT_DECODE_BYTES = 24 * 1024 * 1024; // Avoid mobile browser OOM on huge blobs
const INLINE_FRIENDLY_WAV_BYTES = Math.round(4.2 * 1024 * 1024);

interface SampleRange {
  start: number;
  end: number;
  fadeIn: boolean;
  fadeOut: boolean;
}

export function formatTrimmedSilenceLabel(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 1) return '0s';
  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  if (minutes > 0 && seconds > 0) {
    return `${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

function mixBufferToMono(audioBuffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = audioBuffer;
  if (numberOfChannels === 1) {
    return audioBuffer.getChannelData(0);
  }
  const mono = new Float32Array(length);
  const scale = 1 / numberOfChannels;
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i] * scale;
    }
  }
  return mono;
}

function computeAdaptiveThreshold(frameRms: Float32Array, maxRms: number): number {
  const sorted = Float32Array.from(frameRms);
  sorted.sort();
  const p15Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.15));
  const noiseFloor = sorted[p15Index] ?? 0;

  // Adaptive threshold stays well above ambient room floor while preserving quiet/whispered Burmese speech
  const floorBased = noiseFloor * 2.4 + 0.0018;
  const relativeToVoice = maxRms * 0.045;
  const ceiling = Math.max(0.018, maxRms * 0.14);

  return Math.min(Math.max(0.0045, floorBased, relativeToVoice), ceiling);
}

function buildKeptRanges(
  mono: Float32Array,
  sampleRate: number,
): SampleRange[] | null {
  const totalSamples = mono.length;
  const frameSize = Math.max(1, Math.round(sampleRate * FRAME_DURATION_SEC));
  const numFrames = Math.ceil(totalSamples / frameSize);
  if (numFrames < 8) return null;

  const frameRms = new Float32Array(numFrames);
  let maxRms = 0;

  for (let f = 0; f < numFrames; f++) {
    const start = f * frameSize;
    const end = Math.min(totalSamples, start + frameSize);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const s = mono[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - start));
    frameRms[f] = rms;
    if (rms > maxRms) maxRms = rms;
  }

  // If essentially dead silence, let the pre-upload silence guard handle it without altering the clip
  if (maxRms < 0.003) {
    return null;
  }

  const threshold = computeAdaptiveThreshold(frameRms, maxRms);
  const isSpeech = new Uint8Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    if (frameRms[f] >= threshold) {
      isSpeech[f] = 1;
    }
  }

  // Suppress isolated single-frame (25ms) faint clicks surrounded by silence
  for (let f = 1; f < numFrames - 1; f++) {
    if (
      isSpeech[f] === 1 &&
      isSpeech[f - 1] === 0 &&
      isSpeech[f + 1] === 0 &&
      frameRms[f] < threshold * 2.0
    ) {
      isSpeech[f] = 0;
    }
  }

  // Extract contiguous raw speech islands (in samples)
  const rawIslands: Array<{ start: number; end: number }> = [];
  let inIsland = false;
  let islandStartFrame = 0;

  for (let f = 0; f < numFrames; f++) {
    if (isSpeech[f] === 1 && !inIsland) {
      inIsland = true;
      islandStartFrame = f;
    } else if (isSpeech[f] === 0 && inIsland) {
      inIsland = false;
      rawIslands.push({
        start: islandStartFrame * frameSize,
        end: Math.min(totalSamples, f * frameSize),
      });
    }
  }
  if (inIsland) {
    rawIslands.push({
      start: islandStartFrame * frameSize,
      end: totalSamples,
    });
  }

  if (rawIslands.length === 0) {
    return null;
  }

  // Merge islands separated by <= 0.8s so natural pauses remain completely untouched
  const maxPauseSamples = Math.round(sampleRate * MAX_PRESERVED_PAUSE_SEC);
  const mergedIslands: Array<{ start: number; end: number }> = [rawIslands[0]];
  for (let i = 1; i < rawIslands.length; i++) {
    const prev = mergedIslands[mergedIslands.length - 1];
    const curr = rawIslands[i];
    if (curr.start - prev.end <= maxPauseSamples) {
      prev.end = curr.end;
    } else {
      mergedIslands.push({ start: curr.start, end: curr.end });
    }
  }

  // Convert merged islands into output sample ranges:
  // - 0.15s pre-roll before first speech
  // - 0.40s tail + 0.40s pre-roll (= 0.80s natural pause) across trimmed gaps > 0.80s
  // - 0.25s trailing tail after final speech
  const preRollSamples = Math.round(sampleRate * PRE_ROLL_SEC);
  const trailingTailSamples = Math.round(sampleRate * TRAILING_TAIL_SEC);
  const pauseHalfSamples = Math.round(sampleRate * PAUSE_HALF_SEC);

  const ranges: SampleRange[] = [];
  for (let i = 0; i < mergedIslands.length; i++) {
    const island = mergedIslands[i];
    const isFirst = i === 0;
    const isLast = i === mergedIslands.length - 1;

    const leadPadding = isFirst ? preRollSamples : pauseHalfSamples;
    const tailPadding = isLast ? trailingTailSamples : pauseHalfSamples;

    const rangeStart = Math.max(0, island.start - leadPadding);
    const rangeEnd = Math.min(totalSamples, island.end + tailPadding);

    const prev = ranges[ranges.length - 1];
    if (prev && rangeStart <= prev.end) {
      prev.end = Math.max(prev.end, rangeEnd);
      prev.fadeOut = !isLast && rangeEnd < totalSamples;
    } else {
      ranges.push({
        start: rangeStart,
        end: rangeEnd,
        fadeIn: !isFirst && rangeStart > 0,
        fadeOut: !isLast && rangeEnd < totalSamples,
      });
    }
  }

  return ranges;
}

function assembleAndDownsampleTo16k(
  mono: Float32Array,
  ranges: SampleRange[],
  sourceSampleRate: number,
): Int16Array {
  const fadeSamples = Math.max(1, Math.round(sourceSampleRate * SPLICE_FADE_SEC));

  let totalKeptSourceSamples = 0;
  for (const r of ranges) {
    totalKeptSourceSamples += Math.max(0, r.end - r.start);
  }

  // Copy kept ranges into a contiguous mono buffer with 12ms cosine fades at splice points
  const assembled = new Float32Array(totalKeptSourceSamples);
  let writeOffset = 0;

  for (const r of ranges) {
    const segLen = Math.max(0, r.end - r.start);
    if (segLen === 0) continue;

    assembled.set(mono.subarray(r.start, r.end), writeOffset);

    if (r.fadeIn) {
      const len = Math.min(fadeSamples, segLen);
      for (let i = 0; i < len; i++) {
        const gain = 0.5 * (1 - Math.cos((Math.PI * i) / len));
        assembled[writeOffset + i] *= gain;
      }
    }
    if (r.fadeOut) {
      const len = Math.min(fadeSamples, segLen);
      const fadeStart = writeOffset + segLen - len;
      for (let i = 0; i < len; i++) {
        const gain = 0.5 * (1 + Math.cos((Math.PI * i) / len));
        assembled[fadeStart + i] *= gain;
      }
    }

    writeOffset += segLen;
  }

  // Fast anti-aliased downsample to 16kHz 16-bit signed PCM
  const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.round(assembled.length / ratio));
  const pcm16 = new Int16Array(outputLength);

  if (Math.abs(ratio - 1) < 0.001) {
    for (let i = 0; i < outputLength; i++) {
      const clamped = Math.max(-1, Math.min(1, assembled[i] ?? 0));
      pcm16[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    }
    return pcm16;
  }

  if (ratio > 1) {
    // Box-averaged downsampling prevents high-frequency aliasing without heavy FFT cost
    for (let i = 0; i < outputLength; i++) {
      const srcStart = Math.floor(i * ratio);
      const srcEnd = Math.min(assembled.length, Math.max(srcStart + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = srcStart; j < srcEnd; j++) {
        sum += assembled[j];
      }
      const sample = sum / Math.max(1, srcEnd - srcStart);
      const clamped = Math.max(-1, Math.min(1, sample));
      pcm16[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    }
  } else {
    // Linear interpolation if source sample rate is lower than 16kHz
    for (let i = 0; i < outputLength; i++) {
      const srcPos = i * ratio;
      const idx = Math.floor(srcPos);
      const frac = srcPos - idx;
      const s0 = assembled[idx] ?? 0;
      const s1 = assembled[Math.min(assembled.length - 1, idx + 1)] ?? s0;
      const sample = s0 + (s1 - s0) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      pcm16[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    }
  }

  return pcm16;
}

function encodeMonoWav16k(pcm16: Int16Array): Blob {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (TARGET_SAMPLE_RATE * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataByteLength = pcm16.length * 2;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // Linear PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (let i = 0; i < pcm16.length; i++) {
    view.setInt16(offset, pcm16[i], true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export async function compactRecordedSilence(
  blob: Blob,
  fallbackDurationSec: number,
  originalMimeType: string,
): Promise<AudioCompactionResult> {
  const passthrough: AudioCompactionResult = {
    blob,
    mimeType: originalMimeType || blob.type || 'audio/webm',
    durationSec: fallbackDurationSec,
    originalDurationSec: fallbackDurationSec,
    trimmedSilenceSec: 0,
    wasCompacted: false,
  };

  if (typeof window === 'undefined' || blob.size === 0 || blob.size > MAX_CLIENT_DECODE_BYTES) {
    return passthrough;
  }

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    return passthrough;
  }

  let ctx: AudioContext | null = null;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    ctx = new AudioCtx();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const originalDurationSec =
      Number.isFinite(audioBuffer.duration) && audioBuffer.duration > 0
        ? audioBuffer.duration
        : fallbackDurationSec;

    if (originalDurationSec < MIN_CLIP_DURATION_SEC) {
      return { ...passthrough, durationSec: originalDurationSec, originalDurationSec };
    }

    const mono = mixBufferToMono(audioBuffer);
    const ranges = buildKeptRanges(mono, audioBuffer.sampleRate);
    if (!ranges || ranges.length === 0) {
      return { ...passthrough, durationSec: originalDurationSec, originalDurationSec };
    }

    let keptSamples = 0;
    for (const r of ranges) {
      keptSamples += Math.max(0, r.end - r.start);
    }
    const compactedDurationSec = keptSamples / audioBuffer.sampleRate;
    const trimmedSilenceSec = Math.max(0, originalDurationSec - compactedDurationSec);

    if (trimmedSilenceSec < MIN_TRIM_TO_APPLY_SEC || compactedDurationSec < 0.3) {
      return { ...passthrough, durationSec: originalDurationSec, originalDurationSec };
    }

    const estimatedWavBytes = 44 + Math.ceil(compactedDurationSec * TARGET_SAMPLE_RATE) * 2;
    const isBandwidthFriendly =
      estimatedWavBytes <= Math.max(blob.size * 1.5, INLINE_FRIENDLY_WAV_BYTES) ||
      (trimmedSilenceSec >= SIGNIFICANT_TRIM_SEC && estimatedWavBytes <= MAX_CLIENT_DECODE_BYTES);

    if (!isBandwidthFriendly) {
      return { ...passthrough, durationSec: originalDurationSec, originalDurationSec };
    }

    const pcm16 = assembleAndDownsampleTo16k(mono, ranges, audioBuffer.sampleRate);
    const wavBlob = encodeMonoWav16k(pcm16);
    const exactDurationSec = pcm16.length / TARGET_SAMPLE_RATE;

    return {
      blob: wavBlob,
      mimeType: 'audio/wav',
      durationSec: exactDurationSec,
      originalDurationSec,
      trimmedSilenceSec: Math.max(0, originalDurationSec - exactDurationSec),
      wasCompacted: true,
    };
  } catch {
    // Safe fallback: return original recorded blob untouched if decoding fails
    return passthrough;
  } finally {
    if (ctx) {
      ctx.close().catch(() => undefined);
    }
  }
}
