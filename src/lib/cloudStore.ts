import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
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
  VoiceEnding,
  WritingStyle,
} from '../types.ts';
import { OperationType, db, handleFirestoreError, storage } from './firebase.ts';
import { extensionFromMimeType } from './format.ts';

// Schema limits synchronized with firebase-blueprint.json & firestore.rules
const MAX_TITLE_LENGTH = 300;
const MAX_CONTENT_LENGTH = 200000;
const MAX_VERSIONS = 50;
const MAX_FILENAME_LENGTH = 260;
const MAX_MIMETYPE_LENGTH = 100;
const MAX_URL_LENGTH = 2048;
const MAX_STORAGE_PATH_LENGTH = 512;
const MAX_ID_LENGTH = 128;

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
  return raw === 'summarize_structure' ? 'summarize_structure' : 'full_polish';
}

export interface SanitizedVersionDoc {
  id: string;
  text: string;
  style: WritingStyle;
  refinedEnding: VoiceEnding;
  model: GeminiModel;
  mode: ProcessingMode;
  timestamp: string;
}

export function sanitizeVersionForCloud(v: SectionVersion, index: number): SanitizedVersionDoc {
  return {
    id: sanitizeId(v.id || `ver_${index + 1}`, 'ver'),
    text: clampString(v.text ?? '', MAX_CONTENT_LENGTH),
    style: normalizeStyle(v.style),
    refinedEnding: normalizeEnding(v.refinedEnding),
    model: normalizeModel(v.model),
    mode: normalizeMode(v.mode),
    timestamp: clampString(v.timestamp || new Date().toISOString(), 64),
  };
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
    filename: clampString((meta.filename || 'recording.webm').trim() || 'recording.webm', MAX_FILENAME_LENGTH),
    mimeType: clampString((meta.mimeType || 'audio/webm').trim() || 'audio/webm', MAX_MIMETYPE_LENGTH),
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
    sectionCount: typeof data.sectionCount === 'number' ? data.sectionCount : 0,
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
  const rawIdx = typeof data.activeVersionIndex === 'number' ? data.activeVersionIndex : versions.length - 1;
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
    createdAt,
    updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Real-time Firestore Subscriptions (onSnapshot)
// ---------------------------------------------------------------------------

export function subscribeToStories(
  uid: string,
  onData: (stories: StorySession[]) => void,
  onError: (err: Error) => void,
): Unsubscribe {
  const path = `users/${uid}/stories`;
  const q = query(collection(db, path), where('ownerId', '==', uid));

  return onSnapshot(
    q,
    (snapshot) => {
      const stories = snapshot.docs
        .map((docSnap) => parseStoryDoc(docSnap.id, docSnap.data()))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
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
    nextSectionCount: number;
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
    const batch = writeBatch(db);
    batch.set(doc(db, sectionPath), sectionPayload);
    batch.update(doc(db, storyPath), {
      sectionCount: Math.max(0, Math.min(5000, Math.floor(params.nextSectionCount))),
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, sectionPath);
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

  try {
    const batch = writeBatch(db);
    batch.update(doc(db, sectionPath), {
      content: cleanContent,
      versions: cleanVersions,
      updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, storyPath), {
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, sectionPath);
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
    const batch = writeBatch(db);
    batch.update(doc(db, sectionPath), {
      content: clean.text,
      style: clean.style,
      refinedEnding: clean.refinedEnding,
      model: clean.model,
      activeVersionIndex: Math.max(0, Math.floor(activeVersionIndex)),
      updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, storyPath), {
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, sectionPath);
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

  try {
    const batch = writeBatch(db);
    batch.update(doc(db, sectionPath), {
      content: active.text,
      style: active.style,
      refinedEnding: active.refinedEnding,
      model: active.model,
      versions: cleanVersions,
      activeVersionIndex,
      updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, storyPath), {
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, sectionPath);
  }
}

export async function deleteSectionInCloud(
  uid: string,
  storyId: string,
  sectionId: string,
  storagePath: string | undefined,
  nextSectionCount: number,
): Promise<void> {
  const storyPath = `users/${uid}/stories/${storyId}`;
  const sectionPath = `${storyPath}/sections/${sectionId}`;

  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, sectionPath));
    batch.update(doc(db, storyPath), {
      sectionCount: Math.max(0, Math.min(5000, Math.floor(nextSectionCount))),
      updatedAt: serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, sectionPath);
  }

  if (storagePath) {
    await deleteSectionAudioFile(storagePath);
  }
}

export async function deleteStoryInCloud(uid: string, storyId: string): Promise<void> {
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

  const storagePaths: string[] = [];

  // Delete child section documents BEFORE deleting the parent story so Master Gate passes
  try {
    const docs = sectionDocs.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const chunk = docs.slice(i, i + 400);
      const batch = writeBatch(db);
      for (const secSnap of chunk) {
        const sp = secSnap.data().storagePath;
        if (typeof sp === 'string' && sp.trim()) {
          storagePaths.push(sp.trim());
        }
        batch.delete(secSnap.ref);
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, sectionsPath);
  }

  // Delete parent story document
  try {
    await deleteDoc(doc(db, storyPath));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, storyPath);
  }

  // Best-effort cleanup of Firebase Storage audio objects
  await Promise.allSettled(storagePaths.map((sp) => deleteSectionAudioFile(sp)));
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
