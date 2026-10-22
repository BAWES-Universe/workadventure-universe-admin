/**
 * Role names for the game's badges: which roles a viewer is told about (hidden ones only to role managers and holders).
 */
jest.mock('@/lib/db', () => ({ prisma: {} }))
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }))
jest.mock('@/lib/role-access', () => ({ accessFor: jest.fn() }))
jest.mock('@/lib/universe-route', () => ({ seesHiddenRoles: jest.fn() }))

import { describe, it, expect } from '@jest/globals'


import { accessFor } from '@/lib/role-access'
import { seesHiddenRoles } from '@/lib/universe-route'
import { roleLabelsFor, roleLabelsForViewer } from '@/lib/room-role-labels'

const ROLES = [
  { key: 'editor', name: 'Editor', color: '#60A5FA', showBadge: true, position: 2 },
  { key: 'admin', name: 'Admin', color: '#F87171', showBadge: true, position: 1_000_000 },
  { key: 'customer-service', name: 'Customer Service', color: '#38BDF8', showBadge: true, position: 20 },
  { key: 'secret', name: 'Secret keepers', color: '#FACC15', showBadge: false, position: 30 },
]

describe('roleLabelsFor', () => {
  it('lists roles highest first and never Member or Everyone', () => {
    const labels = roleLabelsFor(
      [...ROLES, { key: 'member', name: 'Member', color: '#A78BFA', showBadge: true, position: 1 }, { key: 'everyone', name: 'Everyone', color: '#A3A3B5', showBadge: true, position: 0 }],
      { seesHidden: false, tags: [] },
    )
    expect(labels.map((l) => l.key)).toEqual(['admin', 'customer-service', 'editor'])
  })

  it('does not tell an ordinary viewer that a hidden role exists', () => {
    const labels = roleLabelsFor(ROLES, { seesHidden: false, tags: ['member'] })
    expect(labels.find((l) => l.key === 'secret')).toBeUndefined()
    expect(labels.every((l) => l.visibleOnOthers)).toBe(true)
  })

  it('names a hidden role to the person who holds it, but not to show on others', () => {
    const labels = roleLabelsFor(ROLES, { seesHidden: false, tags: ['secret', 'member'] })
    expect(labels.find((l) => l.key === 'secret')).toEqual({ key: 'secret', name: 'Secret keepers', color: '#FACC15', visibleOnOthers: false })
  })

  it('shows hidden roles on others to people who manage or give roles', () => {
    const labels = roleLabelsFor(ROLES, { seesHidden: true, tags: [] })
    expect(labels.find((l) => l.key === 'secret')?.visibleOnOthers).toBe(true)
    expect(labels.map((l) => l.key)).toEqual(['admin', 'secret', 'customer-service', 'editor'])
  })
})

describe('roleLabelsForViewer', () => {
  const db = (rows: typeof ROLES) =>
    ({ role: { findMany: jest.fn(async () => rows) }, universe: { findUnique: jest.fn() } }) as never

  it('treats a guest as someone who cannot see hidden roles', async () => {
    const labels = await roleLabelsForViewer(db(ROLES), 'u1', { user: null, tags: [] })
    expect(labels.map((l) => l.key)).toEqual(['admin', 'customer-service', 'editor'])
  })

  it('asks only for roles other than Member and Everyone', async () => {
    const mock = db(ROLES)
    await roleLabelsForViewer(mock, 'u1', { user: null, tags: [] })
    const findMany = (mock as unknown as { role: { findMany: jest.Mock } }).role.findMany
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { universeId: 'u1', key: { notIn: ['member', 'everyone'] } } }),
    )
  })

  it('shows hidden roles on others to a signed-in person who gives or manages roles', async () => {
    jest.mocked(accessFor).mockResolvedValueOnce({} as never)
    jest.mocked(seesHiddenRoles).mockReturnValueOnce(true)
    const labels = await roleLabelsForViewer(db(ROLES), 'u1', { user: { id: 'a' }, tags: [] })
    expect(labels.find((l) => l.key === 'secret')?.visibleOnOthers).toBe(true)
  })

  it('keeps hidden roles off others for a signed-in person who cannot give or manage roles', async () => {
    jest.mocked(accessFor).mockResolvedValueOnce({} as never)
    jest.mocked(seesHiddenRoles).mockReturnValueOnce(false)
    const labels = await roleLabelsForViewer(db(ROLES), 'u1', { user: { id: 'b' }, tags: ['member'] })
    expect(labels.find((l) => l.key === 'secret')).toBeUndefined()
  })
})
