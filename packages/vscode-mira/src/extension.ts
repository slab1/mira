import * as vscode from 'vscode';

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

async function miraFetch(context: vscode.ExtensionContext, path: string, init?: RequestInit): Promise<Response> {
  const base = getApiUrl()
  const token = await getToken(context)
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeaders(token), ...(init?.headers as Record<string, string> | undefined) },
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

function createChatWebview(context: vscode.ExtensionContext): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('miraChat', 'Mira Chat', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  })
  const apiUrl = getApiUrl()
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
  let sessionId = null;
  async function ensureSession(){
    if(sessionId) return sessionId;
    const res = await fetch('${apiUrl}/session', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({title:'VS Code Chat'})});
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
    const res = await fetch('${apiUrl}/session/' + id + '/prompt', {method:'POST', headers:{'Content-Type':'application/json', Accept:'text/event-stream'}, body: JSON.stringify({prompt: text})});
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
  fetch('${apiUrl}/health').then(r=>r.json()).then(h=> log.textContent += '\\n✓ ' + h.version + ' · ' + h.tools + ' tools').catch(()=> log.textContent += '\\n✗ cannot reach ' + '${apiUrl}');
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
    const title = await vscode.window.showInputBox({ prompt: 'Session title', value: 'VS Code Session' })
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
        sessions.map(s => ({ label: s.title || s.id.slice(0, 8), description: `${s.model} · ${new Date(s.updatedAt).toLocaleString()}`, id: s.id })),
        { placeHolder: 'Select Mira session' }
      )
      if (pick && typeof pick === 'object' && 'id' in pick) {
        const id = (pick as { id: string }).id
        vscode.window.showInformationMessage(`Selected ${id}`)
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Mira list failed: ${String(e)}`)
    }
  })

  const setTokenCmd = vscode.commands.registerCommand('mira.setToken', async () => {
    const token = await vscode.window.showInputBox({ prompt: 'Mira API token (Bearer, stored in SecretStorage)', password: true })
    if (token === undefined) return
    await context.secrets.store('mira.token', token)
    vscode.window.showInformationMessage(token ? 'Mira token saved' : 'Mira token cleared')
  })

  const termCmd = vscode.commands.registerCommand('mira.openTerminal', async () => {
    // PTY via VS Code Pseudoterminal → WS /terminal
    const writeEmitter = new vscode.EventEmitter<string>()
    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      open: () => {
        writeEmitter.fire('Mira terminal — connecting to /terminal …\r\n')
        // Minimal WS bridge — runs in extension host (Node has global WebSocket in VS Code 1.99+ via `ws` polyfill fallback)
        try {
          const base = getApiUrl()
          const url = base.replace(/^http/, 'ws') + '/terminal'
          getToken(context).then(token => {
            const ws = new WebSocket(url)
            let authSent = false
            const toWs = (data: string) => {
              if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'terminal.input', data }))
            }
            ws.onopen = () => {
              if (token) ws.send(JSON.stringify({ type: 'auth', token }))
              authSent = true
              writeEmitter.fire('● connected\r\n')
            }
            ws.onmessage = (ev: MessageEvent) => {
              try {
                const m = JSON.parse(String(ev.data)) as { type: string; payload?: Record<string, JsonValue> }
                if (m.type === 'terminal.output') writeEmitter.fire(String(m.payload?.data ?? ''))
                else if (m.type === 'terminal.exit') writeEmitter.fire(`\r\n[exit ${String(m.payload?.code ?? '')}]\r\n`)
              } catch {}
            }
            ws.onclose = () => writeEmitter.fire('\r\n[closed]\r\n')
            ws.onerror = () => writeEmitter.fire('\r\n[error]\r\n')
            pty.handleInput = (data: string) => {
              if (!authSent && token) { try { ws.send(JSON.stringify({ type: 'auth', token })); authSent = true } catch {} }
              toWs(data)
            }
          })
        } catch (e) {
          writeEmitter.fire(`\r\n[failed: ${String(e)}]\r\n`)
        }
      },
      close: () => {},
      handleInput: () => {},
    }
    const term = vscode.window.createTerminal({ name: 'Mira PTY', pty })
    term.show()
  })

  // Also expose a Chat webview
  const chatCmd = vscode.commands.registerCommand('mira.openChat', () => {
    createChatWebview(context)
  })

  context.subscriptions.push(hello, openWeb, createSessCmd, listSessCmd, setTokenCmd, termCmd, chatCmd)

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
