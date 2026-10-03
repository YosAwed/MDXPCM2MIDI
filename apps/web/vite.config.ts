import { defineConfig } from 'vite';
export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022' },
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 10)) },
});
