import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ensureWhisperAssets, downloadModelToStorage, ensureNativeAssets, WhisperAssets } from './setup';
import { transcribeWav } from './transcribe';
import { matchVoiceCommand, executeVoiceCommand } from './commands';
import { MODEL_CHOICES } from './models';
import { TranscriptHistory, renderHistoryHtml } from './history';
import { NativeKeyboard } from './nativeKeyboard';
import { loadNativeBinding, isNativeBindingSupported, NativeTranscriber } from './nativeStreaming';

let voicePanel: vscode.WebviewPanel | undefined;
let webviewReady = false;
let isRecording = false;
let statusItem: vscode.StatusBarItem;
let extCtx: vscode.ExtensionContext;
let lastEditor: vscode.TextEditor | undefined;
let cachedAssetsPromise: Promise<WhisperAssets | undefined> | undefined;
let cachedAssetsValue: WhisperAssets | undefined;
let chunkInFlight = false;
let history: TranscriptHistory;
let historyPanel: vscode.WebviewPanel | undefined;
let nativeKeyboard: NativeKeyboard | undefined;
let nativeTranscriber: NativeTranscriber | undefined;

function getAssets(): Promise<WhisperAssets | undefined> {
  if (cachedAssetsPromise) { return cachedAssetsPromise; }
  cachedAssetsPromise = (async () => {
    try {
      const result = await ensureWhisperAssets(extCtx);
      cachedAssetsValue = result;
      if (!result) { cachedAssetsPromise = undefined; }
      return result;
    } catch (err) {
      cachedAssetsPromise = undefined;
      cachedAssetsValue = undefined;
      throw err;
    }
  })();
  return cachedAssetsPromise;
}

export function activate(context: vscode.ExtensionContext) {
  extCtx = context;
  history = new TranscriptHistory(context);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.text = '$(mic) Voice AI';
  statusItem.tooltip = 'Toggle Voice AI dictation (Ctrl+Shift+Space)';
  statusItem.command = 'localVoiceAI.toggleDictation';
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) { lastEditor = ed; }
    })
  );
  lastEditor = vscode.window.activeTextEditor;

  context.subscriptions.push(
    vscode.commands.registerCommand('localVoiceAI.toggleDictation', toggleDictation),
    vscode.commands.registerCommand('localVoiceAI.openMic', () => ensurePanel()),
    vscode.commands.registerCommand('localVoiceAI.toggleVoiceCommands', toggleVoiceCommands),
    vscode.commands.registerCommand('localVoiceAI.installAssets', installAssets),
    vscode.commands.registerCommand('localVoiceAI.pickModel', pickModel),
    vscode.commands.registerCommand('localVoiceAI.showHistory', showHistory),
    vscode.commands.registerCommand('localVoiceAI.recalibrate', recalibrate),
    vscode.commands.registerCommand('localVoiceAI.toggleHoldToTalk', toggleHoldToTalk),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localVoiceAI')) {
        sendConfigToWebview();
        syncNativeKeyboardState();
      }
    })
  );

  syncNativeKeyboardState();
}

async function toggleDictation() {
  if (!voicePanel || !webviewReady) {
    await ensurePanel();
    vscode.window.showInformationMessage(
      'Voice AI: grant microphone access in the side panel, then press Ctrl+Shift+Space again to record.'
    );
    return;
  }
  const assets = await getAssets();
  if (!assets) { return; }
  if (isRecording) {
    voicePanel.webview.postMessage({ type: 'stop' });
  } else {
    voicePanel.webview.postMessage({ type: 'start' });
  }
}

