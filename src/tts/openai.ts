import OpenAI from "openai";
import { getApiKey } from "../config.js";
import { BaseTTSProvider } from "./base.js";
import type { TTSProviderName, TTSConfig } from "../types.js";

/** PCM format returned by the OpenAI TTS API with response_format "pcm". */
const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;

/**
 * OpenAI TTS provider.
 *
 * Uses the `openai` npm package to call the `audio.speech.create` endpoint
 * with `response_format: "pcm"`, which returns raw 24 kHz 16-bit mono PCM.
 */
export class OpenAITTSProvider extends BaseTTSProvider {
  readonly name: TTSProviderName = "openai";
  readonly displayName = "OpenAI TTS";
  readonly requiresApiKey = true;
  readonly supportedVoices = [
    "alloy",
    "echo",
    "fable",
    "onyx",
    "nova",
    "shimmer",
  ];

  private _client: OpenAI | null = null;
  private _model = "tts-1";

  /** Initialize the OpenAI client and apply configuration. */
  async initialize(config: TTSConfig): Promise<void> {
    await super.initialize(config);

    const apiKey = getApiKey("openai");
    if (!apiKey) {
      throw new Error(
        "OpenAI API key not found. Set OPENAI_API_KEY or configure via voice settings.",
      );
    }

    this._client = new OpenAI({ apiKey });

    if (!this._voice) {
      this._voice = "nova";
    }

    // Allow overriding the model via providerOptions.
    const opts = config.providerOptions?.openai;
    if (opts?.model && typeof opts.model === "string") {
      this._model = opts.model;
    }
  }

  /**
   * Synthesize `text` into PCM audio and emit chunks.
   *
   * The OpenAI API returns the entire response as a streamable body
   * when `response_format` is `"pcm"`.  We read it incrementally and
   * emit `audioChunk` events as data arrives.
   */
  async speak(text: string, signal?: AbortSignal): Promise<void> {
    if (!this._client) {
      throw new Error("OpenAI TTS provider not initialized. Call initialize() first.");
    }
    if (!text.trim()) return;

    const linkedSignal = this.createLinkedAbort(signal);

    this._speaking = true;
    this.emit("start");

    try {
      const timeoutSignal = AbortSignal.timeout(15000);
      const combinedSignal = AbortSignal.any([linkedSignal, timeoutSignal]);

      const response = await this._client.audio.speech.create({
        model: this._model,
        voice: this._voice as any,
        input: text,
        response_format: "pcm",
        speed: this._speed,
      }, { signal: combinedSignal });

      // response.body is a ReadableStream (web) or a Node readable.
      const body = response.body;
      if (!body) {
        throw new Error("Empty response body from OpenAI TTS API.");
      }

      // Iterate over the response body as an async iterable of Uint8Array.
      const reader =
        typeof (body as any)[Symbol.asyncIterator] === "function"
          ? (body as AsyncIterable<Uint8Array>)
          : readWebStream(body as unknown as ReadableStream<Uint8Array>);

      for await (const raw of reader) {
        if (linkedSignal.aborted) break;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        this.emitAudioChunk(buf, SAMPLE_RATE, CHANNELS, BIT_DEPTH);
      }
    } catch (err: any) {
      if (linkedSignal.aborted) return; // expected abort
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    } finally {
      this._speaking = false;
      this.emit("end");
    }
  }
}

/**
 * Convert a web `ReadableStream` into an `AsyncIterable<Uint8Array>`.
 * Used when the `openai` SDK returns a web stream instead of a Node stream.
 */
async function* readWebStream(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
