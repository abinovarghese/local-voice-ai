# Manual Testing Walkthrough

The extension relies on microphone input and native child processes, so there's no automated test suite — this doc is the smoke test before each release.

## Setup (one-time)

```bash
npm install
npm run compile
code --extensionDevelopmentPath=.
```

In the Extension Development Host window that opens, proceed through the tests below. Start with a quiet room and a working microphone.

## 0. First-run asset install (tests B)

**Precondition:** No `localVoiceAI.whisperBinaryPath` or `localVoiceAI.whisperModelPath` set in settings.

1. Trigger `Ctrl+Shift+Space` (macOS: `Cmd+Shift+Space`).
2. Voice AI Mic panel opens. Grant microphone permission.
3. Press the shortcut again.
4. **Expected:** Prompt to download whisper.cpp (Windows only, auto-download) or an instruction to install via `brew` (macOS) / build from source (Linux).
5. After handling the binary, a second prompt offers to download the ~60 MB model.
6. Accept, watch the progress notification, confirm model lands in `context.globalStorageUri`.

**Failure modes to verify:**
- Cancel the model download mid-progress → no partial file left in place (should be `.partial` renamed only on success).
- Deny microphone access → clear error message, panel shows "Mic blocked."

## 1. Basic dictation (tests Phase 1 + A)

1. Press shortcut, speak a sentence, press shortcut again (or wait for auto-stop).
2. **Expected:** Transcript appears at cursor in the active editor.
3. **No active editor path:** Close all editors, repeat → transcript copied to clipboard, info message shown.

## 2. Streaming preview (tests C)

1. With `localVoiceAI.streamingPreview: true` (default), press shortcut and speak for ~8 seconds.
2. **Expected:** Status bar updates with interim transcript text every ~3 seconds (`Voice AI: hello world…`).
3. Final transcript on stop replaces interim.
4. **Stress test:** speak for 30+ seconds. Expected: preview chunks stay bounded to ~20 seconds of audio (check: no memory growth, no slowdown).

## 3. Voice commands (tests D)

1. With an editor open and focused, press shortcut and say: **"open terminal"**.
2. **Expected:** Integrated terminal opens. Status bar: `Voice AI → command: workbench.action.terminal.new`.
3. Try: **"new file"** → untitled file opens.
4. Try: **"go to line 5"** in a file with 10+ lines → cursor moves to line 5.
5. Try: **"hello world"** → falls through to dictation (inserted as text).
6. Disable with `Voice AI: Toggle Voice Commands`, say "open terminal" → text inserted.

## 4. VAD auto-stop (tests E)

1. `localVoiceAI.autoStopOnSilence: true` (default).
2. Press shortcut, speak: "this is a test". Stop talking.
3. **Expected:** Recording stops automatically ~1.2 seconds after last voice. Transcript inserted.
4. **Min-record guard:** press shortcut in silence, do NOT speak → recording doesn't instantly stop (500ms guard). Should still auto-stop ~1.2s after mic settles.
5. Tune `silenceThresholdDb` down (e.g. `-55`) if it cuts you off between words; up (e.g. `-35`) if it lingers.

## 5. Wake-on-voice (tests F)

1. Enable `localVoiceAI.wakeOnVoice: true`.
2. Open the Voice AI Mic panel. Status dot should be **green pulsing** with label "Listening for voice…".
3. Stay silent for 3 seconds. Speak: "open terminal".
4. **Expected:** Recording starts automatically mid-phrase (first syllable should NOT be clipped — pre-roll buffer recovers the first ~700ms).
5. With auto-stop enabled, recording ends when you finish; command executes.
6. **False-fire test:** play music / cough / type loudly. Wake may trigger — that's expected (energy-based, not a true wake word). Raise `wakeThresholdDb` (e.g. `-20`) to reduce sensitivity.

## 6. Chat routing (tests Phase 1 integration)

1. Install GitHub Copilot Chat (or any supported chat extension).
2. Set `localVoiceAI.aiChatCommand: "workbench.action.chat.open"`.
3. Press shortcut, speak a question.
4. **Expected:** Chat panel opens with transcript. Transcript also on clipboard as fallback.

## 7. Network isolation (privacy check)

1. Block outbound network for `Electron.app` (macOS: Little Snitch; Windows: Windows Firewall).
2. Repeat tests 1–5.
3. **Expected:** Dictation and voice commands still work. No blocked-connection warnings from the firewall after initial asset download.

## Pre-release checklist

- [ ] All sections above pass on the release platform (macOS / Windows / Linux)
- [ ] `npx tsc --noEmit` clean
- [ ] `npx @vscode/vsce package` produces a VSIX under 100 KB
- [ ] `README.md` "Status" section updated if features changed
- [ ] Version bumped in `package.json`
- [ ] Tag `vX.Y.Z` pushed — release workflow uploads VSIX automatically
