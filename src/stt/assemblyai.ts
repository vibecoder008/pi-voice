import WebSocket from "ws";
import { BaseSTTProvider } from "./base.js";
import { getApiKey } from "../config.js";
import { redactSecrets } from "../utils.js";
import type { STTConfig, STTProviderName } from "../types.js";

/**
 * AssemblyAI real-time STT provider.
 *
 * Streams audio over a WebSocket connection to AssemblyAI's real-time
 * transcription API. Audio chunks are base64-encoded and sent as JSON
 * messages. Supports both partial and final transcript events.
 */
export class AssemblyAISTTProvider extends BaseSTTProvider {
  readonly name: STTProviderName = "assemblyai";
  readonly displayName = "AssemblyAI";
  readonly supportsStreaming = true;
  readonly requiresApiKey = true;

  private ws: WebSocket | null = null;
  private apiKey: string | null = null;
  private closing = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_RECONNECT_ATTEMPTS = 3;
  private static readonly RECONNECT_BASE_DELAY_MS = 1000;

  /**
   * Initialize the provider with the given configuration.
   * Resolves the AssemblyAI API key from config or environment.
   */
  async initialize(config: STTConfig): Promise<void> {
    this.config = config;
    this.apiKey = getApiKey("assemblyai") ?? null;

    if (!this.apiKey) {
      throw new Error(
        "AssemblyAI API key not found. Set ASSEMBLYAI_API_KEY or configure via voice settings.",
      );
    }
  }

  /**
   * Open a WebSocket connection to AssemblyAI and begin listening.
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
   * Sends a `terminate_session` message to cleanly end the stream.
   *
   * @returns The full accumulated transcript.
   */
  async stopListening(): Promise<string> {
    if (!this.listening) return this.accumulatedTranscript;

    this.listening = false;
    this.closing = true;

    // Send terminate_session to flush remaining audio
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ terminate_session: true }));
      } catch {
        // ignore send errors during close
      }
    }

    // Wait briefly for any final transcripts in-flight
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    this.closeWebSocket();

    return this.accumulatedTranscript;
  }

  /**
   * Send a raw PCM audio chunk to AssemblyAI.
   *
   * AssemblyAI expects audio data as base64-encoded strings inside a
   * JSON object: `{ "audio_data": "<base64>" }`.
   */
  sendAudio(chunk: Buffer): void {
    if (!this.listening) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    try {
      const message = JSON.stringify({
        audio_data: chunk.toString("base64"),
      });
      this.ws.send(message);
    } catch (err) {
      this.emitError(err);
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
   * Build the AssemblyAI WebSocket URL with a temporary auth token.
   */
  private buildUrl(token: string): string {
    const sampleRate =
      (this.config?.providerOptions?.["assemblyai"]?.[
        "sample_rate"
      ] as number) ?? 16000;
    return (
      `wss://api.assemblyai.com/v2/realtime/ws` +
      `?sample_rate=${sampleRate}` +
      `&token=${encodeURIComponent(token)}`
    );
  }

  /**
   * Obtain a short-lived temporary token from AssemblyAI's REST API.
   * This avoids exposing the permanent API key in the WebSocket URL.
   */
  private async obtainTempToken(): Promise<string> {
    const response = await fetch(
      "https://api.assemblyai.com/v2/realtime/token",
      {
        method: "POST",
        headers: {
          Authorization: this.apiKey!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expires_in: 300 }),
        signal: AbortSignal.timeout(15000),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Failed to obtain AssemblyAI temporary token (${response.status})`,
      );
    }

    const data = (await response.json()) as { token: string };
    return data.token;
  }

  /**
   * Establish the WebSocket connection and bind message handlers.
   */
  private async connect(): Promise<void> {
    const tempToken = await this.obtainTempToken();

    return new Promise<void>((resolve, reject) => {
      const url = this.buildUrl(tempToken);

      this.ws = new WebSocket(url);

      let resolved = false;

      const connectTimeout = setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          this.ws.close();
          const err = new Error("AssemblyAI: connection timeout");
          this.emitError(err);
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        }
      }, 10000);

      this.ws.on("open", () => {
        clearTimeout(connectTimeout);
        if (!resolved) {
          resolved = true;
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
        const redacted = new Error(redactSecrets(err.message));
        this.emitError(redacted);
        if (!resolved) {
          resolved = true;
          reject(redacted);
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
   * Parse an incoming AssemblyAI WebSocket message and emit transcript events.
   *
   * AssemblyAI sends JSON objects with:
   * - `message_type` — "PartialTranscript" or "FinalTranscript"
   * - `text` — the recognized text
   * - `confidence` — recognition confidence (0.0 to 1.0)
   * - `audio_start` / `audio_end` — timing information
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const msg = JSON.parse(data.toString());

      // Handle session-level messages
      if (msg.message_type === "SessionBegins") {
        return;
      }

      if (msg.message_type === "SessionTerminated") {
        return;
      }

      // Handle error messages from AssemblyAI
      if (msg.error) {
        this.emitError(new Error(`AssemblyAI: ${msg.error}`));
        return;
      }

      const text: string = msg.text ?? "";
      const confidence: number = msg.confidence ?? 0;

      if (msg.message_type === "PartialTranscript") {
        if (!text) return;
        this.emitTranscript({
          text,
          isFinal: false,
          confidence,
        });
      } else if (msg.message_type === "FinalTranscript") {
        this.emitTranscript({
          text,
          isFinal: true,
          confidence,
        });
      }
    } catch (err) {
      this.emitError(err);
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= AssemblyAISTTProvider.MAX_RECONNECT_ATTEMPTS) {
      this.emitError(
        new Error(
          `AssemblyAI: failed to reconnect after ${AssemblyAISTTProvider.MAX_RECONNECT_ATTEMPTS} attempts`,
        ),
      );
      this.listening = false;
      this.emit("closed");
      return;
    }

    const delay =
      AssemblyAISTTProvider.RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts);
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
   * Cancel any pending reconnection timer.
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
}
