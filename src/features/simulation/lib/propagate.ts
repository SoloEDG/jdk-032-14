import type { DominoDocument, SimulationEvent } from '@/shared/document'
import { nextContact } from '@/features/layout/lib/geometry'

interface Scheduled {
  pieceId: string
  time: number
  causeId: string | null
  detail: string
}

export class SimulationCancelledError extends Error {
  constructor() {
    super('SIMULATION_CANCELLED')
    this.name = 'SimulationCancelledError'
  }
}

export interface StepOptions {
  /** 每个让出点调用一次（UI 环境用于 await 一帧，测试环境可注入微任务） */
  onYield?: () => Promise<void>
  /** 返回 true 时引擎在下一个安全点抛出 SimulationCancelledError，已产生的事件全部丢弃 */
  shouldCancel?: () => boolean
}

export interface PropagationResult {
  events: SimulationEvent[]
  interruptedPieceId: string | null
  interruptionReason: string | null
  reachedTrigger: boolean
  status: 'complete' | 'interrupted' | 'empty'
  duration: number
}

interface EngineState {
  queue: Scheduled[]
  fallen: Set<string>
  events: SimulationEvent[]
  interruptedPieceId: string | null
  interruptionReason: string | null
  reachedTrigger: boolean
  seq: number
  /** 受影响元件集合：为空表示全量运行，所有新事件均为 recomputed */
  affected: ReadonlySet<string> | null
  /** 增量运行时，未受影响元件若被引擎重新处理，沿用其前缀事件的布局版本 */
  retainedRevisions: Map<string, number>
}

const YIELD_EVERY = 8

function newState(affected: ReadonlySet<string> | null = null): EngineState {
  return {
    queue: [],
    fallen: new Set<string>(),
    events: [],
    interruptedPieceId: null,
    interruptionReason: null,
    reachedTrigger: false,
    seq: 0,
    affected,
    retainedRevisions: new Map<string, number>(),
  }
}

/**
 * 事件来源判定：全量运行（affected 为 null）一律 recomputed；
 * 增量续算时，受影响元件产生 recomputed 事件，其余为 retained。
 */
function originFor(state: EngineState, pieceId: string): SimulationEvent['origin'] {
  if (!state.affected) return 'recomputed'
  return state.affected.has(pieceId) ? 'recomputed' : 'retained'
}

/** 事件对应的布局版本：重算事件用当前版本，保留语义事件沿用其原始版本 */
function revisionFor(state: EngineState, pieceId: string, currentRevision: number): number {
  if (!state.affected || state.affected.has(pieceId)) return currentRevision
  return state.retainedRevisions.get(pieceId) ?? currentRevision
}

function pushEvent(
  state: EngineState,
  fields: Omit<SimulationEvent, 'id' | 'origin' | 'layoutRevision'>,
  origin: SimulationEvent['origin'],
  layoutRevision: number,
): SimulationEvent {
  state.seq += 1
  const event: SimulationEvent = { id: `event-${state.seq}`, ...fields, origin, layoutRevision }
  state.events.push(event)
  return event
}

/**
 * 传播引擎主循环。全量运行与增量续算共用同一套物理规则，
 * 区别只在于初始 state：全量从起点事件开始，增量从裁剪边界的队列开始。
 */
