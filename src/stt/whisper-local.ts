import { execFile } from "node:child_process";
import { writeFile, readFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BaseSTTProvider, writeWavHeader } from "./base.js";
import type { STTConfig, STTProviderName } from "../types.js";

/**
 * Candidate binary names for the local Whisper CLI, tried in order.
 * - `whisper` — Python whisper package (openai-whisper)
 * - `whisper-cpp` — whisper.cpp CLI wrapper
 * - `main` — default whisper.cpp build output
 */
const WHISPER_BINARIES = ["whisper", "whisper-cpp", "main"];

/**
 * Local Whisper STT provider.
 *
 * Operates in batch mode: audio chunks are accumulated in memory,
 * written to a temporary WAV file, and processed by a local Whisper
 * CLI binary (openai-whisper or whisper.cpp) on stopListening().
 * Does not require an API key or network access.
 */
export class WhisperLocalSTTProvider extends BaseSTTProvider {
  readonly name: STTProviderName = "whisper-local";
  readonly displayName = "Whisper Local";
  readonly supportsStreaming = false;
  readonly requiresApiKey = false;

  private audioChunks: Buffer[] = [];
  private totalAudioBytes = 0;
  private static readonly MAX_AUDIO_BYTES = 50 * 1024 * 1024;
  private whisperBinary: string | null = null;

  /**
   * Initialize the provider and detect the available Whisper binary.
   */
  async initialize(config: STTConfig): Promise<void> {
    this.config = config;
    this.whisperBinary = await this.detectBinary();

    if (!this.whisperBinary) {
      throw new Error(
        "No local Whisper binary found. Install openai-whisper (`pip install openai-whisper`) " +
          "or whisper.cpp and ensure `whisper`, `whisper-cpp`, or `main` is on your PATH.",
      );
    }
  }

  /**
   * Begin accumulating audio chunks for batch transcription.
   */
  async startListening(): Promise<void> {
    if (this.listening) return;

    this.resetState();
    this.audioChunks = [];
    this.totalAudioBytes = 0;
    this.listening = true;
    this.emit("ready");
  }

  /**
   * Stop listening, write the accumulated audio to a temporary WAV file,
   * run the local Whisper binary, and return the transcribed text.
   *
   * @returns The full transcript from the local Whisper output.
   */
  async stopListening(): Promise<string> {
    if (!this.listening) return this.accumulatedTranscript;

    this.listening = false;

    if (this.audioChunks.length === 0) {
      return this.accumulatedTranscript;
    }

    try {
      const transcript = await this.transcribeAudio();
      if (transcript) {
        this.emitTranscript({
          text: transcript,
          isFinal: true,
          confidence: 1.0,
        });
      }
    } catch (err) {
      this.emitError(err);
    }

    return this.accumulatedTranscript;
  }

  /**
   * Buffer an audio chunk for later batch transcription.
   */
  sendAudio(chunk: Buffer): void {
    if (!this.listening) return;
    this.totalAudioBytes += chunk.length;
    if (this.totalAudioBytes > WhisperLocalSTTProvider.MAX_AUDIO_BYTES) {
      this.emitError(new Error("Audio buffer limit exceeded. Stop and restart recording."));
      return;
    }
    this.audioChunks.push(chunk);
  }

  /**
   * Dispose of the provider, releasing all resources.
   */
  async dispose(): Promise<void> {
    this.listening = false;
    this.audioChunks = [];
  }

  // ─── Private Helpers ───────────────────────────────────────────────

  /**
   * Detect which Whisper binary is available on the system PATH.
   * Tries each candidate in order and returns the first one that responds
   * to `--help` (or `-h`) without error.
   *
   * @returns The binary name, or null if none found.
   */
  private async detectBinary(): Promise<string | null> {
    // Allow explicit override via provider options
    const override = this.config?.providerOptions?.["whisper-local"]?.[
      "binary"
    ] as string | undefined;
    if (override) {
      return override;
    }

    for (const bin of WHISPER_BINARIES) {
      const found = await this.tryBinary(bin);
      if (found) return bin;
    }
    return null;
  }

