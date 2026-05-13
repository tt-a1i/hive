import type { TeamListItem, TeamListItemPayload } from '../shared/types.js'

export const serializeTeamListItem = ({
  id,
  lastOutputLine,
  name,
  pendingTaskCount,
  role,
  status,
}: TeamListItem): TeamListItemPayload => ({
  id,
  name,
  role,
  status,
  pending_task_count: pendingTaskCount,
  last_output_line: lastOutputLine ?? null,
})
