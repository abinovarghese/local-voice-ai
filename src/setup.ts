import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import {
  currentPlatform,
  whisperBinaryName,
  windowsReleaseAssetUrl,
  defaultModelUrl,
  defaultModelFilename,
  manualInstallInstructionsUrl,
  installHint,
} from './platform';

export interface WhisperAssets {
  binaryPath: string;
  modelPath: string;
}

export async function ensureWhisperAssets(
  context: vscode.ExtensionContext
): Promise<WhisperAssets | undefined> {
  const cfg = vscode.workspace.getConfiguration('localVoiceAI');
  const configuredBin = (cfg.get<string>('whisperBinaryPath') || '').trim();
  const configuredModel = (cfg.get<string>('whisperModelPath') || '').trim();

  const storageDir = context.globalStorageUri.fsPath;
  await fs.promises.mkdir(storageDir, { recursive: true });

  const binaryPath = await resolveBinary(configuredBin, storageDir);
  if (!binaryPath) { return undefined; }

  const modelPath = await resolveModel(configuredModel, storageDir);
  if (!modelPath) { return undefined; }

  return { binaryPath, modelPath };
}

async function resolveBinary(configured: string, storageDir: string): Promise<string | undefined> {
  if (configured && fs.existsSync(configured)) { return configured; }

  const cached = path.join(storageDir, whisperBinaryName());
  if (fs.existsSync(cached)) { return cached; }

  const onPath = findOnPath(whisperBinaryName());
  if (onPath) { return onPath; }

  if (currentPlatform() === 'win') {
    const choice = await vscode.window.showInformationMessage(
      'Voice AI needs whisper.cpp. Download the Windows build automatically (~10 MB)?',
      { modal: false },
      'Download',
      'Show instructions'
    );
    if (choice === 'Download') {
      try {
        return await downloadWindowsBinary(storageDir);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Voice AI: auto-download failed — ${err.message}`);
        return undefined;
      }
    }
    if (choice === 'Show instructions') {
      vscode.env.openExternal(vscode.Uri.parse(manualInstallInstructionsUrl()));
    }
    return undefined;
  }

  const choice = await vscode.window.showInformationMessage(
    `Voice AI can't find whisper-cli. ${installHint()}`,
    'Open instructions'
  );
  if (choice === 'Open instructions') {
    vscode.env.openExternal(vscode.Uri.parse(manualInstallInstructionsUrl()));
  }
  return undefined;
}

async function resolveModel(configured: string, storageDir: string): Promise<string | undefined> {
  if (configured && fs.existsSync(configured)) { return configured; }

  const cached = path.join(storageDir, defaultModelFilename());
  if (fs.existsSync(cached)) { return cached; }

  const choice = await vscode.window.showInformationMessage(
    `Voice AI needs a Whisper model. Download ${defaultModelFilename()} (~60 MB) now?`,
    { modal: false },
    'Download',
    'Pick existing file'
  );
  if (choice === 'Pick existing file') {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'ggml model': ['bin'] },
      openLabel: 'Use this model',
    });
    return picked?.[0]?.fsPath;
  }
  if (choice !== 'Download') { return undefined; }

  try {
    return await downloadWithProgress(defaultModelUrl(), cached, 'Downloading Whisper model');
  } catch (err: any) {
    vscode.window.showErrorMessage(`Voice AI: model download failed — ${err.message}`);
    return undefined;
  }
}

async function downloadWindowsBinary(storageDir: string): Promise<string> {
  const zipPath = path.join(storageDir, 'whisper-bin-x64.zip');
  await downloadWithProgress(windowsReleaseAssetUrl(), zipPath, 'Downloading whisper.cpp');

  // Win10 1803+ ships tar with zip support.
  await new Promise<void>((resolve, reject) => {
    const proc = cp.spawn('tar', ['-xf', zipPath, '-C', storageDir], { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`tar exited ${code}: ${stderr.slice(-400)}`)); }
    });
  });

  const candidates = [
    path.join(storageDir, 'whisper-cli.exe'),
    path.join(storageDir, 'Release', 'whisper-cli.exe'),
    path.join(storageDir, 'main.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { return c; }
  }
  throw new Error('Extracted archive but could not find whisper-cli.exe');
}

async function downloadWithProgress(url: string, destPath: string, title: string): Promise<string> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (progress, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} from ${url}`);
      }
      const total = Number(res.headers.get('content-length') || 0);
      const tmp = destPath + '.partial';
      const out = fs.createWriteStream(tmp);
      let received = 0;
      let lastPct = 0;
      const reader = (res.body as any).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        out.write(Buffer.from(value));
        received += value.length;
        if (total > 0) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct) {
            progress.report({ increment: pct - lastPct, message: `${pct}%` });
            lastPct = pct;
          }
        }
      }
      await new Promise<void>((r) => out.end(r));
      await fs.promises.rename(tmp, destPath);
      return destPath;
    }
  );
}

function findOnPath(binary: string): string | undefined {
  const which = currentPlatform() === 'win' ? 'where' : 'which';
  try {
    const out = cp.spawnSync(which, [binary], { encoding: 'utf8' });
    if (out.status === 0) {
      const first = out.stdout.split(/\r?\n/)[0].trim();
      if (first && fs.existsSync(first)) { return first; }
    }
  } catch { /* ignore */ }
  return undefined;
}
