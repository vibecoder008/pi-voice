import WebSocket from "ws";
import { BaseSTTProvider } from "./base.js";
import { getApiKey } from "../config.js";
import type { STTConfig, STTProviderName } from "../types.js";

/** Maximum number of consecutive reconnection attempts. */
const MAX_RECONNECT_ATTEMPTS = 3;

/** Base delay between reconnection attempts in milliseconds. */
const RECONNECT_BASE_DELAY_MS = 1000;

/**
 * Deepgram Nova-3 STT provider.
 *
 * Streams audio over a WebSocket connection to Deepgram's real-time
 * transcription API. Supports interim results, endpointing, and
 * automatic reconnection on transient failures.
 */
export class DeepgramSTTProvider extends BaseSTTProvider {
  readonly name: STTProviderName = "deepgram";
  readonly displayName = "Deepgram Nova-3";
  readonly supportsStreaming = true;
  readonly requiresApiKey = true;

  private ws: WebSocket | null = null;
  private apiKey: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;

  /**
   * Initialize the provider with the given configuration.
   * Resolves the Deepgram API key from config or environment.
   */
  async initialize(config: STTConfig): Promise<void> {
    this.config = config;
    this.apiKey = getApiKey("deepgram") ?? null;

    if (!this.apiKey) {
      throw new Error(
        "Deepgram API key not found. Set DEEPGRAM_API_KEY or configure via voice settings.",
      );
    }
  }

  /**
   * Open a WebSocket connection to Deepgram and begin listening.
   */
  async startListening(): Promise<void> {
    if (this.listening) return;

    this.resetState();
    this.listening = true;
    this.closing = false;
    this.reconnectAttempts = 0;

    await this.connect();
  }

  /**
   * Stop listening and close the WebSocket connection.
   * Sends a CloseStream message so Deepgram flushes any pending audio.
   *
   * @returns The full accumulated transcript.
   */
  async stopListening(): Promise<string> {
    if (!this.listening) return this.accumulatedTranscript;

    this.listening = false;
    this.closing = true;

    // Send close-stream message so Deepgram flushes remaining audio
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        // ignore send errors during close
      }
    }

    // Wait briefly for any final transcripts in-flight
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    this.closeWebSocket();

    return this.accumulatedTranscript;
  }

  /**
   * Send a raw PCM audio chunk to Deepgram over the WebSocket.
   */
  sendAudio(chunk: Buffer): void {
    if (!this.listening) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }

  /**
   * Dispose of the provider, releasing all resources.
   */
  async dispose(): Promise<void> {
    this.closing = true;
    this.listening = false;
    this.clearReconnectTimer();
    this.closeWebSocket();
  }

  // ─── Private Helpers ───────────────────────────────────────────────

  /**
   * Build the Deepgram WebSocket URL with query parameters.
   */
  private buildUrl(): string {
    const lang = this.config?.language ?? "en-US";
    const interimResults = this.config?.interimResults ?? true;
    const params = new URLSearchParams({
      model: "nova-3",
      language: lang,
      punctuate: "true",
      interim_results: String(interimResults),
      endpointing: "300",
      utterance_end_ms: "1500",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
    });
    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  }

  /**
   * Establish the WebSocket connection and bind message handlers.
   */
  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = this.buildUrl();
      let settled = false;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Token ${this.apiKey}`,
        },
      });

      const connectTimeout = setTimeout(() => {
        if (!settled && this.ws && this.ws.readyState !== WebSocket.OPEN) {
          settled = true;
          this.ws.close();
          const err = new Error("Deepgram: connection timeout");
          this.emitError(err);
          reject(err);
        }
      }, 10000);

      this.ws.on("open", () => {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimeout);
          this.reconnectAttempts = 0;
          this.emit("ready");
          resolve();
        }
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (err: Error) => {
        clearTimeout(connectTimeout);
        this.emitError(err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      this.ws.on("close", (code: number) => {
        clearTimeout(connectTimeout);
        this.ws = null;
        if (this.listening && !this.closing && code !== 1000) {
          this.scheduleReconnect();
        } else {
          this.emit("closed");
        }
      });
    });
  }

  /**
   * Parse an incoming Deepgram WebSocket message and emit transcript events.
   *
   * Deepgram sends JSON objects with:
   * - `channel.alternatives[0].transcript` — the recognized text
   * - `is_final` — whether this is the final result for the current utterance
   * - `speech_final` — whether the speaker has finished speaking (endpoint detected)
   * - `channel.alternatives[0].confidence` — recognition confidence
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const msg = JSON.parse(data.toString());

      // Only process transcription results
      if (msg.type !== "Results") return;

      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;

      const text: string = alt.transcript ?? "";
      const confidence: number = alt.confidence ?? 0;
      const isFinal: boolean = msg.is_final === true;
      const speechFinal: boolean = msg.speech_final === true;
      const language: string | undefined =
        msg.channel?.detected_language ?? undefined;

      // Skip empty interim results
      if (!text && !isFinal) return;

      this.emitTranscript({
        text,
        isFinal: isFinal || speechFinal,
        confidence,
        language,
      });
    } catch (err) {
      this.emitError(err);
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.emitError(
        new Error(
          `Deepgram: failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`,
        ),
      );
      this.listening = false;
      this.emit("closed");
      return;
    }

    const delay =
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // connect() already emitted the error; backoff continues via on-close
      }
    }, delay);
  }

  /**
   * Close the WebSocket connection if open.
   */
  private closeWebSocket(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  /**
   * Cancel any pending reconnection timer.
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
