# pi-voice 🎙️🔊

Bidirectional voice extension for [Pi](https://github.com/badlogic/pi-mono) — dictate prompts via speech-to-text and listen to responses via text-to-speech, with full hands-free conversation mode.

## Features

### 🎙️ Voice Input (Speech-to-Text)
- **4 input modes**: Push-to-talk, Toggle, Wake word, Voice Activity Detection (auto)
- **Real-time partial transcription** directly in the editor as you speak
- **7 STT providers**: Deepgram, OpenAI Whisper, Azure, Google Cloud, AssemblyAI, ElevenLabs Scribe, local Whisper
- **Auto-send or review** — dictated text can auto-submit or wait for your review

### 🔊 Voice Output (Text-to-Speech)  
- **Streams responses aloud** in real-time as Pi writes them
- **Smart filtering**: announces code blocks ("Code block in TypeScript"), announces tool calls ("Reading file: src/index.ts"), skips thinking with brief "Pi is thinking..."
- **9 TTS providers**: Edge TTS (free!), OpenAI, ElevenLabs, Cartesia, Google Cloud, Azure, Deepgram Aura, Piper (local), System TTS
- **Interrupt handling**: fade out TTS when you start typing/speaking

### 🗣️ Voice Commands
- **Basic**: "period", "comma", "new line", "send it", "cancel", "clear", "undo"
- **Pi commands**: "slash compact", "switch model to sonnet", "open settings"
- **Navigation**: "scroll up", "read again", "stop reading"
- Configurable tiers — enable only what you need

### 💬 Conversation Mode
Full hands-free loop: Speak → Pi responds with TTS → Mic auto-reopens → repeat.

## Quick Start

```bash
# Install
pi install pi-voice

# Or add to your Pi config
# In ~/.pi/agent/settings.json:
{
  "packages": ["pi-voice"]
}
```

On first load, run the setup wizard:
```
/voice setup
```

Or configure manually:
```
/voice key deepgram YOUR_API_KEY
/voice provider stt deepgram
/voice provider tts edge-tts
```

## Usage

### Keybindings (default)
| Key | Action |
|-----|--------|
| `Alt+V` | Toggle microphone on/off |
| `Alt+M` | Mute/unmute TTS |
| `Alt+Space` | Push-to-talk (hold) / Toggle (press) |

### Commands
```
/voice              — Show status
/voice start        — Start listening
/voice stop         — Stop listening
/voice mute         — Mute TTS
/voice unmute       — Unmute TTS
/voice settings     — Open interactive settings panel
/voice setup        — Run first-time setup wizard
/voice conversation — Toggle conversation mode
/voice provider stt deepgram   — Switch STT provider
/voice provider tts edge-tts   — Switch TTS provider
/voice mode toggle             — Switch input mode
/voice trigger always          — Set TTS trigger mode
/voice key deepgram API_KEY    — Set API key
```

## Providers

### Speech-to-Text

| Provider | Streaming | Cost | API Key |
|----------|-----------|------|---------|
| **Deepgram Nova-3** | ✅ Real-time | $0.008/min | Required |
| **OpenAI Whisper** | ❌ Batch | $0.003/min | Required |
| **Azure Speech** | ✅ Real-time | $0.017/min | Required |
| **Google Cloud STT** | ❌ Batch | $0.016/min | Required |
| **AssemblyAI** | ✅ Real-time | $0.003/min | Required |
| **ElevenLabs Scribe** | ❌ Batch | $0.007/min | Required |
| **Whisper Local** | ❌ Batch | Free | None |

### Text-to-Speech

| Provider | Cost | API Key | Quality |
|----------|------|---------|---------|
| **Edge TTS** ⭐ | **Free** | **None** | Good |
| **OpenAI TTS** | $15/1M chars | Required | High |
| **ElevenLabs** | $120/1M chars | Required | Premium |
| **Cartesia Sonic** | $11/1M chars | Required | High |
| **Google Cloud TTS** | $4/1M chars | Required | High |
| **Azure TTS** | $16/1M chars | Required | High |
| **Deepgram Aura** | $15/1M chars | Required | Good |
| **Piper** | Free | None | Good (local) |
| **System TTS** | Free | None | Basic |

⭐ Edge TTS is the default — zero cost, no API key needed.

## Configuration

Settings are stored in `~/.pi/voice.json`. You can edit this file directly or use `/voice settings`.

API keys can be set via:
1. Environment variables: `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `AZURE_SPEECH_KEY`, etc.
2. Config file via `/voice key <provider> <key>`
3. Interactive setup wizard via `/voice setup`

## System Requirements

### Audio (mic input)
- **Linux**: `arecord` (from `alsa-utils`) — `sudo apt install alsa-utils`
- **macOS**: `sox` — `brew install sox`
- **Windows**: `sox` — `choco install sox.portable`

### Audio (playback)
- **Linux**: `aplay` (from `alsa-utils`)
- **macOS**: `play` (from `sox`)
- **Windows**: `ffplay` (from `ffmpeg`) — `choco install ffmpeg`

### Local providers (optional)
- **Whisper Local**: `whisper` CLI — `pip install openai-whisper`
- **Piper**: `piper` CLI — See [piper releases](https://github.com/rhasspy/piper/releases)

## Architecture

```
pi-voice/
├── src/
│   ├── index.ts              # Extension entry point, event hooks, commands
│   ├── types.ts              # All TypeScript interfaces
│   ├── config.ts             # Configuration loading, saving, API keys
│   ├── text-processor.ts     # Markdown→speech conversion, sentence buffering
│   ├── conversation.ts       # Conversation mode controller
│   ├── audio/
│   │   ├── mic.ts            # Cross-platform microphone capture
│   │   └── speaker.ts        # Cross-platform audio playback
│   ├── stt/
│   │   ├── base.ts           # Abstract STT base class
│   │   ├── deepgram.ts       # Deepgram Nova-3 (WebSocket streaming)
│   │   ├── openai.ts         # OpenAI Whisper API (batch)
│   │   ├── azure.ts          # Azure Speech (WebSocket streaming)
│   │   ├── google.ts         # Google Cloud STT (batch)
│   │   ├── assemblyai.ts     # AssemblyAI (WebSocket streaming)
│   │   ├── elevenlabs.ts     # ElevenLabs Scribe (batch)
│   │   └── whisper-local.ts  # Local whisper.cpp (batch)
│   ├── tts/
│   │   ├── base.ts           # Abstract TTS base class
│   │   ├── edge-tts.ts       # Microsoft Edge TTS (free!)
│   │   ├── openai.ts         # OpenAI TTS
│   │   ├── elevenlabs.ts     # ElevenLabs
│   │   ├── cartesia.ts       # Cartesia Sonic (WebSocket)
│   │   ├── google.ts         # Google Cloud TTS
│   │   ├── azure.ts          # Azure TTS (SSML)
│   │   ├── deepgram.ts       # Deepgram Aura
│   │   ├── piper.ts          # Piper local TTS
│   │   └── system.ts         # OS built-in (say/espeak)
│   ├── voice-commands/
│   │   ├── commands.ts        # All voice command definitions
│   │   └── parser.ts          # Command parsing engine
│   └── ui/
│       ├── status.ts          # Status bar indicators
│       ├── settings.ts        # Interactive TUI settings panel
│       └── wizard.ts          # First-time setup wizard
└── package.json
```

## License

MIT
