export type PieceKind = 'domino' | 'ramp' | 'splitter' | 'trigger'
export type Axis = 'north' | 'east' | 'south' | 'west'

export interface Vec2 { x: number; y: number }

export interface Piece {
  id: string
  kind: PieceKind
  x: number
  y: number
  angle: number
  facing: Axis
  label: string
  height: number
  width: number
  fallThreshold: number
  friction: number
}

export interface MechanismConnection {
  id: string
  from: string
  to: string
  delay: number
  enabled: boolean
}

export interface SceneSettings {
  gravity: number
  friction: number
  width: number
  height: number
  showGrid: boolean
}

export interface DominoDocument {
  id: string
  title: string
  revision: number
  updatedAt: number
  pieces: Piece[]
  connections: MechanismConnection[]
  scene: SceneSettings
  startPieceId: string
}

export type EventOrigin = 'retained' | 'recomputed'

export interface SimulationEvent {
  id: string
  pieceId: string
  time: number
  causeId: string | null
  kind: 'trigger' | 'fall' | 'mechanism' | 'interrupted'
  detail: string
  /** 事件来源：retained=旧布局保留前缀，recomputed=新布局重算后缀 */
  origin: EventOrigin
  /** 该事件对应的布局修订版本 */
  layoutRevision: number
}

export interface SimulationRun {
  id: string
  documentId: string
  revision: number
  startedAt: number
  startPieceId: string
  status: 'complete' | 'interrupted' | 'empty'
  events: SimulationEvent[]
  interruptedPieceId: string | null
  interruptionReason: string | null
  duration: number
  /** 本次运行对应的完整布局快照，供后续增量重算与版本回看 */
  layoutSnapshot: DominoDocument
  /** 增量重算时所基于的上一次运行 id；全量运行为 null */
  basedOnRunId: string | null
  /** 保留前缀事件数 */
  retainedCount: number
  /** 重算后缀事件数 */
  recomputedCount: number
  /** 本次被判定为受影响、参与重算的元件 id */
  affectedPieceIds: string[]
  /** 重算说明（改动来源、保留/重算范围） */
  recomputeNote: string | null
}
