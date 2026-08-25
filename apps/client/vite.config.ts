import { defineConfig } from 'vite';
import { workspaceAliases } from '../../tooling/aliases';

/**
 * The client is a plain static bundle.
 *
 * Workspace packages are aliased to their TypeScript sources so there is no build-order
 * dance during development, and Vite tree-shakes what the client does not use. The
 * simulation package is deliberately *not* excluded: the client imports its pure
 * movement step so client-side prediction and the server run identical math.
 */
export default defineConfig({
  resolve: { alias: workspaceAliases() },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 2400,
    rollupOptions: {
      output: {
        manualChunks: {
          // Phaser is large and changes rarely; keeping it separate keeps rebuilds and
          // browser caching sane.
          phaser: ['phaser'],
        },
      },
    },
  },
  define: {
    // Phaser checks these at load time; setting them lets the bundle drop its
    // Canvas-renderer and debug branches.
    'typeof CANVAS_RENDERER': JSON.stringify('boolean'),
    'typeof WEBGL_RENDERER': JSON.stringify('boolean'),
  },
});
