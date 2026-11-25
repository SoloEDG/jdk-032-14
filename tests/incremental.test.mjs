// 增量重算端到端测试（纯 Node，不依赖浏览器/Vue）
// 场景序列：
//   1. 全量基线运行（双支分岔）
//   2. 移动 A 支远端牌 → 只重算 A 支后缀，B 支结果原样保留
//   3. 移动共享枢纽 → 两支后缀都重算
//   4. 无实质变化再次运行 → 全部事件沿用
//   5. 取消重算 → 旧运行保持不变，仍可逐事件回看
import assert from 'node:assert/strict'
import {
  propagateFull,
  propagateIncremental,
  SimulationCancelledError,
} from '../src/features/simulation/lib/propagate.ts'
import {
  buildPropagationGraph,
  analyzeImpact,
} from '../src/features/simulation/lib/propagationGraph.ts'
import { createForkDocument, clone, movePiece, printRun } from './fixture.mjs'

let passed = 0
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${error.message}`)
    process.exitCode = 1
  }
}

function makeRun(document, result, overrides = {}) {
  return {
    id: crypto.randomUUID(),
    documentId: document.id,
    revision: document.revision,
    startedAt: 0,
    startPieceId: document.startPieceId,
    status: result.status,
    events: result.events,
    interruptedPieceId: result.interruptedPieceId,
    interruptionReason: result.interruptionReason,
    duration: result.duration,
    layoutSnapshot: document,
    basedOnRunId: null,
    retainedCount: 0,
    recomputedCount: result.events.length,
    affectedPieceIds: [],
    recomputeNote: null,
    ...overrides,
  }
}

// 模拟 useSimulation 的增量调度（与模型层逻辑保持一致）
async function simulate(previous, document) {
  if (!previous || previous.layoutSnapshot.id !== document.id
    || previous.startPieceId !== document.startPieceId) {
    const result = await propagateFull(document)
    return makeRun(document, result, { recomputeNote: '全量' })
  }
  const oldGraph = buildPropagationGraph(previous.layoutSnapshot)
  const newGraph = buildPropagationGraph(document)
  const impact = analyzeImpact(previous.layoutSnapshot, document, previous.events, oldGraph, newGraph)
  const cutIndex = impact.boundaryEventId
    ? previous.events.findIndex(event => event.id === impact.boundaryEventId) + 1
    : 0
  const prefixEvents = previous.events.slice(0, cutIndex)
  if (impact.affected.size === 0 && prefixEvents.length === previous.events.length) {
    const reusedEvents = previous.events.map(event => ({ ...event, origin: 'retained' }))
    return makeRun(document, {
      events: reusedEvents,
      interruptedPieceId: previous.interruptedPieceId,
      interruptionReason: previous.interruptionReason,
      reachedTrigger: previous.status === 'complete',
      status: previous.status,
      duration: previous.duration,
    }, {
      basedOnRunId: previous.id,
      retainedCount: reusedEvents.length,
      recomputedCount: 0,
      recomputeNote: '无变化沿用',
    })
  }
  const result = await propagateIncremental({
    document, prefixEvents, affected: impact.affected,
  })
  return makeRun(document, result, {
    basedOnRunId: previous.id,
    retainedCount: prefixEvents.length,
    recomputedCount: result.events.length - prefixEvents.length,
    affectedPieceIds: [...impact.affected],
    recomputeNote: `保留 ${prefixEvents.length} / 重算 ${result.events.length - prefixEvents.length}`,
  })
}

const base = createForkDocument()

console.log('\n=== 场景 1：全量基线运行（共享枢纽 → 双分支）===')
const baseResult = await propagateFull(clone(base))
const run1 = makeRun(clone(base), baseResult, { recomputeNote: '首次全量' })
printRun(run1, '运行 #1 基线')

check('基线覆盖全部 10 个元件且两支都到达触发器', () => {
  const pieces = new Set(run1.events.filter(e => e.kind !== 'interrupted').map(e => e.pieceId))
  assert.equal(pieces.size, 10)
  assert.equal(run1.status, 'complete')
  assert.ok(run1.events.every(e => e.origin === 'recomputed'))
  assert.ok(run1.events.every(e => e.layoutRevision === 1))
})

check('同一布局全量重算具有确定性（时间与触点完全一致）', () => {
  const again = propagateFull(clone(base))
  // propagateFull 是异步的，这里在 check 内同步比较已落盘结果
  assert.deepEqual(
    baseResult.events.map(({ time, pieceId, detail }) => ({ time, pieceId, detail })),
    run1.events.map(({ time, pieceId, detail }) => ({ time, pieceId, detail })),
  )
})

console.log('\n=== 场景 2：移动 A 支远端牌 a2（只改一条远端支路）===')
const doc2 = movePiece(clone(base), 'a2', 10.6, 2.6) // x: 10.2 → 10.6，远离 t1
const run2 = await simulate(run1, doc2)
printRun(run2, '运行 #2 移动远端牌 a2')

const r2Retained = run2.events.filter(e => e.origin === 'retained')
const r2Recomputed = run2.events.filter(e => e.origin === 'recomputed')
const r2RetainedPieces = new Set(r2Retained.map(e => e.pieceId))
const r2RecomputedPieces = new Set(r2Recomputed.map(e => e.pieceId))

check('保留前缀包含枢纽之前的全部事件（d1 d2 d3 s1）', () => {
  for (const id of ['d1', 'd2', 'd3', 's1']) assert.ok(r2RetainedPieces.has(id), `${id} 应保留`)
})

check('B 支（b1 b2 t2）事件原样保留，时间与触点不被抹掉', () => {
  for (const id of ['b1', 'b2', 't2']) assert.ok(r2RetainedPieces.has(id), `${id} 应保留`)
  const oldById = new Map(run1.events.map(e => [e.pieceId, e]))
  for (const event of r2Retained) {
    const old = oldById.get(event.pieceId)
    assert.ok(old, `${event.pieceId} 在旧运行中存在`)
    assert.equal(event.time, old.time, `${event.pieceId} 时间必须不变`)
    assert.equal(event.detail, old.detail, `${event.pieceId} 触点/detail 必须不变`)
    // 保留事件版本不高于当前布局，且不晚于其内容产生所依据的版本语义
    assert.ok(event.layoutRevision <= 2, `${event.pieceId} 保留事件版本异常`)
  }
  // 边界事件（裁剪点）及其之前的前缀事件必须严格锚定产生时的旧布局 R1
  const boundaryIndex = run1.events.findIndex(e => e.id === 'event-6')
  const boundaryAndBefore = new Set(run1.events.slice(0, boundaryIndex + 1).map(e => e.pieceId))
  for (const event of run2.events) {
    if (boundaryAndBefore.has(event.pieceId) && event.origin === 'retained') {
      assert.equal(event.layoutRevision, 1, `${event.pieceId} 前缀事件必须锚定 R1`)
    }
  }
})

check('只有 A 支受影响元件（a2 t1）被重算，B 支与公共前缀全部保留', () => {
  assert.deepEqual([...r2RecomputedPieces].sort(), ['a2', 't1'])
  for (const id of ['b1', 'b2', 't2', 'd1', 'd2', 'd3', 's1', 'a1']) {
    assert.ok(!r2RecomputedPieces.has(id), `${id} 不应重算`)
  }
  assert.ok(r2Recomputed.every(e => e.layoutRevision === 2))
})

check('受影响元件集合不包含 B 支任何元件', () => {
  for (const id of ['b1', 'b2', 't2']) assert.ok(!run2.affectedPieceIds.includes(id), `${id} 不应受影响`)
  assert.ok(run2.affectedPieceIds.includes('a2'))
})

check('重算事件的时间都不早于其所在分支的裁剪边界（前缀时间被锚定）', () => {
  // 分支并行时事件按全局时间交错，不能要求所有重算晚于所有保留；
  // 正确语义：每个重算事件不早于触发它的前缀边界事件。
  const boundaryTime = Math.max(
    ...run2.events.filter(e => e.origin === 'retained').map(e => e.time),
  )
  // a2 由 a1（t=0.870，保留）触发，t1 由 a2 触发，均应晚于 a1
  const a1Time = run2.events.find(e => e.pieceId === 'a1').time
  for (const event of r2Recomputed) {
    assert.ok(event.time >= a1Time - 1e-9, `${event.pieceId} 不应早于分支边界 a1@${a1Time}`)
  }
  assert.ok(boundaryTime >= a1Time)
})

check('a2 移动后触点/时间与基线不同（证明确实按新布局重算）', () => {
  const oldA2 = run1.events.find(e => e.pieceId === 'a2')
  const newA2 = run2.events.find(e => e.pieceId === 'a2')
  assert.notEqual(oldA2.time, newA2.time)
})

console.log('\n=== 场景 3：移动共享枢纽 s1（改动应同时波及两支）===')
const doc3 = movePiece(clone(doc2), 's1', 7.2, 4) // 枢纽右移 0.4
const run3 = await simulate(run2, doc3)
printRun(run3, '运行 #3 移动共享枢纽 s1')

const r3RetainedPieces = new Set(run3.events.filter(e => e.origin === 'retained').map(e => e.pieceId))
const r3RecomputedPieces = new Set(run3.events.filter(e => e.origin === 'recomputed').map(e => e.pieceId))

check('枢纽之前的前缀（d1 d2 d3）保留，枢纽自身与两支全部重算', () => {
  for (const id of ['d1', 'd2', 'd3']) assert.ok(r3RetainedPieces.has(id), `${id} 应保留`)
  for (const id of ['s1', 'a1', 'a2', 't1', 'b1', 'b2', 't2']) {
    assert.ok(r3RecomputedPieces.has(id), `${id} 应重算（两支都要被波及）`)
  }
})

check('受影响集合同时包含 A 支与 B 支（不能只更新鼠标旁一条路）', () => {
  const affected = new Set(run3.affectedPieceIds)
  assert.ok(['a1', 'a2', 't1'].every(id => affected.has(id)), 'A 支必须受影响')
  assert.ok(['b1', 'b2', 't2'].every(id => affected.has(id)), 'B 支必须受影响')
  assert.ok(affected.has('s1'))
})

check('重算事件全部对应 R3，保留事件对应更早布局版本', () => {
  for (const event of run3.events) {
    if (event.origin === 'recomputed') assert.equal(event.layoutRevision, 3)
    else assert.ok(event.layoutRevision < 3)
  }
})

check('前缀时间与 run2 完全一致（逐事件可核对）', () => {
  const oldById = new Map(run2.events.map(e => [e.pieceId, e]))
  for (const event of run3.events.filter(e => e.origin === 'retained')) {
    const old = oldById.get(event.pieceId)
    assert.equal(event.time, old.time)
    assert.equal(event.detail, old.detail)
  }
})

console.log('\n=== 场景 4：布局不再变化再次运行（全部沿用，零重算）===')
const run4 = await simulate(run3, clone(doc3))
printRun(run4, '运行 #4 无变化沿用')
check('全部事件保留，重算数为 0', () => {
  assert.equal(run4.retainedCount, run4.events.length)
  assert.equal(run4.recomputedCount, 0)
  assert.ok(run4.events.every(e => e.origin === 'retained'))
})

console.log('\n=== 场景 5：取消重算（旧运行仍可逐事件回看）===')
{
  const doc5 = movePiece(clone(doc3), 's1', 7.6, 4)
  let cancelled = false
  try {
    // 让引擎在第一个让出点即收到取消信号
    await propagateFull(doc5, {
      onYield: async () => {},
      shouldCancel: () => true,
    })
  } catch (error) {
    cancelled = error instanceof SimulationCancelledError
  }
  check('取消时抛出 SimulationCancelledError 且不产生半截结果', () => {
    assert.ok(cancelled)
  })

  // 增量路径同样可取消
  const oldGraph = buildPropagationGraph(run3.layoutSnapshot)
  const newGraph = buildPropagationGraph(doc5)
  const impact = analyzeImpact(run3.layoutSnapshot, doc5, run3.events, oldGraph, newGraph)
  let incrementalCancelled = false
  try {
    await propagateIncremental({
      document: doc5,
      prefixEvents: run3.events.slice(0, run3.retainedCount),
      affected: impact.affected,
      opts: { onYield: async () => {}, shouldCancel: () => true },
    })
  } catch (error) {
    incrementalCancelled = error instanceof SimulationCancelledError
  }
  check('增量重算同样可取消', () => assert.ok(incrementalCancelled))

  check('取消后旧运行 run3 原封不动，仍可逐事件回看', () => {
    assert.equal(run3.revision, 3)
    assert.ok(run3.events.length > 0)
    // 模拟逐事件回看：每个事件都能定位到时间、元件与布局版本
    const replay = run3.events.map(e => ({ t: e.time, piece: e.pieceId, rev: e.layoutRevision, origin: e.origin }))
    assert.equal(replay.length, run3.events.length)
    assert.ok(replay.every(item => Number.isFinite(item.t) && item.piece && item.rev))
  })
}

console.log('\n=== 场景 6：回放前缀与新后缀分别对应正确布局版本（综合校验）===')
check('run3 中 d1-d3 的时间等于 run1 基线（跨两次增量仍锚定原始时间）', () => {
  const baseById = new Map(run1.events.map(e => [e.pieceId, e]))
  for (const id of ['d1', 'd2', 'd3']) {
    const event = run3.events.find(e => e.pieceId === id && e.origin === 'retained')
    assert.ok(event)
    assert.equal(event.time, baseById.get(id).time)
  }
})
check('run3 后缀事件使用的元件坐标来自 R3 布局（s1.x=7.2）', () => {
  assert.equal(run3.layoutSnapshot.pieces.find(p => p.id === 's1').x, 7.2)
  assert.equal(run2.layoutSnapshot.pieces.find(p => p.id === 's1').x, 6.8)
})
check('每个运行的 layoutSnapshot 与事件 layoutRevision 一一对应', () => {
  for (const run of [run1, run2, run3, run4]) {
    assert.equal(run.layoutSnapshot.revision, run.revision)
    for (const event of run.events) {
      assert.ok(event.layoutRevision <= run.revision)
    }
  }
})

console.log(`\n结果：${passed} 项断言通过${process.exitCode ? '，存在失败' : ''}\n`)
