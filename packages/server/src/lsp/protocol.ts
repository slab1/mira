/**
 * LSP 3.17 Protocol Types — JSON-RPC 2.0 over Content-Length framing
 * Mirrors https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
 */

export interface Position {
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export interface Location {
  uri: string
  range: Range
}

export interface LocationLink {
  targetUri: string
  targetRange: Range
  targetSelectionRange: Range
  originSelectionRange?: Range
}

export interface TextEdit {
  range: Range
  newText: string
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>
  documentChanges?: Array<{
    textDocument: { uri: string; version: number | null }
    edits: TextEdit[]
  }>
}

export enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

export interface SymbolInformation {
  name: string
  kind: SymbolKind
  location: Location
  containerName?: string
  tags?: number[]
  deprecated?: boolean
}

export interface DocumentSymbol {
  name: string
  detail?: string
  kind: SymbolKind
  range: Range
  selectionRange: Range
  children?: DocumentSymbol[]
}

export interface Diagnostic {
  range: Range
  severity?: number
  code?: number | string
  source?: string
  message: string
  relatedInformation?: Array<{ location: Location; message: string }>
}

export interface PrepareRenameResult {
  range: Range
  placeholder: string
}

export interface HoverContents {
  kind?: string
  value?: string
  language?: string
}

export interface Hover {
  contents: HoverContents | HoverContents[] | { kind: string; value: string }
  range?: Range
}

// JSON-RPC 2.0 envelopes
export interface RequestMessage {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export interface ResponseMessage {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface NotificationMessage {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type LSPMessage = RequestMessage | ResponseMessage | NotificationMessage

// Server capabilities (subset)
export interface ServerCapabilities {
  textDocumentSync?: number | object
  hoverProvider?: boolean | object
  definitionProvider?: boolean | object
  referencesProvider?: boolean | object
  renameProvider?: boolean | object | { prepareProvider: boolean }
  documentSymbolProvider?: boolean | object
  workspaceSymbolProvider?: boolean | object
  diagnosticProvider?: boolean | object
  [key: string]: unknown
}

export interface InitializeResult {
  capabilities: ServerCapabilities
  serverInfo?: { name: string; version?: string }
}
