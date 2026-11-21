import type { ManuscriptSection, StorySession } from '../types.ts';

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00';
  const rounded = Math.floor(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isSameDay) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function extensionFromMimeType(mimeType: string): string {
  const clean = mimeType.toLowerCase().split(';')[0].trim();
  switch (clean) {
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
      return 'wav';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
    case 'audio/aac':
      return 'm4a';
    case 'audio/ogg':
    case 'audio/opus':
      return 'ogg';
    case 'audio/webm':
    default:
      return 'webm';
  }
}

export function buildRecordingFilename(storyTitle: string, mimeType: string): string {
  const safeTitle = storyTitle
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u1000-\u109f]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(
    now.getMinutes(),
  ).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const ext = extensionFromMimeType(mimeType);
  return `${safeTitle || 'dictation'}-${stamp}.${ext}`;
}

export function getAudioDuration(blob: Blob, fallbackSeconds = 0): Promise<number> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio();
    let settled = false;

    const finish = (seconds: number) => {
      if (settled) return;
      settled = true;
      audio.src = '';
      URL.revokeObjectURL(objectUrl);
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds);
    };

    const timeout = window.setTimeout(() => finish(fallbackSeconds), 4000);

    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        window.clearTimeout(timeout);
        finish(audio.duration);
      } else if (audio.duration === Infinity) {
        // Common Chrome MediaRecorder WebM behavior: seek to end to calculate real duration
        audio.currentTime = 1e101;
        audio.addEventListener(
          'timeupdate',
          () => {
            window.clearTimeout(timeout);
            const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : fallbackSeconds;
            finish(dur);
          },
          { once: true },
        );
      } else {
        window.clearTimeout(timeout);
        finish(fallbackSeconds);
      }
    });

    audio.addEventListener('error', () => {
      window.clearTimeout(timeout);
      finish(fallbackSeconds);
    });

    audio.preload = 'metadata';
    audio.src = objectUrl;
  });
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function sortSectionsChronologically(
  sections: ManuscriptSection[],
): ManuscriptSection[] {
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => {
      const timeA = Date.parse(a.section.createdAt);
      const timeB = Date.parse(b.section.createdAt);
      if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) {
        return timeA - timeB;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.section);
}

export function compileFullStoryPlainText(session: StorySession): string {
  const ordered = sortSectionsChronologically(session.sections);
  const body = ordered
    .map((s) => s.content.trim())
    .filter(Boolean)
    .join('\n\n');
  if (!body) return '';
  return `${session.title.trim() || 'Untitled Story'}\n\n${body}\n`;
}

export function compileFullStoryMarkdown(session: StorySession): string {
  const title = session.title.trim() || 'Untitled Story';
  const ordered = sortSectionsChronologically(session.sections);
  const body = ordered
    .map((section) => section.content.trim())
    .filter(Boolean)
    .join('\n\n');

  if (!body) return `# ${title}\n`;
  return `# ${title}\n\n${body}\n`;
}

export function safeExportFilename(title: string, extension: 'txt' | 'md'): string {
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${cleaned || 'Untitled-Story'}.${extension}`;
}

export function countCharacters(text: string): number {
  return text.replace(/\s+/g, '').length;
}
