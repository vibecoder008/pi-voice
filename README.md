<p align="center">
  <h1 align="center">🎙️ pi-voice</h1>
  <p align="center">
    <strong>Talk to Pi. Listen to Pi.</strong><br>
    Voice input &amp; output for the <a href="https://github.com/badlogic/pi-mono">Pi coding agent</a>.
  </p>
  <p align="center">
    <a href="#install">Install</a> · <a href="#getting-started-in-60-seconds">Getting Started</a> · <a href="#how-it-works">How It Works</a> · <a href="#settings--customization">Settings</a> · <a href="#providers">Providers</a> · <a href="#voice-commands">Voice Commands</a>
  </p>
</p>

---

## What is pi-voice?

**pi-voice** turns your Pi coding agent into a voice assistant. Instead of typing prompts, **speak them**. Instead of reading responses, **listen to them**.

It works in three ways:

| Mode | What it does |
|------|-------------|
| **🎙️ Voice Input** | Speak a prompt → it appears in Pi's editor → Pi executes it |
| **🔊 Voice Output** | Pi responds → you hear it read aloud in real-time as it types |
| **💬 Conversation** | Speak → Pi responds aloud → mic reopens → fully hands-free loop |

**No API key needed to get started** — the default text-to-speech provider (Edge TTS) is completely free. Voice input requires a mic and one of the supported speech-to-text providers (free local option available).

---

## Install

```bash
pi install https://github.com/vibecoder008/pi-voice
```

That's it. Pi will download the extension and activate it automatically.

> **First time?** After install, run `/voice setup` inside Pi. A step-by-step wizard will walk you through choosing providers and entering API keys.

### System requirements

You need basic audio tools for your OS. Most systems have these already:

| OS | Mic capture | Audio playback | Install command |
|----|------------|----------------|-----------------|
| **Linux** | `arecord` | `aplay` | `sudo apt install alsa-utils` |
| **macOS** | `sox` | `sox` | `brew install sox` |
| **Windows** | `sox` | `ffplay` | `choco install sox.portable ffmpeg` |

---

## Getting Started in 60 Seconds

```
1.  pi install https://github.com/vibecoder008/pi-voice
2.  Open Pi → type:  /voice setup
3.  Follow the wizard → pick providers → paste API keys
4.  Press Alt+V and start talking!
```

Or skip the wizard and jump right in:

```
/voice start          ← start recording (uses your configured provider)
/voice stop           ← stop recording
/voice mute           ← silence TTS output
/voice unmute         ← re-enable TTS output
/voice conversation   ← toggle hands-free mode
/voice settings       ← open the full settings panel
/voice help           ← quick reference card
```

---

## How It Works

### Voice Input — dictate instead of type

Press **Alt+V** (or run `/voice start`). Speak naturally. Your words appear in Pi's editor in real-time as you talk. When you're done:

- **Review mode** (default): Text sits in the editor. Edit it if needed, then press Enter to send.
- **Auto-send mode**: The prompt is sent to Pi automatically when you stop speaking.

You choose which mode in settings.

### Voice Output — listen instead of read

When Pi responds, you hear it spoken aloud sentence by sentence as it streams. The extension is smart about what it reads:

| Content | What you hear |
|---------|--------------|
| Regular text | Read aloud naturally |
| `Code blocks` | *"Code block in TypeScript"* (skips the actual code) |
| Tool calls | *"Reading file: src/index.ts"* or *"Running command: npm test"* |
| Thinking | *"Pi is thinking..."* (brief announcement) |
| Markdown syntax | Stripped — you hear clean prose, not asterisks |

If you start typing while Pi is still talking, the voice **fades out gracefully** and lets you take over.

### Conversation Mode — fully hands-free

Toggle it on with `/voice conversation` or through the settings panel. The flow becomes:

```
You speak → Pi processes → Pi responds aloud → Mic reopens → You speak again → ...
```

No keyboard needed. Perfect for brainstorming, code reviews, or when your hands are busy.

---

## Keybindings

| Key | Action | Customizable? |
|-----|--------|:---:|
| **Alt+V** | Toggle microphone on/off | ✅ |
| **Alt+M** | Mute/unmute TTS | ✅ |
| **Alt+Space** | Push-to-talk / quick toggle | ✅ |

