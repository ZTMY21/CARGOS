import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const url = env.SUPABASE_URL || '';
  const key = env.SUPABASE_ANON_KEY || '';
  const isolated = env.KARDEX_REQ4_PREVIEW_PROJECT || '';
  if ((isolated || process.env.VERCEL_GIT_COMMIT_REF === 'preview/intervencion-4-requerimientos')
      && (isolated !== 'qpbzfzcobkkfnoioqytb' || url !== `https://${isolated}.supabase.co`)) {
    throw new Error('La Preview de Requerimientos requiere el proyecto de pruebas aislado.');
  }
  if (key.startsWith('sb_secret_')) throw new Error('Usa una clave pública de Supabase.');
  if (key && !key.startsWith('sb_publishable_') && key.split('.').length !== 3) {
    throw new Error('SUPABASE_ANON_KEY debe ser una clave pública de Supabase.');
  }
  if (key.split('.').length === 3) {
    let payload;
    try { payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url')); }
    catch { throw new Error('La clave de Supabase no es válida.'); }
    if (payload.role !== 'anon') throw new Error('La clave service_role nunca puede publicarse.');
  }
  if (mode === 'production' && (!url || !key)) {
    throw new Error('Faltan SUPABASE_URL y SUPABASE_ANON_KEY.');
  }
  return {
    define: {
      __SUPABASE_URL__: JSON.stringify(url),
      __SUPABASE_ANON_KEY__: JSON.stringify(key),
      __REQ4_ISOLATED__: JSON.stringify(Boolean(isolated))
    },
    build: { sourcemap: false, rolldownOptions: { input: { app: 'index.html' } } }
  };
});
