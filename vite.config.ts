import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: { include: ['@myriaddreamin/typst.ts', '@myriaddreamin/typst.ts/contrib/snippet', 'paper-parallel-pdfjs'] },
  server: {
    watch: { ignored: ['**/outputs/**'] },
    proxy: {
      '/__deepseek_api__': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__deepseek_api__/, ''),
      },
    },
  },
  preview: {
    proxy: {
      '/__deepseek_api__': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/__deepseek_api__/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    globals: true,
  },
})
