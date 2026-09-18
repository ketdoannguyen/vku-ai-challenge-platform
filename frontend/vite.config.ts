import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Mặc định trỏ vào Nginx của compose (port 8080) chứ không phải uvicorn trực tiếp:
  // giữ nguyên cookie, giới hạn body upload và hành vi reverse-proxy như production.
  const target = loadEnv(mode, process.cwd(), '').VITE_API_PROXY_TARGET || 'http://localhost:8080'

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target, changeOrigin: true },
      },
    },
  }
})
