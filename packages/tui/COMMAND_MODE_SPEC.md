# Mira TUI Command Mode — Design Spec P10

## Overview

Add slash-command palette parity to TUI client, number-key HITL selection for permission/question overlays, and `?` help overlay.

Target: `packages/tui/src`

## States

- **Normal input**: freeform prompt
- **Command mode**: input starts with `/` → palette overlay
- **Help overlay**: `?` toggles modal
- **HITL overlays**: permission / question with number-key selection

## Interaction Flow

### 1. / Command Palette

Activation:

- User types `/` in input bar → `commandMode = true`
- Input placeholder: `> /cost /undo /queue /jobs /fork /export`
- Palette shows filtered commands with description, number key 1-9

Commands:

- `/cost` → fetch `rpc.devHealth()` and show inline cost toast + header badge update
- `/undo` → `store.undoLast()` (parity with header ↩)
- `/queue` → show queue length + list prompts, `rpc.getQueue(id)`, `rpc.clearQueue(id)`
- `/jobs` → `rpc.listJobs(sessionId)` table (id, agent, status, created)
- `/fork` → `rpc.createSession({parentID: currentId})` → select new session
- `/export` → `rpc.exportSession(id, 'md')` → download blob

Navigation:

- Arrow up/down to move, Enter to execute, Esc to cancel
- Number keys 1-9 execute matching entry
- Filter by typing after `/`

Visual:

- Overlay anchored to input bar, max-h 280px, scrollable
- Tokens: bg `rgba(0,0,0,0.85)`, border `rgba(255,255,255,0.12)`, accent `#6366f1`
- Each row: `1. /cost` + description, selected state `bg rgba(99,102,241,0.18)`

### 2. Number-key HITL Selection

PermissionView:

- Show `1) Allow` `2) Deny` with numbers
- Global keydown: `1` → allow, `2` → deny, `a/d/Esc` preserved
- Option list rendered with prefix number

QuestionView:

- Each option rendered as `1. label — description`
- Number keys select/deselect per question header
- Multiple selection toggles on repeat press
- Submit on Enter or `⏎ Submit` button

### 3. ? Help Overlay

Trigger:

- `?` key when not typing, or header `?` icon
- Toggles modal overlay

Content:

- Shortcuts table:
  - `Enter` Send / Submit
  - `Shift+Enter` Newline
  - `Esc` Stop stream / Close overlay
  - `/` Command palette
  - `?` Help
  - `a / d` Allow / Deny permission
  - `1-9` HITL select
  - `↩ undo` Header undo
- State-aware: shows current session, model, connection

Visual:

- Center modal, `max-w 560px`, backdrop `rgba(0,0,0,0.6)`
- Close on Esc / click outside

## Component Changes

### New

- `src/components/CommandPalette.tsx`
  - Props: `open`, `query`, `onSelect`, `onClose`
  - Internal command registry array
  - Filtering + number key binding

- `src/components/HelpOverlay.tsx`
  - Props: `open`, `onClose`, `store`
  - Renders shortcut table

### Modified

- `src/App.tsx`
  - Add signals: `commandMode`, `commandQuery`, `helpOpen`
  - Input `onKeyDown` intercept `/` and `?`
  - Render `<CommandPalette />` and `<HelpOverlay />`
  - Pass `onKeyDown` to permission/question overlays for number keys

- `src/stores/session.ts`
  - Add actions: `forkSession(parentId)`, `exportSession(id)`, `listJobs(id)`, `clearQueue(id)`
  - Expose `cost` refresh on `/cost`

- `src/components/PermissionView.tsx`
  - Render options with numbers, handle `onKeyDown` 1/2

- `src/components/QuestionView.tsx`
  - Prefix options with numbers, map keypress to toggle

- `src/components/SessionView.tsx`
  - Optional: show command hint in empty state

## File Paths

- `/tmp/aether/packages/tui/src/App.tsx`
- `/tmp/aether/packages/tui/src/stores/session.ts`
- `/tmp/aether/packages/tui/src/components/CommandPalette.tsx` [new]
- `/tmp/aether/packages/tui/src/components/HelpOverlay.tsx` [new]
- `/tmp/aether/packages/tui/src/components/PermissionView.tsx`
- `/tmp/aether/packages/tui/src/components/QuestionView.tsx`

## Accessibility

- `htmlFor`/`id` on command input
- `aria-live` for palette results
- Focus trap in help modal
- Keyboard-only flow for all commands
- Contrast AA for overlay text

## Tokens

Reuse existing design tokens: radius 8-10px, spacing 8/10/14px, accent `#6366f1`, muted `#a1a1aa`.

## Verification

- `tsc -b --noEmit` passes
- Command palette filters and executes all 6 commands
- Number keys select permission/question options
- `?` toggles help, Esc closes
- No layout shift on mode switch
