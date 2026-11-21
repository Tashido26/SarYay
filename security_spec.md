# Security Specification — SarYay Cloud Firestore Rules

## 1. Data Invariants

1. **Single-Owner Verified Identity:** Only an authenticated user with `request.auth.token.email_verified == true`, `request.auth.token.email == 'herozboy@gmail.com'`, and `request.auth.uid == userId` may read or write any document under `/users/{userId}/...`.
2. **Parent Existence (Master Gate):** A section under `/users/{userId}/stories/{storyId}/sections/{sectionId}` can only be read (`get`), created, updated, or deleted when its parent story `/users/{userId}/stories/{storyId}` exists and has `ownerId == request.auth.uid`.
3. **Immutable Ownership & Lineage:** `ownerId`, `createdAt`, and (on sections) `storyId` and `order` cannot be changed after creation.
4. **Strict Temporal Integrity:** `createdAt` must equal `request.time` on create; `updatedAt` must equal `request.time` on every create and update.
5. **Bounded Payloads & Version History:** Every string has a strict `.size()` ceiling; `versions` is bounded between `1` and `50` entries with strict validation of `versions[0]`; `activeVersionIndex` must be an integer within `[0, versions.size() - 1]`.
6. **Zero Shadow Fields:** Create checks `hasAll` + `hasOnly`; every update is partitioned into named action branches enforced by `incoming().diff(existing()).affectedKeys().hasOnly(...)` AND wrapped by `isValidStory(incoming())` / `isValidSection(incoming())`.
7. **Secure List Queries:** `allow list` validates `isAuthorizedOwner(userId)` and `existing().ownerId == request.auth.uid` (and `existing().storyId == storyId` on sections) with zero `get()`/`exists()` lookups inside `allow list`.

## 2. The "Dirty Dozen" Payloads (All Must Return PERMISSION_DENIED)

1. **Unauthenticated Story Read:** `get /users/uid1/stories/story_1` with `auth = null`.
2. **Unauthorized Email Sign-In:** `create /users/uid2/stories/story_1` with `email = "attacker@gmail.com"`, `email_verified = true`.
3. **Email Spoofing (Unverified Email):** `create /users/uid1/stories/story_1` with `email = "herozboy@gmail.com"`, `email_verified = false`.
4. **Cross-UID Impersonation:** `create /users/uid_victim/stories/story_1` while signed in as `uid_owner` with `ownerId: "uid_victim"`.
5. **Shadow Field Injection on Create:** `create /users/uid1/stories/story_1` containing all required fields plus ghost field `"isAdmin": true`.
6. **Shadow Field Injection on Update:** `update /users/uid1/stories/story_1` modifying `title`, `updatedAt`, plus ghost field `"role": "superadmin"`.
7. **Immutable Field Tampering (`createdAt` / `ownerId`):** `update /users/uid1/stories/story_1` changing `createdAt` or `ownerId`.
8. **Client-Spoofed Timestamp:** `create /users/uid1/stories/story_1` with `createdAt` set to a client past timestamp instead of `serverTimestamp()`.
9. **ID Poisoning:** `create /users/uid1/stories/bad$id..with..spaces` (fails `isValidId`).
10. **Oversized Title / Denial of Wallet:** `update /users/uid1/stories/story_1` with `title` of 500 characters (`> 300`).
11. **Orphaned Section Write:** `create /users/uid1/stories/nonexistent_story/sections/sec_1` where parent story does not exist.
12. **Out-of-Bounds Version Index / Empty Versions Array:** `update /users/uid1/stories/story_1/sections/sec_1` with `versions: []` or `activeVersionIndex: 5` when `versions.size() == 1`.