  /**
   * Test whether a binary is available by attempting to execute it
   * with a help flag.
   */
  private tryBinary(bin: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(bin, ["--help"], { timeout: 5000 }, (err) => {
        resolve(!err);
      });
    });
  }

  /**
   * Concatenate buffered PCM audio, write to a temporary WAV file,
   * invoke the Whisper binary, and read back the transcript.
   *
   * @returns The transcribed text, or an empty string on failure.
   */
  private async transcribeAudio(): Promise<string> {
    const pcm = Buffer.concat(this.audioChunks);
    this.audioChunks = [];

    if (pcm.length === 0) return "";

    const wav = writeWavHeader(pcm, 16000, 1, 16);

    // Create a temporary directory for input/output files
    const tempDir = await mkdtemp(join(tmpdir(), "pi-whisper-"));
    const wavPath = join(tempDir, "audio.wav");
    const outputBasePath = join(tempDir, "audio");

    try {
      await writeFile(wavPath, wav);

      const transcript = await this.runWhisper(wavPath, outputBasePath, tempDir);
      return transcript.trim();
    } finally {
      // Clean up temporary files
      await this.cleanupTemp(tempDir, wavPath, outputBasePath);
    }
  }

  /**
   * Execute the Whisper binary and return the transcribed text.
   *
   * Handles both openai-whisper (Python) and whisper.cpp CLI argument
   * conventions.
   */
  private runWhisper(
    wavPath: string,
    outputBasePath: string,
    tempDir: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const providerOpts =
        (this.config?.providerOptions?.["whisper-local"] as Record<
          string,
          unknown
        >) ?? {};
      const model = (providerOpts["model"] as string) ?? "base.en";
      const language = this.config?.language?.split("-")[0] ?? "en";
      const binary = this.whisperBinary!;

      let args: string[];

      if (binary === "main") {
        // whisper.cpp main binary uses different argument format
        args = [
          "-m",
          (providerOpts["model_path"] as string) ?? `models/ggml-${model}.bin`,
          "-f",
          wavPath,
          "-l",
          language,
          "--output-txt",
          "--output-file",
          outputBasePath,
          "--no-timestamps",
        ];
      } else if (binary === "whisper-cpp") {
        // whisper-cpp wrapper
        args = [
          "--model",
          model,
          "--file",
          wavPath,
          "--language",
          language,
          "--output-txt",
          "--output-file",
          outputBasePath,
          "--no-timestamps",
        ];
      } else {
        // openai-whisper (Python)
        args = [
          wavPath,
          "--model",
          model,
          "--language",
          language,
          "--output_format",
          "txt",
          "--output_dir",
          tempDir,
        ];
      }

      const timeoutMs = (providerOpts["timeout_ms"] as number) ?? 60000;

      execFile(binary, args, { timeout: timeoutMs }, async (err, stdout) => {
        if (err) {
          reject(
            new Error(`Whisper process failed: ${err.message}`),
          );
          return;
        }

        try {
          // Try to read the output text file
          // openai-whisper writes to <basename>.txt in the output dir
          // whisper.cpp writes to <output_file>.txt
          const txtPath = outputBasePath + ".txt";
          try {
            const text = await readFile(txtPath, "utf-8");
            resolve(text);
          } catch {
            // If no output file, fall back to stdout
            resolve(stdout ?? "");
          }
        } catch {
          resolve(stdout ?? "");
        }
      });
    });
  }

  /**
   * Remove temporary files created during transcription.
   */
  private async cleanupTemp(
    _tempDir: string,
    wavPath: string,
    outputBasePath: string,
  ): Promise<void> {
    const filesToRemove = [
      wavPath,
      outputBasePath + ".txt",
      outputBasePath + ".vtt",
      outputBasePath + ".srt",
      outputBasePath + ".json",
    ];

    for (const f of filesToRemove) {
      try {
        await unlink(f);
      } catch {
        // file may not exist — ignore
      }
    }

    // Try removing the temp directory itself
    try {
      const { rmdir } = await import("node:fs/promises");
      await rmdir(_tempDir);
    } catch {
      // non-empty or already removed — ignore
    }
  }
}
