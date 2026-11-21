import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';

export type WritingStyle = 'colloquial' | 'literary';
export type GeminiModel = 'gemini-2.5-flash' | 'gemini-2.5-pro';
export type ProcessingMode = 'full_polish' | 'summarize_structure';

export const ALLOWED_MODELS = new Set<GeminiModel>(['gemini-2.5-flash', 'gemini-2.5-pro']);
export const ALLOWED_STYLES = new Set<WritingStyle>(['colloquial', 'literary']);
export const ALLOWED_MODES = new Set<ProcessingMode>(['full_polish', 'summarize_structure']);
export const INLINE_AUDIO_LIMIT_BYTES = 15 * 1024 * 1024; // 15 MB
export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024; // 60 MB

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw Object.assign(
      new Error(
        'Gemini API key is not configured. Add GEMINI_API_KEY in Netlify Environment variables (or Settings > Secrets in AI Studio).',
      ),
      { statusCode: 500 },
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function normalizeAudioMimeType(
  rawMime: string | undefined,
  filename: string | undefined,
): string {
  const base = (rawMime || '').toLowerCase().split(';')[0].trim();
  const ext = path.extname(filename || '').toLowerCase();

  if (base === 'audio/mpeg' || base === 'audio/mp3' || ext === '.mp3') return 'audio/mpeg';
  if (base === 'audio/wav' || base === 'audio/x-wav' || base === 'audio/wave' || ext === '.wav') {
    return 'audio/wav';
  }
  if (
    base === 'audio/mp4' ||
    base === 'audio/m4a' ||
    base === 'audio/x-m4a' ||
    base === 'audio/aac' ||
    ext === '.m4a' ||
    ext === '.mp4'
  ) {
    return 'audio/mp4';
  }
  if (base === 'audio/ogg' || base === 'audio/opus' || ext === '.ogg') return 'audio/ogg';
  if (base === 'audio/webm' || base === 'video/webm' || ext === '.webm') return 'audio/webm';
  if (base.startsWith('audio/')) return base;
  return 'audio/webm';
}

const STEP_3_READY_TO_USE_BURMESE_AUDIT = `STEP 3 — MANDATORY FINAL BURMESE SPELLING & GRAMMAR AUDIT (READY-TO-USE GATE):
Before outputting ANY text, perform a strict, word-by-word internal proofreading pass over the entire Burmese and mixed English draft so the result is completely publication-ready and requires zero manual editing afterward:
- Fix all Burmese phonetic and homophone spelling errors (အသံတူ စာလုံးပေါင်းကွဲ / သတ်ပုံအမှား) strictly based on surrounding context:
  * Always write "အိပ်မက်" (dream) instead of "အိမ်မက်".
  * Strictly distinguish "တတ်" (skill, knowledge, capability, tendency — e.g., "programming မတတ်ဘူး", "ရေးတတ်တယ်", "ဖြစ်တတ်သည်") vs. "တက်" (climb, rise, attend, increase — e.g., "တောင်တက်", "ကျောင်းတက်", "ဈေးတက်").
  * Strictly distinguish "ရွေ့" / "မရွေ့" / "မပျက်မကွက်" (move/shift/intact/unchanged — e.g., "အစအဆုံး မရွေ့ လိုချင်တာလား") vs. "ရွေး" / "မရွေး" (choose/select — e.g., "မရွေးချယ်", "ဘယ်သူမရွေး").
  * Fix dropped noun prefixes, misheard words, and incomplete particles (e.g., "ကူညီနဲ့" -> "အကူအညီနဲ့", clipped or misheard verb endings and postpositions).
  * Carefully verify Burmese final consonants (အသတ်အမှားများ — especially ကသတ် "က်", တသတ် "တ်", ပသတ် "ပ်", နသတ် "န်", မသတ် "မ်", ငသတ် "င်") so every single word is spelled accurately in Unicode Burmese.
- Enforce proper Burmese punctuation ("။" for sentence endings and "၊" for clause pauses), clean spacing, and accurate mixed English spelling.
- Confirm every sentence reads smoothly, naturally, and grammatically with zero awkward phrasing, zero leftover filler words, and zero typos.`;

function buildStylePreservationDirective(style: WritingStyle): string {
  if (style === 'colloquial') {
    return `STEP 2 — PRESERVE NATURAL VOICE & TONE (DO NOT OVER-FORMALIZE — Colloquial Style / စကားပြောဟန်):
- Strictly preserve the speaker's authentic conversational tone, personal rhythm, and natural expressive endings (e.g., "ဒီလိုပဲ ဖြစ်ချင်တယ်", "ဟုတ်တာပဲ", "ကွာ", "နော်", "တယ်", "မယ်", "ပြီ", "ဗျ", "ရှင့်", "ပါတယ်", "နေတယ်" where natural to their voice).
- Do NOT convert their natural spoken Burmese into stiff, academic, or literary Burmese (avoid forcing "သည် / မည် / ၏ / ၍" when Colloquial Style is selected).
- Keep 100% of the substantive ideas, storytelling details, nuances, and examples intact.`;
  }

  return `STEP 2 — ELEVATE INTO REFINED LITERARY PROSE (Literary Style / စာရေးဟန်):
- Convert spoken Burmese narrative into polished, formal literary written Burmese (using appropriate literary verb endings and connectors such as "သည်", "မည်", "၏", "၍", "သော", "ခဲ့သည်", "နေသည်", "ဖြစ်သည်") suitable for novels, literary fiction, and published articles.
- Keep direct quoted character dialogue authentic and natural where clearly spoken as dialogue.
- Keep 100% of the substantive ideas, storytelling details, nuances, and examples intact.`;
}

export function buildTranscriptionSystemInstruction(
  style: WritingStyle,
  mode: ProcessingMode,
): string {
  const styleStep = buildStylePreservationDirective(style);

  if (mode === 'summarize_structure') {
    return `You are an expert Burmese and English literary editor and lecture archivist working for writers, researchers, and listeners of literary talks (စာပေဟောပြောပွဲ) and long-form lectures.

MANDATORY THREE-STEP PIPELINE:

STEP 1 — DEEP DE-CLUTTERING, REPETITION REMOVAL & LECTURE STRUCTURING:
- Listen to the entire Burmese (and mixed English) audio carefully from start to finish.
- Aggressively strip out all conversational crutches, verbal stumbles, false starts, stutters, and filler phrases (e.g., "ဘယ်လိုပြောရမလဲ", "သိတယ်မလား", "အခုလိုမျိုးပေါ့", "အဲ့လိုမျိုး", "အေးအေး အဲ့အဲ့", "နောက်တစ်ခုက", "ပေါ့နော်", "ဟိုဟာ", "ဟိုဟာလေ", "အင်း", "အဲ", "အမ်", "ဘာလဲဆိုတော့", "ဆိုတော့ကာ") and eliminate repeated thinking-aloud loops.
- Organize the talk into a clean, publication-ready structured summary suitable for long lectures and literary talks (စာပေဟောပြောပွဲ): begin with a concise topic heading, group key ideas under clear thematic headings, and present well-crafted paragraphs and bullet takeaways capturing all major concepts, quotes, anecdotes, and insights without distorting the speaker's viewpoint.

${styleStep}

${STEP_3_READY_TO_USE_BURMESE_AUDIT}

FINAL OUTPUT RULE:
Return ONLY the final, publication-ready Burmese/English text with zero introductory remarks, meta-commentary, or markdown code fences.`;
  }

  return `You are an expert Burmese and English literary transcriptionist and senior copy editor working for writers and novelists.

MANDATORY THREE-STEP PIPELINE — EXECUTE ALL THREE STEPS SILENTLY BEFORE OUTPUTTING:

STEP 1 — DEEP DE-CLUTTERING & REPETITION REMOVAL:
- Transcribe the entire Burmese (and mixed English) audio faithfully and completely from beginning to end.
- Aggressively strip out ALL conversational crutches, verbal stumbles, and filler phrases (including "ဘယ်လိုပြောရမလဲ", "သိတယ်မလား", "အခုလိုမျိုးပေါ့", "အဲ့လိုမျိုး", "အေးအေး အဲ့အဲ့", "နောက်တစ်ခုက", "ပေါ့နော်", "ဟိုဟာ", "ဟိုဟာလေ", "အင်း", "အဲ", "အမ်", "ဘာလဲဆိုတော့", "ဆိုတော့ကာ", "ဘာခေါ်မလဲ").
- Remove false starts, stutters, hesitation sounds, and sentences or ideas repeated 2–3 times while the speaker was thinking aloud.
- Merge fragmented spoken thoughts into smooth, natural, uninterrupted sentences and clean paragraphs separated by blank lines so there is zero awkwardness when reading.

${styleStep}
- NEVER summarize, shorten, omit, or condense any substantive ideas, scenes, storytelling details, or examples.

${STEP_3_READY_TO_USE_BURMESE_AUDIT}

FINAL OUTPUT RULE:
The returned text must be completely publication-ready so the writer does not need to manually edit it afterward. Return ONLY the final polished Burmese/English paragraphs with zero meta-commentary, labels, introductory notes, or markdown code fences.`;
}

export function buildRestyleSystemInstruction(
  style: WritingStyle,
  mode: ProcessingMode,
): string {
  const styleStep = buildStylePreservationDirective(style);
  const structureDirective =
    mode === 'summarize_structure'
      ? 'Preserve the structured headings, thematic organization, and bullet takeaways cleanly.'
      : 'Preserve clean, flowing narrative paragraphs separated by blank lines.';

  return `You are an expert Burmese and English literary editor working for writers and novelists.

MANDATORY PIPELINE:

STEP 1 — DE-CLUTTER & STRUCTURE PRESERVATION:
- Remove any remaining verbal fillers, stutters, or awkward repetitions without dropping any substantive ideas, storytelling details, or examples.
- ${structureDirective}
- NEVER summarize or shorten the content.

${styleStep}

${STEP_3_READY_TO_USE_BURMESE_AUDIT}

FINAL OUTPUT RULE:
Return ONLY the final, publication-ready Burmese/English text with zero meta-commentary or introductory/concluding remarks.`;
}

function isRetryableError(err: unknown): boolean {
  const status =
    (err as { status?: number; statusCode?: number })?.status ??
    (err as { status?: number; statusCode?: number })?.statusCode;
  if (status && (status === 429 || status === 500 || status === 502 || status === 503 || status === 504)) {
    return true;
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  return (
    msg.includes('temporarily unavailable') ||
    msg.includes('overloaded') ||
    msg.includes('econnreset')
  );
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && isRetryableError(err)) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export function formatApiError(err: unknown): { status: number; message: string } {
  const anyErr = err as { status?: number; statusCode?: number; message?: string };
  const rawMessage = anyErr?.message || 'An unexpected error occurred while processing with Gemini.';
  const upper = rawMessage.toUpperCase();

  if (anyErr?.statusCode === 400 || anyErr?.status === 400) {
    if (upper.includes('API_KEY_INVALID') || upper.includes('API KEY')) {
      return {
        status: 400,
        message: 'The Gemini API key appears invalid. Please verify GEMINI_API_KEY in your environment variables.',
      };
    }
    return { status: 400, message: rawMessage };
  }

  if (anyErr?.status === 403 || upper.includes('PERMISSION_DENIED')) {
    return {
      status: 403,
      message: 'Permission denied by Gemini API. Please check GEMINI_API_KEY in your environment variables.',
    };
  }

  if (anyErr?.status === 429 || upper.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message:
        'Gemini API quota limit reached. Try switching to Gemini 2.5 Flash or verify your billing-enabled API key.',
    };
  }

  if (anyErr?.status === 404 || upper.includes('NOT_FOUND')) {
    return {
      status: 404,
      message: 'The requested Gemini model is unavailable for this key. Please try switching models.',
    };
  }

  return {
    status: anyErr?.statusCode || anyErr?.status || 500,
    message: rawMessage,
  };
}

export async function transcribeAudioBuffer(params: {
  buffer: Buffer;
  rawMimeType?: string;
  filename?: string;
  style: WritingStyle;
  model: GeminiModel;
  mode: ProcessingMode;
}): Promise<{ text: string; style: WritingStyle; model: GeminiModel; mode: ProcessingMode }> {
  if (!params.buffer || params.buffer.length === 0) {
    throw Object.assign(
      new Error('No audio file was received. Please record or upload a valid audio clip.'),
      { statusCode: 400 },
    );
  }

  if (!ALLOWED_STYLES.has(params.style)) {
    throw Object.assign(new Error('Invalid style selected.'), { statusCode: 400 });
  }

  if (!ALLOWED_MODELS.has(params.model)) {
    throw Object.assign(new Error('Invalid Gemini model selected.'), { statusCode: 400 });
  }

  if (!ALLOWED_MODES.has(params.mode)) {
    throw Object.assign(new Error('Invalid processing mode selected.'), { statusCode: 400 });
  }

  const mimeType = normalizeAudioMimeType(params.rawMimeType, params.filename);
  const ai = getGeminiClient();
  const systemInstruction = buildTranscriptionSystemInstruction(params.style, params.mode);
  const userPrompt =
    params.mode === 'summarize_structure'
      ? 'Analyze the entire audio recording, produce a clean structured summary in the requested Burmese/English writing style, apply the mandatory second-pass Burmese proofreading and context-based homophone correction, and return only the final polished text.'
      : 'Transcribe the entire audio recording faithfully and completely in the requested Burmese/English writing style without summarizing, apply the mandatory second-pass Burmese proofreading and context-based homophone correction, and return only the final polished manuscript text.';

  let tempFilePath: string | null = null;
  let uploadedFileName: string | null = null;

  try {
    let responseText = '';

    if (params.buffer.length <= INLINE_AUDIO_LIMIT_BYTES) {
      const audioPart = {
        inlineData: {
          mimeType,
          data: params.buffer.toString('base64'),
        },
      };

      const response = await withRetry(() =>
        ai.models.generateContent({
          model: params.model,
          contents: {
            parts: [audioPart, { text: userPrompt }],
          },
          config: {
            systemInstruction,
          },
        }),
      );

      responseText = (response.text ?? '').trim();
    } else {
      const ext = path.extname(params.filename || '') || '.webm';
      tempFilePath = path.join(
        os.tmpdir(),
        `sarpay-audio-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
      );
      await fs.writeFile(tempFilePath, params.buffer);

      const uploaded = await ai.files.upload({
        file: tempFilePath,
        config: { mimeType },
      });
      uploadedFileName = uploaded.name ?? null;

      const response = await withRetry(() =>
        ai.models.generateContent({
          model: params.model,
          contents: [uploaded, userPrompt],
          config: {
            systemInstruction,
          },
        }),
      );

      responseText = (response.text ?? '').trim();
    }

    if (!responseText) {
      throw Object.assign(
        new Error(
          'No audible speech could be transcribed from this recording. Please play back the audio to check the level.',
        ),
        { statusCode: 422 },
      );
    }

    return {
      text: responseText,
      style: params.style,
      model: params.model,
      mode: params.mode,
    };
  } finally {
    if (uploadedFileName) {
      try {
        await ai.files.delete({ name: uploadedFileName });
      } catch {
        // Best-effort remote temp cleanup
      }
    }
    if (tempFilePath) {
      try {
        await fs.unlink(tempFilePath);
      } catch {
        // Best-effort local temp cleanup
      }
    }
  }
}

export async function restyleTextContent(params: {
  text: string;
  style: WritingStyle;
  model: GeminiModel;
  mode: ProcessingMode;
}): Promise<{ text: string; style: WritingStyle; model: GeminiModel; mode: ProcessingMode }> {
  const cleanedText = params.text.trim();
  if (!cleanedText) {
    throw Object.assign(new Error('Section text is empty.'), { statusCode: 400 });
  }

  if (!ALLOWED_STYLES.has(params.style)) {
    throw Object.assign(new Error('Invalid style selected.'), { statusCode: 400 });
  }

  if (!ALLOWED_MODELS.has(params.model)) {
    throw Object.assign(new Error('Invalid Gemini model selected.'), { statusCode: 400 });
  }

  if (!ALLOWED_MODES.has(params.mode)) {
    throw Object.assign(new Error('Invalid processing mode selected.'), { statusCode: 400 });
  }

  const ai = getGeminiClient();
  const systemInstruction = buildRestyleSystemInstruction(params.style, params.mode);

  const response = await withRetry(() =>
    ai.models.generateContent({
      model: params.model,
      contents: cleanedText,
      config: {
        systemInstruction,
      },
    }),
  );

  const polished = (response.text ?? '').trim();
  if (!polished) {
    throw Object.assign(new Error('Could not convert this passage. Please try again.'), {
      statusCode: 422,
    });
  }

  return {
    text: polished,
    style: params.style,
    model: params.model,
    mode: params.mode,
  };
}
