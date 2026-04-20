# Local Voice AI — Phase 2 Design

**Date:** 2026-04-20
**Author:** Abin O Varghese
**Status:** Approved for implementation (user directive: ship all six in one pass, best judgment)

## Goal

Turn the Phase 1 developer demo into an installable, cross-platform VS Code extension with hands-free activation, streaming feedback, and voice-command dispatch — while keeping the "no data leaves your machine" guarantee intact.

## Scope

Six features, labelled A–F. All ship together. User has pre-approved the scoping decisions called out below.

### A — Cross-platform support

**What:** Remove Windows-only framing. Support macOS (arm64 + x86_64), Linux (x86_64), Windows (x86_64).

**Why:** The existing code is already portable (`child_process.spawn`, webview APIs, `os.tmpdir`); only the docs and example paths were Windows-only. Unlocking macOS/Linux is near-free and the author is on macOS.

**How:** Platform-aware binary name resolution (`whisper-cli.exe` vs `whisper-cli`), updated README with platform-specific setup steps, no code assuming path separators or drive letters.

### B — Auto-install of whisper.cpp + model on first run

**What:** On first activation, if binary/model are not configured, offer to download them automatically to the extension's `globalStorageUri`. Subsequent runs reuse the cached copies.

**Why:** Manual download from two different projects (whisper.cpp releases, HuggingFace) is the biggest adoption friction. Makes first-run a single "Yes, download" click.

