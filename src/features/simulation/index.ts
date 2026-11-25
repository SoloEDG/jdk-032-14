export { useSimulation } from './model/useSimulation'
export type { SimulationSummary } from './model/useSimulation'
export { default as SimulationBar } from './ui/SimulationBar.vue'
export {
  propagateFull,
  propagateIncremental,
  SimulationCancelledError,
} from './lib/propagate'
export {
  buildPropagationGraph,
  analyzeImpact,
  reachableFrom,
} from './lib/propagationGraph'
