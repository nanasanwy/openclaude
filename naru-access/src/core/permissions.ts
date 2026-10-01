export type Role = 'receptionist' | 'cashier' | 'runner' | 'supervisor' | 'events' | 'manager' | 'owner'

export const ROLES: Role[] = ['receptionist', 'cashier', 'runner', 'supervisor', 'events', 'manager', 'owner']

export const ROLE_LABELS: Record<Role, string> = {
  receptionist: 'Receptionist',
  cashier: 'Cashier',
  runner: 'Zone A runner (backup cashier)',
  supervisor: 'Supervisor (gate host)',
  events: 'Events coordinator',
  manager: 'Manager',
  owner: 'Owner',
}

export type Permission =
  | 'walkin.activate'
  | 'party.checkin'
  | 'party.manage'
  | 'package.use'
  | 'package.transfer'
  | 'dashboard.view'
  | 'group.view'
  | 'group.override'
  | 'gate.override'
  | 'settings.manage'
  | 'staff.manage'
  | 'reports.view'
  | 'data.export'

const ROLE_PERMISSIONS: Record<Role, Permission[] | 'all'> = {
  receptionist: ['party.checkin', 'group.view'],
  cashier: ['walkin.activate', 'package.use', 'group.view'],
  runner: ['walkin.activate', 'package.use', 'group.view'],
  supervisor: ['dashboard.view', 'group.view', 'group.override', 'gate.override'],
  events: ['party.manage', 'party.checkin', 'group.view'],
  manager: 'all',
  owner: 'all',
}

export function can(role: Role, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role]
  return perms === 'all' || perms.includes(permission)
}

export function permissionsFor(role: Role): Permission[] {
  const perms = ROLE_PERMISSIONS[role]
  if (perms !== 'all') return [...perms]
  return [
    'walkin.activate', 'party.checkin', 'party.manage', 'package.use', 'package.transfer', 'dashboard.view',
    'group.view', 'group.override', 'gate.override', 'settings.manage', 'staff.manage', 'reports.view', 'data.export',
  ]
}
