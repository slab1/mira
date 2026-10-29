// @ts-nocheck
import './m3-expressive.css';
import { createSignal, For, Show } from 'solid-js';
import type { JSX } from 'solid-js';

export type NavItem = {
  id: string;
  label: string;
  icon: JSX.Element;
  badge?: number;
};

export function NavigationRail(props: {
  items: NavItem[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav class="m3-navigation-rail" aria-label="Primary navigation">
      <Show when={props.items.length}>
        <For each={props.items}>
          {(item) => (
            <a
              href="#"
              class="m3-rail-item"
              aria-selected={props.selected === item.id ? 'true' : 'false'}
              onClick={(e) => {
                e.preventDefault();
                props.onSelect(item.id);
              }}
            >
              <span style={{ font-size: '24px' }}>{item.icon}</span>
              <span style={{ font-size: '12px', font-weight: 500 }}>{item.label}</span>
              <Show when={item.badge}>
                <span style={{
                  background: 'var(--m3-primary-40)',
                  color: 'white',
                  borderRadius: '10px',
                  padding: '2px 6px',
                  fontSize: '10px',
                  fontWeight: '600'
                }}>
                  {item.badge}
                </span>
              </Show>
            </a>
          )}
        </For>
      </Show>
    </nav>
  );
}

export function TopAppBar(props: {
  title: string;
  subtitle?: string;
  actions?: JSX.Element;
}) {
  return (
    <header class="m3-top-app-bar">
      <div class="m3-app-bar-title">{props.title}</div>
      <Show when={props.subtitle}>
        <span style={{ color: 'var(--m3-on-surface-variant)', fontSize: '14px' }}>
          {props.subtitle}
        </span>
      </Show>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
        {props.actions}
      </div>
    </header>
  );
}

/* Material 3 Expressive Card */
export function M3Card(props: {
  children: JSX.Element;
  elevation?: 1 | 2 | 3;
  style?: Record<string, string>;
}) {
  return (
    <div
      class="m3-card"
      style={props.style}
    >
      {props.children}
    </div>
  );
}

/* Material 3 Filled Button */
export function M3FilledButton(props: {
  children: JSX.Element;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      class="m3-filled-button"
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  );
}
