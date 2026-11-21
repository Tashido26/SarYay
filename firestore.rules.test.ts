/**
 * Phase 0 Payload-First Security Test Specification for `firestore.rules`.
 *
 * Run against the Firebase Local Emulator Suite with `@firebase/rules-unit-testing`
 * to verify that all 12 adversarial ("Dirty Dozen") payloads return PERMISSION_DENIED
 * while legitimate owner operations succeed.
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  auth: { uid: string; email?: string; email_verified?: boolean } | null;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

const VALID_OWNER_AUTH = {
  uid: 'owner_uid_1',
  email: 'herozboy@gmail.com',
  email_verified: true,
};

export const DIRTY_DOZEN_CASES: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated Story Read',
    auth: null,
    operation: 'get',
    path: 'users/owner_uid_1/stories/story_1',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unauthorized Email Account',
    auth: { uid: 'attacker_uid', email: 'attacker@gmail.com', email_verified: true },
    operation: 'create',
    path: 'users/attacker_uid/stories/story_1',
    payload: { ownerId: 'attacker_uid', title: 'Hijack' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Email Spoofing (email_verified: false)',
    auth: { uid: 'owner_uid_1', email: 'herozboy@gmail.com', email_verified: false },
    operation: 'create',
    path: 'users/owner_uid_1/stories/story_1',
    payload: { ownerId: 'owner_uid_1', title: 'Spoofed' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Cross-UID Impersonation',
    auth: VALID_OWNER_AUTH,
    operation: 'create',
    path: 'users/other_uid/stories/story_1',
    payload: { ownerId: 'other_uid', title: 'Cross UID' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Shadow Field Injection on Create',
    auth: VALID_OWNER_AUTH,
    operation: 'create',
    path: 'users/owner_uid_1/stories/story_shadow',
    payload: {
      ownerId: 'owner_uid_1',
      title: 'Valid Title',
      defaultStyle: 'colloquial',
      defaultRefinedEnding: 'colloquial',
      defaultModel: 'gemini-2.5-flash',
      sectionCount: 0,
      isAdmin: true,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Shadow Field Injection on Update',
    auth: VALID_OWNER_AUTH,
    operation: 'update',
    path: 'users/owner_uid_1/stories/story_1',
    payload: { title: 'Renamed', role: 'superadmin' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Immutable ownerId / createdAt Tampering',
    auth: VALID_OWNER_AUTH,
    operation: 'update',
    path: 'users/owner_uid_1/stories/story_1',
    payload: { ownerId: 'different_uid' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Client-Forged Timestamp (Non-Server Timestamp)',
    auth: VALID_OWNER_AUTH,
    operation: 'create',
    path: 'users/owner_uid_1/stories/story_bad_time',
    payload: {
      ownerId: 'owner_uid_1',
      title: 'Backdated',
      defaultStyle: 'literary',
      defaultRefinedEnding: 'colloquial',
      defaultModel: 'gemini-2.5-flash',
      sectionCount: 0,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Path ID Poisoning',
    auth: VALID_OWNER_AUTH,
    operation: 'create',
    path: 'users/owner_uid_1/stories/bad$id..with..spaces',
    payload: { ownerId: 'owner_uid_1', title: 'Bad ID' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Oversized Title Value Poisoning (> 300 chars)',
    auth: VALID_OWNER_AUTH,
    operation: 'update',
    path: 'users/owner_uid_1/stories/story_1',
    payload: { title: 'A'.repeat(301) },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Orphaned Section Without Parent Story',
    auth: VALID_OWNER_AUTH,
    operation: 'create',
    path: 'users/owner_uid_1/stories/nonexistent_story/sections/sec_1',
    payload: {
      ownerId: 'owner_uid_1',
      storyId: 'nonexistent_story',
      order: 1,
      content: 'Orphaned prose',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Empty Versions Array / Out-of-Bounds activeVersionIndex',
    auth: VALID_OWNER_AUTH,
    operation: 'update',
    path: 'users/owner_uid_1/stories/story_1/sections/sec_1',
    payload: {
      versions: [],
      activeVersionIndex: 5,
    },
    expected: 'PERMISSION_DENIED',
  },
];
