import type { ProcessNodeType } from "@/lib/domain/process-types";

// The layout algorithm only ever reads this minimal shape — never the rest
// of a template's LocalStep (waitAmount, dueAmount, etc.) or a run's
// ProcessStepRun (status, assignee, config, ...). Narrowing the parameter
// to exactly what's used lets both the template editor's LocalStep[] and
// the process-run view's mapped runtime steps satisfy it structurally,
// with zero change to the algorithm itself — see 6C's plan for why this
// is a safe, purely mechanical refactor (LocalStep already has every field
// below, so every existing call site is unaffected).
export type GraphLayoutRoute = {
  id: string;
  targetStepKey: string;
  isDefault: boolean;
  isParallel: boolean;
  approvalOutcomeLabel?: string;
};

export type GraphLayoutStep = {
  key: string;
  nodeType: ProcessNodeType;
  parallelGroupId?: string;
  routes: GraphLayoutRoute[];
};

// Layout spike finding (6A): reconvergent conditional branches need no
// special handling — they render fine as ordinary rows with multiple
// edges converging on one node, because `steps` is already a valid forward
// topological order (the editor only ever offers targets later in the
// list). The one case that benefits from real layout work is a parallel
// split/join region, where branches should read as side-by-side lanes
// rather than stacked rows. That region is bounded and non-nested by the
// domain's own validation rules, so lane assignment is a small, contained
// walk — not general graph layout. Hence: custom SVG, no layout library.
//
// 6B addition: an edge whose source and target share a lane but aren't
// adjacent ranks would otherwise draw a straight vertical line through
// every node card in between (the known occlusion issue). Rather than
// general obstacle-avoidance routing, such edges jog out to one shared
// "gutter" column past every lane in use, which is clear of every node
// card by construction, and jog back in at the target. This is a bounded,
// deterministic path choice, not a layout algorithm — it does not attempt
// to keep multiple simultaneous gutter edges from overlapping each other
// in that shared column. That remains a known, deferred cosmetic gap; the
// occlusion case (a card obscuring an edge) is what's fixed here.

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
  path: string;
  labelX: number;
  labelY: number;
  insertX: number;
  insertY: number;
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
const GUTTER_MARGIN = 56;

function findMatchingJoinKey(steps: GraphLayoutStep[], split: GraphLayoutStep): string | undefined {
  return steps.find(
    (candidate) =>
      candidate.nodeType === "parallel_join" && candidate.parallelGroupId === split.parallelGroupId,
  )?.key;
}

function assignLanes(steps: GraphLayoutStep[]): Map<string, number> {
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

        const currentStep: GraphLayoutStep | undefined = stepByKey.get(currentKey);
        const nextRoute = currentStep?.routes.find((route) => route.isDefault) ?? currentStep?.routes[0];

        currentKey = nextRoute?.targetStepKey;
      }
    });
  }

  return laneByKey;
}

export type GraphLayoutOptions = {
  nodeWidth?: number;
  nodeHeight?: number;
  rowHeight?: number;
};

// nodeWidth/nodeHeight/rowHeight default to the template editor's
// dimensions, so every existing caller is unaffected. The process-run
// graph view (6C) passes taller cards — its cards carry more context
// (status, assignee, due/wait state) than a template step ever needs to.
export function computeProcessGraphLayout(
  steps: GraphLayoutStep[],
  options?: GraphLayoutOptions,
): GraphLayout {
  const nodeWidth = options?.nodeWidth ?? GRAPH_NODE_WIDTH;
  const nodeHeight = options?.nodeHeight ?? GRAPH_NODE_HEIGHT;
  const rowHeight = options?.rowHeight ?? ROW_HEIGHT;

  const laneByKey = assignLanes(steps);
  const indexByKey = new Map(steps.map((step, index) => [step.key, index]));

  const nodes: GraphNodeLayout[] = steps.map((step, index) => {
    const lane = laneByKey.get(step.key) ?? 0;

    return {
      key: step.key,
      rank: index,
      lane,
      x: CANVAS_PADDING + lane * COLUMN_WIDTH,
      y: CANVAS_PADDING + index * rowHeight,
    };
  });
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));

  const maxLane = nodes.reduce((max, node) => Math.max(max, node.lane), 0);
  const gutterX = CANVAS_PADDING + nodeWidth + maxLane * COLUMN_WIDTH + GUTTER_MARGIN;
  let usesGutter = false;

  const edges: GraphEdgeLayout[] = steps.flatMap((step) =>
    step.routes
      .filter((route) => route.targetStepKey && indexByKey.has(route.targetStepKey))
      .map((route) => {
        const sourceNode = nodeByKey.get(step.key)!;
        const targetNode = nodeByKey.get(route.targetStepKey)!;
        const sourceIndex = indexByKey.get(step.key)!;
        const targetIndex = indexByKey.get(route.targetStepKey)!;
        const sameLane = sourceNode.lane === targetNode.lane;
        const skipsRank = targetIndex > sourceIndex + 1;

        const x1 = sourceNode.x + nodeWidth / 2;
        const y1 = sourceNode.y + nodeHeight;
        const x2 = targetNode.x + nodeWidth / 2;
        const y2 = targetNode.y;

        let path: string;
        let labelX: number;
        let labelY: number;
        let insertX: number;
        let insertY: number;

        if (sameLane && skipsRank) {
          usesGutter = true;

          const gy1 = sourceNode.y + nodeHeight / 2;
          const gy2 = targetNode.y + nodeHeight / 2;

          path = `M ${x1} ${y1} L ${x1} ${gy1} L ${gutterX} ${gy1} L ${gutterX} ${gy2} L ${x2} ${gy2} L ${x2} ${y2}`;
          labelX = gutterX;
          labelY = (gy1 + gy2) / 2 - 6;
          insertX = gutterX;
          insertY = (gy1 + gy2) / 2 + 12;
        } else {
          const midY = (y1 + y2) / 2;

          path = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
          labelX = (x1 + x2) / 2;
          labelY = midY - 6;
          insertX = (x1 + x2) / 2;
          insertY = midY + 12;
        }

        return {
          id: route.id,
          sourceKey: step.key,
          targetKey: route.targetStepKey,
          isDefault: route.isDefault,
          isParallel: route.isParallel,
          approvalOutcomeLabel: route.approvalOutcomeLabel,
          path,
          labelX,
          labelY,
          insertX,
          insertY,
        };
      }),
  );

  const width =
    CANVAS_PADDING * 2 +
    nodeWidth +
    maxLane * COLUMN_WIDTH +
    (usesGutter ? GUTTER_MARGIN + CANVAS_PADDING : 0);
  const height =
    CANVAS_PADDING * 2 + (steps.length > 0 ? (steps.length - 1) * rowHeight + nodeHeight : nodeHeight);

  return { nodes, edges, width, height };
}
