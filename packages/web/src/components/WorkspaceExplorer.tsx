import {
  createSignal,
  createMemo,
  createEffect,
  onMount,
  Show,
  For,
  untrack,
} from 'solid-js'
import { api } from '../api/client'
import { toast } from './Toast'

export interface WorkspaceTreeEntry {
  path: string
  isDir: boolean
  size: number
  mtime: number
}

interface TreeNode {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
  children: TreeNode[]
}

function buildTree(entries: WorkspaceTreeEntry[]): TreeNode[] {
  const rootMap = new Map<string, TreeNode>()
  const childrenMap = new Map<string, Map<string, TreeNode>>()

  const ensureDir = (dirPath: string): TreeNode => {
    const existing = rootMap.get(dirPath)
    if (existing) return existing
    const parts = dirPath.split('/').filter(Boolean)
    const name = parts[parts.length - 1] ?? dirPath
    const node: TreeNode = {
      name,
      path: dirPath,
      isDir: true,
      size: 0,
      mtime: 0,
      children: [],
    }
    rootMap.set(dirPath, node)
    if (parts.length > 1) {
      const parentPath = parts.slice(0, -1).join('/')
      const parent = ensureDir(parentPath)
      let sibs = childrenMap.get(parent.path)
      if (!sibs) {
        sibs = new Map()
        childrenMap.set(parent.path, sibs)
      }
      if (!sibs.has(dirPath)) {
        sibs.set(dirPath, node)
        parent.children.push(node)
      }
    }
    return node
  }

  const topLevel = new Map<string, TreeNode>()

  for (const e of entries) {
    const clean = e.path.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!clean) continue
    const parts = clean.split('/').filter(Boolean)
    if (e.isDir) {
      const dirNode = ensureDir(clean)
      if (parts.length === 1) topLevel.set(clean, dirNode)
      continue
    }

    const fileNode: TreeNode = {
      name: parts[parts.length - 1] ?? clean,
      path: clean,
      isDir: false,
      size: e.size,
      mtime: e.mtime,
      children: [],
    }
    if (parts.length === 1) {
      topLevel.set(clean, fileNode)
    } else {
      const parentPath = parts.slice(0, -1).join('/')
      const parent = ensureDir(parentPath)
      const topName = parts[0]!
      if (!topLevel.has(topName)) {
        const topNode = rootMap.get(topName)
        if (topNode) topLevel.set(topName, topNode)
      }
      let sibs = childrenMap.get(parentPath)
      if (!sibs) {
        sibs = new Map()
        childrenMap.set(parentPath, sibs)
      }
      if (!sibs.has(clean)) {
        sibs.set(clean, fileNode)
        parent.children.push(fileNode)
      }
    }
  }

  for (const [key, node] of rootMap.entries()) {
    if (!key.includes('/')) {
      topLevel.set(key, node)
    }
  }

  const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const n of nodes) {
      if (n.children.length > 0) sortNodes(n.children)
    }
    return nodes
  }

  return sortNodes(Array.from(topLevel.values()))
}

function gitStatusLabel(code: string | undefined): { label: string; color: string; title: string } | null {
  if (!code) return null
  switch (code) {
    case 'M':
      return { label: 'M', color: 'var(--warn)', title: 'Modified in working tree' }
    case 'A':
      return { label: 'A', color: 'var(--ok)', title: 'Staged / added' }
    case 'D':
      return { label: 'D', color: 'var(--danger)', title: 'Deleted' }
    case 'R':
      return { label: 'R', color: 'var(--accent)', title: 'Renamed' }
    case '?':
      return { label: '?', color: 'var(--accent)', title: 'Untracked file' }
    default:
      return { label: code, color: 'var(--fg-muted)', title: `Git status ${code}` }
  }
}

