import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// `npm run dev` proxies the API to a running host or mock server (default the mock on :8443).
const target = process.env.PARTYLINE_SERVER ?? "https://127.0.0.1:8443";

// iOS fetches the Home Screen icon in a separate download that ignores the Safari exception for
// the host's self-signed cert, so a linked icon comes out as a plain letter. Embed it instead.
const inlineTouchIcon = {
  name: "inline-touch-icon",
  transformIndexHtml(html: string) {
    const png = readFileSync(fileURLToPath(new URL("./public/apple-touch-icon.png", import.meta.url))).toString("base64");
    return html.replace(/href="\.?\/apple-touch-icon\.png[^"]*"/, `href="data:image/png;base64,${png}"`);
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), inlineTouchIcon],
  base: "./",
  resolve: {
    alias: { "@partyline/protocol": fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)) },
  },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: {
    host: true,
    proxy: {
      "/api": { target, secure: false, ws: true, changeOrigin: true },
      "/rtc": { target, secure: false, ws: true, changeOrigin: true },
      "/healthz": { target, secure: false },
    },
  },
});
