import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` makes every built asset path relative, so the same build
// works whether it's served from https://<user>.github.io/ (a user/org
// page) or https://<user>.github.io/<repo>/ (a project page) — no need to
// hardcode the repo name here.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
