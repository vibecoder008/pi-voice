import WebSocket from "ws";
import { getApiKey } from "../config.js";
import { redactSecrets } from "../utils.js";
import { BaseTTSProvider } from "./base.js";
import type { TTSProviderName, TTSConfig } from "../types.js";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;
const API_VERSION = "2024-06-10";

/** A few well-known Cartesia voice IDs. */
const KNOWN_VOICES: Record<string, string> = {
  "barbershop-man": "a0e99841-438c-4a64-b679-ae501e7d6091",
  "reading-lady": "2ee87190-8f84-4925-97da-e52547f9462c",
  "newsman": "d46abd1d-2571-4da5-8a47-a5cb5697f4e6",
  "sportscaster": "2695b6b5-5543-4be1-96d9-3967fb5e7fad",
  "teacher": "573e3144-a684-4e72-ac2b-9b2063a50b53",
};

/**
 * Cartesia Sonic TTS provider.
 *
 * Supports two modes:
 *  1. **WebSocket** (default) — persistent connection, lowest latency.
 *  2. **HTTP** — fallback via `POST /tts/bytes`.
 *
 * Both return raw PCM s16le at 24 kHz.
 */
export class CartesiaTTSProvider extends BaseTTSProvider {
  readonly name: TTSProviderName = "cartesia";
  readonly displayName = "Cartesia Sonic";
  readonly requiresApiKey = true;
  readonly supportedVoices = Object.keys(KNOWN_VOICES);

  private _apiKey = "";
  private _modelId = "sonic-2";
  private _ws: WebSocket | null = null;
  private _useWebSocket = true;

  private resolveVoiceId(voice: string): string {
    // Already a UUID
    if (voice.includes("-") && voice.length > 30) return voice;
    return KNOWN_VOICES[voice.toLowerCase()] ?? KNOWN_VOICES["barbershop-man"];
  }

  async initialize(config: TTSConfig): Promise<void> {
    await super.initialize(config);

    const key = getApiKey("cartesia");
    if (!key) {
      throw new Error(
        "Cartesia API key not found. Set CARTESIA_API_KEY or configure via voice settings.",
      );
    }
    this._apiKey = key;

    if (!this._voice) {
      this._voice = "barbershop-man";
    }

    const opts = config.providerOptions?.cartesia;
    if (opts?.model_id && typeof opts.model_id === "string") {
      this._modelId = opts.model_id;
    }
    if (opts?.useWebSocket === false) {
      this._useWebSocket = false;
    }
  }

  /**
   * Speak the given text using either WebSocket or HTTP transport.
   */
  async speak(text: string, signal?: AbortSignal): Promise<void> {
    if (!text.trim()) return;

    if (this._useWebSocket) {
      await this._speakWs(text, signal);
    } else {
      await this._speakHttp(text, signal);
    }
  }

  /**
   * Override streaming to use WebSocket context-based streaming
   * for lower latency when in WebSocket mode.
   */
  async speakStreaming(
    textStream: AsyncIterable<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this._useWebSocket) {
      return super.speakStreaming(textStream, signal);
    }

    const linkedSignal = this.createLinkedAbort(signal);
    const ws = await this._ensureWebSocket();

    this._speaking = true;
    this.emit("start");

    const contextId = crypto.randomUUID();
    const voiceId = this.resolveVoiceId(this._voice);

    try {
      // Set up a promise that resolves when the server signals done.
      const done = new Promise<void>((resolve, reject) => {
        let resolved = false;

        const timeout = setTimeout(() => {
          if (!resolved) { resolved = true; cleanup(); resolve(); }
        }, 30000);

        const cleanup = () => {
          clearTimeout(timeout);
          ws.off("message", onMessage);
          ws.off("error", onError);
          ws.off("close", onClose);
        };

        const onMessage = (data: WebSocket.Data) => {
          if (linkedSignal.aborted) {
            if (!resolved) { resolved = true; cleanup(); resolve(); }
            return;
          }

          // Binary frames are audio chunks.
          if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            this.emitAudioChunk(buf, SAMPLE_RATE, CHANNELS, BIT_DEPTH);
            return;
          }

          // Text frames are JSON status messages.
          try {
            const msg = JSON.parse(data.toString());
            if (msg.done && msg.context_id === contextId) {
              if (!resolved) { resolved = true; cleanup(); resolve(); }
            }
          } catch {
            // ignore parse errors
          }
        };

        const onError = (err: Error) => {
          if (!resolved) { resolved = true; cleanup(); reject(err); }
        };

        const onClose = () => {
          if (!resolved) { resolved = true; cleanup(); resolve(); }
        };

        ws.on("message", onMessage);
        ws.once("error", onError);
        ws.once("close", onClose);

        linkedSignal.addEventListener("abort", () => {
          if (!resolved) { resolved = true; cleanup(); resolve(); }
        }, { once: true });
      });

      // Send text chunks as they arrive.
      for await (const chunk of textStream) {
        if (linkedSignal.aborted) break;
        ws.send(
          JSON.stringify({
            model_id: this._modelId,
            transcript: chunk,
            voice: { mode: "id", id: voiceId },
            context_id: contextId,
            output_format: {
              container: "raw",
              encoding: "pcm_s16le",
              sample_rate: SAMPLE_RATE,
            },
            continue: true,
          }),
        );
      }

