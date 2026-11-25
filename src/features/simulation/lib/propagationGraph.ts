import type { DominoDocument, Piece, SimulationEvent } from '@/shared/document'
import { nextContact } from '@/features/layout/lib/geometry'

/**
 * 传播图：把一次确定性模拟抽象为「元件 → 元件」的有向边。
 * 接触边由几何关系决定（与 propagate 完全同规则），机关边由连线决定。
 * 图是比对两次布局、做增量影响分析的唯一依据。
 */
export interface PropagationEdge {
  from: string
  to: string
  /** contact=物理接触传播，mechanism=机关连线传播 */
  type: 'contact' | 'mechanism'
}

export interface PropagationGraph {
  edges: PropagationEdge[]
  /** 每个元件在该布局下的物理接触目标（可能为 null，表示断链） */
  contactTarget: Map<string, string | null>
  adjacency: Map<string, PropagationEdge[]>
}

export function buildPropagationGraph(document: DominoDocument): PropagationGraph {
  const edges: PropagationEdge[] = []
  const contactTarget = new Map<string, string | null>()
  const adjacency = new Map<string, PropagationEdge[]>()

  const addEdge = (edge: PropagationEdge) => {
    edges.push(edge)
    const list = adjacency.get(edge.from) ?? []
    list.push(edge)
    adjacency.set(edge.from, list)
  }

  for (const piece of document.pieces) {
    const available = document.pieces.filter(item => item.id !== piece.id)
    const surfaceGrip = (document.scene.friction + piece.friction) / 2
    const reachScale = (0.94 + surfaceGrip * 0.35) * (1.25 - piece.fallThreshold * 0.25)
    let target: Piece | null = null
    if (piece.kind === 'ramp') {
      target = available.filter(item => item.x > piece.x && Math.abs(item.y - piece.y) < 2.1)
        .sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))[0] ?? null
    } else {
      target = nextContact(piece, available, reachScale)
    }
    contactTarget.set(piece.id, target?.id ?? null)
    if (target) addEdge({ from: piece.id, to: target.id, type: 'contact' })
  }

  for (const link of document.connections.filter(link => link.enabled)) {
    if (document.pieces.some(piece => piece.id === link.from)
      && document.pieces.some(piece => piece.id === link.to)) {
      addEdge({ from: link.from, to: link.to, type: 'mechanism' })
    }
  }

  return { edges, contactTarget, adjacency }
}

/** 从起点出发在图上做前向可达，返回可达元件集合（含起点） */
export function reachableFrom(graph: PropagationGraph, startId: string): Set<string> {
  const reachable = new Set<string>()
  const stack = [startId]
  while (stack.length) {
    const id = stack.pop()!
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const edge of graph.adjacency.get(id) ?? []) {
      if (!reachable.has(edge.to)) stack.push(edge.to)
    }
  }
  return reachable
}

/** 两个字符串集合的并集 */
export function unionSets(...sets: Set<string>[]): Set<string> {
  const merged = new Set<string>()
  for (const set of sets) for (const id of set) merged.add(id)
  return merged
}

/** 两个字符串集合的差集（a - b） */
export function differenceSets(a: Set<string>, b: Set<string>): Set<string> {
  const rest = new Set<string>()
  for (const id of a) if (!b.has(id)) rest.add(id)
  return rest
}

export interface ImpactAnalysis {
  /** 受改动影响、后缀必须重算的元件 id */
  affected: Set<string>
  /** 保留前缀中最后一个不受影响的已发生事件 id（可能为 null，表示从头重算） */
  boundaryEventId: string | null
  /** 人类可读的改动描述 */
  reasons: string[]
}

/**
 * 比较旧布局（上一次运行的快照）与新布局，计算受影响元件集合。
 *
 * 判定规则：
 * 1. 元件新增 / 删除 → 该元件受影响（删除则其旧事件自然落入重算区被移除）；
 * 2. 元件属性变化（位置、角度、尺寸、阈值、摩擦）→ 该元件受影响；
 * 3. 接触边或机关边变化 → 边的两端都受影响；
 * 4. 所有受影响元件在两张图上的前向可达下游并入受影响集合
 *    （共享枢纽改动因此会同时波及两条分支）；
 * 5. 只与起点可达范围相交的部分才真正需要重算。
 */
