import type {
  GeminiModel,
  ProcessingMode,
  TokenUsage,
  VoiceEnding,
  WritingStyle,
} from '../types.ts';
import { getAuthIdToken } from './firebase.ts';

export interface TranscribeResponse {
  text: string;
  style: WritingStyle;
  refinedEnding?: VoiceEnding;
  model: GeminiModel;
  mode?: ProcessingMode;
  usage?: TokenUsage;
}

async function parseErrorResponse(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string; message?: string };
    if (data.error) return data.error;
    if (data.message) return data.message;
  } catch {
    // Fallback to status-specific guidance
  }
  if (res.status === 401 || res.status === 403) {
    return 'Access Denied: Your session is unauthorized or expired. Please sign in again.';
  }
  if (res.status === 413) {
    return 'This audio file is larger than the hosting platform upload limit (~6 MB on Netlify). Please split or compress the recording into smaller clips.';
  }
  if (res.status === 504 || res.status === 502) {
    return 'Transcription timed out on the server. Try Gemini 2.5 Flash or split very long recordings into shorter clips.';
  }
  return `Request failed (${res.status} ${res.statusText || 'Error'})`;
}

export async function transcribeAudioApi(params: {
  blob: Blob;
  filename: string;
  style: WritingStyle;
  refinedEnding?: VoiceEnding;
  model: GeminiModel;
  mode?: ProcessingMode;
  glossary?: string;
  signal?: AbortSignal;
}): Promise<TranscribeResponse> {
  const idToken = await getAuthIdToken();
  const formData = new FormData();
  const file = new File([params.blob], params.filename, {
    type: params.blob.type || 'audio/webm',
  });
  formData.append('audio', file);
  formData.append('style', params.style);
  formData.append('refinedEnding', params.refinedEnding ?? 'colloquial');
  formData.append('model', params.model);
  formData.append('mode', params.mode ?? 'full_polish');
  if (params.glossary && params.glossary.trim()) {
    formData.append('glossary', params.glossary.trim());
  }

  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
    body: formData,
    signal: params.signal,
  });

  if (!response.ok) {
    throw new Error(await parseErrorResponse(response));
  }

  const data = (await response.json()) as TranscribeResponse;
  if (!data.text || !data.text.trim()) {
    throw new Error(
      'No speech text was returned from transcription. Please verify your audio contains audible speech.',
    );
  }
  return data;
}

export async function restyleTextApi(params: {
  text: string;
  style: WritingStyle;
  refinedEnding?: VoiceEnding;
  model: GeminiModel;
  mode?: ProcessingMode;
  glossary?: string;
  signal?: AbortSignal;
}): Promise<TranscribeResponse> {
  const idToken = await getAuthIdToken();
  const response = await fetch('/api/restyle', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      text: params.text,
      style: params.style,
      refinedEnding: params.refinedEnding ?? 'colloquial',
      model: params.model,
      mode: params.mode ?? 'full_polish',
      glossary: params.glossary?.trim() || undefined,
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    throw new Error(await parseErrorResponse(response));
  }

  const data = (await response.json()) as TranscribeResponse;
  if (!data.text || !data.text.trim()) {
    throw new Error('No polished text was returned.');
  }
  return data;
}
