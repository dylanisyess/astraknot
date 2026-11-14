import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" keeps the static build portable to any host path.
export default defineConfig({
  base: "./",
  plugins: [react()],
});
