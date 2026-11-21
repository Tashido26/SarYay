import { formatApiError, restyleTextContent } from '../../shared/geminiService.ts';
import type {
  GeminiModel,
  ProcessingMode,
  VoiceEnding,
  WritingStyle,
} from '../../shared/geminiService.ts';
import { verifyAuthorizedRequest } from '../../shared/verifyFirebaseAuth.ts';

export const config = {
  path: '/api/restyle',
};

export default async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  }

  try {
    await verifyAuthorizedRequest(req.headers.get('authorization'));
    const body = (await req.json()) as {
      text?: unknown;
      style?: unknown;
      refinedEnding?: unknown;
      model?: unknown;
      mode?: unknown;
      glossary?: unknown;
    };

    const text = typeof body?.text === 'string' ? body.text : '';
    const style = String(body?.style || 'literary') as WritingStyle;
    const refinedEnding = String(body?.refinedEnding || 'colloquial') as VoiceEnding;
    const model = String(body?.model || 'gemini-2.5-flash') as GeminiModel;
    const mode = String(body?.mode || 'full_polish') as ProcessingMode;
    const glossary = typeof body?.glossary === 'string' ? body.glossary : undefined;

    const result = await restyleTextContent({
      text,
      style,
      refinedEnding,
      model,
      mode,
      glossary,
    });
    return Response.json(result, { status: 200 });
  } catch (err) {
    const formatted = formatApiError(err);
    return Response.json({ error: formatted.message }, { status: formatted.status });
  }
};
