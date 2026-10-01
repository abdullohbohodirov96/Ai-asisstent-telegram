import { config } from "./config/env.js";
import { registerOwnerHandler, registerDeletionListener } from "./telegram/ingest.js";
import { onOwnerMessage, onOwnerCallback } from "./bot/owner.js";
import { onMessagesDeleted } from "./engine/preferences.js";
import { setProviderFactory } from "./ai/client.js";
import { GeminiProvider } from "./ai/gemini.js";
import { ClaudeCliProvider } from "./ai/claudeCli.js";

/** Wires handlers and the AI provider (shared by the server and the laptop worker). */
export function wireApp() {
  registerOwnerHandler({ onOwnerMessage, onOwnerCallback });
  registerDeletionListener(onMessagesDeleted);
  setProviderFactory(() => (config().aiProvider === "claude-cli" ? new ClaudeCliProvider() : new GeminiProvider()));
  // To use a local transcription model later:
  //   setTranscriptionProvider(new HttpTranscriptionProvider(process.env.LOCAL_STT_URL!))
}

