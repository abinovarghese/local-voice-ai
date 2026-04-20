export interface ModelChoice {
  id: string;
  label: string;
  filename: string;
  url: string;
  approxMB: number;
  description: string;
}

export const MODEL_CHOICES: ModelChoice[] = [
  {
    id: 'tiny.en',
    label: 'Tiny (English, ~40 MB)',
    filename: 'ggml-tiny.en-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin',
    approxMB: 40,
    description: 'Fastest. Decent for dictation in a quiet room; struggles with accents or noise.',
  },
  {
    id: 'base.en',
    label: 'Base (English, ~60 MB) — default',
    filename: 'ggml-base.en-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin',
    approxMB: 60,
    description: 'Balanced. Recommended default for dictation.',
  },
  {
    id: 'small.en',
    label: 'Small (English, ~250 MB)',
    filename: 'ggml-small.en-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin',
    approxMB: 250,
    description: 'Higher accuracy; slower transcription. Worth it if base keeps mis-hearing names or jargon.',
  },
  {
    id: 'base',
    label: 'Base (multilingual, ~145 MB)',
    filename: 'ggml-base-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
    approxMB: 145,
    description: 'Multilingual — use with `localVoiceAI.language: "auto"` or a non-English code.',
  },
];

export function findModelByFilename(filename: string): ModelChoice | undefined {
  return MODEL_CHOICES.find((m) => m.filename === filename);
}
