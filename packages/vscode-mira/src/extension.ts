import * as vscode from 'vscode'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

type Session = {
  id: string
  title: string
  model: string
  provider: string
  createdAt: number
  updatedAt: number
}

function getApiUrl(): string {
  const cfg = vscode.workspace.getConfiguration('mira')
  const url = cfg.get<string>('mira.apiUrl') ?? cfg.get<string>('apiUrl') ?? 'http://127.0.0.1:4096'
  return String(url).replace(/\/$/, '')
}

async function getToken(context: vscode.ExtensionContext): Promise<string> {
  const stored = await context.secrets.get('mira.token')
  if (stored) return stored
  const cfg = vscode.workspace.getConfiguration('mira')
  const cfgToken = cfg.get<string>('mira.token') ?? cfg.get<string>('token') ?? ''
  return String(cfgToken ?? '')
}

function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function miraFetch(
  context: vscode.ExtensionContext,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = getApiUrl()
  const token = await getToken(context)
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(token),
      ...(init?.headers as Record<string, string> | undefined),
    },
  })
  if (res.status === 401) {
    vscode.window.showWarningMessage('Mira: unauthorized — run "Mira: Set API Token"')
  }
  return res
}

async function listSessions(context: vscode.ExtensionContext): Promise<Session[]> {
  const res = await miraFetch(context, '/session')
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as Session[]
}