**How:**
- Detect `process.platform` + `process.arch`
- Windows: download `https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-bin-x64.zip` → extract `whisper-cli.exe`
- macOS / Linux: check if `whisper-cli` is on `PATH`; if yes, use it. If not, guide user to `brew install whisper-cpp` (macOS) or build-from-source (Linux) with a one-click "Open install instructions" action. No bundled binary.
- Model: download `ggml-base.en-q5_1.bin` (~60 MB) from `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin` to `globalStorageUri`
- Show VS Code progress notification during download
- SHA-256 verify (optional — best-effort, don't block if upstream changes)
- Skip entirely if user has already configured paths in settings

**Scoping decision (author):** VSIX-bundled binaries were rejected because per-platform VSIXes + a 60MB model would balloon install size and hit Marketplace limits. Download-on-first-run is the pattern Copilot, Pylance, and most ML-adjacent extensions use.

### C — Chunked streaming transcription

**What:** While recording, show interim transcription in the status bar every ~3 seconds. Final transcript on stop, same as today.

**Why:** Live feedback dramatically improves perceived responsiveness and catches mic problems early ("why isn't it picking me up?"). No need to wait 5 seconds after stopping to see if it worked.

**How:**
- Webview snapshots the in-progress audio buffer every `streamingChunkSeconds` (default 3) and posts it as a `chunk` message
- Extension transcribes each chunk in a separate whisper-cli invocation with `-np` (no print) and `-otxt`; displays result in a status bar message
- Chunks are **independent** (not incremental whisper state), so there may be minor seam artefacts between chunks — acceptable for preview
- On final stop, the full buffer is transcribed once and that result is the authoritative transcript (inserted into editor / routed to chat)
- Enabled via `localVoiceAI.streamingPreview` (default: true). Disable for slower CPUs.

**Scoping decision (author):** True incremental streaming requires either whisper.cpp's `stream` example (which owns the microphone itself — incompatible with our webview-owned mic) or a custom binding to whisper.cpp's low-level C API. Chunked re-transcription gives 80% of the perceived benefit with 10% of the effort.

### D — Voice commands

**What:** Transcribed text can be interpreted as a VS Code command instead of dictated text. Example: saying "open terminal" executes `workbench.action.terminal.new`.

**Why:** Hands-free control is the natural extension of hands-free dictation.

**How:**
- New config `localVoiceAI.voiceCommands`: array of `{ pattern: string, command: string, args?: any[] }` entries. Pattern is a case-insensitive regex against the trimmed transcript.
- Default set bundled:
  - `^new file$` → `workbench.action.files.newUntitledFile`
  - `^save( file)?$` → `workbench.action.files.save`
  - `^open terminal$` → `workbench.action.terminal.new`
  - `^close (tab|editor)$` → `workbench.action.closeActiveEditor`
  - `^(run|start) tests?$` → `testing.runAll`
  - `^go to line (\d+)$` → `revealLine` (with the captured number as arg)
  - `^find$` → `actions.find`
- Matched transcript invokes the command instead of being inserted/routed
- Unmatched transcripts fall through to existing dictation behavior
- Toggleable per session via command palette (`Voice AI: Toggle Voice Commands`) and globally via `localVoiceAI.voiceCommandsEnabled`

### E — VAD auto-stop (hold-to-talk UX equivalent)

**What:** When enabled, recording auto-stops after N seconds of silence. User presses once to start, then just stops talking to end — no second keypress.

**Why:** The README's Phase 2 idea #1 was "true hold-to-talk via native keyboard helper." VS Code's keybinding API only delivers keydown events; keyup interception requires platform-specific native code (SetWindowsHookEx, CGEventTap, XGrabKey). That's a multi-week project per platform.

Auto-stop-on-silence achieves the same UX goal ("I don't want to press a key twice") through a different mechanism, entirely in the existing webview audio pipeline.

**How:**
- Webview tracks a rolling peak-energy window; if peak stays below `silenceThreshold` for `silenceDurationMs` continuously, webview initiates stop
- Config: `localVoiceAI.autoStopOnSilence` (bool, default true), `localVoiceAI.silenceThresholdDb` (default -45), `localVoiceAI.silenceDurationMs` (default 1200)
- A minimum-recording-time guard (500ms) prevents instant-stop if the mic takes a moment to pick up speech

**Scoping decision (author):** True hold-to-talk deferred. If native-helper hold-to-talk is wanted later, it's an additive feature — this doesn't block it.

### F — Energy-based wake activation

**What:** Continuously listen (VU meter already running); when sustained voice energy is detected, auto-start recording. Combined with E, gives fully hands-free operation.

**Why:** The README's idea #2 was a true wake word ("Hey Code") via openWakeWord. That requires integrating a TFLite/ONNX runtime + per-wake-word models + a training/customization story. Large scope, and adds a Python/ML dependency that conflicts with the "no runtime dependencies beyond whisper.cpp" design.

Energy-based activation is a strictly simpler primitive: "any sustained voice-like sound above threshold starts recording." Accuracy is lower (it fires on nearby conversation, not just the user's wake phrase), but for a single-user extension on a headset mic it's serviceable, and it's zero-dependency.

**How:**
- Webview continuously monitors peak energy (already happens for VU meter)
- New state machine: `idle` → (energy > wake threshold for wake-duration-ms) → `recording` → (E triggers) → `idle`
- Config: `localVoiceAI.wakeOnVoice` (bool, default false), `localVoiceAI.wakeThresholdDb` (default -30), `localVoiceAI.wakeDurationMs` (default 400)
- Defaults to OFF — user must opt in (false alarms would be annoying by default)
- Visible indicator in mic panel when "listening for wake"

**Scoping decision (author):** Real wake-word (Porcupine, openWakeWord) deferred. Can be added later as a drop-in replacement for the energy detector without changing the upstream state machine.

## Architecture

Module layout stays close to current. One new TS module and a trimmed webview:

```
src/
  extension.ts        — activation, wiring, lifecycle, dispatch (existing, extended)
  setup.ts            — NEW. ensureWhisperAssets(): detects/downloads binary + model
  transcribe.ts       — NEW. runWhisper() + streaming chunk runner, extracted from extension.ts
  commands.ts         — NEW. matchVoiceCommand() + default grammar
  platform.ts         — NEW. tiny helper for os/arch → binary name, download URL, install hint
media/
  webview.html        — extended. VAD auto-stop, wake-on-voice, streaming chunk emission
```

New top-level config keys in `package.json` contributes:

| Key | Default | Purpose |
|---|---|---|
| `localVoiceAI.streamingPreview` | `true` | C — interim chunks |
| `localVoiceAI.streamingChunkSeconds` | `3` | C — chunk size |
| `localVoiceAI.voiceCommandsEnabled` | `true` | D — enable command grammar |
| `localVoiceAI.voiceCommands` | `[]` (merged with built-ins) | D — user-defined commands |
| `localVoiceAI.autoStopOnSilence` | `true` | E — VAD stop |
| `localVoiceAI.silenceThresholdDb` | `-45` | E — silence floor |
| `localVoiceAI.silenceDurationMs` | `1200` | E — silence hold time |
| `localVoiceAI.wakeOnVoice` | `false` | F — wake activation |
| `localVoiceAI.wakeThresholdDb` | `-30` | F — wake floor |
| `localVoiceAI.wakeDurationMs` | `400` | F — wake hold time |

## Data flow

```
[webview]                                           [extension.ts]
  mic                                                    │
   │                                                     │
   ▼                                                     │
 AudioContext                                            │
   │ (peak energy loop — always on)                      │
   │──── wake energy > threshold? (F) ──── 'wake' ───────┤
   │                                                     │
   │ ScriptProcessor buffers → flat Float32              │
   │                                                     │
   │──── every chunkSeconds (C) ──── 'chunk' ──► transcribe(chunk) → statusBar
   │                                                     │
   │──── silence > duration (E) ──── 'silence' ─────────►│ stop
   │                                                     │
   ▼                                                     ▼
  WAV → base64 ──── 'audio' (final) ────► transcribe() → match command? (D)
                                              │             │
                                              │             ├── yes → executeCommand()
                                              │             └── no  → insert | chat route
```

## Error handling / failure modes

- **Download failure (B):** retry-once, then fall back to manual instructions. User's extension remains functional if they had paths configured.
- **Unsupported platform (B):** clear error with link to build-from-source instructions.
- **VAD / wake misfire (E, F):** both have opt-out config; wake defaults to off. No permanent state change on misfire.
- **Streaming transcription stalls (C):** each chunk runs in an independent child process; one failure doesn't block the next. Status bar shows last-good text.
- **Voice command collision (D):** if multiple patterns match, first match wins (array order is user-controllable).

## Testing

Manual verification on macOS (the author's machine):
1. Fresh install → first activation → auto-install flow prompts → model downloads → ready
2. Toggle recording, speak, see interim text in status bar, final transcript inserted
3. Enable auto-stop-on-silence, speak, stop speaking, recording ends automatically
4. Enable wake-on-voice, speak after idle gap, recording starts automatically
5. Say "open terminal" → terminal opens (command match)
6. Say "hello world" → text inserted (no command match)
7. Disable streaming → still works (batch only)

No automated test suite — this is a UI-heavy extension and mocking the mic + whisper-cli would be more fragile than manual verification at this phase.

## Non-goals for Phase 2

- Native keyboard hook for true hold-to-talk (deferred; E covers the UX)
- ML wake word (deferred; F covers the UX with a simpler primitive)
- Bundling whisper.cpp binary in the VSIX (deferred; download-on-first-run is cleaner)
- Custom model support (works today via config; no extra work needed)
- Multi-language auto-switching (config already supports `auto`)

## Files changed

- `src/extension.ts` — major refactor, dispatch to new modules
- `src/setup.ts` — NEW
- `src/transcribe.ts` — NEW
- `src/commands.ts` — NEW
- `src/platform.ts` — NEW
- `media/webview.html` — extended with VAD + wake + chunk emission
- `package.json` — new config keys, new command IDs, maybe `@types/node` extensions if needed for `fetch`
- `README.md` — cross-platform setup, new config, Phase 2 status
