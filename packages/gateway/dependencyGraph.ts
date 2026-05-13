/**
 * ?????CS336 ???
 * ???packages/gateway/dependencyGraph.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface DepNode {
  filePath: string;
  relativePath: string;
  imports: string[];
  exports: string[];
}

export interface DepEdge {
  from: string;
  to: string;
  kind: "import" | "require" | "dynamic";
}

export interface DepGraph {
  nodes: Map<string, DepNode>;
  edges: DepEdge[];
  roots: string[];
  leaves: string[];
  cycles: string[][];
}

const IMPORT_RE = [
  { re: /import\s+.*?from\s+['"]([^'"]+)['"]/g, kind: "import" as const },
  { re: /import\s+['"]([^'"]+)['"]/g, kind: "import" as const },
  { re: /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: "require" as const },
  { re: /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: "dynamic" as const },
  { re: /from\s+(\S+)\s+import/g, kind: "import" as const },
];

const SUPPORTED_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cjs", ".py"]);

export function extractImports(filePath: string, content?: string): Array<{ specifier: string; kind: "import" | "require" | "dynamic" }> {
  let text = content;
  if (text === undefined) {
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      return [];
    }
  }

  const results: Array<{ specifier: string; kind: "import" | "require" | "dynamic" }> = [];
  const seen = new Set<string>();

  for (const { re, kind } of IMPORT_RE) {
    const regex = new RegExp(re.source, re.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const specifier = match[1];
      if (specifier && !seen.has(specifier)) {
        seen.add(specifier);
        results.push({ specifier, kind });
      }
    }
  }

  return results;
}

export function resolveImportPath(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return undefined;
  }

  const importerDir = path.dirname(importer);
  const ext = path.extname(importer);
  const candidateBase = path.resolve(importerDir, specifier);

  const extensions = [ext, ".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs"];
  for (const e of extensions) {
    const candidate = candidateBase + e;
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  for (const e of extensions) {
    const candidate = path.join(candidateBase, `index${e}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

export function buildDependencyGraph(root: string, filePaths: string[]): DepGraph {
  const nodes = new Map<string, DepNode>();
  const edges: DepEdge[] = [];
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();

  for (const filePath of filePaths) {
    if (!SUPPORTED_EXTS.has(path.extname(filePath).toLowerCase())) continue;

    const imports = extractImports(filePath);
    const depNode: DepNode = {
      filePath,
      relativePath: path.relative(root, filePath),
      imports: imports.map((i) => i.specifier),
      exports: [],
    };
    nodes.set(filePath, depNode);

    if (!inDegree.has(filePath)) inDegree.set(filePath, 0);
    if (!outDegree.has(filePath)) outDegree.set(filePath, 0);

    for (const imp of imports) {
      const resolved = resolveImportPath(filePath, imp.specifier);
      if (resolved && nodes.has(resolved) || filePaths.includes(resolved!)) {
        const targetPath = resolved!;
        edges.push({ from: filePath, to: targetPath, kind: imp.kind });
        outDegree.set(filePath, (outDegree.get(filePath) ?? 0) + 1);
        inDegree.set(targetPath, (inDegree.get(targetPath) ?? 0) + 1);
      }
    }
  }

  const roots: string[] = [];
  const leaves: string[] = [];

  for (const [filePath] of nodes) {
    if ((inDegree.get(filePath) ?? 0) === 0) roots.push(filePath);
    if ((outDegree.get(filePath) ?? 0) === 0) leaves.push(filePath);
  }

  const cycles = detectCycles(nodes, edges);

  return { nodes, edges, roots, leaves, cycles };
}

function detectCycles(nodes: Map<string, DepNode>, edges: DepEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const [filePath] of nodes) {
    adjacency.set(filePath, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push(path.slice(cycleStart).concat(node));
      }
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const neighbor of adjacency.get(node) ?? []) {
      dfs(neighbor);
    }

    path.pop();
    inStack.delete(node);
  }

  for (const [filePath] of nodes) {
    if (!visited.has(filePath)) {
      dfs(filePath);
    }
  }

  return cycles.slice(0, 20);
}

export function formatDepGraph(graph: DepGraph, maxNodes = 30): string {
  const lines: string[] = [];

  lines.push(`Dependency Graph: ${graph.nodes.size} files, ${graph.edges.length} edges`);
  lines.push(`Root files (no incoming deps): ${graph.roots.length}`);
  lines.push(`Leaf files (no outgoing deps): ${graph.leaves.length}`);

  if (graph.cycles.length > 0) {
    lines.push(`\n⚠️ Circular dependencies detected: ${graph.cycles.length}`);
    for (const cycle of graph.cycles.slice(0, 5)) {
      lines.push(`  ${cycle.map((f) => path.basename(f)).join(" → ")}`);
    }
  }

  const nodeEntries = [...graph.nodes.entries()].sort((a, b) => {
    const aDeps = (graph.edges.filter((e) => e.from === a[0]).length);
    const bDeps = (graph.edges.filter((e) => e.from === b[0]).length);
    return bDeps - aDeps;
  });

  lines.push("\nTop files by dependency count:");
  let count = 0;
  for (const [filePath, node] of nodeEntries) {
    if (count >= maxNodes) break;
    const outEdges = graph.edges.filter((e) => e.from === filePath);
    const inEdges = graph.edges.filter((e) => e.to === filePath);
    if (outEdges.length > 0 || inEdges.length > 0) {
      lines.push(`  ${node.relativePath}: imports ${outEdges.length}, imported by ${inEdges.length}`);
      count++;
    }
  }

  return lines.join("\n");
}
