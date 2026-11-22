import {
  Timestamp,
  collection,
  deleteDoc,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  waitForPendingWrites,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import {
  deleteObject,
  getBlob,
  getDownloadURL,
  ref,
  uploadBytes,
} from 'firebase/storage';
import type {
  AudioMeta,
  GeminiModel,
  ManuscriptSection,
  ProcessingMode,
  SectionVersion,
  StorySession,
  TokenUsage,
  TrashedSection,
  VoiceEnding,
  WritingStyle,
} from '../types.ts';
import { getActiveVersionIndex, getSectionVersions } from '../types.ts';
import { deleteAudioClip, deleteAudioClips, deletePendingDraftAudio } from './audioDb.ts';
import { OperationType, db, handleFirestoreError, storage } from './firebase.ts';
import { extensionFromMimeType, isTrashItemExpired } from './format.ts';
import { createId } from './storage.ts';

// Schema limits synchronized with firebase-blueprint.json & firestore.rules
const MAX_TITLE_LENGTH = 300;
const MAX_GLOSSARY_LENGTH = 8000;
const MAX_CONTENT_LENGTH = 200000;
const MAX_VERSIONS = 50;
const MAX_FILENAME_LENGTH = 260;
const MAX_MIMETYPE_LENGTH = 100;
const MAX_URL_LENGTH = 2048;
const MAX_STORAGE_PATH_LENGTH = 512;
const MAX_ID_LENGTH = 128;
// Safe ceiling below Firestore's hard 1 MiB (1,048,576 byte) document limit (accounts for protobuf field overhead)
const MAX_SAFE_SECTION_DOC_BYTES = 850_000;

function estimateUtf8Bytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(json).length;
  }
  return json.length * 3;
}

function assertSectionPayloadWithinLimit(
  content: string,
  versions: SanitizedVersionDoc[],
): void {
  const estimatedBytes = estimateUtf8Bytes({ content, versions }) + 4096;
  if (estimatedBytes > MAX_SAFE_SECTION_DOC_BYTES) {
    throw new Error(
      'This section and its version history are approaching Firestore’s 1 MB document limit. Please copy the text into a new section before adding another version.',
    );
  }
}

function clampString(value: string, maxLen: number): string {
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

function sanitizeId(raw: string, fallbackPrefix = 'id'): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_ID_LENGTH);
  return cleaned || `${fallbackPrefix}_${Date.now()}`;
}

