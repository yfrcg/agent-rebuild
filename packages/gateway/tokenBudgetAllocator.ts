/**
 * ?????CS336 ???
 * ???packages/gateway/tokenBudgetAllocator.ts
 * ???Gateway ?????
 * ??????? Agent ?????????????????????
 * ???????????????????????????????????? README ????????????????
 */
export interface LayerBudget {
  layer: string;
  tokenBudget: number;
  priority: number;
}

export interface BudgetAllocation {
  layers: LayerBudget[];
  totalAllocated: number;
  totalBudget: number;
  reserveTokens: number;
}

const LAYER_DEFINITIONS: Array<{ layer: string; ratio: number; priority: number }> = [
  { layer: "system", ratio: 0.20, priority: 1 },
  { layer: "project_context", ratio: 0.15, priority: 2 },
  { layer: "memory", ratio: 0.10, priority: 3 },
  { layer: "transcript", ratio: 0.25, priority: 4 },
  { layer: "current_input", ratio: 0.10, priority: 5 },
  { layer: "tool_results", ratio: 0.10, priority: 6 },
  { layer: "reserve", ratio: 0.10, priority: 7 },
];

export function allocateTokenBudget(totalBudget: number): BudgetAllocation {
  const layers: LayerBudget[] = [];
  let totalAllocated = 0;

  for (const def of LAYER_DEFINITIONS) {
    const tokenBudget = Math.floor(totalBudget * def.ratio);
    layers.push({
      layer: def.layer,
      tokenBudget,
      priority: def.priority,
    });
    totalAllocated += tokenBudget;
  }

  const reserveLayer = layers.find((l) => l.layer === "reserve");
  const reserveTokens = reserveLayer?.tokenBudget ?? Math.floor(totalBudget * 0.1);

  return {
    layers,
    totalAllocated,
    totalBudget,
    reserveTokens,
  };
}

export function getLayerBudget(allocation: BudgetAllocation, layerName: string): number {
  const layer = allocation.layers.find((l) => l.layer === layerName);
  return layer?.tokenBudget ?? 0;
}

export function redistributeUnused(allocation: BudgetAllocation, usedByLayer: Record<string, number>): BudgetAllocation {
  const newLayers = allocation.layers.map((l) => ({ ...l }));
  let unused = 0;

  for (const layer of newLayers) {
    if (layer.layer === "reserve") continue;
    const used = usedByLayer[layer.layer] ?? 0;
    const remaining = layer.tokenBudget - used;
    if (remaining > 0) {
      unused += remaining;
    }
  }

  const adjustable = newLayers.filter((l) => l.layer !== "reserve");
  const totalRatio = adjustable.reduce((sum, l) => sum + l.tokenBudget, 0);

  for (const layer of adjustable) {
    const share = totalRatio > 0 ? (layer.tokenBudget / totalRatio) * unused : 0;
    layer.tokenBudget += Math.floor(share);
  }

  return {
    layers: newLayers,
    totalAllocated: newLayers.reduce((sum, l) => sum + l.tokenBudget, 0),
    totalBudget: allocation.totalBudget,
    reserveTokens: allocation.reserveTokens,
  };
}
