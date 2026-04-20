import * as vscode from 'vscode';

export interface VoiceCommand {
  pattern: string;
  command: string;
  args?: any[];
}

export interface VoiceCommandMatch {
  command: string;
  args: any[];
  pattern: string;
}

const BUILT_IN_COMMANDS: VoiceCommand[] = [
  { pattern: '^new file$', command: 'workbench.action.files.newUntitledFile' },
  { pattern: '^save( file)?$', command: 'workbench.action.files.save' },
  { pattern: '^save all$', command: 'workbench.action.files.saveAll' },
  { pattern: '^open terminal$', command: 'workbench.action.terminal.new' },
  { pattern: '^close (tab|editor)$', command: 'workbench.action.closeActiveEditor' },
  { pattern: '^(run|start) tests?$', command: 'testing.runAll' },
  { pattern: '^stop tests?$', command: 'testing.cancelRun' },
  { pattern: '^find$', command: 'actions.find' },
  { pattern: '^replace$', command: 'editor.action.startFindReplaceAction' },
  { pattern: '^go to line (\\d+)$', command: 'revealLine', args: [{ lineNumber: '$1', at: 'top' }] },
  { pattern: '^format( document)?$', command: 'editor.action.formatDocument' },
  { pattern: '^comment( line)?$', command: 'editor.action.commentLine' },
  { pattern: '^undo$', command: 'undo' },
  { pattern: '^redo$', command: 'redo' },
  { pattern: '^split (editor|right)$', command: 'workbench.action.splitEditorRight' },
];

export function matchVoiceCommand(transcript: string): VoiceCommandMatch | undefined {
  const cfg = vscode.workspace.getConfiguration('localVoiceAI');
  if (!cfg.get<boolean>('voiceCommandsEnabled', true)) { return undefined; }

  const normalized = transcript.trim().replace(/[.!?,]+$/g, '').toLowerCase();
  if (!normalized) { return undefined; }

  const userCommands = cfg.get<VoiceCommand[]>('voiceCommands', []) || [];
  const all = [...userCommands, ...BUILT_IN_COMMANDS];

  for (const entry of all) {
    const re = safeRegex(entry.pattern);
    if (!re) { continue; }
    const m = normalized.match(re);
    if (!m) { continue; }
    const args = (entry.args ?? []).map((a) => substituteCaptures(a, m));
    return { command: entry.command, args, pattern: entry.pattern };
  }
  return undefined;
}

function safeRegex(pattern: string): RegExp | undefined {
  try { return new RegExp(pattern, 'i'); }
  catch { return undefined; }
}

function substituteCaptures(value: any, match: RegExpMatchArray): any {
  if (Array.isArray(value)) { return value.map((v) => substituteCaptures(v, match)); }
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) { out[k] = substituteCaptures(value[k], match); }
    return out;
  }
  if (typeof value !== 'string') { return value; }
  const m = value.match(/^\$(\d+)$/);
  if (m) {
    const captured = match[Number(m[1])];
    return captured !== undefined && /^\d+$/.test(captured) ? Number(captured) : captured;
  }
  return value.replace(/\$(\d+)/g, (_, i) => match[Number(i)] ?? '');
}

export async function executeVoiceCommand(m: VoiceCommandMatch): Promise<void> {
  await vscode.commands.executeCommand(m.command, ...m.args);
}
