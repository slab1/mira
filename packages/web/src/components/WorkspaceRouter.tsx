// WorkspaceRouter.tsx - Clean workspace routing with comments
// @ts-nocheck
import { Switch, Match, Show } from 'solid-js';
import { type WorkspaceId } from './TopNav';
import EvolutionPage from '../pages/Evolution';
import MissionsPage from '../pages/Missions';
import IntelligencePage from '../pages/Intelligence';
import ChangesPage from '../pages/Changes';
import SystemPage from '../pages/System';
import DashboardPage from '../pages/Dashboard';

/**
 * ============================================================================
 * WORKSPACE ROUTER
 * ============================================================================
 * Routes workspaces to pages with clear separation of concerns
 * Each workspace has its own page component
 */

export function WorkspaceRouter(props: {
  workspace: WorkspaceId;
  workTab?: 'chat' | 'brio';
  // Props for work workspace
  store?: any;
  viewMode?: string;
  onOpenInChat?: (id: string) => void;
  // Render work workspace content
  renderWork?: () => JSX.Element;
}) {
  return (
    <Switch fallback={<UnknownWorkspace />}>
      {/* Evolution workspace */}
      <Match when={props.workspace === 'evolution'}>
        <EvolutionPage />
      </Match>

      {/* Missions workspace */}
      <Match when={props.workspace === 'missions'}>
        <MissionsPage
          store={props.store}
          onOpenInChat={props.onOpenInChat}
        />
      </Match>

      {/* Intelligence workspace */}
      <Match when={props.workspace === 'intelligence'}>
        <IntelligencePage />
      </Match>

      {/* Changes workspace */}
      <Match when={props.workspace === 'changes'}>
        <ChangesPage />
      </Match>

      {/* System workspace */}
      <Match when={props.workspace === 'system'}>
        <SystemPage />
      </Match>

      {/* Dashboard workspace */}
      <Match when={props.workspace === 'dashboard'}>
        <DashboardPage />
      </Match>

      {/* Work workspace - Chat/Brio */}
      <Match when={props.workspace === 'work'}>
        <Show when={props.renderWork}>
          {props.renderWork()}
        </Show>
      </Match>
    </Switch>
  );
}

function UnknownWorkspace() {
  return (
    <div style={{
      'flex': '1',
      'display': 'grid',
      'place-items': 'center',
      'padding': '24px',
      'color': 'var(--fg-muted)',
      'font-size': 'var(--fs-lg)'
    }}>
      Unknown workspace
    </div>
  );
}
