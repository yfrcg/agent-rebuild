import * as fs from "node:fs";
import * as path from "node:path";

export interface SymbolInfo {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "enum" | "export" | "import";
  line: number;
  column?: number;
  endLine?: number;
  signature?: string;
  modifiers?: string[];
  filePath?: string;
}

const TS_FUNCTION_RE = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
const TS_ARROW_RE = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/;
const TS_ARROW2_RE = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>/;
const TS_CLASS_RE = /^(?:export\s+)?(?:(?:abstract|default)\s+)?class\s+(\w+)/;
const TS_INTERFACE_RE = /^(?:export\s+)?interface\s+(\w+)/;
const TS_TYPE_RE = /^(?:export\s+)?type\s+(\w+)/;
const TS_ENUM_RE = /^(?:export\s+)?(?:(?:const)\s+)?enum\s+(\w+)/;
const TS_CONST_RE = /^(?:export\s+)?(?:const|let)\s+(\w+)\s*[=:]/;
const TS_IMPORT_RE = /^import\s+/;
const TS_EXPORT_RE = /^export\s+/;
const TS_METHOD_RE = /^\s+(?:(?:public|private|protected|static|abstract|override|async|readonly)\s+)*(\w+)\s*\(/;
const TS_PROP_RE = /^\s+(?:(?:public|private|protected|static|readonly)\s+)*(\w+)\s*[?]?\s*:/;
const PY_FUNCTION_RE = /^(?:async\s+)?def\s+(\w+)/;
const PY_CLASS_RE = /^class\s+(\w+)/;
const PY_IMPORT_RE = /^(?:from\s+\S+\s+)?import\s+/;

export function extractSymbols(filePath: string, content?: string): SymbolInfo[] {
  let text = content;
  if (text === undefined) {
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      return [];
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const lines = text.split("\n");
  const symbols: SymbolInfo[] = [];

  if ([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cjs"].includes(ext)) {
    extractTsSymbols(lines, symbols);
  } else if ([".py"].includes(ext)) {
    extractPySymbols(lines, symbols);
  }

  for (const sym of symbols) {
    sym.filePath = filePath;
  }

  return symbols;
}

function extractTsSymbols(lines: string[], symbols: SymbolInfo[]): void {
  let braceDepth = 0;
  let currentClass: string | undefined;
  let classStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;

    for (const ch of line) {
      if (ch === "{") braceDepth++;
      if (ch === "}") braceDepth--;
    }

    if (braceDepth <= 1) {
      currentClass = undefined;
    }

    let match: RegExpMatchArray | null;

    match = trimmed.match(TS_CLASS_RE);
    if (match) {
      const modifiers: string[] = [];
      if (trimmed.includes("abstract")) modifiers.push("abstract");
      if (trimmed.includes("default")) modifiers.push("default");
      if (trimmed.includes("export")) modifiers.push("export");
      symbols.push({ name: match[1], kind: "class", line: i + 1, modifiers, signature: trimmed });
      currentClass = match[1];
      classStartLine = i + 1;
      continue;
    }

    match = trimmed.match(TS_INTERFACE_RE);
    if (match) {
      symbols.push({ name: match[1], kind: "interface", line: i + 1, signature: trimmed });
      continue;
    }

    match = trimmed.match(TS_TYPE_RE);
    if (match) {
      symbols.push({ name: match[1], kind: "type", line: i + 1, signature: trimmed });
      continue;
    }

    match = trimmed.match(TS_ENUM_RE);
    if (match) {
      symbols.push({ name: match[1], kind: "enum", line: i + 1, signature: trimmed });
      continue;
    }

    match = trimmed.match(TS_FUNCTION_RE);
    if (match) {
      const modifiers: string[] = [];
      if (trimmed.includes("async")) modifiers.push("async");
      if (trimmed.includes("export")) modifiers.push("export");
      symbols.push({ name: match[1], kind: "function", line: i + 1, modifiers, signature: trimmed });
      continue;
    }

    match = trimmed.match(TS_ARROW_RE) ?? trimmed.match(TS_ARROW2_RE);
    if (match) {
      const modifiers: string[] = [];
      if (trimmed.includes("async")) modifiers.push("async");
      if (trimmed.includes("export")) modifiers.push("export");
      symbols.push({ name: match[1], kind: "const", line: i + 1, modifiers, signature: trimmed });
      continue;
    }

    match = trimmed.match(TS_CONST_RE);
    if (match && !trimmed.includes("(") && !trimmed.includes("=>")) {
      symbols.push({ name: match[1], kind: "const", line: i + 1, signature: trimmed });
      continue;
    }

    if (currentClass && braceDepth >= 2) {
      const methodMatch = trimmed.match(TS_METHOD_RE);
      if (methodMatch) {
        symbols.push({ name: methodMatch[1], kind: "function", line: i + 1, signature: trimmed });
        continue;
      }
    }

    if (trimmed.match(TS_IMPORT_RE)) {
      symbols.push({ name: trimmed.slice(0, 80), kind: "import", line: i + 1 });
      continue;
    }

    if (trimmed.match(TS_EXPORT_RE) && !trimmed.match(TS_CLASS_RE) && !trimmed.match(TS_FUNCTION_RE) && !trimmed.match(TS_INTERFACE_RE) && !trimmed.match(TS_TYPE_RE) && !trimmed.match(TS_ENUM_RE)) {
      symbols.push({ name: trimmed.slice(0, 80), kind: "export", line: i + 1 });
    }
  }
}

function extractPySymbols(lines: string[], symbols: SymbolInfo[]): void {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed.startsWith("#")) continue;

    let match: RegExpMatchArray | null;

    match = trimmed.match(PY_CLASS_RE);
    if (match) {
      symbols.push({ name: match[1], kind: "class", line: i + 1, signature: trimmed });
      continue;
    }

    match = trimmed.match(PY_FUNCTION_RE);
    if (match) {
      const modifiers: string[] = [];
      if (trimmed.includes("async")) modifiers.push("async");
      symbols.push({ name: match[1], kind: "function", line: i + 1, modifiers, signature: trimmed });
      continue;
    }

    match = trimmed.match(PY_IMPORT_RE);
    if (match) {
      symbols.push({ name: trimmed.slice(0, 80), kind: "import", line: i + 1 });
    }
  }
}

export function formatSymbols(symbols: SymbolInfo[], maxItems = 50): string {
  const lines: string[] = [];
  let count = 0;

  const grouped = new Map<string, SymbolInfo[]>();
  for (const sym of symbols) {
    const key = sym.filePath ?? "unknown";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(sym);
  }

  for (const [filePath, syms] of grouped) {
    const relPath = filePath;
    lines.push(`\n${relPath}:`);
    for (const sym of syms) {
      if (count >= maxItems) {
        lines.push(`  ... (${symbols.length - count} more symbols)`);
        return lines.join("\n");
      }
      const kindTag = `[${sym.kind}]`;
      const modStr = sym.modifiers?.length ? `{${sym.modifiers.join(",")}} ` : "";
      lines.push(`  L${sym.line} ${kindTag} ${modStr}${sym.name}`);
      count++;
    }
  }

  return lines.join("\n");
}
