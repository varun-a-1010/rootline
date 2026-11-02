/**
 * Fit an Agentflow replay to its panel without overlapping labels.
 *
 * The viewer (contract 1.1.0) lays a run out as a tree and spaces its columns at
 * min(208, (frameWidth - 300) / depth) px. Every label gets a fixed 176 px box that starts 16 px
 * right of its node (26 px for the root), so when the columns are narrower than a label, labels on
 * the same row run into each other. requiredWidth() is the frame width at which the widest label
 * fits its column; when the panel is narrower, the viewer is laid out at that width and scaled down.
 *
 * This works around the hosted viewer's current layout. If the viewer starts fitting labels to
 * its columns itself, remove this fitting, or the deepest runs are shrunk twice.
 */
export interface FitNode {
  id: string;
  parentId: string | null;
  label: string;
}

/** 13 px label font: measured at about 5.5 to 6.3 px per character, so this errs wide. */
const CHAR_PX = 6.4;
const LABEL_BOX_PX = 176;
/** Label offset from its node (16 px) plus the next node's ring and a small gap. */
const CLEARANCE_PX = 30;
const ROOT_EXTRA_PX = 10;
const VIEWER_MARGIN_PX = 300;
const MIN_SCALE = 0.5;

export function treeDepth(nodes: FitNode[]): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let depth = 0;
  for (const n of nodes) {
    let d = 0;
    let p = n.parentId;
    while (p !== null && d < 100) {
      d += 1;
      p = byId.get(p)?.parentId ?? null;
    }
    depth = Math.max(depth, d);
  }
  return depth;
}

export function requiredWidth(nodes: FitNode[]): number {
  const depth = Math.max(1, treeDepth(nodes));
  const widest = Math.max(0, ...nodes.map((n) => Math.min(LABEL_BOX_PX, n.label.length * CHAR_PX) + (n.parentId === null ? ROOT_EXTRA_PX : 0)));
  return Math.ceil(VIEWER_MARGIN_PX + depth * (widest + CLEARANCE_PX));
}

/** 1 when the panel is wide enough; otherwise the factor that shrinks the required width to fit. */
export function fitScale(required: number, available: number): number {
  if (available <= 0 || required <= available) return 1;
  return Math.max(MIN_SCALE, available / required);
}
