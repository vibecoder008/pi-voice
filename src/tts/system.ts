import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { BaseTTSProvider } from "./base.js";
import type { TTSProviderName, TTSConfig } from "../types.js";

/**
 * System TTS provider — uses the operating system's built-in speech synthesis.
 *
 * - **macOS**: `say` command
 * - **Linux**: `espeak-ng` (preferred) or `espeak`
 * - **Windows**: PowerShell `System.Speech.Synthesis`
 *
 * Unlike other providers, system TTS plays audio directly through
 * the OS audio system. PCM chunk events are only emitted on Linux
 * when using `espeak-ng --stdout`.
 */
export class SystemTTSProvider extends BaseTTSProvider {
  readonly name: TTSProviderName = "system";
  readonly displayName = "System TTS";
  readonly requiresApiKey = false;

  readonly supportedVoices: string[] = [];

  private _platform: string = "";
  private _binary = "";
  private _activeProcess: ChildProcess | null = null;

  async initialize(config: TTSConfig): Promise<void> {
    await super.initialize(config);

    this._platform = platform();
    this._detectBinaryAndVoices();

    if (!this._voice) {
      this._voice = this._getDefaultVoice();
    }
  }

  /**
   * Detect the appropriate binary and populate supportedVoices
   * based on the current operating system.
   */
  private _detectBinaryAndVoices(): void {
    const voices = this.supportedVoices as string[];
    voices.length = 0; // clear

    switch (this._platform) {
      case "darwin":
        this._binary = "say";
        voices.push("Samantha", "Alex", "Victoria", "Daniel");
        break;
      case "linux":
        this._binary = "espeak-ng";
        voices.push("en-us", "en-gb", "en-au");
        break;
      case "win32":
        this._binary = "powershell";
        voices.push("default");
        break;
      default:
        this._binary = "espeak-ng";
        voices.push("en-us");
        break;
    }
  }

  private _getDefaultVoice(): string {
    switch (this._platform) {
      case "darwin":
        return "Samantha";
      case "linux":
        return "en-us";
      case "win32":
        return "default";
      default:
        return "en-us";
    }
  }

  /**
   * Speak using the system TTS command.
   *
   * This plays audio directly through the OS speakers. On Linux with
   * `espeak-ng --stdout`, we capture PCM data and emit chunks.
   * On macOS and Windows, audio plays directly.
   */
  async speak(text: string, signal?: AbortSignal): Promise<void> {
    if (!text.trim()) return;

    const linkedSignal = this.createLinkedAbort(signal);

    this._speaking = true;
    this.emit("start");

    try {
      switch (this._platform) {
        case "darwin":
          await this._speakDarwin(text, linkedSignal);
          break;
        case "linux":
          await this._speakLinux(text, linkedSignal);
          break;
        case "win32":
          await this._speakWindows(text, linkedSignal);
          break;
        default:
          await this._speakLinux(text, linkedSignal);
          break;
      }
    } catch (err: any) {
      if (linkedSignal.aborted) return;
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    } finally {
      this._speaking = false;
      this.emit("end");
    }
  }

  // ── macOS: `say` command ────────────────────────────────────────────

  private async _speakDarwin(
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    // The `say` command reads from a file for reliable handling
    // of special characters and multi-line text.
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-voice-"));
    const tmpFile = join(tmpDir, "speech.txt");

    try {
      writeFileSync(tmpFile, text, "utf-8");

      // Convert speed multiplier to words per minute.
      // macOS default is ~175-200 wpm.
      const rate = Math.round(this._speed * 175);

      const args = ["-v", this._voice, "-r", String(rate), "-f", tmpFile];

      await this._runProcess("say", args, signal);
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {
        // best-effort cleanup
      }
    }
  }

  // ── Linux: `espeak-ng` ─────────────────────────────────────────────