async function runLoop(
  document: DominoDocument,
  state: EngineState,
  layoutRevision: number,
  opts: StepOptions = {},
): Promise<PropagationResult> {
  let stepsSinceYield = 0
  while (state.queue.length && state.events.length < document.pieces.length * 3) {
    if (opts.shouldCancel?.()) throw new SimulationCancelledError()
    if (opts.onYield && stepsSinceYield >= YIELD_EVERY) {
      stepsSinceYield = 0
      await opts.onYield()
      if (opts.shouldCancel?.()) throw new SimulationCancelledError()
    }
    stepsSinceYield += 1

    state.queue.sort((a, b) => a.time - b.time || a.pieceId.localeCompare(b.pieceId)
      || (a.causeId ?? '').localeCompare(b.causeId ?? ''))
    const next = state.queue.shift()!
    const piece = document.pieces.find(item => item.id === next.pieceId)
    if (!piece || state.fallen.has(piece.id)) continue

    const origin = originFor(state, piece.id)
    const revision = revisionFor(state, piece.id, layoutRevision)
    if (piece.kind === 'trigger') {
      const event = pushEvent(state, {
        pieceId: piece.id, time: next.time, causeId: next.causeId,
        kind: 'mechanism', detail: `触发器响应 · ${next.detail}`,
      }, origin, revision)
      state.reachedTrigger = true
      for (const link of document.connections.filter(link => link.from === piece.id && link.enabled)) {
        state.queue.push({ pieceId: link.to, time: next.time + link.delay, causeId: event.id, detail: '机关连线' })
      }
      continue
    }

    state.fallen.add(piece.id)
    const event = pushEvent(state, {
      pieceId: piece.id, time: next.time, causeId: next.causeId,
      kind: piece.kind === 'splitter' ? 'mechanism' : 'fall',
      detail: piece.kind === 'splitter' ? `分岔展开 · ${next.detail}`
        : piece.kind === 'ramp' ? `坡道传递 · ${next.detail}` : `受力倒下 · ${next.detail}`,
    }, origin, revision)

    for (const link of document.connections.filter(link => link.from === piece.id && link.enabled)) {
      state.queue.push({ pieceId: link.to, time: next.time + link.delay, causeId: event.id, detail: '机关连线' })
    }

    const available = document.pieces.filter(item => !state.fallen.has(item.id) && item.id !== piece.id)
    const surfaceGrip = (document.scene.friction + piece.friction) / 2
    const reachScale = (0.94 + surfaceGrip * 0.35) * (1.25 - piece.fallThreshold * 0.25)
    let target = null
    if (piece.kind === 'ramp') {
      target = available.filter(item => item.x > piece.x && Math.abs(item.y - piece.y) < 2.1)
        .sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))[0] ?? null
    } else {
      target = nextContact(piece, available, reachScale)
    }
    if (target) {
      const separation = Math.hypot(piece.x - target.x, piece.y - target.y)
      const speed = Math.max(1.8, piece.height * document.scene.gravity / 2) * (0.75 + surfaceGrip * 0.5)
      const travel = Math.max(0.24, separation / speed)
      state.queue.push({
        pieceId: target.id, time: next.time + travel, causeId: event.id,
        detail: piece.kind === 'splitter' ? '分岔臂接触' : piece.kind === 'ramp' ? '坡面末端接触' : '相邻接触',
      })
    }

    const hasConnection = document.connections.some(link => link.from === piece.id && link.enabled)
    if (!target && !hasConnection && state.interruptedPieceId === null) {
      state.interruptedPieceId = piece.id
      state.interruptionReason = '倒下方向内没有可触达的元件，链路在此停止。'
      pushEvent(state, {
        pieceId: piece.id, time: next.time + 0.05, causeId: event.id,
        kind: 'interrupted', detail: state.interruptionReason,
      }, origin, revision)    }
  }

  return finalize(state)
}

function finalize(state: EngineState): PropagationResult {
  return {
    events: state.events,
    interruptedPieceId: state.interruptedPieceId,
    interruptionReason: state.interruptionReason,
    reachedTrigger: state.reachedTrigger,
    status: state.events.length === 0 ? 'empty'
      : state.interruptedPieceId || !state.reachedTrigger ? 'interrupted' : 'complete',
    duration: state.events.at(-1)?.time ?? 0,
  }
}

/** 全量传播：所有事件均标记为 recomputed，对应本次布局版本 */
export async function propagateFull(
  document: DominoDocument,
  opts: StepOptions = {},
): Promise<PropagationResult> {
  if (opts.shouldCancel?.()) throw new SimulationCancelledError()
  const state = newState()
  state.queue.push({ pieceId: document.startPieceId, time: 0, causeId: null, detail: '手动触发' })
  return runLoop(document, state, document.revision, opts)
}

export interface IncrementalInput {
  document: DominoDocument
  /** 保留的前缀事件（原样保留时间、触点与 detail，来源标记仍为 retained） */
  prefixEvents: SimulationEvent[]
  /** 受影响元件集合 */
  affected: ReadonlySet<string>
  opts?: StepOptions
}

/**
 * 增量传播：前缀事件原样保留，从裁剪边界按新布局续算。
 * 边界队列由前缀事件在「新布局」下的出边重建，保证后缀严格对应新版本。
 */
