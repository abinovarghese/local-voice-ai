import * as os from 'os';

export type Platform = 'win' | 'mac' | 'linux';

export function currentPlatform(): Platform {
  switch (process.platform) {
    case 'win32': return 'win';
    case 'darwin': return 'mac';
    default: return 'linux';
  }
}

export function whisperBinaryName(): string {
  return currentPlatform() === 'win' ? 'whisper-cli.exe' : 'whisper-cli';
}

export function windowsReleaseAssetUrl(): string {
  // whisper.cpp publishes a prebuilt Windows x64 binary in every release.
  return 'https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-bin-x64.zip';
}

export function defaultModelUrl(): string {
  // base.en quantized — ~60 MB, good balance of size and accuracy for dictation.
  return 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin';
}

export function defaultModelFilename(): string {
  return 'ggml-base.en-q5_1.bin';
}

export function manualInstallInstructionsUrl(): string {
  return 'https://github.com/ggerganov/whisper.cpp#quick-start';
}

export function installHint(): string {
  switch (currentPlatform()) {
    case 'mac':
      return 'Install whisper.cpp with: brew install whisper-cpp';
    case 'linux':
      return 'Build whisper.cpp from source, or install via your package manager, then ensure whisper-cli is on your PATH.';
    case 'win':
      return 'Let the extension auto-download the Windows build, or grab whisper-bin-x64.zip from the whisper.cpp releases page.';
  }
}

export function homeDir(): string {
  return os.homedir();
}
