import { symbolIndex, getSymbolIndex } from "./index.js";

/**
 * Semantic awareness utilities for symbol-safe edits.
 * Provides checks before applying edits to avoid breaking references.
 */
export interface SemanticImpact {
  changedSymbols: string[];
  affectedReferences: number;
  risk: "low" | "medium" | "high";
}

export async function analyzeEditImpact(file: string, oldString: string, newString: string, cwd?: string): Promise<SemanticImpact> {
  // Determine if edit changes a symbol definition
  const changedSymbols: string[] = [];
  const symbolNameRegex = /\b([A-Za-z0-9_$]+)\s*(?:=|\(|{)/;
  const oldMatch = oldString.match(symbolNameRegex);
  const newMatch = newString.match(symbolNameRegex);
  const idx = cwd ? getSymbolIndex(cwd) : symbolIndex

  if (oldMatch && newMatch && oldMatch[1] !== newMatch[1]) {
    changedSymbols.push(oldMatch[1]);
    // Count references — workspace-aware
    const refs = await idx.findReferences(oldMatch[1], cwd);
    return {
      changedSymbols,
      affectedReferences: refs.length,
      risk: refs.length > 10 ? "high" : refs.length > 0 ? "medium" : "low",
    };
  }

  // Check if edit removes a symbol declaration entirely
  if (oldString.includes("export function") || oldString.includes("export const") || oldString.includes("class ")) {
    const nameMatch = oldString.match(/export\s+(?:function|const|class)\s+([A-Za-z0-9_$]+)/);
    if (nameMatch) {
      changedSymbols.push(nameMatch[1]);
      const refs = await idx.findReferences(nameMatch[1], cwd);
      return {
        changedSymbols,
        affectedReferences: refs.length,
        risk: refs.length > 0 ? "high" : "low",
      };
    }
  }

  return { changedSymbols, affectedReferences: 0, risk: "low" };
}

export async function guardEdit(file: string, oldString: string, newString: string, cwd?: string): Promise<{ allowed: boolean; reason?: string; impact?: SemanticImpact }> {
  const impact = await analyzeEditImpact(file, oldString, newString, cwd);
  if (impact.risk === "high") {
    return {
      allowed: false,
      reason: `Edit changes symbol ${impact.changedSymbols.join(", ")} with ${impact.affectedReferences} references. Use lsp rename operation instead.`,
      impact,
    };
  }
  return { allowed: true, impact };
}
