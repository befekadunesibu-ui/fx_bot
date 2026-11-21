
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function isProductionApiBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.pathname === '/api' &&
      !url.search &&
      !url.hash &&
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export default defineConfig(({ mode }) => {
  if (mode === 'production' && !isProductionApiBaseUrl(loadEnv(mode, '.', 'VITE_').VITE_API_BASE_URL)) {
    throw new Error('Production builds require VITE_API_BASE_URL to be an HTTPS backend URL ending in /api.');
  }

  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      allowedHosts: [
        'academy-psi-relative-deaths.trycloudflare.com',
      ],
    },
  };
});
