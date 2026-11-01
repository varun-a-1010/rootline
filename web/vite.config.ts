import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  server: { proxy: { '/api': 'http://localhost:8787', '/downloads': 'http://localhost:8787', '/docs': 'http://localhost:8787' } },
});
