import type { STTProvider, STTProviderName } from "../types.js";

import { DeepgramSTTProvider } from "./deepgram.js";
import { OpenAISTTProvider } from "./openai.js";
import { AzureSTTProvider } from "./azure.js";
import { GoogleSTTProvider } from "./google.js";
import { AssemblyAISTTProvider } from "./assemblyai.js";
import { ElevenLabsSTTProvider } from "./elevenlabs.js";
import { WhisperLocalSTTProvider } from "./whisper-local.js";

// ─── Re-exports ─────────────────────────────────────────────────────────

export { BaseSTTProvider, writeWavHeader } from "./base.js";
export { DeepgramSTTProvider } from "./deepgram.js";
export { OpenAISTTProvider } from "./openai.js";
export { AzureSTTProvider } from "./azure.js";
export { GoogleSTTProvider } from "./google.js";
export { AssemblyAISTTProvider } from "./assemblyai.js";
export { ElevenLabsSTTProvider } from "./elevenlabs.js";
export { WhisperLocalSTTProvider } from "./whisper-local.js";

/**
 * Factory function that creates an STT provider instance by name.
 *
 * The returned provider is uninitialized — call `initialize(config)`
 * before use.
 *
 * @param name - The provider identifier (e.g. "deepgram", "openai")
 * @returns A new STTProvider instance
 * @throws If the provider name is not recognized
 */
export function createSTTProvider(name: STTProviderName): STTProvider {
  switch (name) {
    case "deepgram":
      return new DeepgramSTTProvider();
    case "openai":
      return new OpenAISTTProvider();
    case "azure":
      return new AzureSTTProvider();
    case "google":
      return new GoogleSTTProvider();
    case "assemblyai":
      return new AssemblyAISTTProvider();
    case "elevenlabs":
      return new ElevenLabsSTTProvider();
    case "whisper-local":
      return new WhisperLocalSTTProvider();
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown STT provider: ${exhaustive}`);
    }
  }
}
