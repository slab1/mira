export type SymbolKind = "function" | "class" | "interface" | "type" | "const" | "let" | "var" | "import" | "export" | "enum" | "variable";

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  character: number;
  export: boolean;
  doc?: string;
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

export interface DefinitionResult {
  symbol: SymbolInfo | null;
  locations: Array<{ file: string; line: number; character: number }>;
}

export interface ReferenceResult {
  symbol: string;
  occurrences: Array<{ file: string; line: number; character: number }>;
}

export interface HoverResult {
  contents: string;
  symbol?: SymbolInfo;
}

export interface RenameResult {
  renamedFiles: string[];
  occurrences: number;
}
