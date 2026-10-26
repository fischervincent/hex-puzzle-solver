import { solve, type SolverInput } from './lib/solver'

self.onmessage = (event: MessageEvent<SolverInput>) => {
  self.postMessage(solve(event.data))
}
