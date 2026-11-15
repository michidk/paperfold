import { defineConfig } from 'vite'

// The client. `bun run build` writes it to dist/, which the Bun server serves; GitHub Pages hosts the
// same build elsewhere, pointed at a server by PAPERFOLD_SERVER (empty: the site that served the page).
export default defineConfig({
  root: 'client',
  base: './', // GitHub Pages serves the site from /<repo>/
  envPrefix: 'PAPERFOLD_',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // three.js alone is about 560 kB; its own chunk stays cached across game updates.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'three', test: /node_modules\/three\// }],
        },
      },
    },
  },
  server: {
    allowedHosts: true,
    // `bun run dev:server` runs the game server next to the dev server.
    proxy: {
      '/ws': { target: 'ws://localhost:3001', ws: true },
      '/paint': 'http://localhost:3001',
    },
  },
})
