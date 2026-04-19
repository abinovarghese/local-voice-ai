# Local Voice AI for VS Code

Fully offline push-to-talk voice dictation for VS Code on Windows. Audio is captured in a local webview, transcribed by [whisper.cpp](https://github.com/ggerganov/whisper.cpp) running on your machine, and inserted into the editor — or forwarded to any AI chat extension via a configurable command.

**No data leaves your machine.** The extension makes zero network calls.

---

## Phase 1 status

- [x] Push-to-talk via `Ctrl+Shift+Space` (toggle start/stop)
- [x] Webview-based mic capture (getUserMedia + AudioContext)
- [x] 16 kHz mono WAV encoding, passed to whisper.cpp
- [x] Transcript inserted at cursor, or routed to a configured chat command
- [x] Status bar indicator + VU meter

---

## Prerequisites

1. **Windows 10/11**
2. **Node.js 18+** (for building the extension)
3. **whisper.cpp for Windows** — download the latest release:
   - Go to https://github.com/ggerganov/whisper.cpp/releases
   - Grab the Windows zip (e.g. `whisper-bin-x64.zip`). If you have an NVIDIA GPU, there are CUDA builds too.
   - Extract somewhere permanent, e.g. `C:\tools\whisper\`. You want `whisper-cli.exe` (older releases call it `main.exe` — both work).
4. **A Whisper model** (ggml format):
   - `base.en` quantized is a good default: https://huggingface.co/ggerganov/whisper.cpp/blob/main/ggml-base.en-q5_1.bin (~60 MB)
   - For better accuracy: `small.en-q5_1.bin` (~250 MB)
   - Drop it next to the binary, e.g. `C:\tools\whisper\ggml-base.en-q5_1.bin`

---

## Build & run

```powershell
cd local-voice-ai
npm install
npm run compile
```

Open the folder in VS Code, then press **F5** to launch a new Extension Development Host with the extension loaded.

---

## Configure (in Settings → Extensions → Local Voice AI)

| Setting | Value |
|---|---|
| `localVoiceAI.whisperBinaryPath` | `C:\tools\whisper\whisper-cli.exe` |
| `localVoiceAI.whisperModelPath` | `C:\tools\whisper\ggml-base.en-q5_1.bin` |
| `localVoiceAI.language` | `en` (or `auto`) |
| `localVoiceAI.threads` | `4` (raise on beefy CPUs) |
| `localVoiceAI.aiChatCommand` | *(leave blank for now)* |

---

## Use

1. Press `Ctrl+Shift+Space`. The first time, a **Voice AI Mic** panel opens beside your editor and prompts for microphone permission. Grant it.
2. Press `Ctrl+Shift+Space` **again** to start recording. Status bar turns red, VU meter moves.
3. Speak.
4. Press `Ctrl+Shift+Space` once more to stop. whisper.cpp transcribes locally; the text is inserted at your cursor.

---

## Routing to an AI chat extension

Set `localVoiceAI.aiChatCommand` to the command ID exposed by your AI extension. Common ones:

| Extension | Command ID |
|---|---|
| GitHub Copilot Chat | `workbench.action.chat.open` |
| Continue | `continue.focusContinueInput` |
| Cline | `cline.newTask` |
| Cursor chat (in Cursor only) | `aichat.newfollowupaction` |

> Not every extension accepts the transcript as an argument. The code tries three invocation styles (`cmd(transcript)`, `cmd({query: transcript})`, `cmd()`) and always copies the transcript to the clipboard as a universal fallback — so worst case you just paste.

To find the exact ID of any command: `Ctrl+Shift+P` → "Developer: Show Running Extensions" → inspect contributions, or open the Keyboard Shortcuts UI and search.

---

## Verifying it's truly local

- No dependencies on cloud SDKs in `package.json`.
- The webview CSP blocks everything except inline scripts/styles (`default-src 'none'`).
- The extension shells out only to the binary path *you* configured.
- You can confirm with Windows Firewall (block outbound for `Code.exe` while testing) or Wireshark — no traffic should appear during dictation.

---

## Architecture

```
┌─────────────────────┐      postMessage       ┌──────────────────────┐
│  webview.html       │  ───────────────────►  │  extension.ts        │
│  (getUserMedia,     │      WAV (base64)      │  (Node host)         │
│   AudioContext,     │                        │                      │
│   resample, encode) │                        │  writes temp .wav    │
└─────────────────────┘                        │  spawns whisper-cli  │
                                               │  reads .txt output   │
                                               │  inserts at cursor   │
                                               └──────────────────────┘
```

---

## Roadmap (Phase 2 ideas)

- True hold-to-talk (not toggle) via a small native helper that hooks the keyboard outside VS Code's event model
- Local wake word using [openWakeWord](https://github.com/dscripka/openWakeWord) (Apache-2.0)
- Streaming transcription so text appears as you speak (whisper.cpp has a streaming mode)
- Voice commands — "new file", "run tests", "open terminal" — mapped to VS Code command IDs
- Package whisper.cpp + model inside the VSIX so there's no manual setup

---

---

## Contributing

PRs and issues welcome. Open an issue before large changes so we can align on scope.

## License

[MIT](./LICENSE). whisper.cpp is MIT too; Whisper models are MIT from OpenAI.