  private async _speakLinux(
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    // espeak-ng speed is in words per minute; default is 175.
    const speed = Math.round(this._speed * 175);

    // Use --stdout to capture WAV output and emit PCM chunks.
    const args = [
      "-v", this._voice,
      "-s", String(speed),
      "--stdout",
      "--",
      text,
    ];

    const binary = await this._findLinuxBinary();

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      this._activeProcess = proc;

      let headerSkipped = false;
      let headerBuf = Buffer.alloc(0);

      proc.stdout!.on("data", (chunk: Buffer) => {
        if (signal.aborted) return;

        if (!headerSkipped) {
          // Accumulate until we have at least 44 bytes (WAV header).
          headerBuf = Buffer.concat([headerBuf, chunk]);
          if (headerBuf.length >= 44) {
            const pcm = headerBuf.subarray(44);
            headerSkipped = true;
            if (pcm.length > 0) {
              // espeak-ng default: 22050 Hz, 16-bit, mono
              this.emitAudioChunk(pcm, 22050, 1, 16);
            }
          }
          return;
        }

        this.emitAudioChunk(chunk, 22050, 1, 16);
      });

      const stderrChunks: Buffer[] = [];
      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      proc.on("close", (code) => {
        this._activeProcess = null;
        if (signal.aborted) {
          resolve();
          return;
        }
        if (code !== 0 && code !== null) {
          const stderr = Buffer.concat(stderrChunks).toString().trim();
          reject(
            new Error(
              `${binary} exited with code ${code}${stderr ? `: ${stderr}` : ""}`,
            ),
          );
        } else {
          resolve();
        }
      });

      proc.on("error", (err) => {
        this._activeProcess = null;
        reject(
          new Error(
            `Failed to run ${binary}: ${err.message}\n\n` +
            "Install espeak-ng:\n" +
            "  Ubuntu/Debian: sudo apt install espeak-ng\n" +
            "  Fedora:        sudo dnf install espeak-ng\n" +
            "  Arch:          sudo pacman -S espeak-ng\n",
          ),
        );
      });

      const onAbort = () => proc.kill("SIGTERM");
      signal.addEventListener("abort", onAbort, { once: true });
      proc.on("close", () => signal.removeEventListener("abort", onAbort));
    });
  }

  /**
   * Try to find espeak-ng; fall back to espeak.
   */
  private async _findLinuxBinary(): Promise<string> {
    for (const bin of ["espeak-ng", "espeak"]) {
      const ok = await new Promise<boolean>((resolve) => {
        const p = spawn(bin, ["--version"], { stdio: "ignore", timeout: 2000 });
        p.on("error", () => resolve(false));
        p.on("close", (code) => resolve(code === 0));
      });
      if (ok) return bin;
    }
    return "espeak-ng"; // will fail with a helpful error
  }

  // ── Windows: PowerShell ────────────────────────────────────────────

  private async _speakWindows(
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    // Escape single quotes for PowerShell string literals.
    const escaped = text.replace(/'/g, "''");

    const psScript = [
      "Add-Type -AssemblyName System.Speech;",
      "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
      `$synth.Rate = ${Math.round((this._speed - 1.0) * 10)};`,
      this._voice !== "default"
        ? `$synth.SelectVoice('${this._voice.replace(/'/g, "''")}');`
        : "",
      `$synth.Speak('${escaped}');`,
      "$synth.Dispose();",
    ]
      .filter(Boolean)
      .join(" ");

    // Use -EncodedCommand with base64-encoded UTF-16LE to prevent
    // shell-level command injection via crafted text input.
    const encoded = Buffer.from(psScript, "utf16le").toString("base64");

    await this._runProcess(
      "powershell",
      ["-NoProfile", "-EncodedCommand", encoded],
      signal,
    );
  }

  // ── Shared process runner ──────────────────────────────────────────

  private _runProcess(
    cmd: string,
    args: string[],
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn(cmd, args, { stdio: "ignore" });
      this._activeProcess = proc;

      proc.on("close", (code) => {
        this._activeProcess = null;
        if (signal.aborted) {
          resolve();
          return;
        }
        if (code !== 0 && code !== null) {
          reject(new Error(`${cmd} exited with code ${code}`));
        } else {
          resolve();
        }
      });

      proc.on("error", (err) => {
        this._activeProcess = null;
        reject(new Error(`Failed to run ${cmd}: ${err.message}`));
      });

      const onAbort = () => proc.kill("SIGTERM");
      signal.addEventListener("abort", onAbort, { once: true });
      proc.on("close", () => signal.removeEventListener("abort", onAbort));
    });
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
