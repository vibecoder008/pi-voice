import { spawn, type ChildProcess } from "node:child_process";
import { BaseTTSProvider } from "./base.js";
import type { TTSProviderName, TTSConfig } from "../types.js";

/** Piper outputs raw PCM 16-bit mono at 22050 Hz by default. */
const SAMPLE_RATE = 22050;
const CHANNELS = 1;
const BIT_DEPTH = 16;

/**
 * Piper local TTS provider.
 *
 * Uses the `piper` CLI to synthesize speech entirely offline.
 * Piper is a fast, local neural TTS engine. Audio is generated
 * as raw 16-bit mono PCM at 22050 Hz.
 *
 * Install: https://github.com/rhasspy/piper
 *
 * Usage: `echo "text" | piper --model {model} --output-raw`
 */
export class PiperTTSProvider extends BaseTTSProvider {
  readonly name: TTSProviderName = "piper";
  readonly displayName = "Piper (Local)";
  readonly requiresApiKey = false;
  readonly supportedVoices = [
    "en_US-lessac-medium",
    "en_US-amy-medium",
    "en_US-ryan-medium",
    "en_GB-alan-medium",
  ];

  private _binaryPath = "piper";
  private _activeProcess: ChildProcess | null = null;

  async initialize(config: TTSConfig): Promise<void> {
    await super.initialize(config);

    if (!this._voice) {
      this._voice = "en_US-lessac-medium";
    }

    const opts = config.providerOptions?.piper;
    if (opts?.binaryPath && typeof opts.binaryPath === "string") {
      this._binaryPath = opts.binaryPath;
    }

    // Verify piper is available.
    await this._findBinary();
  }

  /**
   * Locate the piper binary. Try `piper` first, then `piper-tts`.
   */
  private async _findBinary(): Promise<void> {
    const candidates = [this._binaryPath, "piper", "piper-tts"];
    const seen = new Set<string>();

    for (const bin of candidates) {
      if (seen.has(bin)) continue;
      seen.add(bin);

      const found = await this._binaryExists(bin);
      if (found) {
        this._binaryPath = bin;
        return;
      }
    }

    throw new Error(
      "Piper TTS binary not found.\n\n" +
      "Install piper:\n" +
      "  - Linux/macOS: Download from https://github.com/rhasspy/piper/releases\n" +
      "  - pip:         pip install piper-tts\n" +
      "  - Arch Linux:  paru -S piper-tts-bin\n\n" +
      "You also need at least one voice model. Download from:\n" +
      "  https://github.com/rhasspy/piper/blob/master/VOICES.md\n\n" +
      'Place the .onnx file and .json config in ~/.local/share/piper-voices/\n' +
      'or specify the full path via the "voice" config option.',
    );
  }

  /**
   * Check whether a binary exists on $PATH by attempting to run `--version`.
   */
  private _binaryExists(bin: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(bin, ["--version"], {
        stdio: "ignore",
        timeout: 3000,
      });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    });
  }

  /**
   * Synthesize text by piping it through the piper CLI.
   *
   * `echo "{text}" | piper --model {model} --output-raw`
   *
   * Output is raw 16-bit signed LE mono PCM at 22050 Hz.
   */
  async speak(text: string, signal?: AbortSignal): Promise<void> {
    if (!text.trim()) return;

    const linkedSignal = this.createLinkedAbort(signal);

    this._speaking = true;
    this.emit("start");

    try {
      await new Promise<void>((resolve, reject) => {
        const args = ["--model", this._voice, "--output-raw"];
        const proc = spawn(this._binaryPath, args, {
          stdio: ["pipe", "pipe", "pipe"],
        });
        this._activeProcess = proc;

        const stderrChunks: Buffer[] = [];

        proc.stdout!.on("data", (chunk: Buffer) => {
          if (linkedSignal.aborted) return;
          this.emitAudioChunk(chunk, SAMPLE_RATE, CHANNELS, BIT_DEPTH);
        });

        proc.stderr!.on("data", (chunk: Buffer) => {
          stderrChunks.push(chunk);
        });

        proc.on("close", (code) => {
          this._activeProcess = null;
          if (linkedSignal.aborted) {
            resolve();
            return;
          }
          if (code !== 0 && code !== null) {
            const stderr = Buffer.concat(stderrChunks).toString().trim();
            reject(
              new Error(
                `Piper exited with code ${code}${stderr ? `: ${stderr}` : ""}`,
              ),
            );
          } else {
            resolve();
          }
        });

        proc.on("error", (err) => {
          this._activeProcess = null;
          reject(err);
        });

        const onAbort = () => {
          proc.kill("SIGTERM");
        };
        linkedSignal.addEventListener("abort", onAbort, { once: true });
        proc.on("close", () => {
          linkedSignal.removeEventListener("abort", onAbort);
        });

        // Write text to stdin and close.
        proc.stdin!.write(text);
        proc.stdin!.end();
      });
    } catch (err: any) {
      if (linkedSignal.aborted) return;
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    } finally {
      this._speaking = false;
      this.emit("end");
    }
  }

  stop(): void {
    if (this._activeProcess) {
      this._activeProcess.kill("SIGTERM");
      this._activeProcess = null;
    }
    super.stop();
  }

  async dispose(): Promise<void> {
    if (this._activeProcess) {
      this._activeProcess.kill("SIGTERM");
      this._activeProcess = null;
    }
    await super.dispose();
  }
}
