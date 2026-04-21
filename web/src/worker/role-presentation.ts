import type { WorkerRole } from '../../../src/shared/types.js'

export interface RolePresentation {
  badgeClass: string
  emoji: string
  label: string
}

export const getRolePresentation = (role: WorkerRole): RolePresentation => {
  switch (role) {
    case 'coder':
      return { badgeClass: 'role-badge--coder', emoji: '🐝', label: 'Coder' }
    case 'tester':
      return { badgeClass: 'role-badge--tester', emoji: '🐛', label: 'Tester' }
    case 'reviewer':
      return { badgeClass: 'role-badge--reviewer', emoji: '🦉', label: 'Reviewer' }
    case 'custom':
      return { badgeClass: 'role-badge--custom', emoji: '🐜', label: 'Custom' }
    default:
      return { badgeClass: 'role-badge--custom', emoji: '🐜', label: String(role) }
  }
}
