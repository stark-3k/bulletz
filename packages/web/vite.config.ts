import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command, mode }) => ({
  plugins: [react()],
  // Relative, because the same bundle is loaded two ways: served over http
  // from the server, and opened over file:// by the packaged desktop app.
  // An absolute base resolves to the filesystem root under file:// and the
  // window comes up blank.
  base: "./",
  server: { port: 5174, strictPort: true },
  define: {
    // VITE_BULLETZ_TOKEN is a local convenience that keeps the dev server from
    // stopping at the login screen. Vite loads .env.local in every mode, so
    // without this a production build silently embeds a real API token in a
    // file meant to be handed to other people. It has to be stripped here, not
    // remembered.
    ...(command === "build" ? { "import.meta.env.VITE_BULLETZ_TOKEN": "undefined" } : {}),
    // A build for distribution must not pin a server either: the whole point
    // of the first-run Connect screen is that the person installing it says
    // where their workspace lives. A team building their own preconfigured
    // binary can still pin one by building without this mode.
    ...(mode === "package" ? { "import.meta.env.VITE_BULLETZ_URL": "undefined" } : {}),
  },
}));
