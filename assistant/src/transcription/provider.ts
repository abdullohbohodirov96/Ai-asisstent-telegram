import { generateText } from "../ai/client.js";
import { TRANSCRIPTION_SYSTEM, TRANSCRIPTION_USER } from "../ai/prompts/transcription.js";

/**
 * Speech-to-text abstraction. V1 uses Gemini multimodal. To switch to a local
 * model later, implement this interface (e.g. an HTTP call to your own Whisper
 * server) and register it with setTranscriptionProvider() in src/index.ts.
 */
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

export class GeminiTranscriptionProvider implements TranscriptionProvider {
  readonly name = "gemini";
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const { text } = await generateText({
      purpose: "TRANSCRIPTION",
      tier: "TRANSCRIBE",
      system: TRANSCRIPTION_SYSTEM,
      user: TRANSCRIPTION_USER,
      audio: { data: audio, mimeType },
    });
    return text.trim();
  }
}

/** Example skeleton for a future self-hosted model (not used in V1). */
export class HttpTranscriptionProvider implements TranscriptionProvider {
  readonly name = "http";
  constructor(private readonly url: string) {}
  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const res = await fetch(this.url, { method: "POST", headers: { "Content-Type": mimeType }, body: new Uint8Array(audio) });
    if (!res.ok) throw new Error(`transcription server ${res.status}`);
    const json = (await res.json()) as { text: string };
    return json.text.trim();
  }
}

let current: TranscriptionProvider = new GeminiTranscriptionProvider();
export function setTranscriptionProvider(p: TranscriptionProvider) {
  current = p;
}
export function transcriptionProvider(): TranscriptionProvider {
  return current;
}
