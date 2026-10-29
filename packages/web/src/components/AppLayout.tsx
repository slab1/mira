// AppLayout.tsx - Refactored layout with Material 3 Navigation Rail
// @ts-nocheck
import { Show, For } from 'solid-js';
import { NavigationRail, TopAppBar } from './M3Components';
import { WORKSPACES, type WorkspaceId } from './TopNav';

/**
 * ============================================================================
 * MAIN LAYOUT COMPONENT
 * ============================================================================
 * Structure:
 * - Navigation Rail (left sidebar, 72px)
 * - Top App Bar (header below rail)
 * - Main Content (workspace switcher)
 */

export function AppLayout(props: {
  workspace: WorkspaceId;
  onWorkspaceChange: (id: WorkspaceId) => void;
  visibleWorkspaces: WorkspaceId[];
  children: () => JSX.Element;
}) {
  return (
    <div style={{ 'display': 'flex', 'height': '100vh', 'background': 'var(--bg-app)' }}>
      {/* ===== NAVIGATION RAIL ===== */}
      <NavigationRail
        items={WORKSPACES.filter(w => props.visibleWorkspaces.includes(w.id)).map(w => ({
          id: w.id,
          label: w.label,
          icon: w.icon,
        }))}
        selected={props.workspace}
        onSelect={props.onWorkspaceChange}
      />

      {/* ===== MAIN AREA ===== */}
      <div style={{ 'flex': '1', 'display': 'flex', 'flex-direction': 'column', 'min-width': '0', 'margin-left': '72px' }}>
        
        {/* ===== TOP APP BAR ===== */}
        <TopAppBar
          title={WORKSPACES.find(w => w.id === props.workspace)?.label || 'Mira'}
          subtitle="AI Agent Platform"
        />

        {/* ===== WORKSPACE CONTENT ===== */}
        <main style={{ 'flex': '1', 'overflow': 'auto', 'min-height': '0' }}>
          {props.children()}
        </main>
      </div>
    </div>
  );
}

/**
 * ============================================================================
 * HEADER COMPONENT - Simplified
 * ============================================================================
 * Contains connection status, health link, and actions menu
 */

export function AppHeader(props: {
  connected: boolean;
  onSettings: () => void;
  onUndo: () => Promise<void>;
  onExport: () => Promise<void>;
  hasSession: boolean;
  hasMessages: boolean;
}) {
  return (
    <header style={{ 
      'display': 'flex', 
      'align-items': 'center', 
      'justify-content': 'space-between',
      'padding': '12px 16px',
      'background': 'var(--m3-surface-container)',
      'border-bottom': '1px solid var(--border)'
    }}>
      {/* Status Indicators */}
      <div style={{ 'display': 'flex', 'gap': '12px', 'align-items': 'center' }}>
        <span class={`pill ${props.connected ? 'pill-ok' : 'pill-danger'}`}>
          <span class={`dot ${props.connected ? 'dot-pulse' : ''}`} 
                style={{ 'background': props.connected ? 'var(--ok)' : 'var(--danger)' }} />
          {props.connected ? 'live' : 'offline'}
        </span>
      </div>

      {/* Actions */}
      <div style={{ 'display': 'flex', 'gap': '8px' }}>
        <button onClick={props.onSettings} class="btn btn-ghost">⚙ Settings</button>
        <Show when={props.hasSession}>
          <button onClick={props.onUndo} class="btn btn-ghost" disabled={!props.hasMessages}>
            ↩ Undo
          </button>
          <button onClick={props.onExport} class="btn btn-ghost" disabled={!props.hasMessages}>
            ⤓ Export
          </button>
        </Show>
      </div>
    </header>
  );
}
