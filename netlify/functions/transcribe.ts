import { formatApiError, transcribeAudioBuffer } from '../../shared/geminiService.ts';
import type { GeminiModel, ProcessingMode, WritingStyle } from '../../shared/geminiService.ts';

export const config = {
  path: '/api/transcribe',
};

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  }

  try {
    const formData = await req.formData();
    const audioEntry = formData.get('audio');

    if (!audioEntry || typeof audioEntry === 'string') {
      return Response.json(
        { error: 'No audio file was received. Please record or upload a valid audio clip.' },
        { status: 400 },
      );
    }

    const arrayBuffer = await audioEntry.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const style = String(formData.get('style') || 'literary') as WritingStyle;
    const model = String(formData.get('model') || 'gemini-2.5-flash') as GeminiModel;
    const mode = String(formData.get('mode') || 'full_polish') as ProcessingMode;

    const result = await transcribeAudioBuffer({
      buffer,
      rawMimeType: audioEntry.type || undefined,
      filename: 'name' in audioEntry && typeof audioEntry.name === 'string' ? audioEntry.name : 'recording.webm',
      style,
      model,
      mode,
    });

    return Response.json(result, { status: 200 });
  } catch (err) {
    const formatted = formatApiError(err);
    return Response.json({ error: formatted.message }, { status: formatted.status });
  }
};
