// ─── Core Configuration ──────────────────────────────────────────────────

export interface VoiceConfig {
  stt: STTConfig;
  tts: TTSConfig;
  voiceCommands: VoiceCommandConfig;
  conversation: ConversationConfig;
  keybindings: KeybindingConfig;
}

export interface STTConfig {
  provider: STTProviderName;
  mode: STTMode;
  language: string;
  wakeWord: string;
  autoSend: boolean;
  vadSilenceMs: number;
  interimResults: boolean;
  providerOptions: Record<string, Record<string, unknown>>;
}

export interface TTSConfig {
  provider: TTSProviderName;
  triggerMode: TTSTriggerMode;
  voice: string;
  speed: number;
  codeBlockBehavior: "skip" | "announce" | "read";
  toolCallBehavior: "skip" | "announce" | "announce-and-summarize";
  thinkingBehavior: "skip" | "announce" | "read";
  interruptBehavior: "immediate" | "fade" | "finish-sentence" | "lower-volume";
  fadeDurationMs: number;
  providerOptions: Record<string, Record<string, unknown>>;
}

export interface VoiceCommandConfig {
  enabled: boolean;
  tier: VoiceCommandTier;
  customCommands: Record<string, string>;
}

export interface ConversationConfig {
  enabled: boolean;
  autoListenAfterTTS: boolean;
  delayBeforeListenMs: number;
}

export interface KeybindingConfig {
  toggleMic: string;
  muteTTS: string;
  pushToTalk: string;
}

// ─── Provider Names ──────────────────────────────────────────────────────

export type STTProviderName =
  | "deepgram"
  | "openai"
  | "azure"
  | "google"
  | "assemblyai"
  | "elevenlabs"
  | "whisper-local";

export type TTSProviderName =
  | "openai"
  | "elevenlabs"
  | "cartesia"
  | "google"
  | "azure"
  | "deepgram"
  | "edge-tts"
  | "piper"
  | "system";

// ─── Modes & Enums ──────────────────────────────────────────────────────

export type STTMode = "push-to-talk" | "toggle" | "wake-word" | "vad";
export type TTSTriggerMode = "always" | "voice-mode" | "manual";
export type VoiceCommandTier = "basic" | "pi-commands" | "navigation" | "all";

// ─── STT Provider Interface ─────────────────────────────────────────────

export interface STTTranscript {
  text: string;
  isFinal: boolean;
  confidence: number;
  language?: string;
}

export interface STTProviderEvents {
  transcript: (transcript: STTTranscript) => void;
  error: (error: Error) => void;
  ready: () => void;
  closed: () => void;
}

export interface STTProvider {
  readonly name: STTProviderName;
  readonly displayName: string;
  readonly supportsStreaming: boolean;
  readonly requiresApiKey: boolean;

  initialize(config: STTConfig): Promise<void>;
  startListening(): Promise<void>;
  stopListening(): Promise<string>;
  isListening(): boolean;
  sendAudio(chunk: Buffer): void;
  on<E extends keyof STTProviderEvents>(event: E, handler: STTProviderEvents[E]): void;
  off<E extends keyof STTProviderEvents>(event: E, handler: STTProviderEvents[E]): void;
  dispose(): Promise<void>;
}

// ─── TTS Provider Interface ─────────────────────────────────────────────

export interface TTSAudioChunk {
  audio: Buffer;
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

export interface TTSProviderEvents {
  audioChunk: (chunk: TTSAudioChunk) => void;
  start: () => void;
  end: () => void;
  error: (error: Error) => void;
}

export interface TTSProvider {
  readonly name: TTSProviderName;
  readonly displayName: string;
  readonly requiresApiKey: boolean;
  readonly supportedVoices: string[];

  initialize(config: TTSConfig): Promise<void>;
  speak(text: string, signal?: AbortSignal): Promise<void>;
  speakStreaming(textStream: AsyncIterable<string>, signal?: AbortSignal): Promise<void>;
  stop(): void;
  isSpeaking(): boolean;
  setVoice(voice: string): void;
  setSpeed(speed: number): void;
  on<E extends keyof TTSProviderEvents>(event: E, handler: TTSProviderEvents[E]): void;
  off<E extends keyof TTSProviderEvents>(event: E, handler: TTSProviderEvents[E]): void;
  dispose(): Promise<void>;
}

// ─── Audio I/O Interfaces ───────────────────────────────────────────────

export interface MicOptions {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  device?: string;
}

export interface MicRecorder {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRecording(): boolean;
  onData(handler: (chunk: Buffer) => void): void;
  onError(handler: (error: Error) => void): void;
  onSilence(handler: () => void): void;
  getLevel(): number;
  dispose(): void;
}

export interface SpeakerOptions {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

export interface AudioSpeaker {
  play(chunk: Buffer): void;
  playStream(stream: AsyncIterable<Buffer>): Promise<void>;
  stop(): void;
  fadeOut(durationMs: number): Promise<void>;
  setVolume(volume: number): void;
  isPlaying(): boolean;
  dispose(): void;
}

// ─── Voice Command Types ────────────────────────────────────────────────

export interface VoiceCommand {
  pattern: RegExp;
  phrases: string[];
  action: VoiceCommandAction;
  tier: VoiceCommandTier;
  description: string;
}

export type VoiceCommandAction =
  | { type: "insert"; text: string }
  | { type: "punctuation"; char: string }
  | { type: "submit" }
  | { type: "cancel" }
  | { type: "clear" }
  | { type: "undo" }
  | { type: "newline" }
  | { type: "select-all" }
  | { type: "delete-word" }
  | { type: "pi-command"; command: string; args?: string }
  | { type: "set-model"; model: string }
  | { type: "scroll"; direction: "up" | "down" }
  | { type: "read-again" }
  | { type: "stop-reading" }
  | { type: "toggle-voice-mode" };

export interface VoiceCommandResult {
  matched: boolean;
  command?: VoiceCommand;
  action?: VoiceCommandAction;
  remainingText?: string;
}

// ─── Extension State ────────────────────────────────────────────────────

export interface VoiceState {
  micActive: boolean;
  micMode: STTMode;
  ttsActive: boolean;
  ttsMuted: boolean;
  ttsTriggerMode: TTSTriggerMode;
  conversationMode: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  currentTranscript: string;
  sttProvider: STTProviderName;
  ttsProvider: TTSProviderName;
  audioLevel: number;
}

// ─── Config File ────────────────────────────────────────────────────────

export interface VoiceConfigFile {
  version: number;
  apiKeys: Record<string, string>;
  stt: Partial<STTConfig>;
  tts: Partial<TTSConfig>;
  voiceCommands: Partial<VoiceCommandConfig>;
  conversation: Partial<ConversationConfig>;
  keybindings: Partial<KeybindingConfig>;
}
