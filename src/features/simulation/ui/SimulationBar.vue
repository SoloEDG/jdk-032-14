<script setup lang="ts">
import { Ban, Play, RotateCcw, Sparkles } from '@lucide/vue'
import type { SimulationRun } from '@/shared/document'
import type { SimulationSummary } from '../model/useSimulation'

defineProps<{
  run: SimulationRun | null
  stale: boolean
  busy: boolean
  issue: string
  summary: SimulationSummary | null
}>()
const emit = defineEmits<{ run: []; reset: []; cancel: [] }>()
</script>

<template>
  <section class="simulation-bar">
    <div class="simulation-status">
      <span class="status-orb" :class="run?.status ?? 'idle'"></span>
      <div>
        <strong>{{ busy ? '增量计算中…' : stale ? '场景已更改' : run?.status === 'complete' ? '链路完成' : run?.status === 'interrupted' ? '链路中断' : '待运行' }}</strong>
        <small>{{ stale ? '当前回放属于上一个布局版本' : run ? `${run.events.length} 个事件已记录` : '运行一次，观察倒下顺序' }}</small>
      </div>
    </div>
    <div v-if="run && (run.retainedCount > 0 || run.affectedPieceIds.length > 0)" class="recompute-badge"
      :title="run.recomputeNote ?? ''">
      <span class="badge-segment retained">保留 {{ run.retainedCount }}</span>
      <span class="badge-segment recomputed">重算 {{ run.recomputedCount }}</span>
      <span v-if="run.affectedPieceIds.length" class="badge-affected">影响 {{ run.affectedPieceIds.length }} 件</span>
    </div>
    <p v-if="issue" class="simulation-error" role="alert">{{ issue }}</p>
    <div class="simulation-actions">
      <button v-if="run" class="secondary-button" @click="emit('reset')"><RotateCcw :size="15" /> 清除</button>
      <button v-if="busy" class="cancel-button" @click="emit('cancel')"><Ban :size="15" /> 取消重算</button>
      <button v-else class="run-button" @click="emit('run')">
        <Play :size="16" fill="currentColor" />
        {{ stale ? '增量重算' : run ? '再次运行' : '运行模拟' }}
        <kbd>Space</kbd>
      </button>
    </div>
    <span class="simulation-decoration"><Sparkles :size="15" /> 只重算受影响后缀</span>
  </section>
</template>

<style scoped>
.recompute-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px;
  border: 1px solid var(--rule);
  border-radius: 4px;
  background: var(--field);
  font: 9px var(--mono);
}
.badge-segment { padding: 2px 6px; border-radius: 3px; }
.badge-segment.retained { color: var(--mint); background: rgba(145, 196, 164, 0.12); }
.badge-segment.recomputed { color: var(--gold); background: rgba(230, 189, 104, 0.14); }
.badge-affected { padding: 2px 6px; color: var(--terracotta); }
.cancel-button {
  height: 38px;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid #8a5a4a;
  border-radius: 4px;
  background: transparent;
  color: var(--terracotta);
  font-size: 11px;
  font-weight: 700;
}
.cancel-button:hover { background: rgba(232, 139, 105, 0.12); }
</style>