All keybindings can be changed in `/voice settings` → Overview tab, or by editing `~/.pi/voice.json`.

---

## Settings & Customization

pi-voice is designed to be **fully customizable**. There are three ways to configure it:

### 1. Interactive Settings Panel — `/voice settings`

A 6-tab interactive panel right inside Pi's terminal:

| Tab | What you configure |
|-----|-------------------|
| **Overview** | See current status, keybindings reference, all commands at a glance |
| **Input** | STT provider, input mode (push-to-talk / toggle / VAD), auto-send, real-time preview |
| **Output** | TTS provider, voice, speed, when to speak (always / voice-mode / manual), how to handle code blocks, tool calls, thinking, and interruptions |
| **Commands** | Enable/disable voice commands, choose tier (basic → full), see available commands |
| **Conversation** | Toggle conversation mode, auto-listen delay, behavior after TTS finishes |
| **API Keys** | See which providers have keys set, how to add them, env var names |

Navigate with **Tab** / **Shift+Tab** between tabs, **↑↓** to browse settings, **←→** or **Enter** to change values. Press **Esc** to close.

### 2. Slash Commands — for quick changes

```bash
/voice provider stt deepgram      # Switch speech-to-text engine
/voice provider tts elevenlabs    # Switch text-to-speech engine
/voice mode toggle                # Change input mode
/voice trigger always             # TTS reads every response
/voice trigger voice-mode         # TTS only when mic was used
/voice trigger manual             # TTS only on demand
/voice key deepgram               # Set API key (masked input)
/voice say "testing one two three" # Test TTS with custom text
```

### 3. Config File — `~/.pi/voice.json`

For power users. Every setting is stored in a single JSON file:

```jsonc
{
  "version": 1,
  "apiKeys": {
    "deepgram": "your-key-here",
    "openai": "sk-..."
  },
  "stt": {
    "provider": "deepgram",       // which STT engine to use
    "mode": "toggle",             // push-to-talk | toggle | wake-word | vad
    "autoSend": false,            // send prompt automatically after speaking?
    "interimResults": true,       // show partial transcription while speaking?
    "language": "en-US"
  },
  "tts": {
    "provider": "edge-tts",       // which TTS engine to use (edge-tts = free!)
    "triggerMode": "voice-mode",  // always | voice-mode | manual
    "voice": "en-US-AriaNeural",  // voice name (varies by provider)
    "speed": 1.0,                 // 0.5 to 2.0
    "codeBlockBehavior": "announce",   // skip | announce | read
    "toolCallBehavior": "announce",    // skip | announce | announce-and-summarize
    "thinkingBehavior": "announce",    // skip | announce | read
    "interruptBehavior": "fade",       // immediate | fade | finish-sentence | lower-volume
    "fadeDurationMs": 500
  },
  "voiceCommands": {
    "enabled": true,
    "tier": "all"                 // basic | pi-commands | navigation | all
  },
  "conversation": {
    "enabled": false,
    "autoListenAfterTTS": true,
    "delayBeforeListenMs": 500
  },
  "keybindings": {
    "toggleMic": "alt+v",
    "muteTTS": "alt+m",
    "pushToTalk": "alt+space"
  }
}
```

