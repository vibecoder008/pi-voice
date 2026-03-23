import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AudioSpeaker, SpeakerOptions } from "../types.js";

const DEFAULT_SPEAKER_OPTIONS: SpeakerOptions = {
  sampleRate: 24000,
  channels: 1,
  bitDepth: 16,
};

/** Interval (ms) at which `fadeOut` steps volume down. */
const FADE_STEP_MS = 20;

// ─── Platform helpers ────────────────────────────────────────────────────

interface SpawnDescriptor {
  command: string;
  args: string[];
}

function buildSpawnDescriptor(
  opts: SpeakerOptions,
  platform: NodeJS.Platform,
): SpawnDescriptor {
  switch (platform) {
    case "linux":
      return {
        command: "aplay",
        args: [
          "-f", `S${opts.bitDepth}_LE`,
          "-r", String(opts.sampleRate),
          "-c", String(opts.channels),
          "-t", "raw",
          "-",
        ],
      };
    case "darwin":
      return {
        command: "play",
        args: [
          "-t", "raw",
          "-b", String(opts.bitDepth),
          "-e", "signed-integer",
          "-r", String(opts.sampleRate),
          "-c", String(opts.channels),
          "-",
        ],
      };
    case "win32":
      return {
        command: "ffplay",
        args: [
          "-f", `s${opts.bitDepth}le`,
          "-ar", String(opts.sampleRate),
          "-ac", String(opts.channels),
          "-nodisp",
          "-autoexit",
          "-",
        ],
      };
    default:
      throw new Error(
        `Unsupported platform "${platform}". ` +
        "Audio playback requires Linux (aplay), macOS (play/sox), or Windows (ffplay).",
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
      return 'Install FFmpeg (includes ffplay): choco install ffmpeg   (or download from https://ffmpeg.org)';
    default:
      return '';
  }
}

// ─── PCM volume scaling ──────────────────────────────────────────────────

/**
 * Scale every 16-bit signed sample in `buf` by `volume` (0.0 – 1.0).
 * Returns a **new** buffer — the input is not mutated.
 */
function scalePcm16(buf: Buffer, volume: number): Buffer {
  if (volume >= 1) return buf;
  if (volume <= 0) return Buffer.alloc(buf.length);

  const out = Buffer.allocUnsafe(buf.length);
  const sampleCount = Math.floor(buf.length / 2);

  for (let i = 0; i < sampleCount; i++) {
    const offset = i * 2;
    const sample = buf.readInt16LE(offset);
    // Clamp after multiplication to stay within Int16 range.
    const scaled = Math.max(-32768, Math.min(32767, Math.round(sample * volume)));
    out.writeInt16LE(scaled, offset);
  }

  // If the buffer had an odd trailing byte, copy it unchanged.
  if (buf.length % 2 !== 0) {
    out[buf.length - 1] = buf[buf.length - 1];
  }

  return out;
}

// ─── Implementation ──────────────────────────────────────────────────────

/**
 * Cross-platform audio speaker that spawns a system playback process and
 * streams raw PCM data to its stdin.
 *
 * Supports Linux (`aplay`), macOS (`play` from SoX), and Windows (`ffplay`).
 */
export function createAudioSpeaker(
  userOpts?: Partial<SpeakerOptions>,
): AudioSpeaker {
  const opts: SpeakerOptions = { ...DEFAULT_SPEAKER_OPTIONS, ...userOpts };
  const platform = process.platform;

  const emitter = new EventEmitter();
  let proc: ChildProcess | null = null;
  let playing = false;
  let disposed = false;
  let volume = 1.0;
  let fadingOut = false;

  // ── Process lifecycle ───────────────────────────────────────────────

  /**
   * Ensure a player process is running. Spawns one if necessary and
   * returns `true` on success.
   */
  function ensureProc(): boolean {
    if (disposed) return false;
    if (proc !== null && !proc.killed) return true;

    let desc: SpawnDescriptor;
    try {
      desc = buildSpawnDescriptor(opts, platform);
    } catch (err) {
      emitter.emit("error", err instanceof Error ? err : new Error(String(err)));
      return false;
    }

    try {
      proc = spawn(desc.command, desc.args, {
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (err) {
      const hint = toolInstallHint(platform);
      const msg =
        `Failed to start "${desc.command}". Is it installed and on PATH?\n` +
        (hint ? `${hint}\n` : "") +
        (err instanceof Error ? err.message : String(err));
      emitter.emit("error", new Error(msg));
      return false;
    }

    playing = true;
    const thisProc = proc;

    thisProc.stderr!.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        emitter.emit("error", new Error(`[${desc.command}] ${msg}`));
      }
    });

    thisProc.on("error", (err: Error) => {
      if (proc === thisProc) {
        playing = false;
      }
      const hint = toolInstallHint(platform);
      const msg =
        `"${desc.command}" process error: ${err.message}\n` +
        (hint || "");
      emitter.emit("error", new Error(msg));
    });

    thisProc.on("close", () => {
      if (proc === thisProc) {
        playing = false;
        proc = null;
      }
    });

    return true;
  }

  function killProc(): void {
    if (proc === null) return;
    const p = proc;
    proc = null;
    playing = false;

    try {
      if (p.stdin && !p.stdin.destroyed) {
        p.stdin.end();
      }
    } catch {
      // stdin may already be closed.
    }

    if (!p.killed) {
      p.kill("SIGTERM");

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

  /**
   * Write a buffer to the player's stdin. Applies volume scaling before
   * writing. Silently no-ops if the stream is not writable.
   */
  function writeToProc(chunk: Buffer): boolean {
    if (proc === null || proc.stdin === null || proc.stdin.destroyed) {
      return false;
    }

    const scaled = scalePcm16(chunk, volume);
    try {
      return proc.stdin.write(scaled);
    } catch {
      // Process may have exited between the check and the write.
      return false;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  const speaker: AudioSpeaker = {
    /**
     * Send a single PCM audio chunk to the playback process.
     * Spawns the player process on the first call.
     */
    play(chunk: Buffer): void {
      if (disposed) return;
      if (!ensureProc()) return;
      writeToProc(chunk);
    },

    /**
     * Stream audio from an async iterable to the playback process.
     * Resolves when the stream is exhausted and all data has been written.
     */
    async playStream(stream: AsyncIterable<Buffer>): Promise<void> {
      if (disposed) return;
      if (!ensureProc()) return;

      for await (const chunk of stream) {
        if (disposed || !playing) break;

        const ok = writeToProc(chunk);

        // Back-pressure: if the write returned false, wait for drain.
        if (!ok && proc?.stdin && !proc.stdin.destroyed) {
          await new Promise<void>((resolve) => {
            const onDrain = (): void => resolve();
            // If the stream closes before draining, resolve anyway.
            const onClose = (): void => {
              proc?.stdin?.removeListener("drain", onDrain);
              resolve();
            };
            proc!.stdin!.once("drain", onDrain);
            proc!.stdin!.once("close", onClose);
          });
        }
      }

      // Signal EOF so the player can flush its buffer and exit normally.
      if (proc?.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }

      // Wait for the player to finish.
      if (proc !== null) {
        await new Promise<void>((resolve) => {
          if (proc === null) {
            resolve();
            return;
          }
          proc.on("close", () => resolve());
        });
      }
    },

    /** Immediately stop playback and kill the player process. */
    stop(): void {
      fadingOut = false;
      killProc();
    },

    /**
     * Gradually reduce volume to zero over `durationMs` milliseconds,
     * then stop the player.
     */
    async fadeOut(durationMs: number): Promise<void> {
      if (!playing || disposed) return;
      if (durationMs <= 0) {
        speaker.stop();
        return;
      }

      fadingOut = true;
      const startVolume = volume;
      const steps = Math.max(1, Math.floor(durationMs / FADE_STEP_MS));
      const decrement = startVolume / steps;

      for (let i = 0; i < steps; i++) {
        if (!fadingOut || disposed) break;
        volume = Math.max(0, startVolume - decrement * (i + 1));
        await new Promise<void>((r) => setTimeout(r, FADE_STEP_MS));
      }

      volume = 0;
      speaker.stop();
      // Restore volume so subsequent plays are not muted.
      volume = startVolume;
      fadingOut = false;
    },

    /**
     * Set playback volume.
     * @param v — value between 0.0 (mute) and 1.0 (full volume).
     */
    setVolume(v: number): void {
      volume = Math.max(0, Math.min(1, v));
    },

    /** Whether audio is currently being played. */
    isPlaying(): boolean {
      return playing;
    },

    /** Stop playback and release all resources. */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      fadingOut = false;
      killProc();
      emitter.removeAllListeners();
    },
  };

  return speaker;
}
