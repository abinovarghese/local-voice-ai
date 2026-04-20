# Local Voice AI for VS Code

Fully offline push-to-talk voice dictation, live preview, voice commands, and hands-free activation for VS Code. Audio is captured in a local webview, transcribed by [whisper.cpp](https://github.com/ggerganov/whisper.cpp) running on your machine, and inserted into the editor — or forwarded to any AI chat extension.

**No data leaves your machine.** The extension makes zero network calls except when you explicitly ask it to download whisper.cpp or the Whisper model during first-run setup.

Works on **Windows, macOS, and Linux**.

---

## Status

**Phase 1 — shipped**
- [x] Toggle dictation via `Ctrl+Shift+Space` / `Cmd+Shift+Space`
- [x] Webview-based mic capture, 16 kHz mono WAV, whisper.cpp offline
- [x] Transcript inserted at cursor, or routed to a configured chat command
- [x] Status bar indicator + VU meter

**Phase 2 — shipped**
- [x] **Cross-platform** — Windows, macOS, Linux
- [x] **Auto-install** — one-click download of whisper.cpp (Windows) and the Whisper model (all platforms)
- [x] **Streaming preview** — interim transcription in the status bar every ~3 seconds
- [x] **Voice commands** — say "open terminal", "new file", "save file", "go to line 42", etc.
- [x] **Auto-stop on silence** — press once, talk, recording ends automatically
- [x] **Wake-on-voice** — hands-free activation from sustained voice energy

**Phase 3 — shipped**
- [x] **Auto-calibration** — 2-second ambient-noise sample on mic init sets silence / wake thresholds for your room
- [x] **Model picker** — `Voice AI: Choose Whisper Model…` to swap between tiny / base / small / multilingual without editing config
- [x] **Transcript history** — `Voice AI: Show Transcript History` — last 50 transcripts with delivery method (editor / chat / command / clipboard), stored locally

---

## Install

1. **Clone and build:**
   ```bash
   git clone https://github.com/abinovarghese/local-voice-ai.git
   cd local-voice-ai
   npm install
   npm run compile
   ```
2. Open the folder in VS Code and press **F5** to launch an Extension Development Host with the extension loaded.

First time you trigger recording, the extension offers to download whisper.cpp (Windows only — macOS/Linux users install via `brew` or package manager) and the Whisper model (~60 MB). Accept once, done forever.

### Manual setup (if you prefer)

| Platform | whisper.cpp binary |
|---|---|
| **Windows** | Download `whisper-bin-x64.zip` from [whisper.cpp releases](https://github.com/ggerganov/whisper.cpp/releases) and extract `whisper-cli.exe` |
| **macOS** | `brew install whisper-cpp` |
| **Linux** | Build from source: `git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp && make` |

Model: any ggml file, e.g. [ggml-base.en-q5_1.bin](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin) (~60 MB).

Point the extension at them via settings (`localVoiceAI.whisperBinaryPath`, `localVoiceAI.whisperModelPath`) — or leave blank to let the extension find them on `PATH` automatically.

---

## Use

1. Press `Ctrl+Shift+Space` (`Cmd+Shift+Space` on macOS). The first time, a **Voice AI Mic** panel opens and prompts for microphone permission.
2. Press again to start recording. Speak.
3. With auto-stop enabled (default), recording ends when you stop talking. Otherwise, press the shortcut again to stop.
4. Transcript is inserted at the cursor — or, if it matches a voice command, the command runs instead.

---

## Voice commands

Default grammar (extend via `localVoiceAI.voiceCommands`):

| Say | Runs |
|---|---|
| new file | `workbench.action.files.newUntitledFile` |
| save / save file | `workbench.action.files.save` |
| save all | `workbench.action.files.saveAll` |
| open terminal | `workbench.action.terminal.new` |
| close tab / close editor | `workbench.action.closeActiveEditor` |
| run tests / start test | `testing.runAll` |
| stop tests | `testing.cancelRun` |
| find | `actions.find` |
| replace | `editor.action.startFindReplaceAction` |
| go to line 42 | `revealLine 42` |
| format / format document | `editor.action.formatDocument` |
| comment / comment line | `editor.action.commentLine` |
| undo / redo | `undo` / `redo` |
| split editor / split right | `workbench.action.splitEditorRight` |

Add your own in settings:
```json
"localVoiceAI.voiceCommands": [
  { "pattern": "^toggle sidebar$", "command": "workbench.action.toggleSidebarVisibility" },
  { "pattern": "^close all$",     "command": "workbench.action.closeAllEditors" }
]
```

Toggle the grammar on/off with `Voice AI: Toggle Voice Commands` in the command palette.

---

## Hands-free mode

Enable both settings:

- `localVoiceAI.wakeOnVoice: true` — start recording when sustained voice is detected
- `localVoiceAI.autoStopOnSilence: true` (default) — stop recording when you go silent

Result: talk → transcribe → insert → listen for next activation. Hands never leave the keyboard.

Tune the thresholds if it fires too eagerly or too reluctantly:
- `localVoiceAI.wakeThresholdDb` (default `-30`) — raise to require louder voice
- `localVoiceAI.silenceThresholdDb` (default `-45`) — lower if it cuts you off mid-pause

---

## Routing to an AI chat extension

Set `localVoiceAI.aiChatCommand` to the command ID exposed by your AI extension.

| Extension | Command ID |
|---|---|
| GitHub Copilot Chat | `workbench.action.chat.open` |
| Continue | `continue.focusContinueInput` |
| Cline | `cline.newTask` |
| Cursor chat | `aichat.newfollowupaction` |

Not every extension accepts the transcript as an argument. The code tries three invocation styles (`cmd(transcript)`, `cmd({query: transcript})`, `cmd()`) and always copies the transcript to the clipboard as a universal fallback.

---

## Verifying it's truly local

- No dependencies on cloud SDKs in `package.json` (`devDependencies` only).
- The only network calls the extension *ever* makes are the first-run downloads you explicitly accept.
- The webview CSP blocks everything except inline scripts/styles (`default-src 'none'`).
- You can confirm with a firewall (block outbound for `Code.exe` / Electron while testing) or Wireshark — no traffic should appear during dictation.

---

## Architecture

```
┌──────────────────────────┐   postMessage    ┌──────────────────────┐
│ webview.html             │ ───────────────► │ extension.ts         │
│                          │                  │                      │
│ AudioContext,            │ chunk (every 3s) │ setup.ts             │
│ ScriptProcessor buffers, │ silence → auto-  │   download assets    │
│ VAD auto-stop,           │   stop           │ transcribe.ts        │
│ wake-on-voice detector,  │ wake → auto-     │   spawn whisper-cli  │
│ WAV encode + resample    │   start          │ commands.ts          │
└──────────────────────────┘                  │   voice command      │
                                              │   grammar            │
                                              │ platform.ts          │
                                              │   OS detection       │
                                              └──────────────────────┘
```

---

## Roadmap (Phase 3 ideas)

- True native hold-to-talk keyboard hook (SetWindowsHookEx / CGEventTap / XGrabKey)
- Porcupine / openWakeWord for real wake-word recognition
- Incremental streaming via direct whisper.cpp C API binding (no chunk seams)
- Per-workspace grammars (project-specific voice commands)

---

## Contributing

PRs and issues welcome. Open an issue before large changes so we can align on scope.

## License

[MIT](./LICENSE). whisper.cpp is MIT too; Whisper models are MIT from OpenAI.
