import type { TeamListItem } from '../shared/types.js'

export const serializeTeamListItem = ({
  id,
  name,
  pendingTaskCount,
  role,
  status,
}: TeamListItem): {
  id: string
  name: string
  role: string
  status: string
  pending_task_count: number
} => ({
  id,
  name,
  role,
  status,
  pending_task_count: pendingTaskCount,
})
