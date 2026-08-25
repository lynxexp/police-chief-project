import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev-only proxy so the Vite dev server and the Fastify API look
// same-origin to the browser (matches production, where Fastify serves
// this build directly -- see webapp/backend/src/plugins/static.ts).
// Without this, the session/PKCE cookies (SameSite=Lax, no CORS headers
// on the backend) wouldn't be visible to fetches made from :5173.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: false,
      },
    },
  },
});
