<script setup lang="ts">
import { AlertTriangle, CheckCircle2, CircleStop, FastForward, History, Pause, Play, RotateCcw, SkipBack } from '@lucide/vue'
import type { SimulationEvent, SimulationRun } from '@/shared/document'
import { formatSeconds } from '@/shared/time'

const props = defineProps<{
  run: SimulationRun | null
  runs: SimulationRun[]
  activeRunId: string | null
  events: SimulationEvent[]
  time: number
  playing: boolean
  currentEvent: SimulationEvent | null
  stale: boolean
}>()
const emit = defineEmits<{
  toggle: []
  seek: [number]
  restart: []
  event: [string]
  selectRun: [string]
}>()
const iconFor = (kind: SimulationEvent['kind']) => kind === 'interrupted' ? AlertTriangle
  : kind === 'mechanism' ? FastForward : CheckCircle2
const originLabel = (event: SimulationEvent) => event.origin === 'retained' ? '保留' : '重算'
</script>

<template>
  <section class="replay-panel" aria-labelledby="replay-title">
    <div class="replay-heading">
      <div class="section-kicker"><span>05 / REVIEW</span><h2 id="replay-title">结果回看</h2></div>
      <span v-if="run" class="replay-revision" :class="{ stale }">{{ stale ? `旧版 R${run.revision}` : `R${run.revision}` }}</span>
    </div>
    <template v-if="run">
      <div v-if="runs.length > 1" class="run-history">
        <span class="history-title"><History :size="12" /> 运行历史</span>
        <div class="history-chips">
          <button v-for="item in [...runs].reverse()" :key="item.id" class="history-chip"
            :class="{ active: item.id === activeRunId, interrupted: item.status === 'interrupted' }"
            :title="item.recomputeNote ?? `运行于布局 R${item.revision}`" @click="emit('selectRun', item.id)">
            R{{ item.revision }} · {{ item.events.length }} 事件
            <em v-if="item.basedOnRunId">增量</em>
          </button>
        </div>
      </div>
      <div class="replay-summary" :class="run.status">
        <div class="summary-symbol"><CircleStop v-if="run.status === 'interrupted'" :size="17" /><CheckCircle2 v-else :size="17" /></div>
        <div>
          <strong>{{ run.status === 'interrupted' ? '找到中断点' : run.status === 'complete' ? '连锁已完成' : '场景暂无元件' }}</strong>
          <small>{{ run.interruptionReason ?? '所有触发事件均已记录' }}</small>
        </div>
      </div>
      <div v-if="run.recomputeNote" class="recompute-note" :class="run.retainedCount > 0 ? 'incremental' : 'full'">
        <RotateCcw :size="13" />
        <p>{{ run.recomputeNote }}</p>
      </div>
      <div v-if="run.retainedCount > 0" class="origin-legend">
        <span><i class="dot retained"></i>保留前缀 · R{{ run.events[0]?.layoutRevision }}</span>
        <span><i class="dot recomputed"></i>重算后缀 · R{{ run.revision }}</span>
      </div>
      <div class="replay-controls">
        <button class="replay-icon" aria-label="回到开头" @click="emit('restart')"><SkipBack :size="15" /></button>
        <button class="replay-play" :aria-label="playing ? '暂停回放' : '播放回放'" @click="emit('toggle')">
          <Pause v-if="playing" :size="16" fill="currentColor" /><Play v-else :size="16" fill="currentColor" />
        </button>
        <span class="replay-clock mono">{{ formatSeconds(time) }}</span>
        <input aria-label="回放进度" class="replay-range" type="range" min="0" :max="run.duration || 0.01" step="0.01" :value="time"
          @input="emit('seek', Number(($event.target as HTMLInputElement).value))" />
        <span class="replay-clock mono">{{ formatSeconds(run.duration) }}</span>
      </div>
      <div class="event-list-heading">
        <span>事件轨迹</span>
        <span class="heading-legend">
          <em class="tag retained">保留 {{ run.retainedCount }}</em>
          <em class="tag recomputed">重算 {{ run.recomputedCount }}</em>
        </span>
      </div>
      <ol class="event-list">
        <li v-for="event in events" :key="event.id">
          <button class="event-row"
            :class="{ current: currentEvent?.id === event.id, interrupted: event.kind === 'interrupted', [event.origin]: true }"
            :aria-current="currentEvent?.id === event.id ? 'step' : undefined" @click="emit('event', event.id)">
            <span class="event-time mono">{{ formatSeconds(event.time) }}</span>
            <span class="event-icon"><component :is="iconFor(event.kind)" :size="14" /></span>
            <span class="event-copy">
              <strong>{{ run.events.find(item => item.id === event.id)?.pieceId === run.startPieceId ? '启动点' : event.detail.split(' · ')[0] }}</strong>
              <small>{{ event.detail.split(' · ')[1] ?? event.pieceId }}</small>
            </span>
            <span class="event-meta">
              <em class="origin-tag" :class="event.origin">{{ originLabel(event) }}</em>
              <em class="revision-tag mono">R{{ event.layoutRevision }}</em>
              <span v-if="event.kind === 'interrupted'" class="event-flag">中断</span>
            </span>
          </button>
        </li>
      </ol>
      <div v-if="run.interruptedPieceId" class="interruption-card">
        <span class="interrupt-icon"><AlertTriangle :size="16" /></span>
        <div><strong>中断位置</strong><p>{{ run.events.find(event => event.kind === 'interrupted')?.pieceId }} 未触及下一件元件。返回场景调整间距或方向，再次模拟。</p></div>
        <button :aria-label="'定位到 ' + run.interruptedPieceId" @click="emit('event', run.events.find(event => event.kind === 'interrupted')?.id ?? '')">定位</button>
      </div>
      <div v-if="stale" class="stale-note"><RotateCcw :size="13" /> 当前布局已改变，这份结果仍对应运行时保存的布局版本，可随时回看或发起增量重算。</div>
    </template>
    <div v-else class="replay-empty">
      <div class="empty-orbit"><i></i><i></i><i></i><span></span></div>
      <strong>等待第一次模拟</strong><p>点击「运行模拟」，倒下顺序与中断位置会显示在这里。</p>
    </div>
  </section>
