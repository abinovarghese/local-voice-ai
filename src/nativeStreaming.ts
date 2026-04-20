import * as fs from 'fs';

interface WhisperBindingCtor {
  new (modelPath: string, language: string, threads: number): WhisperBindingInstance;
}

interface WhisperBindingInstance {
  transcribe(pcm: Buffer): string;
}

interface BindingModule {
  WhisperBinding: WhisperBindingCtor;
}

let cachedModule: BindingModule | undefined;
let cachedModulePath: string | undefined;

export function loadNativeBinding(modulePath: string): BindingModule {
  if (cachedModule && cachedModulePath === modulePath) { return cachedModule; }
  if (!fs.existsSync(modulePath)) {
    throw new Error(`native addon not found at ${modulePath}`);
  }
  // `require` is resolved at runtime by VS Code's Node host — the module is a
  // prebuilt .node file we downloaded. TypeScript doesn't know the shape, so
  // we trust the BindingModule interface above.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  cachedModule = require(modulePath) as BindingModule;
  cachedModulePath = modulePath;
  return cachedModule;
}

export function isNativeBindingSupported(): boolean {
  return process.platform === 'win32' && process.arch === 'x64';
}

export class NativeTranscriber {
  private instance: WhisperBindingInstance;

  constructor(binding: BindingModule, modelPath: string, language: string, threads: number) {
    this.instance = new binding.WhisperBinding(modelPath, language, Math.max(1, threads));
  }

  transcribe(pcm: Float32Array): string {
    // Node addons receive the Float32Array as a Buffer view over the same
    // memory. Convert explicitly via Buffer.from to satisfy N-API copy
    // semantics on all platforms.
    const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    return this.instance.transcribe(buf);
  }
}