function timestampToIso(value: unknown, fallback?: string): string {
  if (value instanceof Timestamp) {
    return value.toDate().toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { toDate?: () => Date }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return fallback ?? new Date().toISOString();
}

function optionalTimestampToIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (typeof value === 'string' && value.trim()) return value;
  if (
    typeof value === 'object' &&
    typeof (value as { toDate?: () => Date }).toDate === 'function'
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

function normalizeStyle(raw: unknown): WritingStyle {
  if (raw === 'colloquial' || raw === 'literary' || raw === 'refined_flow') return raw;
  return 'colloquial';
}

function normalizeEnding(raw: unknown): VoiceEnding {
  return raw === 'literary' ? 'literary' : 'colloquial';
}

function normalizeModel(raw: unknown): GeminiModel {
  return raw === 'gemini-2.5-pro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
}

function normalizeMode(raw: unknown): ProcessingMode {
  if (raw === 'summarize_structure' || raw === 'proofread_only') return raw;
  return 'full_polish';
}

function parseUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const inputTokens = Number(r.inputTokens);
  const outputTokens = Number(r.outputTokens);
  const totalTokens = Number(r.totalTokens);
  const estimatedCostUsd = Number(r.estimatedCostUsd);
  if (
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(totalTokens) ||
    !Number.isFinite(estimatedCostUsd)
  ) {
    return undefined;
  }
  return {
    inputTokens: Math.max(0, Math.round(inputTokens)),
    outputTokens: Math.max(0, Math.round(outputTokens)),
    totalTokens: Math.max(0, Math.round(totalTokens)),
    estimatedCostUsd: Math.max(0, Number(estimatedCostUsd.toFixed(6))),
  };
}

function sanitizeUsageForCloud(usage: TokenUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = Math.max(0, Math.min(100_000_000, Math.round(usage.inputTokens || 0)));
  const outputTokens = Math.max(0, Math.min(100_000_000, Math.round(usage.outputTokens || 0)));
  const totalTokens = Math.max(
    0,
    Math.min(200_000_000, Math.round(usage.totalTokens || inputTokens + outputTokens)),
  );
  const estimatedCostUsd = Math.max(
    0,
    Math.min(10_000, Number((usage.estimatedCostUsd || 0).toFixed(6))),
  );
  return { inputTokens, outputTokens, totalTokens, estimatedCostUsd };
}

export interface SanitizedVersionDoc {
  id: string;
  text: string;
  style: WritingStyle;
  refinedEnding: VoiceEnding;
  model: GeminiModel;
  mode: ProcessingMode;
  timestamp: string;
  usage?: TokenUsage;
}

export function sanitizeVersionForCloud(v: SectionVersion, index: number): SanitizedVersionDoc {
  const docItem: SanitizedVersionDoc = {
    id: sanitizeId(v.id || `ver_${index + 1}`, 'ver'),
    text: clampString(v.text ?? '', MAX_CONTENT_LENGTH),
    style: normalizeStyle(v.style),
    refinedEnding: normalizeEnding(v.refinedEnding),
    model: normalizeModel(v.model),
    mode: normalizeMode(v.mode),
    timestamp: clampString(v.timestamp || new Date().toISOString(), 64),
  };
  const cleanUsage = sanitizeUsageForCloud(v.usage);
  if (cleanUsage) {
    docItem.usage = cleanUsage;
  }
  return docItem;
}

export function sanitizeVersionsForCloud(versions: SectionVersion[]): SanitizedVersionDoc[] {
  const bounded =
    versions.length > MAX_VERSIONS
      ? [versions[0], ...versions.slice(-(MAX_VERSIONS - 1))]
      : versions;
  return bounded.map((v, idx) => sanitizeVersionForCloud(v, idx));
}

function sanitizeAudioMetaForCloud(meta: AudioMeta): AudioMeta {
  return {
    filename: clampString(
      (meta.filename || 'recording.webm').trim() || 'recording.webm',
      MAX_FILENAME_LENGTH,
    ),
    mimeType: clampString(
      (meta.mimeType || 'audio/webm').trim() || 'audio/webm',
      MAX_MIMETYPE_LENGTH,
    ),
    durationSec: Math.max(0, Math.min(86400, Number.isFinite(meta.durationSec) ? meta.durationSec : 0)),
    sizeBytes: Math.max(0, Math.min(104857600, Number.isFinite(meta.sizeBytes) ? meta.sizeBytes : 0)),
  };
}

function parseStoryDoc(id: string, data: Record<string, unknown>): StorySession {
  const createdAt = timestampToIso(data.createdAt);
  const updatedAt = timestampToIso(data.updatedAt, createdAt);
  return {
    id,
    ownerId: typeof data.ownerId === 'string' ? data.ownerId : undefined,
    title: typeof data.title === 'string' && data.title.trim() ? data.title : 'Untitled Story',
    defaultStyle: normalizeStyle(data.defaultStyle),
    defaultRefinedEnding: normalizeEnding(data.defaultRefinedEnding),
    defaultModel: normalizeModel(data.defaultModel),
    sectionCount: typeof data.sectionCount === 'number' ? Math.max(0, data.sectionCount) : 0,
    glossary: typeof data.glossary === 'string' ? data.glossary : '',
    isDeleted: data.isDeleted === true,
    deletedAt: optionalTimestampToIso(data.deletedAt),
    sections: [],
    createdAt,
    updatedAt,
  };
}

function parseSectionDoc(id: string, data: Record<string, unknown>): ManuscriptSection {
  const createdAt = timestampToIso(data.createdAt);
  const updatedAt = timestampToIso(data.updatedAt, createdAt);
  const rawVersions = Array.isArray(data.versions) ? data.versions : [];
  const parsedVersions: SectionVersion[] = rawVersions
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map((item, idx) => ({
      id: typeof item.id === 'string' && item.id ? item.id : `${id}_v${idx + 1}`,
      text: typeof item.text === 'string' ? item.text : '',
      style: normalizeStyle(item.style),
      refinedEnding: normalizeEnding(item.refinedEnding),
      model: normalizeModel(item.model),
      mode: normalizeMode(item.mode),
      timestamp: typeof item.timestamp === 'string' && item.timestamp ? item.timestamp : updatedAt,
      usage: parseUsage(item.usage),
    }));

  const fallbackVersion: SectionVersion = {
    id: `${id}_v1`,
    text: typeof data.content === 'string' ? data.content : '',
    style: normalizeStyle(data.style),
    refinedEnding: normalizeEnding(data.refinedEnding),
    model: normalizeModel(data.model),
    mode: normalizeMode(data.mode),
    timestamp: updatedAt,
  };

  const versions = parsedVersions.length > 0 ? parsedVersions : [fallbackVersion];
  const rawIdx =
    typeof data.activeVersionIndex === 'number' ? data.activeVersionIndex : versions.length - 1;
  const activeVersionIndex = Math.max(0, Math.min(rawIdx, versions.length - 1));
  const active = versions[activeVersionIndex];

  const rawMeta = data.audioMeta;
  const audioMeta: AudioMeta | undefined =
    rawMeta && typeof rawMeta === 'object'
      ? {
          filename: String((rawMeta as Record<string, unknown>).filename || 'recording.webm'),
          mimeType: String((rawMeta as Record<string, unknown>).mimeType || 'audio/webm'),
          durationSec: Number((rawMeta as Record<string, unknown>).durationSec || 0),
          sizeBytes: Number((rawMeta as Record<string, unknown>).sizeBytes || 0),
        }
      : undefined;

  return {
    id,
    ownerId: typeof data.ownerId === 'string' ? data.ownerId : undefined,
    storyId: typeof data.storyId === 'string' ? data.storyId : undefined,
    order: typeof data.order === 'number' ? data.order : Date.parse(createdAt) || 0,
    content: active.text,
    style: active.style,
    refinedEnding: active.style === 'refined_flow' ? active.refinedEnding : undefined,
    model: active.model,
    mode: active.mode ?? normalizeMode(data.mode),
    audioUrl: typeof data.audioUrl === 'string' && data.audioUrl ? data.audioUrl : undefined,
    storagePath:
      typeof data.storagePath === 'string' && data.storagePath ? data.storagePath : undefined,
    audioId: typeof data.audioId === 'string' && data.audioId ? data.audioId : undefined,
    audioMeta,
    versions,
    activeVersionIndex,
    isDeleted: data.isDeleted === true,
    deletedAt: optionalTimestampToIso(data.deletedAt),
    parentStoryId: typeof data.parentStoryId === 'string' ? data.parentStoryId : undefined,
    parentStoryTitle:
      typeof data.parentStoryTitle === 'string' ? data.parentStoryTitle : undefined,
    createdAt,
    updatedAt,
  };
}

function parseTrashedSectionDoc(id: string, data: Record<string, unknown>): TrashedSection {
  const base = parseSectionDoc(id, data);
  return {
    ...base,
    parentStoryId:
      typeof data.parentStoryId === 'string' && data.parentStoryId
        ? data.parentStoryId
        : base.storyId || 'unknown',
    parentStoryTitle:
      typeof data.parentStoryTitle === 'string' && data.parentStoryTitle
        ? data.parentStoryTitle
        : 'Untitled Story',
    isDeleted: true,
    deletedAt: base.deletedAt || base.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Real-time Firestore Subscriptions (onSnapshot) & Cursor Pagination
// ---------------------------------------------------------------------------

export const STORIES_PAGE_SIZE = 30;

/**
 * Re-establishes Firestore's live WebChannel after iOS PWA background suspension
 * and optionally performs a lightweight 1-document server round-trip check on manual sync.
 * Active onSnapshot listeners retain IndexedDB watch resume tokens so only server deltas sync.
 */
export async function syncFirestoreConnection(params: {
  uid: string;
  activeStoryId?: string;
  forceReconnect?: boolean;
  verifyServer?: boolean;
}): Promise<{ online: boolean }> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { online: false };
  }

  try {
    if (params.forceReconnect) {
      await disableNetwork(db);
    }
    await enableNetwork(db);

    await Promise.race([
      waitForPendingWrites(db),
      new Promise<void>((resolve) => setTimeout(resolve, 4000)),
    ]);

    if (params.verifyServer) {
      const verifyPath = params.activeStoryId
        ? `users/${params.uid}/stories/${params.activeStoryId}`
        : `users/${params.uid}/stories`;

      try {
        if (params.activeStoryId) {
          await getDocFromServer(doc(db, verifyPath));
        } else {
          const pingQuery = query(
            collection(db, verifyPath),
            orderBy('updatedAt', 'desc'),
            limit(1),
          );
          await getDocsFromServer(pingQuery);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
        if (msg.includes('offline') || msg.includes('unavailable') || msg.includes('network')) {
          return { online: false };
        }
        if (!msg.includes('not-found')) {
          handleFirestoreError(
            err,
            params.activeStoryId ? OperationType.GET : OperationType.LIST,
            verifyPath,
          );
        }
      }
    }

    return { online: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (msg.includes('offline') || msg.includes('unavailable') || msg.includes('network')) {
      return { online: false };
    }
    throw err;
  }
}

export type StoryCursor = QueryDocumentSnapshot<DocumentData>;

export interface StoriesPageResult {
  stories: StorySession[];
  hasMore: boolean;
  lastDoc: StoryCursor | null;
}

/**
 * Subscribes only to the lightweight story metadata list for the most recent
 * `pageSize` stories (default 30), ordered by `updatedAt` descending.
 * Served directly from persistent IndexedDB cache on refresh, syncing deltas only.
 */
export function subscribeToRecentStories(
  uid: string,
  pageSize: number,
  onData: (result: StoriesPageResult) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const path = `users/${uid}/stories`;
  const q = query(
    collection(db, path),
    orderBy('updatedAt', 'desc'),
    limit(pageSize + 1),
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const hasMore = snapshot.docs.length > pageSize;
      const pageDocs = hasMore ? snapshot.docs.slice(0, pageSize) : snapshot.docs;
      const stories = pageDocs.map((docSnap) => parseStoryDoc(docSnap.id, docSnap.data()));
      const lastDoc = pageDocs.length > 0 ? pageDocs[pageDocs.length - 1] : null;
      onData({ stories, hasMore, lastDoc });
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    },
  );
}

/**
 * Loads the next page of older story metadata documents on demand when the user
 * clicks "Load older stories" in the sidebar.
 */
export async function fetchOlderStoriesPage(
  uid: string,
  afterCursor: StoryCursor,
  pageSize = STORIES_PAGE_SIZE,
): Promise<StoriesPageResult> {
  const path = `users/${uid}/stories`;
  try {
    const q = query(
      collection(db, path),
      orderBy('updatedAt', 'desc'),
      startAfter(afterCursor),
      limit(pageSize + 1),
    );
    const snapshot = await getDocs(q);
    const hasMore = snapshot.docs.length > pageSize;
    const pageDocs = hasMore ? snapshot.docs.slice(0, pageSize) : snapshot.docs;
    const stories = pageDocs.map((docSnap) => parseStoryDoc(docSnap.id, docSnap.data()));
    const lastDoc = pageDocs.length > 0 ? pageDocs[pageDocs.length - 1] : null;
    return { stories, hasMore, lastDoc };
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

/**
 * Lightweight single-field query for soft-deleted stories in the 30-day Trash Bin.
 * Ensures Trash count and automatic 30-day expiry cleanup remain accurate even when
 * the user has 1,000+ active stories.
 */
export function subscribeToTrashedStories(
  uid: string,
  onData: (stories: StorySession[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const path = `users/${uid}/stories`;
  const q = query(collection(db, path), where('isDeleted', '==', true));

  return onSnapshot(
    q,
    (snapshot) => {
      const stories = snapshot.docs
        .map((docSnap) => parseStoryDoc(docSnap.id, docSnap.data()))
        .sort(
          (a, b) =>
            Date.parse(b.deletedAt || b.updatedAt) - Date.parse(a.deletedAt || a.updatedAt),
        );
      onData(stories);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    },
  );
}

export function subscribeToSections(
  uid: string,
  storyId: string,
  onData: (sections: ManuscriptSection[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const path = `users/${uid}/stories/${storyId}/sections`;
  const q = query(
    collection(db, path),
    where('ownerId', '==', uid),
    where('storyId', '==', storyId),
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const sections = snapshot.docs
        .map((docSnap) => parseSectionDoc(docSnap.id, docSnap.data()))
        .filter((sec) => sec.isDeleted !== true)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      onData(sections);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    },
  );
}

export function subscribeToTrashedSections(
  uid: string,
  onData: (items: TrashedSection[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const path = `users/${uid}/trashedSections`;
  const q = query(collection(db, path), where('ownerId', '==', uid));

  return onSnapshot(
    q,
    (snapshot) => {
      const items = snapshot.docs
        .map((docSnap) => parseTrashedSectionDoc(docSnap.id, docSnap.data()))
        .sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
      onData(items);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    },
  );
}

export async function fetchStorySectionsOnce(
  uid: string,
  storyId: string,
): Promise<ManuscriptSection[]> {
  const path = `users/${uid}/stories/${storyId}/sections`;
  try {
    const q = query(
      collection(db, path),
      where('ownerId', '==', uid),
      where('storyId', '==', storyId),
    );
    const snap = await getDocs(q);
    return snap.docs
      .map((docSnap) => parseSectionDoc(docSnap.id, docSnap.data()))
      .filter((sec) => sec.isDeleted !== true)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

// ---------------------------------------------------------------------------
// Story CRUD Operations
// ---------------------------------------------------------------------------

export async function createStoryInCloud(
  uid: string,
  params: {
    storyId: string;
    title: string;
    defaultStyle: WritingStyle;
    defaultRefinedEnding: VoiceEnding;
    defaultModel: GeminiModel;
  },
): Promise<void> {
  const storyId = sanitizeId(params.storyId, 'story');
  const path = `users/${uid}/stories/${storyId}`;
  const cleanTitle = clampString(params.title.trim() || 'Untitled Story', MAX_TITLE_LENGTH);

  try {
    await setDoc(doc(db, path), {
      ownerId: uid,
      title: cleanTitle,
      defaultStyle: normalizeStyle(params.defaultStyle),
      defaultRefinedEnding: normalizeEnding(params.defaultRefinedEnding),
      defaultModel: normalizeModel(params.defaultModel),
      sectionCount: 0,
      isDeleted: false,
      deletedAt: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function renameStoryInCloud(
  uid: string,
  storyId: string,
  title: string,
): Promise<void> {
  const path = `users/${uid}/stories/${storyId}`;
  const cleanTitle = clampString(title.trim() || 'Untitled Story', MAX_TITLE_LENGTH);
  try {
    await updateDoc(doc(db, path), {
      title: cleanTitle,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateStoryStyleInCloud(
  uid: string,
  storyId: string,
  defaultStyle: WritingStyle,
): Promise<void> {
  const path = `users/${uid}/stories/${storyId}`;
  try {
    await updateDoc(doc(db, path), {
      defaultStyle: normalizeStyle(defaultStyle),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateStoryRefinedEndingInCloud(
  uid: string,
  storyId: string,
  defaultRefinedEnding: VoiceEnding,
): Promise<void> {
  const path = `users/${uid}/stories/${storyId}`;
  try {
    await updateDoc(doc(db, path), {
      defaultRefinedEnding: normalizeEnding(defaultRefinedEnding),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateStoryModelInCloud(
  uid: string,
  storyId: string,
  defaultModel: GeminiModel,
): Promise<void> {
  const path = `users/${uid}/stories/${storyId}`;
  try {
    await updateDoc(doc(db, path), {
      defaultModel: normalizeModel(defaultModel),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateStoryGlossaryInCloud(
  uid: string,
  storyId: string,
  glossary: string,
): Promise<void> {
  const path = `users/${uid}/stories/${storyId}`;
  const cleanGlossary = clampString(glossary.trim(), MAX_GLOSSARY_LENGTH);
  try {
    await updateDoc(doc(db, path), {
      glossary: cleanGlossary,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

// ---------------------------------------------------------------------------
// Section CRUD Operations
// ---------------------------------------------------------------------------

export async function createSectionInCloud(
  uid: string,
  storyId: string,
  params: {
    sectionId: string;
    order: number;
    initialVersion: SectionVersion;
    audioUrl?: string;
    storagePath?: string;
    audioId?: string;
    audioMeta?: AudioMeta;
  },
): Promise<void> {
  const sectionId = sanitizeId(params.sectionId, 'sec');
  const storyPath = `users/${uid}/stories/${storyId}`;
  const sectionPath = `${storyPath}/sections/${sectionId}`;

  const cleanVersion = sanitizeVersionForCloud(params.initialVersion, 0);
  const sectionPayload: Record<string, unknown> = {
    ownerId: uid,
    storyId,
    order: Math.max(0, Number.isFinite(params.order) ? params.order : Date.now()),
    content: cleanVersion.text,
    style: cleanVersion.style,
    refinedEnding: cleanVersion.refinedEnding,
    model: cleanVersion.model,
    mode: cleanVersion.mode,
    versions: [cleanVersion],
    activeVersionIndex: 0,
    audioUrl: clampString(params.audioUrl ?? '', MAX_URL_LENGTH),
    storagePath: clampString(params.storagePath ?? '', MAX_STORAGE_PATH_LENGTH),
    isDeleted: false,
    deletedAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (params.audioId) {
    sectionPayload.audioId = clampString(params.audioId, MAX_ID_LENGTH);
  }
  if (params.audioMeta) {
    sectionPayload.audioMeta = sanitizeAudioMetaForCloud(params.audioMeta);
  }

  try {
    await setDoc(doc(db, sectionPath), sectionPayload);
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, sectionPath);
  }

  try {
    await updateDoc(doc(db, storyPath), {
      sectionCount: increment(1),
      updatedAt: serverTimestamp(),
    });
  } catch (storyErr) {
    console.warn('Section created, but parent story metadata update failed:', storyErr);
  }
}

export async function updateSectionContentInCloud(
  uid: string,
  storyId: string,
  sectionId: string,
  content: string,
  versions: SectionVersion[],
): Promise<void> {
  const storyPath = `users/${uid}/stories/${storyId}`;
  const sectionPath = `${storyPath}/sections/${sectionId}`;
  const cleanVersions = sanitizeVersionsForCloud(versions);
  const cleanContent = clampString(content, MAX_CONTENT_LENGTH);

  assertSectionPayloadWithinLimit(cleanContent, cleanVersions);

  try {
    await updateDoc(doc(db, sectionPath), {
      content: cleanContent,
      versions: cleanVersions,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, sectionPath);
  }

  try {
    await updateDoc(doc(db, storyPath), {
      updatedAt: serverTimestamp(),
    });
  } catch (storyErr) {
    console.warn('Section updated, but parent story timestamp touch failed:', storyErr);
  }
}

export async function selectSectionVersionInCloud(
  uid: string,
  storyId: string,
  sectionId: string,
  selectedVersion: SectionVersion,
  activeVersionIndex: number,
): Promise<void> {
  const storyPath = `users/${uid}/stories/${storyId}`;
  const sectionPath = `${storyPath}/sections/${sectionId}`;
  const clean = sanitizeVersionForCloud(selectedVersion, activeVersionIndex);

  try {
    await updateDoc(doc(db, sectionPath), {
      content: clean.text,
      style: clean.style,
      refinedEnding: clean.refinedEnding,
      model: clean.model,
      mode: clean.mode,
      activeVersionIndex: Math.max(0, Math.floor(activeVersionIndex)),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, sectionPath);
  }

  try {
    await updateDoc(doc(db, storyPath), {
      updatedAt: serverTimestamp(),
    });
  } catch (storyErr) {
    console.warn('Section version selected, but parent story timestamp touch failed:', storyErr);
  }
}

export async function appendSectionVersionInCloud(
  uid: string,
  storyId: string,
  sectionId: string,
  nextVersions: SectionVersion[],
): Promise<void> {
  const storyPath = `users/${uid}/stories/${storyId}`;
  const sectionPath = `${storyPath}/sections/${sectionId}`;
  const cleanVersions = sanitizeVersionsForCloud(nextVersions);
  const activeVersionIndex = cleanVersions.length - 1;
  const active = cleanVersions[activeVersionIndex];

  assertSectionPayloadWithinLimit(active.text, cleanVersions);

  try {
    await updateDoc(doc(db, sectionPath), {
      content: active.text,
      style: active.style,
      refinedEnding: active.refinedEnding,
      model: active.model,
      mode: active.mode,
      versions: cleanVersions,
      activeVersionIndex,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, sectionPath);
  }

  try {
    await updateDoc(doc(db, storyPath), {
      updatedAt: serverTimestamp(),
    });
  } catch (storyErr) {
    console.warn('Section version appended, but parent story timestamp touch failed:', storyErr);
  }
}

// ---------------------------------------------------------------------------
// 30-Day Soft Delete (Trash Bin), Restore & Permanent Cleanup
// ---------------------------------------------------------------------------

export async function moveStoryToTrashInCloud(uid: string, storyId: string): Promise<void> {
  const path = `users/${uid}/stories/${storyId}`;
  try {
    await updateDoc(doc(db, path), {
      isDeleted: true,
      deletedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function restoreStoryFromTrashInCloud(uid: string, storyId: string): Promise<void> {
  const path = `users/${uid}/stories/${storyId}`;
  try {
    await updateDoc(doc(db, path), {
      isDeleted: false,
      deletedAt: null,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function moveSectionToTrashInCloud(
  uid: string,
  storyId: string,
  storyTitle: string,
  section: ManuscriptSection,
): Promise<void> {
  const storyPath = `users/${uid}/stories/${storyId}`;
  const sectionPath = `${storyPath}/sections/${section.id}`;
  const trashPath = `users/${uid}/trashedSections/${section.id}`;

  const cleanStoryTitle = clampString(storyTitle.trim() || 'Untitled Story', MAX_TITLE_LENGTH);
  const cleanVersions = sanitizeVersionsForCloud(getSectionVersions(section));
  const activeIdx = Math.max(0, Math.min(getActiveVersionIndex(section), cleanVersions.length - 1));
  const active = cleanVersions[activeIdx];

  const trashPayload: Record<string, unknown> = {
    ownerId: uid,
    parentStoryId: storyId,
    parentStoryTitle: cleanStoryTitle,
    order: Math.max(0, typeof section.order === 'number' ? section.order : Date.now()),
    content: active.text,
    style: active.style,
    refinedEnding: active.refinedEnding,
    model: active.model,
    mode: active.mode,
    versions: cleanVersions,
    activeVersionIndex: activeIdx,
    audioUrl: clampString(section.audioUrl ?? '', MAX_URL_LENGTH),
    storagePath: clampString(section.storagePath ?? '', MAX_STORAGE_PATH_LENGTH),
    isDeleted: true,
    deletedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (section.audioId) {
    trashPayload.audioId = clampString(section.audioId, MAX_ID_LENGTH);
  }
  if (section.audioMeta) {
    trashPayload.audioMeta = sanitizeAudioMetaForCloud(section.audioMeta);
  }

  try {
    const batch = writeBatch(db);
    batch.update(doc(db, sectionPath), {
      isDeleted: true,
      deletedAt: serverTimestamp(),
      parentStoryId: storyId,
      parentStoryTitle: cleanStoryTitle,
      updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, storyPath), {
      sectionCount: increment(-1),
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, trashPath), trashPayload);
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, sectionPath);
  }
}

export async function restoreSectionFromTrashInCloud(
  uid: string,
  trashed: TrashedSection,
  allStories: StorySession[],
): Promise<{ restoredStoryId: string; restoredStoryTitle: string; usedFallbackStory: boolean }> {
  const trashPath = `users/${uid}/trashedSections/${trashed.id}`;
  let parentStory = allStories.find(
    (s) => s.id === trashed.parentStoryId && !s.isDeleted,
  );

  // If the original parent story wasn't in the currently loaded page, verify it directly
  if (!parentStory && trashed.parentStoryId && trashed.parentStoryId !== 'unknown') {
    try {
      const parentSnap = await getDoc(doc(db, `users/${uid}/stories/${trashed.parentStoryId}`));
      if (parentSnap.exists()) {
        const parsedParent = parseStoryDoc(parentSnap.id, parentSnap.data());
        if (!parsedParent.isDeleted) {
          parentStory = parsedParent;
        }
      }
    } catch {
      // Ignore lookup failures and fall back cleanly
    }
  }

  // Case 1: Original parent story still exists and is active -> restore section in place
  if (parentStory) {
    const parentStoryPath = `users/${uid}/stories/${parentStory.id}`;
    const originalSectionPath = `${parentStoryPath}/sections/${trashed.id}`;
    try {
      const existingSnap = await getDoc(doc(db, originalSectionPath));
      if (existingSnap.exists()) {
        const batch = writeBatch(db);
        batch.update(doc(db, originalSectionPath), {
          isDeleted: false,
          deletedAt: null,
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(db, parentStoryPath), {
          sectionCount: increment(1),
          updatedAt: serverTimestamp(),
        });
        batch.delete(doc(db, trashPath));
        await batch.commit();
        return {
          restoredStoryId: parentStory.id,
          restoredStoryTitle: parentStory.title,
          usedFallbackStory: false,
        };
      }
    } catch {
      // Fall through to recreating section in target story
    }
  }

  // Case 2: Original parent story was permanently deleted or is still in Trash ->
  // restore into an active "Restored Sections" story (reusing existing one or creating new)
  let fallbackStory = allStories.find(
    (s) => !s.isDeleted && s.title.trim().toLowerCase() === 'restored sections',
  );
  let targetStoryId: string;

  if (fallbackStory) {
    targetStoryId = fallbackStory.id;
  } else {
    targetStoryId = createId('story');
    await createStoryInCloud(uid, {
      storyId: targetStoryId,
      title: 'Restored Sections',
      defaultStyle: trashed.style,
      defaultRefinedEnding: trashed.refinedEnding ?? 'colloquial',
      defaultModel: trashed.model,
    });
  }

  const targetStoryPath = `users/${uid}/stories/${targetStoryId}`;
  const restoredSectionId = sanitizeId(trashed.id, 'sec');
  const restoredSectionPath = `${targetStoryPath}/sections/${restoredSectionId}`;

  const cleanVersions = sanitizeVersionsForCloud(getSectionVersions(trashed));
  const activeIdx = Math.max(0, Math.min(getActiveVersionIndex(trashed), cleanVersions.length - 1));
  const active = cleanVersions[activeIdx];

  const payload: Record<string, unknown> = {
    ownerId: uid,
    storyId: targetStoryId,
    order: Math.max(0, typeof trashed.order === 'number' ? trashed.order : Date.now()),
    content: active.text,
    style: active.style,
    refinedEnding: active.refinedEnding,
    model: active.model,
    mode: active.mode,
    versions: cleanVersions,
    activeVersionIndex: activeIdx,
    audioUrl: clampString(trashed.audioUrl ?? '', MAX_URL_LENGTH),
    storagePath: clampString(trashed.storagePath ?? '', MAX_STORAGE_PATH_LENGTH),
    isDeleted: false,
    deletedAt: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (trashed.audioId) {
    payload.audioId = clampString(trashed.audioId, MAX_ID_LENGTH);
  }
  if (trashed.audioMeta) {
    payload.audioMeta = sanitizeAudioMetaForCloud(trashed.audioMeta);
  }

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, restoredSectionPath), payload);
    batch.update(doc(db, targetStoryPath), {
      sectionCount: increment(1),
      updatedAt: serverTimestamp(),
    });
    batch.delete(doc(db, trashPath));
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, restoredSectionPath);
  }

  return {
    restoredStoryId: targetStoryId,
    restoredStoryTitle: 'Restored Sections',
    usedFallbackStory: true,
  };
}

export async function permanentlyDeleteSectionFromTrashInCloud(
  uid: string,
  trashed: TrashedSection,
): Promise<void> {
  const trashPath = `users/${uid}/trashedSections/${trashed.id}`;

  // 1. Delete Firebase Storage audio file FIRST so transient Storage failures never orphan audio
  if (trashed.storagePath) {
    await deleteSectionAudioFileStrict(trashed.storagePath);
  }

  // 2. Always attempt to clean up the original subcollection doc regardless of sidebar pagination
  if (trashed.parentStoryId && trashed.parentStoryId !== 'unknown') {
    const origPath = `users/${uid}/stories/${trashed.parentStoryId}/sections/${trashed.id}`;
    try {
      await deleteDoc(doc(db, origPath));
    } catch {
      // Safe to ignore if parent story was already permanently deleted or doc already removed
    }
  }

  // 3. Remove Trash index document last
  try {
    await deleteDoc(doc(db, trashPath));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, trashPath);
  }

  // 4. Clean up local IndexedDB audio clip so deleted sections never bloat browser storage
  if (trashed.audioId) {
    await deleteAudioClip(trashed.audioId).catch(() => undefined);
  }
}

export async function permanentlyDeleteStoryInCloud(uid: string, storyId: string): Promise<void> {
  const storyPath = `users/${uid}/stories/${storyId}`;
  const sectionsPath = `${storyPath}/sections`;

  let sectionDocs;
  try {
    const q = query(
      collection(db, sectionsPath),
      where('ownerId', '==', uid),
      where('storyId', '==', storyId),
    );
    sectionDocs = await getDocs(q);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, sectionsPath);
  }

  const storagePathsToDelete: string[] = [];
  const localAudioIdsToDelete: string[] = [];
  for (const secSnap of sectionDocs.docs) {
    const data = secSnap.data();
    const isIndividuallyTrashed = data.isDeleted === true;
    // Preserve audio for sections that are independently tracked in trashedSections
    if (!isIndividuallyTrashed) {
      if (typeof data.storagePath === 'string' && data.storagePath.trim()) {
        storagePathsToDelete.push(data.storagePath.trim());
      }
      if (typeof data.audioId === 'string' && data.audioId.trim()) {
        localAudioIdsToDelete.push(data.audioId.trim());
      }
    }
  }

  // 1. Delete Firebase Storage audio files FIRST so no audio files are orphaned on Storage errors
  for (const sp of storagePathsToDelete) {
    await deleteSectionAudioFileStrict(sp);
  }

  // 2. Delete child section documents BEFORE deleting parent story so Master Gate passes
  try {
    const docs = sectionDocs.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const chunk = docs.slice(i, i + 400);
      const batch = writeBatch(db);
      for (const secSnap of chunk) {
        batch.delete(secSnap.ref);
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, sectionsPath);
  }

  // 3. Delete parent story document last
  try {
    await deleteDoc(doc(db, storyPath));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, storyPath);
  }

  // 4. Clean up all local IndexedDB section audio clips & any pending draft audio for this story
  await Promise.allSettled([
    localAudioIdsToDelete.length > 0 ? deleteAudioClips(localAudioIdsToDelete) : Promise.resolve(),
    deletePendingDraftAudio(storyId),
  ]);
}

export async function purgeExpiredTrashInCloud(
  uid: string,
  trashedStories: StorySession[],
  trashedSections: TrashedSection[],
): Promise<number> {
  let purgedCount = 0;

  const expiredStories = trashedStories.filter((s) => isTrashItemExpired(s.deletedAt));
  for (const story of expiredStories) {
    try {
      await permanentlyDeleteStoryInCloud(uid, story.id);
      purgedCount += 1;
    } catch (err) {
      console.warn('Auto-cleanup failed for expired story:', story.id, err);
    }
  }

  const expiredSections = trashedSections.filter((sec) => isTrashItemExpired(sec.deletedAt));
  for (const sec of expiredSections) {
    try {
      await permanentlyDeleteSectionFromTrashInCloud(uid, sec);
      purgedCount += 1;
    } catch (err) {
      console.warn('Auto-cleanup failed for expired section:', sec.id, err);
    }
  }

  return purgedCount;
}

// ---------------------------------------------------------------------------
// Firebase Storage Audio Operations
// ---------------------------------------------------------------------------

export async function uploadSectionAudio(params: {
  uid: string;
  storyId: string;
  sectionId: string;
  blob: Blob;
  mimeType: string;
  filename?: string;
}): Promise<{ audioUrl: string; storagePath: string }> {
  const extFromName = params.filename?.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]?.toLowerCase();
  const ext = extFromName || extensionFromMimeType(params.mimeType);
  const safeStoryId = sanitizeId(params.storyId, 'story');
  const safeSectionId = sanitizeId(params.sectionId, 'sec');
  const storagePath = `users/${params.uid}/audio/${safeStoryId}/${safeSectionId}.${ext}`;
  const fileRef = ref(storage, storagePath);

  await uploadBytes(fileRef, params.blob, {
    contentType: params.mimeType || 'audio/webm',
  });
  const audioUrl = await getDownloadURL(fileRef);
  return { audioUrl, storagePath };
}

export async function downloadSectionAudioBlob(
  storagePath?: string,
  audioUrl?: string,
): Promise<Blob | null> {
  if (storagePath) {
    try {
      return await getBlob(ref(storage, storagePath));
    } catch {
      // Fallback to direct download URL fetch
    }
  }
  if (audioUrl) {
    try {
      const res = await fetch(audioUrl);
      if (res.ok) {
        return await res.blob();
      }
    } catch {
      return null;
    }
  }
  return null;
}

export async function deleteSectionAudioFileStrict(storagePath: string): Promise<void> {
  if (!storagePath) return;
  try {
    await deleteObject(ref(storage, storagePath));
  } catch (err) {
    const code = (err as { code?: string })?.code || '';
    if (code === 'storage/object-not-found') {
      return;
    }
    throw err;
  }
}

export async function deleteSectionAudioFile(storagePath: string): Promise<void> {
  if (!storagePath) return;
  try {
    await deleteObject(ref(storage, storagePath));
  } catch (err) {
    const code = (err as { code?: string })?.code || '';
    if (code !== 'storage/object-not-found') {
      console.warn('Could not remove audio object from Firebase Storage:', err);
    }
  }
}

export function formatCloudErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes("Quota exceeded for quota metric 'Free daily read units per project")) {
    return 'Firestore daily free-tier read quota exceeded. Your quota resets tomorrow, or you can upgrade in the Firebase Console.';
  }
  if (raw.toLowerCase().includes('quota exceeded')) {
    return 'Firestore usage quota exceeded. Quota resets tomorrow.';
  }
  if (raw.includes('permission-denied') || raw.includes('Missing or insufficient permissions')) {
    return 'Cloud sync permission denied. Please verify you are signed in with your authorized Google account and that Firestore rules are active.';
  }
  if (raw.includes('storage/unauthorized')) {
    return 'Firebase Storage upload was blocked by Storage Rules. Paste the Storage Security Rules in Firebase Console → Storage → Rules.';
  }
  if (raw.includes('offline')) {
    return 'Currently offline. Changes will sync when your connection returns.';
  }
  return raw;
}
