import type { AuthorizeFn } from 'payload-plugin-attribution'

// read: the ledger and health report. operate: redelivery. pii: hashed identifiers, request
// context and provider request bodies.
export const authorize: AuthorizeFn = ({ req, scope }) => {
  const roles = (req.user as { roles?: unknown } | null)?.roles
  const hasRole = (role: string): boolean => Array.isArray(roles) && roles.includes(role)
  if (scope === 'pii') {
    return hasRole('admin')
  }
  return hasRole('admin') || hasRole('marketing')
}
