import 'dotenv/config';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type WritingStyle = 'colloquial' | 'literary';
type GeminiModel = 'gemini-2.5-flash' | 'gemini-2.5-pro';
type ProcessingMode = 'full_polish' | 'summarize_structure';

const ALLOWED_MODELS = new Set<GeminiModel>(['gemini-2.5-flash', 'gemini-2.5-pro']);
const ALLOWED_STYLES = new Set<WritingStyle>(['colloquial', 'literary']);
const ALLOWED_MODES = new Set<ProcessingMode>(['full_polish', 'summarize_structure']);
const INLINE_AUDIO_LIMIT_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024; // 60 MB

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw Object.assign(
      new Error('Gemini API key is not configured. Please check your key in Settings > Secrets.'),
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

function normalizeAudioMimeType(rawMime: string | undefined, filename: string | undefined): string {
  const base = (rawMime || '').toLowerCase().split(';')[0].trim();
  const ext = path.extname(filename || '').toLowerCase();

  if (base === 'audio/mpeg' || base === 'audio/mp3' || ext === '.mp3') return 'audio/mpeg';
  if (base === 'audio/wav' || base === 'audio/x-wav' || base === 'audio/wave' || ext === '.wav') return 'audio/wav';
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

const SECOND_PASS_BURMESE_PROOFREADING_BLOCK = `MANDATORY SECOND-PASS STEP — BURMESE PROOFREADING & CONTEXT CORRECTION:
Before producing your final output, silently perform a strict second-pass editorial proofreading of the entire Burmese and mixed English draft from start to finish, checking every single phrase against its surrounding context:
- Fix Burmese phonetic and homophone spelling errors (အသံတူ စာလုံးပေါင်းကွဲ / သတ်ပုံအမှား) based strictly on meaning and context, including:
  * Distinguish "တတ်" (skill, knowledge, capability, tendency — e.g., "programming မတတ်ဘူး", "ရေးတတ်တယ်", "ဖြစ်တတ်သည်") vs. "တက်" (climb, rise, attend, increase — e.g., "တောင်တက်", "ကျောင်းတက်", "ဈေးတက်").
  * Distinguish "မရွေ့" / "မပျက်မကွက်" (intact, unchanged, without shifting or missing — e.g., "အစအဆုံး မရွေ့ လိုချင်တာလား") vs. "မရွေး" (choose/select — e.g., "မရွေးချယ်", "ဘယ်သူမရွေး").
  * Fix commonly misheard words, dropped noun prefixes, and particles (e.g., "အိမ်မက်" -> "အိပ်မက်", "ကူညီနဲ့" -> "အကူအညီနဲ့", as well as incomplete, clipped, or misheard Burmese verb endings and postpositions).
- Verify proper Burmese punctuation ("။" and "၊"), natural word spacing, and accurate mixed English spelling.
- Ensure every sentence flows with natural, grammatically sound Burmese phrasing while preserving 100% of the speaker's intended meaning and strictly adhering to the selected style (Colloquial or Literary).`;

function buildTranscriptionSystemInstruction(style: WritingStyle, mode: ProcessingMode): string {
  const styleDirective =
    style === 'colloquial'
      ? `TARGET STYLE — Colloquial Style (စကားပြောဟန်):
- Preserve natural spoken Burmese verb endings and conversational particles (such as တယ်, မယ်, ပြီ, ဗျ, ရှင့်, ပါတယ်, နေတယ်, ခဲ့တယ်, နော်, လေ) while making every sentence smooth, idiomatic, and effortless to read.
- Do NOT convert colloquial endings into stiff literary endings.`
      : `TARGET STYLE — Literary Style (စာရေးဟန်):
- Convert spoken Burmese narrative into refined, formal literary written Burmese (using appropriate literary verb endings and connectors such as သည်, မည်, ၏, ၍, သော, ခဲ့သည်, နေသည်, လေသည်, ဖြစ်သည်) suitable for novels, literary fiction, and published articles.
- Keep quoted character dialogue natural where clearly spoken as direct dialogue, while elevating narrative prose into polished literary Burmese.`;

  if (mode === 'summarize_structure') {
    return `You are an expert Burmese and English literary editor and lecture archivist working for writers, researchers, and listeners of literary talks (စာပေဟောပြောပွဲ) and long-form lectures.

PASS 1 — COMPREHENSION, STRUCTURING & SUMMARIZATION:
1. Listen to the entire Burmese (and mixed English) audio carefully from start to finish.
2. Create a clear, well-organized, structured summary suitable for long lectures, talks (စာပေဟောပြောပွဲ), and discussions:
   - Begin with a concise title/topic line capturing the core theme of the talk.
   - Organize the lecture into logical thematic sections with clean section headings, well-written paragraphs, and concise bullet points for key arguments, stories, quotes, and takeaways.
   - Retain all major concepts, named references, literary quotes, anecdotes, and practical insights faithfully without distorting the speaker's original viewpoint.
3. Automatically ignore spoken filler words (အင်း, အဲ, အမ်, ပေါ့နော်, ဟိုဟာလေ, ဘာလဲဆိုတော့, ဆိုတော့ကာ), stutters, and false starts.
4. ${styleDirective}

PASS 2 — ${SECOND_PASS_BURMESE_PROOFREADING_BLOCK}

FINAL OUTPUT RULE:
Return ONLY the clean, proofread, structured Burmese/English summary. Never include introductory or concluding AI remarks or markdown code fences.`;
  }

  return `You are an expert Burmese and English literary transcriptionist and copy editor working for novelists and authors.

PASS 1 — COMPLETE TRANSCRIPTION & CLEANING:
1. COMPLETE & FAITHFUL TRANSCRIPTION: Transcribe the entire Burmese (and any mixed English) audio faithfully and completely from beginning to end.
2. ZERO SUMMARIZATION OR OMISSION: DO NOT summarize, shorten, omit, paraphrase away, or condense ANY ideas, scenes, dialogue, sensory descriptions, emotions, or minor details. Keep 100% of the speaker's narrative content intact.
3. CLEAN SPOKEN DISFLUENCIES: Automatically remove spoken filler words and hesitations (such as အင်း, အဲ, အမ်, ပေါ့နော်, ဟိုဟာလေ, ဟိုဟာ, ဘာလဲဆိုတော့, ဆိုတော့ကာ, ဘာခေါ်မလဲ), stutters, false starts, and accidental word repetitions without losing any intended meaning.
4. ${styleDirective}
5. PARAGRAPH FORMATTING: Organize the transcription into clean, natural, well-structured paragraphs separated by blank lines so it reads like a finished manuscript section.

PASS 2 — ${SECOND_PASS_BURMESE_PROOFREADING_BLOCK}

FINAL OUTPUT RULE:
Return ONLY the clean, proofread, polished Burmese/English manuscript text. Never include any introductory remarks, headers, notes, labels, markdown code blocks, or concluding commentary.`;
}

function buildRestyleSystemInstruction(style: WritingStyle, mode: ProcessingMode): string {
  const styleDirective =
    style === 'colloquial'
      ? `Convert the passage into natural Colloquial Style (စကားပြောဟန်), using smooth spoken Burmese verb endings (such as တယ်, မယ်, ပြီ, ဗျ, ရှင့်, ပါတယ်, နေတယ်) so it reads naturally and fluidly.`
      : `Convert the passage into formal Literary Style (စာရေးဟန်), using refined written Burmese verb endings and connectors (such as သည်, မည်, ၏, ၍, သော, ခဲ့သည်, နေသည်) suitable for novels and published articles.`;

  const structureDirective =
    mode === 'summarize_structure'
      ? 'Preserve the structured headings, section organization, and bullet takeaways cleanly.'
      : 'Preserve clean narrative paragraph structure.';

  return `You are an expert Burmese and English literary editor working for novelists and authors.

PASS 1 — STYLE CONVERSION:
1. ${styleDirective}
2. DO NOT summarize, shorten, omit, or condense any ideas, scenes, details, or mixed English terms. Preserve 100% of the original meaning and sequence.
3. ${structureDirective}

PASS 2 — ${SECOND_PASS_BURMESE_PROOFREADING_BLOCK}

FINAL OUTPUT RULE:
Return ONLY the polished, proofread Burmese/English text with zero introductory or concluding remarks.`;
}

function isRetryableError(err: unknown): boolean {
  const status =
    (err as { status?: number; statusCode?: number })?.status ??
    (err as { status?: number; statusCode?: number })?.statusCode;
  if (status && (status === 429 || status === 500 || status === 502 || status === 503 || status === 504)) {
    return true;
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  return msg.includes('temporarily unavailable') || msg.includes('overloaded') || msg.includes('econnreset');
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

function formatApiError(err: unknown): { status: number; message: string } {
  const anyErr = err as { status?: number; statusCode?: number; message?: string };
  const rawMessage = anyErr?.message || 'An unexpected error occurred while processing with Gemini.';
  const upper = rawMessage.toUpperCase();

  if (anyErr?.statusCode === 400 || anyErr?.status === 400) {
    if (upper.includes('API_KEY_INVALID') || upper.includes('API KEY')) {
      return {
        status: 400,
        message: 'The Gemini API key appears invalid. Please verify it in Settings > Secrets.',
      };
    }
    return { status: 400, message: rawMessage };
  }

  if (anyErr?.status === 403 || upper.includes('PERMISSION_DENIED')) {
    return {
      status: 403,
      message: 'Permission denied by Gemini API. Please check your API key in Settings > Secrets.',
    };
  }

  if (anyErr?.status === 429 || upper.includes('RESOURCE_EXHAUSTED')) {
    return {
      status: 429,
      message:
        'Gemini API quota limit reached. Try switching to Gemini 2.5 Flash or verify your billing-enabled API key in Settings > Secrets.',
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
});

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post('/api/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
    let tempFilePath: string | null = null;
    let uploadedFileName: string | null = null;
    let aiClient: GoogleGenAI | null = null;

    try {
      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        res.status(400).json({ error: 'No audio file was received. Please record or upload a valid audio clip.' });
        return;
      }

      const rawStyle = String(req.body?.style || 'literary') as WritingStyle;
      const rawModel = String(req.body?.model || 'gemini-2.5-flash') as GeminiModel;
      const rawMode = String(req.body?.mode || 'full_polish') as ProcessingMode;

      if (!ALLOWED_STYLES.has(rawStyle)) {
        res.status(400).json({ error: 'Invalid style selected.' });
        return;
      }

      if (!ALLOWED_MODELS.has(rawModel)) {
        res.status(400).json({ error: 'Invalid Gemini model selected.' });
        return;
      }

      if (!ALLOWED_MODES.has(rawMode)) {
        res.status(400).json({ error: 'Invalid processing mode selected.' });
        return;
      }

      const mimeType = normalizeAudioMimeType(file.mimetype, file.originalname);
      const ai = getGeminiClient();
      aiClient = ai;

      const systemInstruction = buildTranscriptionSystemInstruction(rawStyle, rawMode);
      const userPrompt =
        rawMode === 'summarize_structure'
          ? 'Analyze the entire audio recording, produce a clean structured summary in the requested Burmese/English writing style, apply the mandatory second-pass Burmese proofreading and context-based homophone correction, and return only the final polished text.'
          : 'Transcribe the entire audio recording faithfully and completely in the requested Burmese/English writing style without summarizing, apply the mandatory second-pass Burmese proofreading and context-based homophone correction, and return only the final polished manuscript text.';

      let responseText = '';

      if (file.buffer.length <= INLINE_AUDIO_LIMIT_BYTES) {
        const audioPart = {
          inlineData: {
            mimeType,
            data: file.buffer.toString('base64'),
          },
        };

        const response = await withRetry(() =>
          ai.models.generateContent({
            model: rawModel,
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
        const ext = path.extname(file.originalname || '') || '.webm';
        tempFilePath = path.join(os.tmpdir(), `sarpay-audio-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        await fs.writeFile(tempFilePath, file.buffer);

        const uploaded = await ai.files.upload({
          file: tempFilePath,
          config: { mimeType },
        });
        uploadedFileName = uploaded.name ?? null;

        const response = await withRetry(() =>
          ai.models.generateContent({
            model: rawModel,
            contents: [uploaded, userPrompt],
            config: {
              systemInstruction,
            },
          }),
        );

        responseText = (response.text ?? '').trim();
      }

      if (!responseText) {
        res.status(422).json({
          error: 'No audible speech could be transcribed from this recording. Please play back the audio to check the level.',
        });
        return;
      }

      res.json({
        text: responseText,
        style: rawStyle,
        model: rawModel,
        mode: rawMode,
      });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    } finally {
      if (uploadedFileName && aiClient) {
        try {
          await aiClient.files.delete({ name: uploadedFileName });
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
  });

  app.post('/api/restyle', async (req: Request, res: Response) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      const rawStyle = String(req.body?.style || 'literary') as WritingStyle;
      const rawModel = String(req.body?.model || 'gemini-2.5-flash') as GeminiModel;
      const rawMode = String(req.body?.mode || 'full_polish') as ProcessingMode;

      if (!text) {
        res.status(400).json({ error: 'Section text is empty.' });
        return;
      }

      if (!ALLOWED_STYLES.has(rawStyle)) {
        res.status(400).json({ error: 'Invalid style selected.' });
        return;
      }

      if (!ALLOWED_MODELS.has(rawModel)) {
        res.status(400).json({ error: 'Invalid Gemini model selected.' });
        return;
      }

      if (!ALLOWED_MODES.has(rawMode)) {
        res.status(400).json({ error: 'Invalid processing mode selected.' });
        return;
      }

      const ai = getGeminiClient();
      const systemInstruction = buildRestyleSystemInstruction(rawStyle, rawMode);

      const response = await withRetry(() =>
        ai.models.generateContent({
          model: rawModel,
          contents: text,
          config: {
            systemInstruction,
          },
        }),
      );

      const polished = (response.text ?? '').trim();
      if (!polished) {
        res.status(422).json({ error: 'Could not convert this passage. Please try again.' });
        return;
      }

      res.json({
        text: polished,
        style: rawStyle,
        model: rawModel,
        mode: rawMode,
      });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Multer error handler
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'Audio file exceeds the 60 MB upload limit.' });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  });

  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Sarpay Studio server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Sarpay Studio server:', err);
  process.exit(1);
});
