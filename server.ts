import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import {
  MAX_UPLOAD_BYTES,
  formatApiError,
  restyleTextContent,
  transcribeAudioBuffer,
} from './shared/geminiService.ts';
import type { GeminiModel, ProcessingMode, WritingStyle } from './shared/geminiService.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    res.json({ ok: true, runtime: 'express' });
  });

  app.post('/api/transcribe', upload.single('audio'), async (req: Request, res: Response) => {
    try {
      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        res.status(400).json({
          error: 'No audio file was received. Please record or upload a valid audio clip.',
        });
        return;
      }

      const style = String(req.body?.style || 'literary') as WritingStyle;
      const model = String(req.body?.model || 'gemini-2.5-flash') as GeminiModel;
      const mode = String(req.body?.mode || 'full_polish') as ProcessingMode;

      const result = await transcribeAudioBuffer({
        buffer: file.buffer,
        rawMimeType: file.mimetype,
        filename: file.originalname,
        style,
        model,
        mode,
      });

      res.json(result);
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  app.post('/api/restyle', async (req: Request, res: Response) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text : '';
      const style = String(req.body?.style || 'literary') as WritingStyle;
      const model = String(req.body?.model || 'gemini-2.5-flash') as GeminiModel;
      const mode = String(req.body?.mode || 'full_polish') as ProcessingMode;

      const result = await restyleTextContent({ text, style, model, mode });
      res.json(result);
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

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
