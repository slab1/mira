# LSP Intelligence Implementation Summary

> **Status:** Superseded by real LSP integration (2026-08). `packages/server/src/lsp/client.ts` speaks LSP 3.17 JSON-RPC to actual servers (gopls auto-detected; `MIRA_LSP_<LANG>_CMD` for others), with this heuristic SymbolIndex retained as fallback. See `src/lsp/client.test.ts` + `gopls.live.test.ts`.

## Overview
Implemented symbol-aware LSP capabilities for Mira agent platform. Integrated Language Server Protocol-like symbol resolution, go-to-definition, references, semantic awareness, hover, diagnostics, and rename into the codebase while preserving existing functionality.

## Files Changed

### Modified
- `packages/server/src/tools/lsp.ts`
  - Replaced stub implementation with full symbol-aware operations using SymbolIndex
  - Added support for hover, definition, references, diagnostics, rename
  - Added `symbol` parameter for direct symbol queries
  - Returns structured results instead of stub placeholder

- `packages/server/src/tools/edit-fallback.ts`
  - Integrated Layer 8 Symbol-Aware edit fallback
  - Imports `symbolIndex` and `guardEdit` for semantic safety checks
  - Detects symbol rename patterns and performs workspace-wide rename via LSP
  - Adds semantic guard to prevent high-risk edits without using rename operation
  - Returns layer 8 fallback with symbol rename metadata

### New Files
- `packages/server/src/symbols/types.ts`
  - Type definitions for SymbolInfo, SymbolKind, DefinitionResult, ReferenceResult, HoverResult, RenameResult
  - Shared types for symbol-aware operations

- `packages/server/src/symbols/index.ts`
  - `SymbolIndex` class with workspace symbol indexing
  - Parses TypeScript/JavaScript files via regex patterns for export/function/class/interface/type/enum/const/let/var
  - Methods:
    - `ensureIndexed`: lazy file parsing with cache
    - `findSymbolAt`: locate symbol under cursor
    - `findDefinition`: resolve definition via index
    - `findSymbolInWorkspace`: find exported symbols across packages
    - `findReferences`: grep-based reference finding with word boundaries
    - `renameSymbol`: workspace-wide symbol rename with cache invalidation
    - `hover`: symbol info + JSDoc extraction
    - `diagnostics`: simple heuristics (TODO, any usage)
  - Naive glob walker for packages/**/*.ts

- `packages/server/src/symbols/semantic.ts`
  - Semantic awareness utilities
  - `analyzeEditImpact`: detects symbol name changes, counts references, assigns risk level
  - `guardEdit`: blocks high-risk edits, suggests using LSP rename instead

## Capabilities Implemented

1. **Symbol Resolution**: Regex-based parser for TS/JS constructs with export tracking
2. **Go-to-definition**: Finds symbol definition in file or workspace
3. **References**: Workspace-wide grep for symbol occurrences
4. **Hover**: Returns symbol kind, location, export status, JSDoc
5. **Diagnostics**: Basic lint heuristics (TODO, any)
6. **Rename**: Safe workspace rename with reference updating
7. **Semantic Awareness**: Edit impact analysis, risk scoring, guardrails integrated into 9-layer edit fallback
8. **Edit Integration**: Layer 8 of 9-layer fallback now uses LSP symbol awareness instead of stub

## Preservation
- Existing tool registry, edit tool, patch tool unchanged
- Backward compatible return shapes maintained
- No new external dependencies added
- LSP tool remains in `file` category with same schema (extended with optional symbol param)

## Notes
- Implementation uses lightweight regex parsing for speed, suitable for in-process symbol index
- Full LSP server integration (typescript-language-server) can be added later; current design provides drop-in replacement
- Symbol cache invalidated on rename to keep index fresh
