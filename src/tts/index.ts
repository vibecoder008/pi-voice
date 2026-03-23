export { BaseTTSProvider } from "./base.js";
export { OpenAITTSProvider } from "./openai.js";
export { ElevenLabsTTSProvider } from "./elevenlabs.js";
export { CartesiaTTSProvider } from "./cartesia.js";
export { GoogleTTSProvider } from "./google.js";
export { AzureTTSProvider } from "./azure.js";
export { DeepgramTTSProvider } from "./deepgram.js";
export { EdgeTTSProvider } from "./edge-tts.js";
export { PiperTTSProvider } from "./piper.js";
export { SystemTTSProvider } from "./system.js";

import type { TTSProvider, TTSProviderName } from "../types.js";
import { OpenAITTSProvider } from "./openai.js";
import { ElevenLabsTTSProvider } from "./elevenlabs.js";
import { CartesiaTTSProvider } from "./cartesia.js";
import { GoogleTTSProvider } from "./google.js";
import { AzureTTSProvider } from "./azure.js";
import { DeepgramTTSProvider } from "./deepgram.js";
import { EdgeTTSProvider } from "./edge-tts.js";
import { PiperTTSProvider } from "./piper.js";
import { SystemTTSProvider } from "./system.js";

/**
 * Create a TTS provider instance by name.
 *
 * The returned provider still needs to be initialized via
 * `provider.initialize(config)` before use.
 *
 * @param name - One of the supported TTSProviderName values.
 * @returns An uninitialized TTSProvider instance.
 * @throws If the provider name is unknown.
 */
export function createTTSProvider(name: TTSProviderName): TTSProvider {
  switch (name) {
    case "openai":
      return new OpenAITTSProvider();
    case "elevenlabs":
      return new ElevenLabsTTSProvider();
    case "cartesia":
      return new CartesiaTTSProvider();
    case "google":
      return new GoogleTTSProvider();
    case "azure":
      return new AzureTTSProvider();
    case "deepgram":
      return new DeepgramTTSProvider();
    case "edge-tts":
      return new EdgeTTSProvider();
    case "piper":
      return new PiperTTSProvider();
    case "system":
      return new SystemTTSProvider();
    default: {
      const _exhaustive: never = name;
      throw new Error(
        `Unknown TTS provider: "${_exhaustive}". ` +
        `Supported: openai, elevenlabs, cartesia, google, azure, deepgram, edge-tts, piper, system`,
      );
    }
  }
}
