import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { MicRecorder, MicOptions } from "../types.js";

const DEFAULT_MIC_OPTIONS: MicOptions = {
  sampleRate: 16000,
  channels: 1,
  bitDepth: 16,
};

/** Silence threshold (default 1500ms) after which the `silence` event fires. */
const DEFAULT_SILENCE_MS = 1500;

/**
 * RMS floor below which audio is considered silence.
 * Value is a fraction of the Int16 range (0–32767). A level below ~1.5%
 * of full-scale is treated as background noise / silence.
 */
const SILENCE_RMS_THRESHOLD = 500;

// ─── Platform helpers ────────────────────────────────────────────────────

interface SpawnDescriptor {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function buildSpawnDescriptor(
  opts: MicOptions,
  platform: NodeJS.Platform,
): SpawnDescriptor {
  switch (platform) {
    case "linux": {
      const args = [
        "-f", `S${opts.bitDepth}_LE`,
        "-r", String(opts.sampleRate),
        "-c", String(opts.channels),
        "-t", "raw",
      ];
      if (opts.device) {
        args.push("-D", opts.device);
      }
      args.push("-");
      return { command: "arecord", args };
    }
    case "darwin": {
      const args = [
        "-d",
        "-t", "raw",
        "-b", String(opts.bitDepth),
        "-e", "signed-integer",
        "-r", String(opts.sampleRate),
        "-c", String(opts.channels),
      ];
      args.push("-");
      const env = opts.device ? { ...process.env, AUDIODEV: opts.device } : undefined;
      return { command: "sox", args, env };
    }
    case "win32": {
      const args = [
        "-d",
        "-t", "raw",
        "-b", String(opts.bitDepth),
        "-e", "signed-integer",
        "-r", String(opts.sampleRate),
        "-c", String(opts.channels),
        "-",
      ];
      return { command: "sox", args };
    }
    default:
      throw new Error(
        `Unsupported platform "${platform}". ` +
        "Microphone capture requires Linux (arecord), macOS (sox), or Windows (sox).",
      );
  }
}

function toolInstallHint(platform: NodeJS.Platform): string {
  switch (platform) {
    case "linux":
      return 'Install ALSA utilities: sudo apt-get install alsa-utils';
    case "darwin":
      return 'Install SoX: brew install sox';
    case "win32":
      return 'Install SoX: choco install sox.portable   (or download from https://sox.sourceforge.net)';
    default:
      return '';
  }
}

// ─── RMS calculation ─────────────────────────────────────────────────────

/**
 * Calculate root-mean-square of 16-bit signed PCM samples.
 * Returns a value in the range 0 – 32767.
 */
function rms16(buf: Buffer): number {
  const sampleCount = Math.floor(buf.length / 2);
  if (sampleCount === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = buf.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

// ─── Implementation ──────────────────────────────────────────────────────

/**
 * Cross-platform microphone recorder that spawns a system audio-capture
 * process and streams raw PCM data.
 *
 * Supports Linux (`arecord`), macOS (`sox`), and Windows (`sox`).
 */
export function createMicRecorder(
  userOpts?: Partial<MicOptions>,
  silenceMs?: number,
): MicRecorder {
  const opts: MicOptions = { ...DEFAULT_MIC_OPTIONS, ...userOpts };
  const silenceTimeout = silenceMs ?? DEFAULT_SILENCE_MS;
  const platform = process.platform;

  const emitter = new EventEmitter();
  let proc: ChildProcess | null = null;
  let recording = false;
  let disposed = false;
  let currentLevel = 0;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let inSilence = false;

  // ── Silence tracking ────────────────────────────────────────────────

  function resetSilenceTimer(): void {
    inSilence = false;
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer);
    }
    silenceTimer = setTimeout(() => {
      if (recording && !disposed) {
        inSilence = true;
        emitter.emit("silence");
      }
    }, silenceTimeout);
  }

  function clearSilenceTimer(): void {
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
    inSilence = false;
  }

  // ── Process management ──────────────────────────────────────────────

  function killProc(): void {
    if (proc === null) return;
    const p = proc;
    proc = null;

    // Guard against writing to an already-closed stream.
    try {
      if (p.stdin && !p.stdin.destroyed) {
        p.stdin.end();
      }
    } catch {
      // stdin may already be closed — ignore.
    }

    if (!p.killed) {
      p.kill("SIGTERM");

      // If the process hasn't exited after 500ms, force-kill.
      const forceKill = setTimeout(() => {
        try {
          if (!p.killed) p.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 500);
      forceKill.unref();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  const recorder: MicRecorder = {
    /** Spawn the platform recording process and begin streaming PCM data. */
    async start(): Promise<void> {
      if (disposed) {
        throw new Error("MicRecorder has been disposed");
      }
      if (recording) return;

      let desc: SpawnDescriptor;
      try {
        desc = buildSpawnDescriptor(opts, platform);
      } catch (err) {
        emitter.emit("error", err instanceof Error ? err : new Error(String(err)));
        return;
      }

      try {
        proc = spawn(desc.command, desc.args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: desc.env,
        });
      } catch (err) {
        const hint = toolInstallHint(platform);
        const msg =
          `Failed to start "${desc.command}". Is it installed and on PATH?\n` +
          (hint ? `${hint}\n` : "") +
          (err instanceof Error ? err.message : String(err));
        emitter.emit("error", new Error(msg));
        return;
      }

      recording = true;
      const thisProc = proc;

      thisProc.stdout!.on("data", (chunk: Buffer) => {
        if (!recording || disposed) return;

        const level = rms16(chunk);
        // Normalise to 0.0 – 1.0 (Int16 max = 32767).
        currentLevel = Math.min(level / 32767, 1);

        if (level > SILENCE_RMS_THRESHOLD) {
          resetSilenceTimer();
        } else if (silenceTimer === null && !inSilence) {
          // First silent chunk — start counting.
          resetSilenceTimer();
        }

        emitter.emit("data", chunk);
      });

      thisProc.stderr!.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        // arecord/sox print informational lines to stderr that are not
        // real errors — only forward lines that look like failures.
        if (
          msg &&
          !msg.startsWith("Recording") &&
          !msg.startsWith("Input File")
        ) {
          emitter.emit("error", new Error(`[${desc.command}] ${msg}`));
        }
      });

      thisProc.on("error", (err: Error) => {
        if (proc === thisProc) {
          recording = false;
          clearSilenceTimer();
        }
        const hint = toolInstallHint(platform);
        const msg =
          `"${desc.command}" process error: ${err.message}\n` +
          (hint || "");
        emitter.emit("error", new Error(msg));
      });

      thisProc.on("close", (code) => {
        if (proc === thisProc) {
          recording = false;
          clearSilenceTimer();
          proc = null;
        }
        // Exit code 0 or null (killed by signal) are normal stop paths.
        if (code !== null && code !== 0) {
          emitter.emit(
            "error",
            new Error(`"${desc.command}" exited with code ${code}`),
          );
        }
      });
    },

    /** Stop the recording process and clean up. */
    async stop(): Promise<void> {
      if (!recording) return;
      recording = false;
      clearSilenceTimer();
      currentLevel = 0;
      killProc();
    },

    /** Whether the recorder is currently capturing audio. */
    isRecording(): boolean {
      return recording;
    },

    /** Register a handler for incoming PCM audio chunks. */
    onData(handler: (chunk: Buffer) => void): void {
      emitter.on("data", handler);
    },

    /** Register a handler for errors (missing tools, process failures, etc). */
    onError(handler: (error: Error) => void): void {
      emitter.on("error", handler);
    },

    /**
     * Register a handler that fires when sustained silence is detected.
     * Silence is defined as RMS below the threshold for longer than the
     * configured silence timeout.
     */
    onSilence(handler: () => void): void {
      emitter.on("silence", handler);
    },

    /**
     * Current audio amplitude as a value from 0.0 (silence) to 1.0
     * (full-scale). Updated on every incoming data chunk.
     */
    getLevel(): number {
      return currentLevel;
    },

    /** Stop recording, kill the process, and release all resources. */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      recording = false;
      clearSilenceTimer();
      killProc();
      emitter.removeAllListeners();
    },
  };

  return recorder;
}
