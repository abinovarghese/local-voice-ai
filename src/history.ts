import * as vscode from 'vscode';

export interface TranscriptEntry {
  text: string;
  timestamp: number;
  delivered: 'editor' | 'clipboard' | 'chat' | 'command';
  commandId?: string;
}

const STATE_KEY = 'localVoiceAI.history';
const MAX_ENTRIES = 50;

export class TranscriptHistory {
  constructor(private ctx: vscode.ExtensionContext) {}

  all(): TranscriptEntry[] {
    return this.ctx.globalState.get<TranscriptEntry[]>(STATE_KEY, []);
  }

  async record(entry: TranscriptEntry): Promise<void> {
    const trimmed = entry.text.trim();
    if (!trimmed) { return; }
    const next = [{ ...entry, text: trimmed }, ...this.all()].slice(0, MAX_ENTRIES);
    await this.ctx.globalState.update(STATE_KEY, next);
  }

  async clear(): Promise<void> {
    await this.ctx.globalState.update(STATE_KEY, []);
  }
}

export function renderHistoryHtml(entries: TranscriptEntry[]): string {
  const rows = entries.length === 0
    ? `<p class="empty">No transcripts yet. Start dictating to fill this up.</p>`
    : entries.map((e) => {
        const when = new Date(e.timestamp).toLocaleString();
        const tag = e.delivered === 'command' ? `→ ${escapeHtml(e.commandId || '')}` : `→ ${e.delivered}`;
        return `<article>
          <header><time>${escapeHtml(when)}</time><span class="tag">${escapeHtml(tag)}</span></header>
          <pre>${escapeHtml(e.text)}</pre>
        </article>`;
      }).join('\n');

  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';" />
<title>Voice AI History</title>
<style>
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 1rem; font-size: 13px; }
  h3 { margin-top: 0; }
  article { border-bottom: 1px solid var(--vscode-panel-border, #444); padding: .6rem 0; }
  header { display: flex; justify-content: space-between; font-size: .85em; opacity: .75; margin-bottom: .3rem; }
  .tag { font-family: var(--vscode-editor-font-family, monospace); }
  pre { margin: 0; white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; }
  .empty { opacity: .7; }
  button { padding: .4rem .8rem; font-size: .9rem; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid transparent; }
  .actions { margin-bottom: 1rem; display: flex; gap: .5rem; }
</style></head>
<body>
<h3>Voice AI — transcript history</h3>
<div class="actions">
  <button id="clear">Clear history</button>
  <span style="opacity:.6;align-self:center;font-size:.85em;">Stored locally in VS Code global state.</span>
</div>
${rows}
<script>
  const vscode = acquireVsCodeApi();
  document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}
