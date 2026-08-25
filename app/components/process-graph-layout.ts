import type { LocalStep } from "./process-template-shared";

// Layout spike finding (6A): reconvergent conditional branches need no
// special handling — they render fine as ordinary rows with multiple
// edges converging on one node, because `steps` is already a valid forward
// topological order (the editor only ever offers targets later in the
// list). The one case that benefits from real layout work is a parallel
// split/join region, where branches should read as side-by-side lanes
// rather than stacked rows. That region is bounded and non-nested by the
// domain's own validation rules, so lane assignment is a small, contained
// walk — not general graph layout. Hence: custom SVG, no layout library.

export type GraphNodeLayout = {
  key: string;
  rank: number;
  lane: number;
  x: number;
  y: number;
};

export type GraphEdgeLayout = {
  id: string;
  sourceKey: string;
  targetKey: string;
  isDefault: boolean;
  isParallel: boolean;
  approvalOutcomeLabel?: string;
};

export type GraphLayout = {
  nodes: GraphNodeLayout[];
  edges: GraphEdgeLayout[];
  width: number;
  height: number;
};

export const GRAPH_NODE_WIDTH = 200;
export const GRAPH_NODE_HEIGHT = 84;
const COLUMN_WIDTH = 236;
const ROW_HEIGHT = 128;
const CANVAS_PADDING = 32;

function findMatchingJoinKey(steps: LocalStep[], split: LocalStep): string | undefined {
  return steps.find(
    (candidate) =>
      candidate.nodeType === "parallel_join" && candidate.parallelGroupId === split.parallelGroupId,
  )?.key;
}

function assignLanes(steps: LocalStep[]): Map<string, number> {
  const laneByKey = new Map<string, number>(steps.map((step) => [step.key, 0]));
  const stepByKey = new Map(steps.map((step) => [step.key, step]));

  for (const step of steps) {
    if (step.nodeType !== "parallel_split") {
      continue;
    }

    const joinKey = findMatchingJoinKey(steps, step);
    const branchRoutes = step.routes.filter((route) => route.isParallel);

    branchRoutes.forEach((branchRoute, branchIndex) => {
      let currentKey: string | undefined = branchRoute.targetStepKey;
      const visited = new Set<string>();

      while (currentKey && currentKey !== joinKey && !visited.has(currentKey)) {
        visited.add(currentKey);
        laneByKey.set(currentKey, branchIndex);

        const currentStep: LocalStep | undefined = stepByKey.get(currentKey);
        const nextRoute = currentStep?.routes.find((route) => route.isDefault) ?? currentStep?.routes[0];

        currentKey = nextRoute?.targetStepKey;
      }
    });
  }

  return laneByKey;
}

export function computeProcessGraphLayout(steps: LocalStep[]): GraphLayout {
  const laneByKey = assignLanes(steps);
  const indexByKey = new Map(steps.map((step, index) => [step.key, index]));

  const nodes: GraphNodeLayout[] = steps.map((step, index) => {
    const lane = laneByKey.get(step.key) ?? 0;

    return {
      key: step.key,
      rank: index,
      lane,
      x: CANVAS_PADDING + lane * COLUMN_WIDTH,
      y: CANVAS_PADDING + index * ROW_HEIGHT,
    };
  });

  const edges: GraphEdgeLayout[] = steps.flatMap((step) =>
    step.routes
      .filter((route) => route.targetStepKey && indexByKey.has(route.targetStepKey))
      .map((route) => ({
        id: route.id,
        sourceKey: step.key,
        targetKey: route.targetStepKey,
        isDefault: route.isDefault,
        isParallel: route.isParallel,
        approvalOutcomeLabel: route.approvalOutcomeLabel,
      })),
  );

  const maxLane = nodes.reduce((max, node) => Math.max(max, node.lane), 0);
  const width = CANVAS_PADDING * 2 + GRAPH_NODE_WIDTH + maxLane * COLUMN_WIDTH;
  const height =
    CANVAS_PADDING * 2 + (steps.length > 0 ? (steps.length - 1) * ROW_HEIGHT + GRAPH_NODE_HEIGHT : GRAPH_NODE_HEIGHT);

  return { nodes, edges, width, height };
}