export async function propagateIncremental(input: IncrementalInput): Promise<PropagationResult> {
  const { document, prefixEvents, affected, opts = {} } = input
  if (opts.shouldCancel?.()) throw new SimulationCancelledError()
  const state = newState(affected)
  const ordered = [...prefixEvents].sort(
    (a, b) => a.time - b.time || a.id.localeCompare(b.id),
  )

  // 还原已倒下集合：触发器不会进入 fallen，其余主事件元件均已倒下
  for (const event of ordered) {
    if (event.kind === 'interrupted') continue
    const piece = document.pieces.find(item => item.id === event.pieceId)
    if (piece && piece.kind !== 'trigger') state.fallen.add(piece.id)
  }

  // 已在前缀发生过的元件（含触发器）：边界队列里指向它们的条目必须剔除，
  // 否则引擎会把保留段事件重新处理一遍，错误地改写来源标记与布局版本。
  const settled = new Set(ordered.filter(event => event.kind !== 'interrupted').map(event => event.pieceId))

  // 未受影响元件若在后缀阶段被引擎重新处理（例如新出边指向它），
  // 仍应沿用其前缀事件的布局版本号。
  for (const event of ordered) {
    if (!state.retainedRevisions.has(event.pieceId)) {
      state.retainedRevisions.set(event.pieceId, event.layoutRevision)
    }
  }

  // 序号从前缀最大值继续，保留事件 id（event-N）不被重写
  state.seq = ordered.reduce((max, event) => {
    const seq = Number(event.id.replace('event-', ''))
    return Number.isFinite(seq) ? Math.max(max, seq) : max
  }, 0)

  // 边界队列：按新布局重放前缀每个主事件的出边（机关 + 接触），
  // 仅保留目标尚未在前缀发生的条目——这正是「裁剪边界」上等待续算的后缀。
  for (const event of ordered) {
    if (event.kind === 'interrupted') continue
    const piece = document.pieces.find(item => item.id === event.pieceId)
    if (!piece) continue
    for (const link of document.connections.filter(link => link.from === piece.id && link.enabled)) {
      if (!settled.has(link.to)) {
        state.queue.push({ pieceId: link.to, time: event.time + link.delay, causeId: event.id, detail: '机关连线' })
      }
    }
    if (piece.kind === 'trigger') continue
    const available = document.pieces.filter(item => !state.fallen.has(item.id) && item.id !== piece.id)
    const surfaceGrip = (document.scene.friction + piece.friction) / 2
    const reachScale = (0.94 + surfaceGrip * 0.35) * (1.25 - piece.fallThreshold * 0.25)
    let target = null
    if (piece.kind === 'ramp') {
      target = available.filter(item => item.x > piece.x && Math.abs(item.y - piece.y) < 2.1)
        .sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))[0] ?? null
    } else {
      target = nextContact(piece, available, reachScale)
    }
    if (target && !settled.has(target.id)) {
      const separation = Math.hypot(piece.x - target.x, piece.y - target.y)
      const speed = Math.max(1.8, piece.height * document.scene.gravity / 2) * (0.75 + surfaceGrip * 0.5)
      const travel = Math.max(0.24, separation / speed)
      state.queue.push({
        pieceId: target.id, time: event.time + travel, causeId: event.id,
        detail: piece.kind === 'splitter' ? '分岔臂接触' : piece.kind === 'ramp' ? '坡面末端接触' : '相邻接触',
      })
    }
  }

  const suffix = await runLoop(document, state, document.revision, opts)
  // 前缀事件在本次运行中是「保留」语义：时间/触点/detail 原样不动，
  // 仅把来源标记改为 retained，并保留其产生时的布局版本号。
  const retained = ordered.map(event => ({
    ...structuredClone(event),
    origin: 'retained' as const,
  }))
  const events = [...retained, ...suffix.events]
  const interruptedEvent = events.find(event => event.kind === 'interrupted') ?? null
  const reachedTrigger = suffix.reachedTrigger || retained.some(event => event.kind === 'mechanism'
    && document.pieces.find(item => item.id === event.pieceId)?.kind === 'trigger')
  const interruptedPieceId = suffix.interruptedPieceId ?? interruptedEvent?.pieceId ?? null
  return {
    events,
    interruptedPieceId,
    interruptionReason: suffix.interruptionReason ?? interruptedEvent?.detail ?? null,
    reachedTrigger,
    status: events.length === 0 ? 'empty'
      : interruptedPieceId || !reachedTrigger ? 'interrupted' : 'complete',
    duration: events.at(-1)?.time ?? 0,
  }
}