async function createSession(context: vscode.ExtensionContext, title?: string): Promise<Session> {
  const cfg = vscode.workspace.getConfiguration('mira')
  const model = cfg.get<string>('mira.model') ?? 'openrouter/anthropic/claude-sonnet-4'
  const res = await miraFetch(context, '/session', {
    method: 'POST',
    body: JSON.stringify({ title: title ?? 'VS Code Session', model }),
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`)
  return (await res.json()) as Session
}

async function createChatWebview(
  context: vscode.ExtensionContext,
  opts: { sessionID?: string; title?: string } = {},
): Promise<vscode.WebviewPanel> {
  const panelTitle = opts.sessionID
    ? `Mira Chat — ${opts.title ?? opts.sessionID.slice(0, 8)}`
    : 'Mira Chat'
  const panel = vscode.window.createWebviewPanel('miraChat', panelTitle, vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  })
  const apiUrl = getApiUrl()
  const token = await getToken(context)
  const tokenJson = JSON.stringify(token)
  const sessionIdJson = JSON.stringify(opts.sessionID ?? null)
  panel.webview.html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:var(--vscode-font-family);background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);margin:0;padding:12px}
  #log{white-space:pre-wrap;font-family:var(--vscode-editor-font-family);font-size:13px;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px;min-height:300px;overflow:auto}
  #input{width:100%;box-sizing:border-box;margin-top:8px;padding:8px;border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground)}
  button{margin-top:8px;padding:6px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px;cursor:pointer}
  .hint{opacity:0.7;font-size:11px;margin-top:6px}
</style></head>
<body>
  <div style="font-weight:700;margin-bottom:6px">Mira — ${apiUrl}</div>
  <div id="log">Connecting to ${apiUrl}/session …</div>
  <textarea id="input" rows="3" placeholder="Ask Mira… (Enter to send, Shift+Enter for newline)"></textarea><br>
  <button id="send">Send</button>
  <div class="hint">Uses <code>mira.apiUrl</code> + secret <code>mira.token</code>. Streaming via SSE <code>POST /session/:id/prompt</code>.</div>
<script>
  const vscodeApi = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  let sessionId = ${sessionIdJson};
  const token = ${tokenJson};
  const authHeaders = token ? {Authorization: 'Bearer ' + token} : {};
  if (sessionId) log.textContent += '\\n● resuming session ' + sessionId;
  async function ensureSession(){
    if(sessionId) return sessionId;
    const res = await fetch('${apiUrl}/session', {method:'POST', headers:{'Content-Type':'application/json', ...authHeaders}, body: JSON.stringify({title:'VS Code Chat'})});
    const s = await res.json();
    sessionId = s.id;
    log.textContent += '\\n● session ' + s.id + ' (' + s.model + ')';
    return sessionId;
  }
  async function send(){
    const text = input.value.trim();
    if(!text) return;
    input.value = '';
    log.textContent += '\\n\\n▶ ' + text + '\\n';
    const id = await ensureSession();
    const res = await fetch('${apiUrl}/session/' + id + '/prompt', {method:'POST', headers:{'Content-Type':'application/json', Accept:'text/event-stream', ...authHeaders}, body: JSON.stringify({prompt: text})});
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while(true){
      const {done, value} = await reader.read();
      if(done) break;
      buf += decoder.decode(value, {stream:true});
      const frames = buf.split('\\n\\n');
      buf = frames.pop() || '';
      for(const f of frames){
        const m = f.match(/data:\\s*(.*)/);
        if(!m) continue;
        try{
          const j = JSON.parse(m[1]);
          const d = j.textDelta || j.text || j.content || '';
          if(d) log.textContent += d;
        }catch{ log.textContent += m[1]; }
      }
      log.scrollTop = log.scrollHeight;
    }
  }
  sendBtn.onclick = send;
  input.onkeydown = (e)=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); } };
  // initial
  fetch('${apiUrl}/health', {headers: authHeaders}).then(r=>r.json()).then(h=> log.textContent += '\\n✓ ' + h.version + ' · ' + h.tools + ' tools').catch(()=> log.textContent += '\\n✗ cannot reach ' + '${apiUrl}');
</script>
</body></html>`
  return panel
}

export function activate(context: vscode.ExtensionContext) {
  const hello = vscode.commands.registerCommand('mira.hello', () => {
    vscode.window.showInformationMessage('Mira: agent platform — try "Mira: Create Session"')
  })

  const openWeb = vscode.commands.registerCommand('mira.openWeb', () => {
    const cfgUrl = getApiUrl().replace(':4096', ':5173')
    vscode.env.openExternal(vscode.Uri.parse(cfgUrl))
  })

  const createSessCmd = vscode.commands.registerCommand('mira.createSession', async () => {
    const title = await vscode.window.showInputBox({
      prompt: 'Session title',
      value: 'VS Code Session',
    })
    if (title === undefined) return
    try {
      const s = await createSession(context, title)
      vscode.window.showInformationMessage(`Mira session ${s.id} (${s.model})`)
    } catch (e) {
      vscode.window.showErrorMessage(`Mira create failed: ${String(e)}`)
    }
  })

  const listSessCmd = vscode.commands.registerCommand('mira.listSessions', async () => {
    try {
      const sessions = await listSessions(context)
      const pick = await vscode.window.showQuickPick(
        sessions.map((s) => ({
          label: s.title || s.id.slice(0, 8),
          description: `${s.model} · ${new Date(s.updatedAt).toLocaleString()}`,
          id: s.id,
        })),
        { placeHolder: 'Select Mira session' },
      )
      if (pick && typeof pick === 'object' && 'id' in pick) {
        const id = (pick as { id: string }).id
        const title = sessions.find((s) => s.id === id)?.title
        await createChatWebview(context, { sessionID: id, title })
        vscode.window.showInformationMessage(`Opened session ${id.slice(0, 8)}`)
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Mira list failed: ${String(e)}`)
    }
  })

  const setTokenCmd = vscode.commands.registerCommand('mira.setToken', async () => {
    const token = await vscode.window.showInputBox({
      prompt: 'Mira API token (Bearer, stored in SecretStorage)',
      password: true,
    })
    if (token === undefined) return
    await context.secrets.store('mira.token', token)
    vscode.window.showInformationMessage(token ? 'Mira token saved' : 'Mira token cleared')
  })

  const termCmd = vscode.commands.registerCommand('mira.openTerminal', async () => {
    // PTY via VS Code Pseudoterminal → WS /terminal
    const writeEmitter = new vscode.EventEmitter<string>()
    let ws: WebSocket | null = null
    let authed = false
    const buffer: string[] = []
    const sendToWs = (data: string) => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'terminal.input', data }))
      else buffer.push(data)
    }
    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      open: () => {
        writeEmitter.fire('Mira terminal — connecting to /terminal …\r\n')
        // Minimal WS bridge — runs in extension host (Node has global WebSocket in VS Code 1.99+ via `ws` polyfill fallback)
        const base = getApiUrl()
        const url = base.replace(/^http/, 'ws') + '/terminal'
        getToken(context)
          .then((token) => {
            ws = new WebSocket(url)
            ws.onopen = () => {
              if (token) ws?.send(JSON.stringify({ type: 'auth', token }))
              authed = true
              writeEmitter.fire('● connected\r\n')
              // Flush input typed before the socket was ready
              for (const d of buffer.splice(0)) sendToWs(d)
            }
            ws.onmessage = (ev: MessageEvent) => {
              try {
                const m = JSON.parse(String(ev.data)) as {
                  type: string
                  payload?: Record<string, JsonValue>
                }
                if (m.type === 'terminal.output') writeEmitter.fire(String(m.payload?.data ?? ''))
                else if (m.type === 'terminal.exit') {
                  writeEmitter.fire(`\r\n[exit ${String(m.payload?.code ?? '')}]\r\n`)
                  try {
                    ws?.close(1000, 'terminal exit')
                  } catch {}
                  ws = null
                }
              } catch {}
            }
            ws.onclose = () => writeEmitter.fire('\r\n[closed]\r\n')
            ws.onerror = () => writeEmitter.fire('\r\n[error]\r\n')
          })
          .catch((e) => writeEmitter.fire(`\r\n[failed: ${String(e)}]\r\n`))
      },
      close: () => {
        // Terminal closed by user — tear down the WS cleanly
        try {
          if (ws && ws.readyState <= 1) ws.close(1000, 'terminal closed by user')
        } catch {}
        ws = null
      },
      handleInput: (data: string) => {
        if (!authed) {
          // Socket not ready yet — buffer the input
          buffer.push(data)
          return
        }
        sendToWs(data)
      },
    }
    const term = vscode.window.createTerminal({ name: 'Mira PTY', pty })
    term.show()
  })

  // Also expose a Chat webview
  const chatCmd = vscode.commands.registerCommand('mira.openChat', async () => {
    await createChatWebview(context)
  })

  context.subscriptions.push(
    hello,
    openWeb,
    createSessCmd,
    listSessCmd,
    setTokenCmd,
    termCmd,
    chatCmd,
  )

  // Inline autocomplete (Kilo K4) — ghost-text via POST /complete
  let autocompleteEnabled =
    vscode.workspace.getConfiguration('mira').get<boolean>('autocomplete') ?? true
  const toggleAutocomplete = vscode.commands.registerCommand(
    'mira.toggleAutocomplete',
    async () => {
      autocompleteEnabled = !autocompleteEnabled
      await vscode.workspace
        .getConfiguration('mira')
        .update('autocomplete', autocompleteEnabled, vscode.ConfigurationTarget.Global)
      vscode.window.showInformationMessage(
        `Mira autocomplete ${autocompleteEnabled ? 'enabled' : 'disabled'}`,
      )
    },
  )
  context.subscriptions.push(toggleAutocomplete)
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('mira.autocomplete')) {
      autocompleteEnabled =
        vscode.workspace.getConfiguration('mira').get<boolean>('autocomplete') ?? true
    }
  })

  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position,
      inlineContext: vscode.InlineCompletionContext,
      token: vscode.CancellationToken,
    ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[]> {
      if (!autocompleteEnabled) return []
      if (token.isCancellationRequested) return []
      // Skip if triggered by explicit request and empty prefix
      const linePrefix = document.lineAt(position.line).text.slice(0, position.character)
      if (
        linePrefix.trim().length === 0 &&
        inlineContext.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
      )
        return []

      const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position))
      const suffix = document.getText(
        new vscode.Range(position, new vscode.Position(document.lineCount, 0)),
      )
      // Truncate to last 2000 chars of prefix and first 1000 of suffix (server also truncates)
      const truncatedPrefix = prefix.slice(-2000)
      const truncatedSuffix = suffix.slice(0, 1000)
      const cfg = vscode.workspace.getConfiguration('mira')
      const model = cfg.get<string>('autocompleteModel') || undefined
      try {
        const res = await miraFetch(context, '/complete', {
          method: 'POST',
          body: JSON.stringify({
            prefix: truncatedPrefix,
            suffix: truncatedSuffix,
            file: document.fileName,
            ...(model ? { model } : {}),
          }),
        })
        if (!res.ok) return []
        const data = (await res.json()) as { text?: string }
        const text = String(data.text ?? '').trim()
        if (!text) return []
        // Return as inline completion — no full-file replacement, just insertion at cursor
        return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))]
      } catch {
        return []
      }
    },
  }
  const selector: vscode.DocumentSelector = [{ pattern: '**' }]
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(selector, provider),
  )

  // Status bar
  const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  sb.text = '$(hubot) Mira'
  sb.tooltip = getApiUrl()
  sb.command = 'mira.hello'
  sb.show()
  context.subscriptions.push(sb)

  // status bar already wired
}

export function deactivate() {}
