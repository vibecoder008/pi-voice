import { getApiKey } from "../config.js";
import { redactSecrets } from "../utils.js";
import { BaseTTSProvider } from "./base.js";
import type { TTSProviderName, TTSConfig } from "../types.js";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;

/**
 * Deepgram Aura Text-to-Speech provider.
 *
 * Uses the `POST /v1/speak` REST endpoint with `encoding=linear16`
 * and `sample_rate=24000` to receive raw PCM audio.
 */
export class DeepgramTTSProvider extends BaseTTSProvider {
  readonly name: TTSProviderName = "deepgram";
  readonly displayName = "Deepgram Aura";
  readonly requiresApiKey = true;
  readonly supportedVoices = [
    "aura-asteria-en",
    "aura-luna-en",
    "aura-stella-en",
    "aura-athena-en",
    "aura-hera-en",
    "aura-orion-en",
    "aura-arcas-en",
    "aura-perseus-en",
    "aura-angus-en",
    "aura-orpheus-en",
    "aura-helios-en",
    "aura-zeus-en",
  ];

  private _apiKey = "";

  async initialize(config: TTSConfig): Promise<void> {
    await super.initialize(config);

    const key = getApiKey("deepgram");
    if (!key) {
      throw new Error(
        "Deepgram API key not found. Set DEEPGRAM_API_KEY or configure via voice settings.",
      );
    }
    this._apiKey = key;

    if (!this._voice) {
      this._voice = "aura-asteria-en";
    }
  }

  /**
   * Synthesize text via the Deepgram Aura REST API.
   *
   * The voice name is passed as the `model` query parameter.
   * The response body is streamed as raw linear16 PCM at 24 kHz.
   */
  async speak(text: string, signal?: AbortSignal): Promise<void> {
    if (!text.trim()) return;

    const linkedSignal = this.createLinkedAbort(signal);
    const params = new URLSearchParams({
      model: this._voice,
      encoding: "linear16",
      sample_rate: String(SAMPLE_RATE),
    });
    const url = `https://api.deepgram.com/v1/speak?${params}`;

    this._speaking = true;
    this.emit("start");

    try {
      const timeoutSignal = AbortSignal.timeout(15000);
      const combinedSignal = AbortSignal.any([linkedSignal, timeoutSignal]);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${this._apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
        signal: combinedSignal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Deepgram TTS API error ${response.status}: ${redactSecrets(body)}`,
        );
      }

      if (!response.body) {
        throw new Error("Empty response body from Deepgram TTS API.");
      }

      for await (const raw of response.body as any as AsyncIterable<Uint8Array>) {
        if (linkedSignal.aborted) break;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        this.emitAudioChunk(buf, SAMPLE_RATE, CHANNELS, BIT_DEPTH);
      }
    } catch (err: any) {
      if (linkedSignal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("error", new Error(redactSecrets(msg)));
    } finally {
      this._speaking = false;
      this.emit("end");
    }
  }
}