export function analyzeImpact(
  previous: DominoDocument,
  current: DominoDocument,
  previousEvents: readonly SimulationEvent[],
  previousGraph: PropagationGraph,
  currentGraph: PropagationGraph,
): ImpactAnalysis {
  const reasons: string[] = []
  const seeds = new Set<string>()
  const seed = (id: string, reason: string) => {
    if (!seeds.has(id)) {
      seeds.add(id)
      reasons.push(reason)
    }
  }

  const oldPieces = new Map(previous.pieces.map(piece => [piece.id, piece]))
  const newPieces = new Map(current.pieces.map(piece => [piece.id, piece]))

  // 1 & 2：元件级变化
  for (const [id, oldPiece] of oldPieces) {
    const newPiece = newPieces.get(id)
    if (!newPiece) {
      seed(id, `元件 ${id} 已删除`)
      continue
    }
    if (pieceSignature(oldPiece) !== pieceSignature(newPiece)) {
      seed(id, `元件 ${id}（${newPiece.label}）参数变化`)
    }
  }
  for (const id of newPieces.keys()) {
    if (!oldPieces.has(id)) seed(id, `元件 ${id} 为新增`)
  }

  // 3：边变化（接触边 + 机关边统一比较）
  const oldEdgeKeys = new Set(previousGraph.edges.map(edgeKey))
  const newEdgeKeys = new Set(currentGraph.edges.map(edgeKey))
  for (const edge of previousGraph.edges) {
    if (!newEdgeKeys.has(edgeKey(edge))) {
      seed(edge.from, `元件 ${edge.from} 的${edge.type === 'contact' ? '接触' : '机关'}出边移除`)
      seed(edge.to, `元件 ${edge.to} 的${edge.type === 'contact' ? '接触' : '机关'}入边移除`)
    }
  }
  for (const edge of currentGraph.edges) {
    if (!oldEdgeKeys.has(edgeKey(edge))) {
      seed(edge.from, `元件 ${edge.from} 的${edge.type === 'contact' ? '接触' : '机关'}出边新增`)
      seed(edge.to, `元件 ${edge.to} 的${edge.type === 'contact' ? '接触' : '机关'}入边新增`)
    }
  }

  // 场景参数变化会改变所有接触传播的耗时与可达半径，全量重算
  if (sceneSignature(previous) !== sceneSignature(current)) {
    for (const id of newPieces.keys()) seed(id, '场景参数变化，传播参数整体更新')
  }
  if (previous.startPieceId !== current.startPieceId) {
    seed(current.startPieceId, '触发起点变化')
  }

  // 4：前向波及（在两张图上都做，保证被删掉的下游也被纳入）
  const downstream = unionSets(
    ...[...seeds].map(id => reachableFrom(previousGraph, id)),
    ...[...seeds].map(id => reachableFrom(currentGraph, id)),
  )
  const affected = unionSets(seeds, downstream)

  // 5：只保留当前布局中仍存在、且从起点可达的元件
  const liveReachable = reachableFrom(currentGraph, current.startPieceId)
  for (const id of [...affected]) {
    if (!newPieces.has(id) || !liveReachable.has(id)) affected.delete(id)
  }

  // 边界事件：按时间排序的旧事件里，最后一个 pieceId 不在受影响集合的事件
  const ordered = [...previousEvents].sort(
    (a, b) => a.time - b.time || a.id.localeCompare(b.id),
  )
  let boundaryEventId: string | null = null
  for (const event of ordered) {
    if (!affected.has(event.pieceId)) boundaryEventId = event.id
    else break
  }

  return { affected, boundaryEventId, reasons: [...new Set(reasons)] }
}

function edgeKey(edge: PropagationEdge) {
  return `${edge.type}:${edge.from}->${edge.to}`
}

function pieceSignature(piece: Piece) {
  return JSON.stringify([
    piece.kind, piece.x, piece.y, piece.angle, piece.facing,
    piece.height, piece.width, piece.fallThreshold, piece.friction,
  ])
}

function sceneSignature(document: DominoDocument) {
  return JSON.stringify([document.scene.gravity, document.scene.friction])
}
