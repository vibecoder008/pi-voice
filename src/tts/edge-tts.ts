import { EdgeTTS } from "node-edge-tts";
import { readFile, unlink, mkdtemp, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { BaseTTSProvider } from "./base.js";
import type { TTSProviderName, TTSConfig } from "../types.js";

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BIT_DEPTH = 16;

/**
 * Microsoft Edge TTS provider (free, no API key required).
 *
 * This is the **default TTS provider** for pi-voice because it
 * requires no API key, has good quality neural voices, and is free.
 *
 * Uses the `node-edge-tts` npm package which communicates with
 * Microsoft's Edge speech synthesis service over WebSocket.
 */
export class EdgeTTSProvider extends BaseTTSProvider {
  readonly name: TTSProviderName = "edge-tts";
  readonly displayName = "Edge TTS (Free)";
  readonly requiresApiKey = false;
  readonly supportedVoices = [
    "en-US-AriaNeural",
    "en-US-GuyNeural",
    "en-US-JennyNeural",
    "en-US-ChristopherNeural",
    "en-GB-SoniaNeural",
    "en-AU-NatashaNeural",
  ];

  async initialize(config: TTSConfig): Promise<void> {
    await super.initialize(config);

    if (!this._voice) {
      this._voice = "en-US-AriaNeural";
    }
  }

  /**
   * Convert a numeric speed multiplier to the Edge TTS rate string.
   *
   * speed = 1.0  =>  "+0%"
   * speed = 1.5  =>  "+50%"
   * speed = 0.5  =>  "-50%"
   */
  private _speedToRate(): string {
    const percent = Math.round((this._speed - 1.0) * 100);
    return percent >= 0 ? `+${percent}%` : `${percent}%`;
  }

  /**
   * Decode an MP3 file to raw PCM via ffmpeg subprocess.
   */
  private async decodeMp3ToPcm(mp3Path: string, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const ffmpeg = spawn("ffmpeg", [
        "-i", mp3Path,
        "-f", "s16le",
        "-ar", String(SAMPLE_RATE),
        "-ac", String(CHANNELS),
        "-"
      ], { stdio: ["ignore", "pipe", "ignore"] });

      if (signal) {
        signal.addEventListener("abort", () => ffmpeg.kill("SIGTERM"), { once: true });
      }

      ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      ffmpeg.on("close", (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error("ffmpeg decode failed"));
      });
      ffmpeg.on("error", reject);
    });
  }

  /**
   * Fallback: play MP3 directly via sox/play (skips PCM pipeline).
   */
  private async playMp3Directly(mp3Path: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const player = spawn("play", [mp3Path], { stdio: "ignore" });
      if (signal) signal.addEventListener("abort", () => player.kill(), { once: true });
      player.on("close", () => resolve());
      player.on("error", () => reject(new Error("Neither ffmpeg nor play (sox) found. Install one: apt install ffmpeg")));
    });
  }

  /**
   * Synthesize text using Microsoft Edge's free TTS service.
   *
   * The `node-edge-tts` package synthesizes audio to a file via
   * `ttsPromise(text, audioPath)`. We write to a temp file, decode
   * MP3 to PCM via ffmpeg, emit the PCM data, then clean up.
   * Falls back to playing the MP3 directly via sox/play if ffmpeg
   * is not available.
   */
  async speak(text: string, signal?: AbortSignal): Promise<void> {
    if (!text.trim()) return;

    const linkedSignal = this.createLinkedAbort(signal);

    this._speaking = true;
    this.emit("start");

    let tmpFile = "";
    let tmpDir = "";

    try {
      tmpDir = await mkdtemp(join(tmpdir(), "pi-voice-edge-"));
      tmpFile = join(tmpDir, "speech.mp3");

      const tts = new EdgeTTS({
        voice: this._voice,
        rate: this._speedToRate(),
      });

      if (linkedSignal.aborted) return;

      await tts.ttsPromise(text, tmpFile);

      if (linkedSignal.aborted) return;

      // Decode MP3 to raw PCM via ffmpeg, then emit as audio chunks
      try {
        const pcmData = await this.decodeMp3ToPcm(tmpFile, linkedSignal);
        if (pcmData.length > 0 && !linkedSignal.aborted) {
          this.emitAudioChunk(pcmData, SAMPLE_RATE, CHANNELS, BIT_DEPTH);
        }
      } catch {
        // ffmpeg not available — fall back to playing MP3 directly
        if (!linkedSignal.aborted) {
          await this.playMp3Directly(tmpFile, linkedSignal);
        }
      }
    } catch (err: any) {
      if (linkedSignal.aborted) return;
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    } finally {
      this._speaking = false;
      this.emit("end");

      // Clean up temp file and directory.
      if (tmpFile) {
        unlink(tmpFile).catch(() => {});
      }
      if (tmpDir) {
        rmdir(tmpDir).catch(() => {});
      }
    }
  }
}
