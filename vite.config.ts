import { readFileSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { bundleBudget } from './scripts/bundle-budget.mjs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// Tauri 需要一个固定端口，且不能在构建时清屏，否则 Rust 侧的日志会被吞掉。
export default defineConfig({
  test: {
    // 审查基线和历史缺陷复现不是当前版本的回归测试。
    exclude: [...configDefaults.exclude, '**/.superpowers/**', '**/docs/**', '**/.impeccable/**', '**/.cache/**'],
  },
  plugins: [react(), bundleBudget()],
  // QuickJS WASM 在 Worker 内按模块加载，生产构建也必须保留模块格式。
  worker: { format: 'es' },
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // Tauri 用 tauri:// 自定义协议加载页面，绝对路径 /assets 会 404，必须用相对路径
  base: './',
  clearScreen: false,
  server: {
    // 固定 IPv4：Vite 默认只监听 ::1，Tauri 的 localhost 解析可能落到 127.0.0.1 而连不上
    host: '127.0.0.1',
    port: 5183,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: false,
    // QuickJS 的 single-file WASM 运行时约 684 KB，仅在 JS 覆写执行时懒加载；初始包由 bundleBudget 单独限额。
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replaceAll('\\\\', '/');
          if (normalized.includes('/node_modules/@codemirror/lang-yaml/')
            || normalized.includes('/node_modules/@lezer/yaml/')) return 'code-editor-yaml';
          if (normalized.includes('/node_modules/@codemirror/lang-javascript/')
            || normalized.includes('/node_modules/@lezer/javascript/')
            || normalized.includes('/node_modules/acorn/')) return 'code-editor-javascript';
          if (normalized.includes('/node_modules/@codemirror/')
            || normalized.includes('/node_modules/@lezer/')) return 'code-editor-core';
        },
      },
    },
  },
});
