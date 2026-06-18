import type { TaskDispatchSummary } from './useTasksApi.js'

type DispatchBadgeProps = {
  summary: TaskDispatchSummary
}

export const DispatchBadge = ({ summary }: DispatchBadgeProps) => {
  const { total, reported, cancelled, allDone } = summary
  const done = reported + cancelled
  const hasFailed = cancelled > 0 && !allDone
  const tone = allDone ? 'green' : hasFailed ? 'red' : 'orange'
  const label = allDone ? `all reported ✓` : `${done}/${total} done`

  return (
    <span
      className="dispatch-badge"
      data-testid="dispatch-badge"
      data-tone={tone}
    >
      {label}
    </span>
  )
}
