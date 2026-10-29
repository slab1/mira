# Mira Design System — Material 3 Expressive Implementation

## Overview
Implemented Material 3 Expressive design with Google Navigation Rail + Top App Bar for Mira Web UI.

## Files Created

### 1. packages/web/src/m3-expressive.css
**Material 3 Token System:**
- Dynamic Color tonal palette (primary/secondary/tertiary/neutral/error)
- Surface containers: lowest → highest
- M3 Expressive shapes: extra-small to extra-large
- M3 elevation system 0-5
- Legacy aliases for backward compatibility

**Components:**
- `.m3-navigation-rail` — 72px vertical rail, fixed left
- `.m3-top-app-bar` — 64px app bar with margin-left for rail
- `.m3-card` — elevated cards with hover states
- `.m3-filled-button` / `.m3-outlined-button`

### 2. packages/web/src/components/M3Components.tsx
**New Components:**
- `NavigationRail` — Vertical navigation with icons, labels, badges
- `TopAppBar` — Title + subtitle + actions
- `M3Card` — Material 3 expressive cards
- `M3FilledButton` — Filled tonal buttons

**Usage:**
```tsx
import { NavigationRail, TopAppBar } from './components/M3Components';

<NavigationRail items={navItems} selected={active} onSelect={setActive} />
<TopAppBar title="Mira Workspaces" subtitle="AI Agent Platform" />
```

### 3. Updated imports
App.tsx now imports m3-expressive.css

## Google UI-UX Patterns Implemented

### Navigation Rail (Material 3)
- 72px width, icons + labels stacked vertically
- Selected state with container color
- Hover states with surface elevation
- Fixed positioning for desktop
- Converts to bottom nav on mobile (media query ready)

### Top App Bar
- 64px height, surface container low
- Title in 22sp, medium weight
- Actions aligned right
- Margin-left accounts for navigation rail

### Material 3 Expressive
- Tonal surfaces for depth hierarchy
- Rounded corners: 12px/16px/28px
- Elevation shadows matching Material spec
- Dynamic color ready for Material You

## Integration Steps

1. Replace TopNav with NavigationRail in App.tsx
2. Use TopAppBar for workspace headers
3. Migrate cards to M3Card component
4. Add responsive breakpoints for mobile bottom nav

## Next Steps
- Implement responsive mobile bottom navigation
- Add Material You dynamic color extraction
- Migrate remaining components to M3 tokens
- Add motion specs with Material Easing
