import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy: /api routes hit the FastAPI backend on :8000.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
