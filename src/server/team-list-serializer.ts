import type { TeamListItem, TeamListItemPayload } from '../shared/types.js'

export const serializeTeamListItem = ({
  commandPresetId,
  id,
  lastPtyLine,
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
  last_pty_line: lastPtyLine ?? null,
  command_preset_id: commandPresetId ?? null,
})
