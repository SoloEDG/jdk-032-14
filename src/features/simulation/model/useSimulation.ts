import { computed, ref, shallowRef, type Ref } from 'vue'
import type { DominoDocument, SimulationRun } from '@/shared/document'
import {
  propagateFull,
  propagateIncremental,
  SimulationCancelledError,
} from '../lib/propagate'
import { analyzeImpact, buildPropagationGraph } from '../lib/propagationGraph'

const HISTORY_LIMIT = 8

export interface SimulationSummary {
  mode: 'full' | 'incremental'
  retainedCount: number
  recomputedCount: number
  affectedPieceIds: string[]
  note: string
  cancelled: boolean
}

export function useSimulation(document: Ref<DominoDocument>) {
  const runs = shallowRef<SimulationRun[]>([])
  const activeRunId = ref<string | null>(null)
  const busy = ref(false)
  const issue = ref('')
  /** 最近一次增量重算的摘要，供界面高亮「哪一段被重算」 */
  const lastSummary = ref<SimulationSummary | null>(null)

  let taskToken = 0

  const activeRun = computed<SimulationRun | null>(
    () => runs.value.find(item => item.id === activeRunId.value) ?? null,
  )
  /** 兼容旧调用点 */
  const run = activeRun
  const current = activeRun
  const stale = computed(() => Boolean(activeRun.value && activeRun.value.revision !== document.value.revision))

  function frame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => resolve()))
  }

  async function simulate() {
    const token = ++taskToken
    busy.value = true
    issue.value = ''
    const snapshot = structuredClone(document.value)
    const previous = activeRun.value
    await frame()

    try {
      let result
      let basedOnRunId: string | null = null
      let retainedCount = 0
      let recomputedCount = 0
      let affectedPieceIds: string[] = []
      let note: string
      let mode: 'full' | 'incremental'

      if (previous && previous.layoutSnapshot.id === snapshot.id
        && previous.startPieceId === snapshot.startPieceId) {
        // —— 增量路径：基于上一次运行做影响分析 ——
        const oldGraph = buildPropagationGraph(previous.layoutSnapshot)
        const newGraph = buildPropagationGraph(snapshot)
        const impact = analyzeImpact(
          previous.layoutSnapshot, snapshot, previous.events, oldGraph, newGraph,
        )
        affectedPieceIds = [...impact.affected]
        const cutIndex = impact.boundaryEventId
          ? previous.events.findIndex(event => event.id === impact.boundaryEventId) + 1
          : 0
        const prefixEvents = previous.events.slice(0, cutIndex)

        if (impact.affected.size === 0 && prefixEvents.length === previous.events.length) {
          // 无实质变化：直接沿用上一份结果，所有事件标记为保留
          result = {
            events: previous.events.map(event => ({ ...event, origin: 'retained' as const })),
            interruptedPieceId: previous.interruptedPieceId,
            interruptionReason: previous.interruptionReason,
            reachedTrigger: previous.status === 'complete',
            status: previous.status,
            duration: previous.duration,
          }
          retainedCount = previous.events.length
          note = '布局变化不影响传播路径，全部事件沿用上一次运行结果。'
          mode = 'incremental'
        } else if (prefixEvents.length === 0
          || (impact.boundaryEventId === null && impact.affected.has(snapshot.startPieceId))) {
          result = await propagateFull(snapshot, {
            onYield: frame,
            shouldCancel: () => taskToken !== token,
          })
          recomputedCount = result.events.length
          note = `改动触及起点或全部已发生事件，执行全量重算（${impact.reasons.join('；') || '布局变更'}）。`
          mode = 'full'
        } else {
          basedOnRunId = previous.id
          result = await propagateIncremental({
            document: snapshot,
            prefixEvents,
            affected: impact.affected,
            opts: { onYield: frame, shouldCancel: () => taskToken !== token },
          })
          retainedCount = prefixEvents.length
          recomputedCount = result.events.length - retainedCount
          note = `保留前 ${retainedCount} 个事件（旧布局 R${previous.revision} 时间与触点不变），`
            + `重算后 ${recomputedCount} 个事件（新布局 R${snapshot.revision}）。影响元件：${affectedPieceIds.join('、') || '无'}。`
          mode = 'incremental'
        }
      } else {
        // —— 全量路径：首次运行或文档已切换 ——
        result = await propagateFull(snapshot, {
          onYield: frame,
          shouldCancel: () => taskToken !== token,
        })
        recomputedCount = result.events.length
        note = '首次运行，全量计算全部事件。'
        mode = 'full'
      }

      if (taskToken !== token) throw new SimulationCancelledError()

      const nextRun: SimulationRun = {
        id: crypto.randomUUID(),
        documentId: snapshot.id,
        revision: snapshot.revision,
        startedAt: Date.now(),
        startPieceId: snapshot.startPieceId,
        status: result.status,
        events: result.events,
        interruptedPieceId: result.interruptedPieceId,
        interruptionReason: result.interruptionReason,
        duration: result.duration,
        layoutSnapshot: snapshot,
        basedOnRunId,
        retainedCount,
        recomputedCount,
        affectedPieceIds,
        recomputeNote: note,
      }
      runs.value = [...runs.value, nextRun].slice(-HISTORY_LIMIT)
      activeRunId.value = nextRun.id
      lastSummary.value = {
        mode, retainedCount, recomputedCount, affectedPieceIds, note, cancelled: false,
      }
      if (result.status === 'empty') issue.value = '场景里没有可运行的触发点。'
    } catch (error) {
      if (error instanceof SimulationCancelledError) {
        // 取消：旧运行保持原样，仍可逐事件回看
        lastSummary.value = lastSummary.value
          ? { ...lastSummary.value, cancelled: true }
          : { mode: 'full', retainedCount: 0, recomputedCount: 0, affectedPieceIds: [], note: '重算已取消，旧运行结果保持不变。', cancelled: true }
        issue.value = '重算已取消，上一次运行结果保持不变，仍可逐事件回看。'
      } else {
        issue.value = '场景计算未能完成，请检查元件连接。'
      }
    } finally {
      if (taskToken === token) busy.value = false
    }
  }

  function cancel() {
    taskToken += 1
    busy.value = false
  }

  function selectRun(id: string) {
    if (runs.value.some(item => item.id === id)) activeRunId.value = id
  }

  function clear() {
    taskToken += 1
    runs.value = []
    activeRunId.value = null
    issue.value = ''
    lastSummary.value = null
    busy.value = false
  }

  return {
    runs, activeRunId, activeRun, run, current, stale, busy, issue, lastSummary,
    simulate, cancel, selectRun, clear,
  }
}
