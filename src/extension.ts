import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ensureWhisperAssets, WhisperAssets } from './setup';
import { transcribeWav } from './transcribe';
import { matchVoiceCommand, executeVoiceCommand } from './commands';

let voicePanel: vscode.WebviewPanel | undefined;
let webviewReady = false;
let isRecording = false;
let statusItem: vscode.StatusBarItem;
let extCtx: vscode.ExtensionContext;
let lastEditor: vscode.TextEditor | undefined;
let cachedAssetsPromise: Promise<WhisperAssets | undefined> | undefined;
let cachedAssetsValue: WhisperAssets | undefined;
let chunkInFlight = false;

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
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localVoiceAI')) {
        sendConfigToWebview();
      }
    })
  );
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
    const interim = await transcribeWav(base64Wav, transcribeOpts(cachedAssetsValue));
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
      async () => { transcript = await transcribeWav(base64Wav, transcribeOpts(assets)); }
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
      return;
    } catch (err: any) {
      vscode.window.showErrorMessage(
        `Voice AI: command '${voiceCommand.command}' failed — ${err.message}`
      );
      return;
    }
  }

  await deliverTranscript(transcript);
}

async function deliverTranscript(transcript: string) {
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
    } else {
      vscode.window.setStatusBarMessage(
        `Voice AI → chat: "${shorten(transcript)}" (also on clipboard)`,
        4000
      );
    }
    return;
  }

  const editor = vscode.window.activeTextEditor ?? lastEditor;
  if (editor) {
    await editor.edit((b) => b.insert(editor.selection.active, transcript));
    await vscode.window.showTextDocument(editor.document, editor.viewColumn, false);
  } else {
    await vscode.env.clipboard.writeText(transcript);
    vscode.window.showInformationMessage(
      `Voice AI: no active editor — copied to clipboard: "${shorten(transcript)}"`
    );
  }
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