function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function WorkspaceExplorer(props: {
  cwd?: string
  sessionId?: string
  globalSearch?: string
  isMobile?: boolean
  onAttachToChat: (path: string) => void
  onOpenChanges: () => void
  onTreeChanged?: () => void
}) {
  const [entries, setEntries] = createSignal<WorkspaceTreeEntry[]>([])
  const [activeCwd, setActiveCwd] = createSignal<string>(props.cwd ?? '')
  const [nextCursor, setNextCursor] = createSignal<string | null>(null)
  const [truncated, setTruncated] = createSignal(false)
  const [treeLoading, setTreeLoading] = createSignal(true)
  const [loadingMore, setLoadingMore] = createSignal(false)
  const [treeError, setTreeError] = createSignal('')

  const [localFilter, setLocalFilter] = createSignal('')
  const [expandedDirs, setExpandedDirs] = createSignal<Set<string>>(new Set())
  const [activeFolder, setActiveFolder] = createSignal<string>('')

  const [gitBranch, setGitBranch] = createSignal<string | null>(null)
  const [isGitRepo, setIsGitRepo] = createSignal(false)
  const [gitFiles, setGitFiles] = createSignal<Record<string, string>>({})

  // Selected file inspector & editor state
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null)
  const [fileLoading, setFileLoading] = createSignal(false)
  const [fileError, setFileError] = createSignal('')
  const [fileContent, setFileContent] = createSignal<string | null>(null)
  const [fileMeta, setFileMeta] = createSignal<{
    size: number
    mtime: number
    lines: number
    binary: boolean
    tooLarge: boolean
  } | null>(null)

  const [isEditing, setIsEditing] = createSignal(false)
  const [editDraft, setEditDraft] = createSignal('')
  const [saving, setSaving] = createSignal(false)
  const [pendingSwitchPath, setPendingSwitchPath] = createSignal<string | null>(null)

  // New file creation UI state
  const [newFileOpen, setNewFileOpen] = createSignal(false)
  const [newFilePath, setNewFilePath] = createSignal('')
  const [creatingFile, setCreatingFile] = createSignal(false)

  const effectiveQuery = createMemo(() => {
    const local = localFilter().trim()
    const global = (props.globalSearch ?? '').trim()
    return (local || global).toLowerCase()
  })

  const isDirty = createMemo(() => {
    if (!isEditing()) return false
    return editDraft() !== (fileContent() ?? '')
  })

  const fetchTreeAndGit = async (cursor?: string | null) => {
    const isAppend = Boolean(cursor)
    if (isAppend) {
      setLoadingMore(true)
    } else {
      setTreeLoading(true)
      setTreeError('')
    }
    try {
      const treeRes = await api.getWorkspaceTreePage({
        cwd: props.cwd || undefined,
        cursor: cursor ?? undefined,
        limit: 300,
        includeDirs: true,
      })
      if (treeRes.cwd) setActiveCwd(treeRes.cwd)
      setTruncated(Boolean(treeRes.truncated))
      setNextCursor(treeRes.nextCursor ?? null)
      const incoming = Array.isArray(treeRes.files) ? treeRes.files : []
      if (isAppend) {
        setEntries((prev) => {
          const seen = new Set(prev.map((x) => x.path))
          const merged = [...prev]
          for (const item of incoming) {
            if (!seen.has(item.path)) merged.push(item)
          }
          return merged
        })
      } else {
        setEntries(incoming)
        if (untrack(expandedDirs).size === 0) {
          const topDirs = incoming
            .filter((f) => f.isDir && !f.path.includes('/'))
            .slice(0, 2)
            .map((f) => f.path)
          if (topDirs.length > 0) {
            setExpandedDirs(new Set(topDirs))
          }
        }
      }
    } catch (e) {
      setTreeError(e instanceof Error ? e.message : 'Unable to load workspace tree')
    } finally {
      setTreeLoading(false)
      setLoadingMore(false)
    }

    if (!isAppend) {
      try {
        const gitRes = await api.getWorkspaceGitStatus(props.cwd || undefined)
        setIsGitRepo(Boolean(gitRes.isGitRepo))
        setGitBranch(gitRes.branch ?? null)
        setGitFiles(gitRes.files ?? {})
      } catch {
        setIsGitRepo(false)
        setGitBranch(null)
        setGitFiles({})
      }
    }
  }

  onMount(() => {
    void fetchTreeAndGit()
  })

  createEffect(() => {
    const nextCwd = props.cwd ?? ''
    if (nextCwd && nextCwd !== untrack(activeCwd)) {
      setSelectedPath(null)
      setFileContent(null)
      setIsEditing(false)
      void fetchTreeAndGit()
    }
  })

  const filteredEntries = createMemo(() => {
    const q = effectiveQuery()
    const list = entries()
    if (!q) return list
    return list.filter((item) => !item.isDir && item.path.toLowerCase().includes(q))
  })

  const treeNodes = createMemo(() => buildTree(filteredEntries()))

  // Auto-expand ancestor directories when searching
  const visibleExpanded = createMemo(() => {
    const q = effectiveQuery()
    if (!q) return expandedDirs()
    const auto = new Set<string>()
    for (const item of filteredEntries()) {
      const parts = item.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        auto.add(parts.slice(0, i).join('/'))
      }
    }
    return auto
  })

  // Directories that contain at least one git-changed file
  const dirHasGitChanges = createMemo(() => {
    const dirtyDirs = new Set<string>()
    for (const p of Object.keys(gitFiles())) {
      const parts = p.split('/')
      for (let i = 1; i < parts.length; i++) {
        dirtyDirs.add(parts.slice(0, i).join('/'))
      }
    }
    return dirtyDirs
  })

  const toggleDir = (dirPath: string) => {
    setActiveFolder(dirPath)
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }

  const loadFile = async (relPath: string, openInEdit = false) => {
    setSelectedPath(relPath)
    setPendingSwitchPath(null)
    setFileLoading(true)
    setFileError('')
    setIsEditing(false)
    try {
      const res = await api.readWorkspaceFile(relPath, props.cwd || activeCwd() || undefined)
      setFileMeta({
        size: res.size,
        mtime: res.mtime,
        lines: res.lines,
        binary: res.binary,
        tooLarge: res.tooLarge,
      })
      setFileContent(res.content)
      if (openInEdit && !res.binary && !res.tooLarge && res.content !== null) {
        setEditDraft(res.content)
        setIsEditing(true)
      }
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'Unable to read file')
      setFileContent(null)
      setFileMeta(null)
    } finally {
      setFileLoading(false)
    }
  }

  const selectFile = (relPath: string) => {
    if (selectedPath() === relPath && !fileError()) return
    if (isDirty()) {
      setPendingSwitchPath(relPath)
      return
    }
    void loadFile(relPath)
  }

  const handleStartEdit = () => {
    const content = fileContent()
    if (content === null) return
    setEditDraft(content)
    setIsEditing(true)
    setPendingSwitchPath(null)
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
    setEditDraft('')
    setPendingSwitchPath(null)
  }

  const handleSaveFile = async () => {
    const relPath = selectedPath()
    if (!relPath) return
    setSaving(true)
    try {
      const res = await api.writeWorkspaceFile({
        path: relPath,
        content: editDraft(),
        cwd: props.cwd || activeCwd() || undefined,
        sessionId: props.sessionId || undefined,
      })
      setFileContent(editDraft())
      setFileMeta({
        size: res.size,
        mtime: res.mtime,
        lines: editDraft().length === 0 ? 0 : editDraft().split('\n').length,
        binary: false,
        tooLarge: false,
      })
      setIsEditing(false)
      setPendingSwitchPath(null)
      toast.success(`Saved ${relPath}${res.snapshotId ? ' (snapshot recorded in Changes)' : ''}`)
      void fetchTreeAndGit()
      props.onTreeChanged?.()
    } catch (e) {
      toast.error(`Save failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  const openNewFilePrompt = () => {
    const prefix = activeFolder() ? `${activeFolder()}/` : ''
    setNewFilePath(prefix)
    setNewFileOpen(true)
  }

  const handleCreateFile = async (e: Event) => {
    e.preventDefault()
    const raw = newFilePath().trim().replace(/^\/+/, '').replace(/^\.\//, '')
    if (!raw || raw.endsWith('/')) {
      toast.error('Enter a valid file path (for example: src/helper.ts)')
      return
    }
    setCreatingFile(true)
    try {
      await api.writeWorkspaceFile({
        path: raw,
        content: '',
        cwd: props.cwd || activeCwd() || undefined,
        sessionId: props.sessionId || undefined,
        createOnly: true,
      })
      setNewFileOpen(false)
      setNewFilePath('')
      const parts = raw.split('/')
      if (parts.length > 1) {
        setExpandedDirs((prev) => {
          const next = new Set(prev)
          for (let i = 1; i < parts.length; i++) {
            next.add(parts.slice(0, i).join('/'))
          }
          return next
        })
      }
      await fetchTreeAndGit()
      await loadFile(raw, true)
      toast.success(`Created ${raw}`)
      props.onTreeChanged?.()
    } catch (err) {
      toast.error(`Create failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCreatingFile(false)
    }
  }

  const handleCopyPath = async () => {
    const p = selectedPath()
    if (!p) return
    try {
      await navigator.clipboard.writeText(p)
      toast.success(`Copied ${p}`)
    } catch {
      toast.error('Clipboard unavailable')
    }
  }

  const selectedGitInfo = createMemo(() => {
    const p = selectedPath()
    if (!p) return null
    return gitStatusLabel(gitFiles()[p])
  })

  const changedCount = createMemo(() => Object.keys(gitFiles()).length)

  const fileLines = createMemo(() => {
    const c = fileContent()
    if (c === null) return []
    return c.split('\n')
  })

  const renderTreeRows = (nodes: TreeNode[], depth: number): any => (
    <For each={nodes}>
      {(node) => {
        const isExpanded = () => visibleExpanded().has(node.path)
        const isSelected = () => !node.isDir && selectedPath() === node.path
        const git = () => (!node.isDir ? gitStatusLabel(gitFiles()[node.path]) : null)
        const dirDirty = () => node.isDir && dirHasGitChanges().has(node.path)

        return (
          <>
            <button
              type="button"
              onClick={() => (node.isDir ? toggleDir(node.path) : selectFile(node.path))}
              aria-expanded={node.isDir ? (isExpanded() ? 'true' : 'false') : undefined}
              title={node.path}
              style={{
                width: '100%',
                display: 'flex',
                'align-items': 'center',
                'justify-content': 'space-between',
                gap: '6px',
                padding: `5px 10px 5px ${10 + depth * 14}px`,
                'min-height': '32px',
                background: isSelected() ? 'var(--bg-active)' : 'transparent',
                border: 'none',
                'border-bottom': '1px solid var(--border)',
                color: isSelected()
                  ? 'var(--fg)'
                  : node.isDir
                    ? 'var(--fg)'
                    : 'var(--fg-muted)',
                'font-size': 'var(--fs-xs)',
                'font-family': 'var(--font-mono)',
                'font-weight': node.isDir || isSelected() ? '600' : '400',
                cursor: 'pointer',
                'text-align': 'left',
              }}
            >
              <span
                style={{
                  display: 'flex',
                  'align-items': 'center',
                  gap: '6px',
                  'min-width': '0',
                  flex: '1',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: '12px',
                    'text-align': 'center',
                    color: node.isDir ? 'var(--accent)' : 'var(--fg-faint)',
                    'flex-shrink': '0',
                    'font-size': '10px',
                  }}
                >
                  {node.isDir ? (isExpanded() ? '▾' : '▸') : '·'}
                </span>
                <span
                  style={{
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                  }}
                >
                  {node.name}
                </span>
              </span>

              <span
                style={{
                  display: 'inline-flex',
                  'align-items': 'center',
                  gap: '6px',
                  'flex-shrink': '0',
                }}
              >
                <Show when={dirDirty()}>
                  <span
                    title="Contains uncommitted changes"
                    style={{
                      width: '5px',
                      height: '5px',
                      'border-radius': '50%',
                      background: 'var(--warn)',
                    }}
                  />
                </Show>
                <Show when={git()}>
                  {(g) => (
                    <span
                      title={g().title}
                      style={{
                        color: g().color,
                        'font-weight': '700',
                        'font-size': 'var(--fs-2xs)',
                      }}
                    >
                      {g().label}
                    </span>
                  )}
                </Show>
                <Show when={!node.isDir}>
                  <span
                    class="tabular-nums"
                    style={{
                      'font-size': 'var(--fs-2xs)',
                      color: 'var(--fg-faint)',
                    }}
                  >
                    {fmtSize(node.size)}
                  </span>
                </Show>
              </span>
            </button>

            <Show when={node.isDir && isExpanded() && node.children.length > 0}>
              {renderTreeRows(node.children, depth + 1)}
            </Show>
          </>
        )
      }}
    </For>
  )

  return (
    <div
      data-slot="workspace-explorer"
      style={{
        flex: '1',
        display: 'flex',
        'flex-direction': 'column',
        'min-height': '0',
        padding: props.isMobile ? '10px' : '16px',
        gap: '12px',
        background: 'var(--bg-canvas)',
      }}
    >
      {/* Top Explorer Bar */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          'flex-wrap': 'wrap',
          gap: '10px',
          'padding-bottom': '10px',
          'border-bottom': '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '3px', 'min-width': '0' }}>
          <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
            <h2
              style={{
                margin: '0',
                'font-size': 'var(--fs-md)',
                'font-weight': '700',
                color: 'var(--fg)',
              }}
            >
              Workspace Files
            </h2>
            <span class="meta-inline">
              <span class="tabular-nums">
                {entries().filter((e) => !e.isDir).length} indexed
              </span>
              <Show when={isGitRepo() && gitBranch()}>
                <span aria-hidden="true">·</span>
                <span style={{ color: 'var(--accent)', 'font-weight': '600' }}>
                  {gitBranch()}
                </span>
              </Show>
              <Show when={changedCount() > 0}>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={props.onOpenChanges}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: '0',
                    color: 'var(--warn)',
                    'font-family': 'inherit',
                    'font-size': 'inherit',
                    'font-weight': '600',
                    cursor: 'pointer',
                    'text-decoration': 'underline',
                  }}
                >
                  {changedCount()} modified · View in Changes
                </button>
              </Show>
            </span>
          </div>
          <Show when={activeCwd()}>
            <div
              title={activeCwd()}
              style={{
                'font-size': 'var(--fs-2xs)',
                'font-family': 'var(--font-mono)',
                color: 'var(--fg-faint)',
                overflow: 'hidden',
                'text-overflow': 'ellipsis',
                'white-space': 'nowrap',
              }}
            >
              {activeCwd()}
            </div>
          </Show>
        </div>

        <div style={{ display: 'flex', 'align-items': 'center', gap: '8px', 'flex-wrap': 'wrap' }}>
          <input
            type="search"
            class="input"
            aria-label="Filter files by path"
            placeholder="Filter file paths…"
            value={localFilter()}
            onInput={(e) => setLocalFilter(e.currentTarget.value)}
            style={{
              width: props.isMobile ? '150px' : '210px',
              padding: '6px 10px',
              'font-size': 'var(--fs-xs)',
              'min-height': '32px',
            }}
          />
          <button
            type="button"
            class="btn btn-outline"
            onClick={openNewFilePrompt}
            style={{ padding: '6px 12px', 'font-size': 'var(--fs-xs)', 'min-height': '32px' }}
          >
            + New File
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => void fetchTreeAndGit()}
            disabled={treeLoading()}
            style={{
              padding: '6px 10px',
              'font-size': 'var(--fs-xs)',
              border: '1px solid var(--border)',
              'border-radius': 'var(--r-md)',
              'min-height': '32px',
            }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Inline New File Creator */}
      <Show when={newFileOpen()}>
        <form
          onSubmit={(e) => void handleCreateFile(e)}
          style={{
            display: 'flex',
            'align-items': 'center',
            gap: '8px',
            'flex-wrap': 'wrap',
            padding: '10px 12px',
            background: 'var(--bg-surface)',
            border: '1px solid var(--accent-border)',
            'border-radius': 'var(--r-md)',
          }}
        >
          <label
            for="new-workspace-file-input"
            style={{ 'font-size': 'var(--fs-xs)', 'font-weight': '600', color: 'var(--fg)' }}
          >
            New file path
          </label>
          <input
            id="new-workspace-file-input"
            type="text"
            class="input"
            autofocus
            value={newFilePath()}
            onInput={(e) => setNewFilePath(e.currentTarget.value)}
            placeholder="src/components/Example.tsx"
            style={{
              flex: '1',
              'min-width': '200px',
              padding: '6px 10px',
              'font-family': 'var(--font-mono)',
              'font-size': 'var(--fs-xs)',
            }}
          />
          <button
            type="submit"
            class="btn btn-primary"
            disabled={creatingFile() || !newFilePath().trim()}
            style={{ padding: '6px 14px', 'font-size': 'var(--fs-xs)', 'min-height': '32px' }}
          >
            {creatingFile() ? 'Creating…' : 'Create'}
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => setNewFileOpen(false)}
            style={{ padding: '6px 10px', 'font-size': 'var(--fs-xs)', 'min-height': '32px' }}
          >
            Cancel
          </button>
        </form>
      </Show>

      {/* Split-Pane Explorer Surface */}
      <div
        style={{
          flex: '1',
          'min-height': '0',
          display: 'grid',
          'grid-template-columns': props.isMobile ? '1fr' : 'minmax(250px, 310px) minmax(0, 1fr)',
          'grid-template-rows': props.isMobile ? 'minmax(220px, 38vh) minmax(260px, 1fr)' : 'minmax(0, 1fr)',
          border: '1px solid var(--border)',
          'border-radius': 'var(--r-lg)',
          background: 'var(--bg-surface)',
          overflow: 'hidden',
        }}
      >
        {/* Left Pane: Collapsible Directory Tree */}
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            'min-height': '0',
            'border-right': props.isMobile ? 'none' : '1px solid var(--border)',
            'border-bottom': props.isMobile ? '1px solid var(--border)' : 'none',
            background: 'var(--bg-app)',
          }}
        >
          <div style={{ flex: '1', overflow: 'auto' }} role="tree" aria-label="Workspace file tree">
            <Show when={treeLoading() && entries().length === 0}>
              <div style={{ padding: '12px', display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                <div class="skeleton" style={{ height: '24px' }} />
                <div class="skeleton" style={{ height: '24px', width: '80%' }} />
                <div class="skeleton" style={{ height: '24px', width: '90%' }} />
              </div>
            </Show>

            <Show when={treeError()}>
              <div style={{ padding: '14px', 'font-size': 'var(--fs-xs)', color: 'var(--danger)' }}>
                {treeError()}
              </div>
            </Show>

            <Show when={!treeLoading() && !treeError() && treeNodes().length === 0}>
              <div
                style={{
                  padding: '20px 12px',
                  'text-align': 'center',
                  'font-size': 'var(--fs-xs)',
                  color: 'var(--fg-subtle)',
                }}
              >
                {effectiveQuery()
                  ? `No files match "${effectiveQuery()}".`
                  : 'No workspace files returned by server.'}
              </div>
            </Show>

            <Show when={treeNodes().length > 0}>{renderTreeRows(treeNodes(), 0)}</Show>
          </div>

          <Show when={truncated() && nextCursor()}>
            <div
              style={{
                padding: '8px 10px',
                'border-top': '1px solid var(--border)',
                background: 'var(--bg-surface)',
                display: 'flex',
                'justify-content': 'center',
              }}
            >
              <button
                type="button"
                class="btn btn-ghost"
                disabled={loadingMore()}
                onClick={() => void fetchTreeAndGit(nextCursor())}
                style={{
                  width: '100%',
                  padding: '6px 10px',
                  'font-size': 'var(--fs-xs)',
                  border: '1px solid var(--border)',
                  'border-radius': 'var(--r-md)',
                }}
              >
                {loadingMore() ? 'Loading more…' : 'Load more files'}
              </button>
            </div>
          </Show>
        </div>

        {/* Right Pane: Read-Only Preview & Controlled Editor */}
        <div
          style={{
            display: 'flex',
            'flex-direction': 'column',
            'min-height': '0',
            background: 'var(--bg-surface)',
          }}
        >
          <Show
            when={selectedPath()}
            fallback={
              <div
                style={{
                  flex: '1',
                  display: 'grid',
                  'place-items': 'center',
                  padding: '24px',
                  'text-align': 'center',
                }}
              >
                <div style={{ 'max-width': '380px', display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                  <div style={{ 'font-size': 'var(--fs-sm)', 'font-weight': '700', color: 'var(--fg)' }}>
                    Select a file to inspect or edit
                  </div>
                  <div style={{ 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)', 'line-height': '1.6' }}>
                    Expand folders on the left to preview code, edit text files with automatic change snapshots, or insert `@file` references directly into Chat.
                  </div>
                </div>
              </div>
            }
          >
            {(currentPath) => (
              <>
                {/* File Inspector Header */}
                <div
                  style={{
                    display: 'flex',
                    'align-items': 'center',
                    'justify-content': 'space-between',
                    'flex-wrap': 'wrap',
                    gap: '8px',
                    padding: '10px 14px',
                    'border-bottom': '1px solid var(--border)',
                    background: 'var(--bg-app)',
                  }}
                >
                  <div style={{ display: 'flex', 'flex-direction': 'column', gap: '2px', 'min-width': '0' }}>
                    <div
                      style={{
                        'font-family': 'var(--font-mono)',
                        'font-size': 'var(--fs-xs)',
                        'font-weight': '700',
                        color: 'var(--fg)',
                        overflow: 'hidden',
                        'text-overflow': 'ellipsis',
                        'white-space': 'nowrap',
                      }}
                    >
                      {currentPath()}
                    </div>
                    <div class="meta-inline">
                      <Show when={fileMeta()}>
                        {(meta) => (
                          <>
                            <span>{fmtSize(meta().size)}</span>
                            <Show when={!meta().binary && !meta().tooLarge}>
                              <span aria-hidden="true">·</span>
                              <span>{meta().lines} lines</span>
                            </Show>
                          </>
                        )}
                      </Show>
                      <Show when={selectedGitInfo()}>
                        {(git) => (
                          <>
                            <span aria-hidden="true">·</span>
                            <span style={{ color: git().color, 'font-weight': '600' }}>
                              Git {git().label} ({git().title})
                            </span>
                          </>
                        )}
                      </Show>
                      <Show when={isDirty()}>
                        <span aria-hidden="true">·</span>
                        <span style={{ color: 'var(--warn)', 'font-weight': '600' }}>Unsaved edits</span>
                      </Show>
                    </div>
                  </div>

                  <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'flex-wrap': 'wrap' }}>
                    <button
                      type="button"
                      class="btn btn-outline"
                      onClick={() => props.onAttachToChat(currentPath())}
                      style={{ padding: '6px 10px', 'font-size': 'var(--fs-xs)', 'min-height': '32px' }}
                    >
                      Attach @file to Chat
                    </button>
                    <button
                      type="button"
                      class="btn btn-ghost"
                      onClick={() => void handleCopyPath()}
                      style={{
                        padding: '6px 10px',
                        'font-size': 'var(--fs-xs)',
                        border: '1px solid var(--border)',
                        'border-radius': 'var(--r-md)',
                        'min-height': '32px',
                      }}
                    >
                      Copy Path
                    </button>
                    <Show when={selectedGitInfo()}>
                      <button
                        type="button"
                        class="btn btn-ghost"
                        onClick={props.onOpenChanges}
                        style={{
                          padding: '6px 10px',
                          'font-size': 'var(--fs-xs)',
                          border: '1px solid var(--border)',
                          'border-radius': 'var(--r-md)',
                          'min-height': '32px',
                        }}
                      >
                        View in Changes
                      </button>
                    </Show>

                    <Show when={!isEditing() && fileContent() !== null && !fileMeta()?.binary && !fileMeta()?.tooLarge}>
                      <button
                        type="button"
                        class="btn btn-primary"
                        onClick={handleStartEdit}
                        style={{ padding: '6px 12px', 'font-size': 'var(--fs-xs)', 'min-height': '32px' }}
                      >
                        Edit
                      </button>
                    </Show>

                    <Show when={isEditing()}>
                      <button
                        type="button"
                        class="btn btn-ghost"
                        onClick={handleCancelEdit}
                        disabled={saving()}
                        style={{
                          padding: '6px 10px',
                          'font-size': 'var(--fs-xs)',
                          border: '1px solid var(--border)',
                          'border-radius': 'var(--r-md)',
                          'min-height': '32px',
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        class="btn btn-primary"
                        onClick={() => void handleSaveFile()}
                        disabled={saving() || !isDirty()}
                        style={{ padding: '6px 14px', 'font-size': 'var(--fs-xs)', 'min-height': '32px' }}
                      >
                        {saving() ? 'Saving…' : 'Save'}
                      </button>
                    </Show>
                  </div>
                </div>

                {/* Non-blocking unsaved-changes guard banner */}
                <Show when={pendingSwitchPath()}>
                  {(nextPath) => (
                    <div
                      role="alert"
                      style={{
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'space-between',
                        'flex-wrap': 'wrap',
                        gap: '8px',
                        padding: '8px 14px',
                        background: 'var(--warn-soft)',
                        'border-bottom': '1px solid var(--warn-border)',
                        'font-size': 'var(--fs-xs)',
                        color: 'var(--fg)',
                      }}
                    >
                      <span>Discard unsaved edits to {currentPath()} and open {nextPath()}?</span>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          type="button"
                          class="btn btn-ghost"
                          onClick={() => setPendingSwitchPath(null)}
                          style={{ padding: '4px 10px', 'font-size': 'var(--fs-xs)' }}
                        >
                          Stay
                        </button>
                        <button
                          type="button"
                          class="btn btn-danger-ghost"
                          onClick={() => void loadFile(nextPath())}
                          style={{ padding: '4px 10px', 'font-size': 'var(--fs-xs)' }}
                        >
                          Discard & Open
                        </button>
                      </div>
                    </div>
                  )}
                </Show>

                {/* File Body */}
                <div style={{ flex: '1', overflow: 'auto', 'min-height': '0' }}>
                  <Show when={fileLoading()}>
                    <div style={{ padding: '16px', display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
                      <div class="skeleton" style={{ height: '16px', width: '70%' }} />
                      <div class="skeleton" style={{ height: '16px', width: '90%' }} />
                      <div class="skeleton" style={{ height: '16px', width: '60%' }} />
                    </div>
                  </Show>

                  <Show when={!fileLoading() && fileError()}>
                    <div style={{ padding: '16px', 'font-size': 'var(--fs-xs)', color: 'var(--danger)' }}>
                      {fileError()}
                    </div>
                  </Show>

                  <Show when={!fileLoading() && !fileError() && fileMeta()?.binary}>
                    <div style={{ padding: '24px', 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
                      Binary file ({fmtSize(fileMeta()!.size)}) — text preview and in-browser editing are disabled.
                    </div>
                  </Show>

                  <Show when={!fileLoading() && !fileError() && fileMeta()?.tooLarge}>
                    <div style={{ padding: '24px', 'font-size': 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
                      File is {fmtSize(fileMeta()!.size)} and exceeds the 512 KB browser preview limit.
                    </div>
                  </Show>

                  <Show when={!fileLoading() && !fileError() && isEditing()}>
                    <textarea
                      aria-label={`Editing ${currentPath()}`}
                      value={editDraft()}
                      onInput={(e) => setEditDraft(e.currentTarget.value)}
                      spellcheck={false}
                      style={{
                        width: '100%',
                        height: '100%',
                        'min-height': '360px',
                        padding: '12px 14px',
                        border: 'none',
                        outline: 'none',
                        resize: 'none',
                        background: 'var(--bg-canvas)',
                        color: 'var(--fg)',
                        'font-family': 'var(--font-mono)',
                        'font-size': 'var(--fs-xs)',
                        'line-height': '1.6',
                        'tab-size': '2',
                      }}
                    />
                  </Show>

                  <Show when={!fileLoading() && !fileError() && !isEditing() && fileContent() !== null}>
                    <div
                      style={{
                        padding: '10px 0',
                        'font-family': 'var(--font-mono)',
                        'font-size': 'var(--fs-xs)',
                        'line-height': '1.6',
                      }}
                    >
                      <For each={fileLines()}>
                        {(line, idx) => (
                          <div
                            style={{
                              display: 'grid',
                              'grid-template-columns': '52px minmax(0, 1fr)',
                              padding: '0 14px 0 6px',
                            }}
                          >
                            <span
                              class="tabular-nums"
                              aria-hidden="true"
                              style={{
                                'text-align': 'right',
                                'padding-right': '14px',
                                color: 'var(--fg-faint)',
                                'user-select': 'none',
                              }}
                            >
                              {idx() + 1}
                            </span>
                            <span
                              style={{
                                color: 'var(--fg)',
                                'white-space': 'pre',
                                overflow: 'visible',
                              }}
                            >
                              {line || ' '}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
