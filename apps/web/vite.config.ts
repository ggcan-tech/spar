/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // The MediaPipe bundle loads its WASM loader at runtime from a URL we hand it
  // (see src/camera/pose.ts); keep it out of the dep pre-bundler so nothing rewrites it.
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
  test: { globals: true, environment: 'node', include: ['src/**/*.test.ts'] },
});