async function toggleVoiceCommands() {
  const cfg = vscode.workspace.getConfiguration('localVoiceAI');
  const current = cfg.get<boolean>('voiceCommandsEnabled', true);
  await cfg.update('voiceCommandsEnabled', !current, vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(
    `Voice AI: voice commands ${!current ? 'enabled' : 'disabled'}`,
    2500
  );
}

async function installAssets() {
  cachedAssetsPromise = undefined;
  cachedAssetsValue = undefined;
  const assets = await getAssets();
  if (assets) {
    vscode.window.showInformationMessage('Voice AI: whisper.cpp and model ready.');
  }
}

async function pickModel() {
  const items = MODEL_CHOICES.map((m) => ({
    label: m.label,
    description: `${m.approxMB} MB`,
    detail: m.description,
    choice: m,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Pick a Whisper model to download',
    matchOnDetail: true,
  });
  if (!picked) { return; }

  try {
    const dest = await downloadModelToStorage(
      extCtx,
      picked.choice.url,
      picked.choice.filename,
      `Downloading ${picked.choice.label}`
    );
    await vscode.workspace
      .getConfiguration('localVoiceAI')
      .update('whisperModelPath', dest, vscode.ConfigurationTarget.Global);
    cachedAssetsPromise = undefined;
    cachedAssetsValue = undefined;
    vscode.window.showInformationMessage(
      `Voice AI: using ${picked.choice.label}. Next recording will use the new model.`
    );
  } catch (err: any) {
    vscode.window.showErrorMessage(`Voice AI: model download failed — ${err.message}`);
  }
}

async function showHistory() {
  if (historyPanel) { historyPanel.reveal(vscode.ViewColumn.Beside, true); historyPanel.webview.html = renderHistoryHtml(history.all()); return; }
  historyPanel = vscode.window.createWebviewPanel(
    'localVoiceAIHistory',
    'Voice AI History',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true }
  );
  historyPanel.webview.html = renderHistoryHtml(history.all());
  historyPanel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === 'clear') {
      await history.clear();
      historyPanel!.webview.html = renderHistoryHtml(history.all());
    }
  });
  historyPanel.onDidDispose(() => { historyPanel = undefined; });
}

function recalibrate() {
  if (!voicePanel || !webviewReady) {
    vscode.window.showInformationMessage('Voice AI: open the mic panel first (Ctrl+Shift+Space).');
    return;
  }
  voicePanel.webview.postMessage({ type: 'recalibrate' });
  vscode.window.setStatusBarMessage('Voice AI: recalibrating noise floor…', 3000);
}