      // Signal end of input.
      if (!linkedSignal.aborted) {
        ws.send(
          JSON.stringify({
            model_id: this._modelId,
            transcript: "",
            voice: { mode: "id", id: voiceId },
            context_id: contextId,
            output_format: {
              container: "raw",
              encoding: "pcm_s16le",
              sample_rate: SAMPLE_RATE,
            },
            continue: false,
          }),
        );
      }

      await done;
    } catch (err: any) {
      if (linkedSignal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("error", new Error(redactSecrets(msg)));
    } finally {
      this._speaking = false;
      this.emit("end");
    }
  }

  stop(): void {
    super.stop();
  }

  async dispose(): Promise<void> {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    await super.dispose();
  }

  // ── WebSocket transport ─────────────────────────────────────────────

  private async _ensureWebSocket(): Promise<WebSocket> {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      return this._ws;
    }

    const url = `wss://api.cartesia.ai/tts/websocket?cartesia_version=${API_VERSION}`;

    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          "X-API-Key": this._apiKey,
          "Cartesia-Version": API_VERSION,
        },
      });
      ws.binaryType = "arraybuffer";

      const connectTimeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          reject(new Error("Cartesia: connection timeout"));
        }
      }, 10000);

      ws.once("open", () => {
        clearTimeout(connectTimeout);
        this._ws = ws;
        resolve(ws);
      });
      ws.once("error", (err) => {
        clearTimeout(connectTimeout);
        reject(err);
      });

      ws.on("close", () => {
        clearTimeout(connectTimeout);
        if (this._ws === ws) this._ws = null;
      });
    });
  }

  private async _speakWs(text: string, signal?: AbortSignal): Promise<void> {
    const linkedSignal = this.createLinkedAbort(signal);
    const ws = await this._ensureWebSocket();
    const voiceId = this.resolveVoiceId(this._voice);
    const contextId = crypto.randomUUID();

    this._speaking = true;
    this.emit("start");

    try {
      const done = new Promise<void>((resolve, reject) => {
        let resolved = false;

        const timeout = setTimeout(() => {
          if (!resolved) { resolved = true; cleanup(); resolve(); }
        }, 30000);

        const cleanup = () => {
          clearTimeout(timeout);
          ws.off("message", onMessage);
          ws.off("error", onError);
          ws.off("close", onClose);
        };

        const onMessage = (data: WebSocket.Data) => {
          if (linkedSignal.aborted) {
            if (!resolved) { resolved = true; cleanup(); resolve(); }
            return;
          }

          if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            this.emitAudioChunk(buf, SAMPLE_RATE, CHANNELS, BIT_DEPTH);
            return;
          }

          try {
            const msg = JSON.parse(data.toString());
            if (msg.done && msg.context_id === contextId) {
              if (!resolved) { resolved = true; cleanup(); resolve(); }
            }
          } catch {
            // ignore
          }
        };

        const onError = (err: Error) => {
          if (!resolved) { resolved = true; cleanup(); reject(err); }
        };

        const onClose = () => {
          if (!resolved) { resolved = true; cleanup(); resolve(); }
        };

        ws.on("message", onMessage);
        ws.once("error", onError);
        ws.once("close", onClose);

        linkedSignal.addEventListener("abort", () => {
          if (!resolved) { resolved = true; cleanup(); resolve(); }
        }, { once: true });
      });

      ws.send(
        JSON.stringify({
          model_id: this._modelId,
          transcript: text,
          voice: { mode: "id", id: voiceId },
          context_id: contextId,
          output_format: {
            container: "raw",
            encoding: "pcm_s16le",
            sample_rate: SAMPLE_RATE,
          },
        }),
      );

      await done;
    } catch (err: any) {
      if (linkedSignal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("error", new Error(redactSecrets(msg)));
    } finally {
      this._speaking = false;
      this.emit("end");
    }
  }

  // ── HTTP transport ──────────────────────────────────────────────────

  private async _speakHttp(text: string, signal?: AbortSignal): Promise<void> {
    const linkedSignal = this.createLinkedAbort(signal);
    const voiceId = this.resolveVoiceId(this._voice);

    this._speaking = true;
    this.emit("start");

    try {
      const timeoutSignal = AbortSignal.timeout(15000);
      const combinedSignal = AbortSignal.any([linkedSignal, timeoutSignal]);

      const response = await fetch("https://api.cartesia.ai/tts/bytes", {
        method: "POST",
        headers: {
          "X-API-Key": this._apiKey,
          "Cartesia-Version": API_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_id: this._modelId,
          transcript: text,
          voice: { mode: "id", id: voiceId },
          output_format: {
            container: "raw",
            encoding: "pcm_s16le",
            sample_rate: SAMPLE_RATE,
          },
        }),
        signal: combinedSignal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Cartesia API error ${response.status}: ${redactSecrets(body)}`);
      }

      if (!response.body) {
        throw new Error("Empty response body from Cartesia API.");
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
