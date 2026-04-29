import type { WorkerRole } from '../../../src/shared/types.js'

export interface RolePresentation {
  badgeClass: string
  label: string
}

export const getRolePresentation = (role: WorkerRole): RolePresentation => {
  switch (role) {
    case 'coder':
      return { badgeClass: 'role-badge--coder', label: 'Coder' }
    case 'tester':
      return { badgeClass: 'role-badge--tester', label: 'Tester' }
    case 'reviewer':
      return { badgeClass: 'role-badge--reviewer', label: 'Reviewer' }
    case 'custom':
      return { badgeClass: 'role-badge--custom', label: 'Custom' }
    default:
      return { badgeClass: 'role-badge--custom', label: String(role) }
  }
}
