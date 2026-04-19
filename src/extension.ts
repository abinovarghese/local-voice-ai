import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let voicePanel: vscode.WebviewPanel | undefined;
let webviewReady = false;
let isRecording = false;
let statusItem: vscode.StatusBarItem;
let extCtx: vscode.ExtensionContext;
let lastEditor: vscode.TextEditor | undefined;

export function activate(context: vscode.ExtensionContext) {
  extCtx = context;

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.text = '$(mic) Voice AI';
  statusItem.tooltip = 'Toggle Voice AI dictation (Ctrl+Shift+Space)';
  statusItem.command = 'localVoiceAI.toggleDictation';
  statusItem.show();
  context.subscriptions.push(statusItem);

  // Remember the last real text editor, because when the webview is focused
  // activeTextEditor becomes undefined.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) { lastEditor = ed; }
    })
  );
  lastEditor = vscode.window.activeTextEditor;

  context.subscriptions.push(
    vscode.commands.registerCommand('localVoiceAI.toggleDictation', toggleDictation),
    vscode.commands.registerCommand('localVoiceAI.openMic', () => ensurePanel())
  );
}

async function toggleDictation() {
  if (!voicePanel || !webviewReady) {
    ensurePanel();
    vscode.window.showInformationMessage(
      'Voice AI: grant microphone access in the side panel, then press Ctrl+Shift+Space again to record.'
    );
    return;
  }
  if (isRecording) {
    voicePanel.webview.postMessage({ type: 'stop' });
  } else {
    voicePanel.webview.postMessage({ type: 'start' });
  }
}

function ensurePanel() {
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
      localResourceRoots: [vscode.Uri.file(path.join(extCtx.extensionPath, 'media'))]
    }
  );

  const htmlPath = path.join(extCtx.extensionPath, 'media', 'webview.html');
  voicePanel.webview.html = fs.readFileSync(htmlPath, 'utf8');

  voicePanel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'ready':
        webviewReady = true;
        vscode.window.setStatusBarMessage('Voice AI: mic ready', 2500);
        break;
      case 'started':
        isRecording = true;
        updateStatus(true);
        break;
      case 'audio':
        isRecording = false;
        updateStatus(false);
        await transcribeAndDeliver(msg.data);
        break;
      case 'error':
        isRecording = false;
        updateStatus(false);
        vscode.window.showErrorMessage(`Voice AI: ${msg.message}`);
        break;
      case 'log':
        // Useful when debugging the webview
        console.log('[VoiceAI webview]', msg.message);
        break;
    }
  });

  voicePanel.onDidDispose(() => {
    voicePanel = undefined;
    webviewReady = false;
    isRecording = false;
    updateStatus(false);
  });
}

function updateStatus(recording: boolean) {
  if (!statusItem) { return; }
  statusItem.text = recording ? '$(record) Recording…' : '$(mic) Voice AI';
  statusItem.backgroundColor = recording
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined;
}

async function transcribeAndDeliver(base64Wav: string) {
  const cfg = vscode.workspace.getConfiguration('localVoiceAI');
  const binPath = (cfg.get<string>('whisperBinaryPath') || '').trim();
  const modelPath = (cfg.get<string>('whisperModelPath') || '').trim();
  const lang = cfg.get<string>('language') || 'en';
  const threads = cfg.get<number>('threads') || 4;
  const chatCmd = (cfg.get<string>('aiChatCommand') || '').trim();

  if (!binPath || !modelPath) {
    vscode.window.showErrorMessage(
      'Voice AI: set localVoiceAI.whisperBinaryPath and localVoiceAI.whisperModelPath in Settings.'
    );
    return;
  }
  if (!fs.existsSync(binPath)) {
    vscode.window.showErrorMessage(`Voice AI: whisper binary not found at ${binPath}`);
    return;
  }
  if (!fs.existsSync(modelPath)) {
    vscode.window.showErrorMessage(`Voice AI: whisper model not found at ${modelPath}`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceai-'));
  const wavPath = path.join(tmpDir, 'clip.wav');
  const outBase = path.join(tmpDir, 'out');

  try {
    fs.writeFileSync(wavPath, Buffer.from(base64Wav, 'base64'));
  } catch (err: any) {
    vscode.window.showErrorMessage(`Voice AI: failed to write audio: ${err.message}`);
    return;
  }

  let transcript = '';
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Voice AI: transcribing…' },
      () => runWhisper(binPath, modelPath, wavPath, outBase, lang, threads)
    );
    const txtPath = outBase + '.txt';
    if (fs.existsSync(txtPath)) {
      transcript = fs.readFileSync(txtPath, 'utf8').trim();
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`Voice AI: transcription failed — ${err.message}`);
    return;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (!transcript) {
    vscode.window.setStatusBarMessage('Voice AI: (empty transcript)', 3000);
    return;
  }

  if (chatCmd) {
    // Copy to clipboard as a universal fallback, then try the configured command.
    await vscode.env.clipboard.writeText(transcript);
    try {
      await vscode.commands.executeCommand(chatCmd, transcript);
    } catch {
      try {
        await vscode.commands.executeCommand(chatCmd, { query: transcript });
      } catch {
        try { await vscode.commands.executeCommand(chatCmd); } catch { /* ignore */ }
      }
    }
    vscode.window.setStatusBarMessage(
      `Voice AI → chat: "${shorten(transcript)}" (also on clipboard)`,
      4000
    );
  } else {
    const editor = vscode.window.activeTextEditor ?? lastEditor;
    if (editor) {
      await editor.edit((b) => b.insert(editor.selection.active, transcript));
      // Pop focus back to the editor so typing continues naturally.
      await vscode.window.showTextDocument(editor.document, editor.viewColumn, false);
    } else {
      await vscode.env.clipboard.writeText(transcript);
      vscode.window.showInformationMessage(
        `Voice AI: no active editor — copied to clipboard: "${shorten(transcript)}"`
      );
    }
  }
}

function shorten(s: string, n = 60) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function runWhisper(
  bin: string,
  model: string,
  wav: string,
  outBase: string,
  lang: string,
  threads: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', model,
      '-f', wav,
      '-otxt',
      '-of', outBase,
      '-l', lang,
      '-t', String(threads),
      '-nt'
    ];
    const proc = cp.spawn(bin, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`whisper exited ${code}. ${stderr.slice(-400)}`)); }
    });
  });
}

export function deactivate() {
  if (voicePanel) { voicePanel.dispose(); }
}