async function toggleHoldToTalk() {
  const cfg = vscode.workspace.getConfiguration('localVoiceAI');
  const next = !cfg.get<boolean>('holdToTalk', false);
  await cfg.update('holdToTalk', next, vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(
    `Voice AI: hold-to-talk ${next ? 'enabled' : 'disabled'}`,
    2500
  );
}

async function syncNativeKeyboardState() {
  const cfg = vscode.workspace.getConfiguration('localVoiceAI');
  const want = cfg.get<boolean>('holdToTalk', false);
  const hotkey = cfg.get<string>('holdToTalkHotkey', 'ctrl+shift+space');

  if (!want) {
    stopNativeKeyboard();
    return;
  }

  if (process.platform !== 'win32') {
    vscode.window.showWarningMessage(
      'Voice AI: hold-to-talk currently ships only for Windows. Ignoring localVoiceAI.holdToTalk on this platform.'
    );
    return;
  }

  if (nativeKeyboard) { return; }

  let binary: string | undefined;
  try {
    const assets = await ensureNativeAssets(extCtx, { keyboard: true, streaming: false });
    binary = assets.holdToTalkExe;
  } catch (err: any) {
    vscode.window.showErrorMessage(`Voice AI: failed to fetch hold-to-talk helper — ${err.message}`);
    return;
  }
  if (!binary) { return; }

  nativeKeyboard = new NativeKeyboard({
    binary,
    hotkey,
    onKeyDown: () => onHoldToTalkKeyDown(),
    onKeyUp: () => onHoldToTalkKeyUp(),
    onError: (err) => console.error('[VoiceAI hold-to-talk]', err),
  });
  extCtx.subscriptions.push(nativeKeyboard);

  try {
    await nativeKeyboard.start();
    await vscode.commands.executeCommand('setContext', 'localVoiceAIHoldToTalkActive', true);
    vscode.window.setStatusBarMessage(`Voice AI: hold-to-talk active (${hotkey})`, 3000);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Voice AI: hold-to-talk helper failed to start — ${err.message}`);
    nativeKeyboard.dispose();
    nativeKeyboard = undefined;
  }
}

function stopNativeKeyboard() {
  if (nativeKeyboard) {
    nativeKeyboard.dispose();
    nativeKeyboard = undefined;
  }
  void vscode.commands.executeCommand('setContext', 'localVoiceAIHoldToTalkActive', false);
}

async function onHoldToTalkKeyDown() {
  if (!voicePanel || !webviewReady) { await ensurePanel(); return; }
  const assets = await getAssets();
  if (!assets) { return; }
  if (!isRecording) {
    voicePanel!.webview.postMessage({ type: 'start' });
  }
}

function onHoldToTalkKeyUp() {
  if (voicePanel && webviewReady && isRecording) {
    voicePanel.webview.postMessage({ type: 'stop' });
  }
}

async function getNativeTranscriber(assets: WhisperAssets): Promise<NativeTranscriber | undefined> {
  const cfg = vscode.workspace.getConfiguration('localVoiceAI');
  if (!cfg.get<boolean>('useNativeEngine', false)) { return undefined; }
  if (!isNativeBindingSupported()) { return undefined; }
  if (nativeTranscriber) { return nativeTranscriber; }
  try {
    const native = await ensureNativeAssets(extCtx, { keyboard: false, streaming: true });
    if (!native.whisperNapiNode) { return undefined; }
    const binding = loadNativeBinding(native.whisperNapiNode);
    const language = cfg.get<string>('language') || 'en';
    const threads = cfg.get<number>('threads') || 4;
    nativeTranscriber = new NativeTranscriber(binding, assets.modelPath, language, threads);
    return nativeTranscriber;
  } catch (err: any) {
    vscode.window.showWarningMessage(
      `Voice AI: native engine unavailable — falling back to whisper-cli. (${err.message})`
    );
    return undefined;
  }
}

async function ensurePanel() {
  if (voicePanel) {
    voicePanel.reveal(vscode.ViewColumn.Beside, true);
    return;
  }

  voicePanel = vscode.window.createWebviewPanel(
    'localVoiceAI',
    'Voice AI Mic',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(extCtx.extensionPath, 'media'))],
    }
  );

  const htmlPath = path.join(extCtx.extensionPath, 'media', 'webview.html');
  voicePanel.webview.html = fs.readFileSync(htmlPath, 'utf8');

  voicePanel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'ready':
        webviewReady = true;
        sendConfigToWebview();
        vscode.window.setStatusBarMessage('Voice AI: mic ready', 2500);
        break;
      case 'started':
        isRecording = true;
        updateStatus(true);
        break;
      case 'chunk':
        await handleChunk(msg.data);
        break;
      case 'audio':
        isRecording = false;
        updateStatus(false);
        await handleFinalAudio(msg.data);
        break;
      case 'wake':
        if (!isRecording) {
          voicePanel?.webview.postMessage({ type: 'start' });
        }
        break;
      case 'error':
        isRecording = false;
        updateStatus(false);
        vscode.window.showErrorMessage(`Voice AI: ${msg.message}`);
        break;
      case 'log':
        console.log('[VoiceAI webview]', msg.message);
        break;
    }
  });

  voicePanel.onDidDispose(() => {
    const wasRecording = isRecording;
    voicePanel = undefined;
    webviewReady = false;
    isRecording = false;
    chunkInFlight = false;
    updateStatus(false);
    if (wasRecording) {
      vscode.window.showInformationMessage('Voice AI: recording canceled — mic panel was closed.');
    }
  });
}

function sendConfigToWebview() {
  if (!voicePanel) { return; }
  const cfg = vscode.workspace.getConfiguration('localVoiceAI');
  voicePanel.webview.postMessage({
    type: 'config',
    streamingPreview: cfg.get<boolean>('streamingPreview', true),
    streamingChunkSeconds: cfg.get<number>('streamingChunkSeconds', 3),
    autoStopOnSilence: cfg.get<boolean>('autoStopOnSilence', true),
    silenceThresholdDb: cfg.get<number>('silenceThresholdDb', -45),
    silenceDurationMs: cfg.get<number>('silenceDurationMs', 1200),
    wakeOnVoice: cfg.get<boolean>('wakeOnVoice', false),
    wakeThresholdDb: cfg.get<number>('wakeThresholdDb', -30),
    wakeDurationMs: cfg.get<number>('wakeDurationMs', 400),
    autoCalibrate: cfg.get<boolean>('autoCalibrate', true),
  });
}

function updateStatus(recording: boolean) {
  if (!statusItem) { return; }
  statusItem.text = recording ? '$(record) Recording…' : '$(mic) Voice AI';
  statusItem.backgroundColor = recording
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
}

async function handleChunk(base64Wav: string) {
  const ack = () => voicePanel?.webview.postMessage({ type: 'chunkAck' });
  if (!base64Wav || !cachedAssetsValue || chunkInFlight) { ack(); return; }
  chunkInFlight = true;
  try {
    const interim = await transcribeOnce(base64Wav, cachedAssetsValue);
    if (interim) {
      vscode.window.setStatusBarMessage(`Voice AI: ${shorten(interim, 80)}`, 4000);
    }
  } catch {
    // Chunk failures are non-fatal; final pass still runs on stop.
  } finally {
    chunkInFlight = false;
    ack();
  }
}

async function transcribeOnce(base64Wav: string, assets: WhisperAssets): Promise<string> {
  const native = await getNativeTranscriber(assets);
  if (native) {
    const pcm = wavBase64ToFloat32(base64Wav);
    if (pcm.length === 0) { return ''; }
    return native.transcribe(pcm);
  }
  return transcribeWav(base64Wav, transcribeOpts(assets));
}

function wavBase64ToFloat32(base64: string): Float32Array {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length <= 44) { return new Float32Array(0); }
  const data = buf.subarray(44);
  const count = Math.floor(data.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const s = data.readInt16LE(i * 2);
    out[i] = s / (s < 0 ? 0x8000 : 0x7fff);
  }
  return out;
}

async function handleFinalAudio(base64Wav: string) {
  if (!base64Wav) {
    vscode.window.setStatusBarMessage('Voice AI: (empty transcript)', 3000);
    return;
  }
  const assets = await getAssets();
  if (!assets) { return; }

  let transcript = '';
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Voice AI: transcribing…' },
      async () => { transcript = await transcribeOnce(base64Wav, assets); }
    );
  } catch (err: any) {
    vscode.window.showErrorMessage(`Voice AI: transcription failed — ${err.message}`);
    return;
  }

  if (!transcript) {
    vscode.window.setStatusBarMessage('Voice AI: (empty transcript)', 3000);
    return;
  }

  const voiceCommand = matchVoiceCommand(transcript);
  if (voiceCommand) {
    try {
      await executeVoiceCommand(voiceCommand);
      vscode.window.setStatusBarMessage(
        `Voice AI → command: ${voiceCommand.command}`,
        3000
      );
      await history.record({
        text: transcript,
        timestamp: Date.now(),
        delivered: 'command',
        commandId: voiceCommand.command,
      });
      return;
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Voice AI: command '${voiceCommand.command}' failed — ${err.message}`
      );
      return;
    }
  }

  const delivered = await deliverTranscript(transcript);
  await history.record({ text: transcript, timestamp: Date.now(), delivered });
}

