import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface TranscribeOptions {
  binaryPath: string;
  modelPath: string;
  language: string;
  threads: number;
}

export async function transcribeWav(
  base64Wav: string,
  opts: TranscribeOptions
): Promise<string> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'voiceai-'));
  const wavPath = path.join(tmpDir, 'clip.wav');
  const outBase = path.join(tmpDir, 'out');

  try {
    await fs.promises.writeFile(wavPath, Buffer.from(base64Wav, 'base64'));
    await runWhisper(wavPath, outBase, opts);
    const txt = outBase + '.txt';
    if (!fs.existsSync(txt)) { return ''; }
    return (await fs.promises.readFile(txt, 'utf8')).trim();
  } finally {
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function runWhisper(wavPath: string, outBase: string, opts: TranscribeOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', opts.modelPath,
      '-f', wavPath,
      '-otxt',
      '-of', outBase,
      '-l', opts.language,
      '-t', String(opts.threads),
      '-nt',
    ];
    const proc = cp.spawn(opts.binaryPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) { resolve(); }
      else { reject(new Error(`whisper exited ${code}. ${stderr.slice(-400)}`)); }
    });
  });
}
