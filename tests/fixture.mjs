// 测试夹具：共享枢纽（分岔器 s1）后分开两支的场景
//
//   d1 → d2 → d3 → s1(枢纽) ──机关线──> a1 → a2 → t1   （A 支 / 上支）
//                              └──机关线──> b1 → b2 → t2（B 支 / 下支）
//
// 机关线保证两支都会被枢纽展开；接触链沿 x 轴排列，角度均为 0（朝东）。
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// 通过 node:register 链路外无法直接 import .ts，这里由测试脚本注入 document 工厂；
// 本文件只输出纯数据构造函数，不依赖 "@/" 别名。

const domino = (id, x, y, label, extra = {}) => ({
  id, kind: 'domino', x, y, angle: 0, facing: 'east', label,
  height: 1.6, width: 0.42, fallThreshold: 0.8, friction: 0.55, ...extra,
})

export function createForkDocument() {
  return {
    id: 'fork-test-doc',
    title: '双支分岔夹具',
    revision: 1,
    updatedAt: 0,
    pieces: [
      domino('d1', 2, 4, '起点'),
      domino('d2', 3.6, 4, 'd2'),
      domino('d3', 5.2, 4, 'd3'),
      { ...domino('s1', 6.8, 4, '枢纽'), kind: 'splitter', width: 0.75 },
      // A 支（上支）
      domino('a1', 8.6, 2.6, 'a1'),
      domino('a2', 10.2, 2.6, 'a2'),
      { ...domino('t1', 11.8, 2.6, '终点A'), kind: 'trigger', width: 0.7, height: 0.8 },
      // B 支（下支）
      domino('b1', 8.6, 5.4, 'b1'),
      domino('b2', 10.2, 5.4, 'b2'),
      { ...domino('t2', 11.8, 5.4, '终点B'), kind: 'trigger', width: 0.7, height: 0.8 },
    ],
    connections: [
      { id: 'c1', from: 's1', to: 'a1', delay: 0.15, enabled: true },
      { id: 'c2', from: 's1', to: 'b1', delay: 0.15, enabled: true },
    ],
    scene: { gravity: 9.8, friction: 0.62, width: 14, height: 9, showGrid: true },
    startPieceId: 'd1',
  }
}

export function clone(doc) {
  return structuredClone(doc)
}

export function movePiece(doc, id, x, y) {
  return {
    ...doc,
    revision: doc.revision + 1,
    pieces: doc.pieces.map(piece => piece.id === id ? { ...piece, x, y } : piece),
  }
}

export function printRun(run, title) {
  console.log(`\n── ${title}（R${run.revision}，状态=${run.status}，保留=${run.retainedCount}，重算=${run.recomputedCount}）`)
  if (run.recomputeNote) console.log(`   说明: ${run.recomputeNote}`)
  for (const event of run.events) {
    const flag = event.origin === 'retained' ? '保' : '算'
    console.log(
      `   [${flag}] R${String(event.layoutRevision).padStart(2, '0')} `
      + `t=${event.time.toFixed(3).padStart(7)} ${event.pieceId.padEnd(4)} ${event.kind.padEnd(11)} ${event.detail}`,
    )
  }
}