async function deliverTranscript(transcript: string): Promise<'editor' | 'clipboard' | 'chat'> {
  const cfg = vscode.workspace.getConfiguration('localVoiceAI');
  const chatCmd = (cfg.get<string>('aiChatCommand') || '').trim();

  if (chatCmd) {
    await vscode.env.clipboard.writeText(transcript);
    const variants: Array<() => Thenable<unknown>> = [
      () => vscode.commands.executeCommand(chatCmd, transcript),
      () => vscode.commands.executeCommand(chatCmd, { query: transcript }),
      () => vscode.commands.executeCommand(chatCmd),
    ];
    let lastErr: any;
    for (const run of variants) {
      try { await run(); lastErr = undefined; break; }
      catch (err) { lastErr = err; }
    }
    if (lastErr) {
      vscode.window.showWarningMessage(
        `Voice AI: chat command "${chatCmd}" failed — transcript is on the clipboard. ` +
        `(${lastErr?.message ?? 'unknown error'})`
      );
      return 'clipboard';
    }
    vscode.window.setStatusBarMessage(
      `Voice AI → chat: "${shorten(transcript)}" (also on clipboard)`,
      4000
    );
    return 'chat';
  }

  const editor = vscode.window.activeTextEditor ?? lastEditor;
  if (editor) {
    await editor.edit((b) => b.insert(editor.selection.active, transcript));
    await vscode.window.showTextDocument(editor.document, editor.viewColumn, false);
    return 'editor';
  }

  await vscode.env.clipboard.writeText(transcript);
  vscode.window.showInformationMessage(
    `Voice AI: no active editor — copied to clipboard: "${shorten(transcript)}"`
  );
  return 'clipboard';
}

function transcribeOpts(assets: WhisperAssets) {
  const cfg = vscode.workspace.getConfiguration('localVoiceAI');
  return {
    binaryPath: assets.binaryPath,
    modelPath: assets.modelPath,
    language: cfg.get<string>('language') || 'en',
    threads: cfg.get<number>('threads') || 4,
  };
}

function shorten(s: string, n = 60) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export function deactivate() {
  if (voicePanel) { voicePanel.dispose(); }
}
