import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    server: {
      fs: {
        // 插件目录在 renderer root 之外，需要放行整个工程目录
        allow: [resolve(__dirname)]
      }
    },
    plugins: [react()]
  }
})
