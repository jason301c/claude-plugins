export type ProgressState = 'working' | 'waiting' | 'failed' | 'done'
// isStopped: the turn ended while the band still said working
export type Progress = { percent: number; state: ProgressState; text: string; isStopped?: boolean }

declare module 'claude-code' {
  interface PluginState {
    progress: { current: Progress | null }
  }
}