> **Tip:** API keys can also be set as environment variables (`DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, etc.) — they take priority over the config file.

---

## Settings Deep Dive

### Input Modes

| Mode | How it works | Best for |
|------|-------------|----------|
| **Push-to-talk** | Hold Alt+Space to record, release to stop | Noisy environments |
| **Toggle** | Press Alt+V once to start, again to stop | General use (default) |
| **Wake word** | Say "Hey Pi" to activate | Fully hands-free |
| **VAD** (auto) | Mic detects when you start/stop speaking | Conversation mode |

### TTS Trigger Modes

| Mode | When Pi speaks aloud | Best for |
|------|---------------------|----------|
| **Always** | Every response is read aloud | Accessibility, multitasking |
| **Voice-mode** | Only when you used voice input or conversation mode is on | Natural flow (default) |
| **Manual** | Only when you run `/voice say` | Minimal interruption |

### Interrupt Behavior

What happens when you start typing while Pi is talking:

| Behavior | Effect |
|----------|--------|
| **Fade** | Voice smoothly fades out over 0.5s (default) |
| **Immediate** | Voice stops instantly |
| **Finish sentence** | Current sentence completes, then stops |
| **Lower volume** | Voice continues quietly in the background |

### Code Block Handling

| Setting | What you hear when Pi writes code |
|---------|----------------------------------|
| **Skip** | Nothing — code blocks are silent |
| **Announce** | *"Code block in TypeScript."* (default) |
| **Read** | The actual code is read aloud |

---

## Voice Commands

Speak these phrases while dictating to control Pi without touching the keyboard:

### Basic (always available)

| Say this | What happens |
|----------|-------------|
| *"send it"* / *"submit"* / *"go"* | Submit your prompt to Pi |
| *"cancel"* / *"never mind"* | Cancel current dictation |
| *"clear"* | Clear the editor |
| *"undo"* | Remove the last word |
| *"new line"* | Insert a line break |
| *"period"* / *"comma"* / *"question mark"* | Insert punctuation |

### Pi Commands (enable in settings → tier: "pi-commands" or "all")

| Say this | What happens |
|----------|-------------|
| *"slash compact"* | Run `/compact` |
| *"slash reload"* | Run `/reload` |
| *"new session"* | Run `/new` |
| *"switch model to sonnet"* | Change the AI model |
| *"open settings"* | Open `/voice settings` |

### Navigation (enable in settings → tier: "navigation" or "all")

| Say this | What happens |
|----------|-------------|
| *"scroll up"* / *"scroll down"* | Scroll the terminal |
| *"read again"* / *"repeat"* | Replay the last response |
| *"stop reading"* / *"mute"* | Stop TTS immediately |

> **Tier system:** Set `voiceCommands.tier` to control which commands are active. `"basic"` = punctuation + submission only. `"all"` = everything enabled.

---

## Providers

### Speech-to-Text (voice → text)

| Provider | Type | Cost | API Key | Best for |
|----------|------|------|---------|----------|
| **Deepgram Nova-3** | Real-time streaming | $0.008/min | Required | Best streaming experience |
| **OpenAI Whisper** | Batch | $0.003/min | Required | Cheapest cloud option |
| **Azure Speech** | Real-time streaming | $0.017/min | Required | Enterprise environments |
| **Google Cloud STT** | Batch | $0.016/min | Required | Multi-language support |
| **AssemblyAI** | Real-time streaming | $0.003/min | Required | Budget real-time |
| **ElevenLabs Scribe** | Batch | $0.007/min | Required | Low-latency batch |
| **Whisper Local** ★ | Batch | **Free** | **None** | Offline, private, no cost |

★ Requires `whisper` CLI installed locally (`pip install openai-whisper`).

### Text-to-Speech (text → voice)

| Provider | Cost | API Key | Quality | Best for |
|----------|------|---------|---------|----------|
| **Edge TTS** ★ | **Free** | **None** | Good | Default — just works |
| **OpenAI TTS** | $15/1M chars | Required | High | Already using OpenAI |
| **ElevenLabs** | $120/1M chars | Required | Premium | Most natural voices |
| **Cartesia Sonic** | $11/1M chars | Required | High | Lowest latency |
| **Google Cloud TTS** | $4/1M chars | Required | High | WaveNet voices |
| **Azure TTS** | $16/1M chars | Required | High | Enterprise environments |
| **Deepgram Aura** | $15/1M chars | Required | Good | Fast generation |
| **Piper** ★ | **Free** | **None** | Good | Offline neural TTS |
| **System TTS** ★ | **Free** | **None** | Basic | Zero setup (uses OS built-in) |

★ No API key or internet required.

> **Recommendation:** Start with **Edge TTS** (free, no setup) for output and **Deepgram** (best streaming) or **Whisper Local** (free) for input. Upgrade later if you want higher quality voices.

---

## Setting API Keys

Three ways, in order of priority:

### 1. Environment variables (highest priority)

```bash
export DEEPGRAM_API_KEY="your-key"
export OPENAI_API_KEY="sk-..."
export AZURE_SPEECH_KEY="..."
export AZURE_SPEECH_REGION="eastus"
export GOOGLE_APPLICATION_CREDENTIALS="..."
export ASSEMBLYAI_API_KEY="..."
export ELEVENLABS_API_KEY="..."
export CARTESIA_API_KEY="..."
```

### 2. Interactive prompt

```
/voice key deepgram
```
You'll be prompted to paste your key (input is masked).

### 3. Setup wizard

```
/voice setup
```
Walks you through everything step by step.

> **Security:** API keys are stored in `~/.pi/voice.json` with `0600` file permissions (owner-only read/write). Keys are never included in URLs, error messages, or session logs.

---

## All Commands Reference

| Command | Description |
|---------|-------------|
| `/voice` | Show current status (providers, mode, state) |
| `/voice start` | Start microphone recording |
| `/voice stop` | Stop microphone recording |
| `/voice mute` | Mute TTS output |
| `/voice unmute` | Unmute TTS output |
| `/voice settings` | Open interactive 6-tab settings panel |
| `/voice setup` | Run first-time setup wizard |
| `/voice help` | Show quick reference overlay |
| `/voice conversation` | Toggle conversation mode on/off |
| `/voice say <text>` | Speak custom text through TTS |
| `/voice provider stt <name>` | Switch speech-to-text provider |
| `/voice provider tts <name>` | Switch text-to-speech provider |
| `/voice mode <mode>` | Change input mode (push-to-talk/toggle/wake-word/vad) |
| `/voice trigger <mode>` | Change TTS trigger (always/voice-mode/manual) |
| `/voice key <provider>` | Set API key for a provider (masked input) |

---

## Architecture

For developers who want to understand or contribute:

```
pi-voice/
├── src/
│   ├── index.ts              ← Extension entry point, Pi event hooks, /voice commands
│   ├── types.ts              ← All TypeScript interfaces and type definitions
│   ├── config.ts             ← Config loading/saving, API key management, validation
│   ├── text-processor.ts     ← Markdown → speech conversion, sentence buffering
│   ├── conversation.ts       ← Conversation mode controller (speak → listen loop)
│   ├── utils.ts              ← Security utilities (secret redaction)
│   ├── audio/
│   │   ├── mic.ts            ← Cross-platform microphone capture (arecord/sox)
│   │   └── speaker.ts        ← Cross-platform audio playback (aplay/play/ffplay)
│   ├── stt/                  ← 7 speech-to-text provider implementations
│   │   ├── base.ts           ← Abstract base with event emitter, WAV utilities
│   │   ├── deepgram.ts       ← WebSocket streaming with reconnection
│   │   ├── openai.ts         ← Whisper API batch transcription
│   │   ├── azure.ts          ← WebSocket streaming with reconnection
│   │   ├── google.ts         ← REST batch transcription
│   │   ├── assemblyai.ts     ← WebSocket streaming with temp tokens
│   │   ├── elevenlabs.ts     ← REST batch transcription
│   │   └── whisper-local.ts  ← Local CLI (whisper.cpp)
│   ├── tts/                  ← 9 text-to-speech provider implementations
│   │   ├── base.ts           ← Abstract base with sentence buffering
│   │   ├── edge-tts.ts       ← Free Edge TTS with ffmpeg decode
│   │   ├── openai.ts         ← OpenAI TTS streaming PCM
│   │   ├── elevenlabs.ts     ← REST streaming
│   │   ├── cartesia.ts       ← WebSocket streaming with timeout handling
│   │   ├── google.ts         ← REST with LINEAR16 decode
│   │   ├── azure.ts          ← SSML-based with sanitization
│   │   ├── deepgram.ts       ← Aura REST streaming
│   │   ├── piper.ts          ← Local neural TTS via CLI
│   │   └── system.ts         ← OS built-in (say/espeak/PowerShell)
│   ├── voice-commands/
│   │   ├── commands.ts       ← 30+ command definitions across 3 tiers
│   │   └── parser.ts         ← Real-time command parsing engine
│   └── ui/
│       ├── settings.ts       ← 6-tab interactive settings panel
│       ├── wizard.ts         ← Step-by-step first-time setup
│       ├── help.ts           ← Quick reference overlay
│       └── status.ts         ← Status bar indicators with audio level meter
└── package.json
```

**38 files · ~9,500 lines · 0 TypeScript errors**
Audited through 5 security/quality rounds with 23 issues found and fixed.

---

## License

MIT — free to use, modify, and distribute.

---

<p align="center">
  Built for <a href="https://github.com/badlogic/pi-mono">Pi</a> · Made by <a href="https://github.com/vibecoder008">vibecoder008</a>
</p>
