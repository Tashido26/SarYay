export const config = {
  path: '/api/health',
};

export default async (): Promise<Response> => {
  return Response.json({ ok: true, runtime: 'netlify' }, { status: 200 });
};