</template>

<style scoped>
.run-history { margin: 12px 0 4px; }
.history-title { display: flex; align-items: center; gap: 5px; color: var(--quiet); font: 9px var(--mono); letter-spacing: .08em; }
.history-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.history-chip {
  padding: 4px 7px; border: 1px solid var(--rule); border-radius: 3px; background: var(--field);
  color: var(--muted); font: 9px var(--mono);
}
.history-chip em { margin-left: 4px; font-style: normal; color: var(--gold); }
.history-chip.active { border-color: var(--gold); color: var(--ink); background: rgba(230, 189, 104, 0.12); }
.history-chip.interrupted:not(.active) { border-color: #6b5245; }
.recompute-note {
  display: flex; gap: 7px; margin: 10px 0 0; padding: 9px 10px; border-radius: 5px;
  font-size: 9px; line-height: 1.5;
}
.recompute-note.incremental { border: 1px solid #465545; background: #28372e; color: var(--muted); }
.recompute-note.full { border: 1px solid var(--rule); background: var(--field); color: var(--muted); }
.recompute-note svg { flex: none; margin-top: 1px; color: var(--gold); }
.origin-legend { display: flex; gap: 12px; margin-top: 8px; color: var(--quiet); font: 9px var(--mono); }
.origin-legend .dot { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 4px; }
.origin-legend .dot.retained { background: var(--mint); }
.origin-legend .dot.recomputed { background: var(--gold); }
.heading-legend { display: inline-flex; gap: 5px; }
.tag { font-style: normal; padding: 1px 5px; border-radius: 2px; font-size: 8px; }
.tag.retained { color: var(--mint); background: rgba(145, 196, 164, 0.12); }
.tag.recomputed { color: var(--gold); background: rgba(230, 189, 104, 0.14); }
.event-row { grid-template-columns: 37px 21px minmax(0, 1fr) auto; }
.event-row.retained { border-left-color: rgba(145, 196, 164, 0.55); }
.event-row.recomputed { border-left-color: rgba(230, 189, 104, 0.65); }
.event-meta { display: flex; align-items: center; gap: 4px; }
.origin-tag, .revision-tag { font-style: normal; border-radius: 2px; padding: 1px 4px; font-size: 8px; }
.origin-tag.retained { color: var(--mint); background: rgba(145, 196, 164, 0.12); }
.origin-tag.recomputed { color: var(--gold); background: rgba(230, 189, 104, 0.14); }
.revision-tag { color: var(--quiet); border: 1px solid var(--rule); }
.event-flag { color: var(--terracotta); font-size: 8px; }
</style>
