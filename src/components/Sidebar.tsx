import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, LogOut, PanelLeftClose, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { StorySession } from '../types.ts';
import { STYLE_SHORT_LABELS } from '../types.ts';
import { formatTimestamp } from '../lib/format.ts';
import { BRAND_LOGO_URL } from '../lib/brand.ts';

interface SidebarProps {
  sessions: StorySession[];
  activeSessionId: string;
  activeSectionCount: number;
  activeView: 'story' | 'trash';
  trashCount: number;
  hasMoreStories?: boolean;
  isLoadingMoreStories?: boolean;
  isOpen: boolean;
  userEmail?: string | null;
  onSignOut: () => void;
  onCloseMobile: () => void;
  onToggleDesktop: () => void;
  onSelectSession: (id: string) => void;
  onSelectTrash: () => void;
  onLoadOlderStories?: () => void;
  onCreateSession: () => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id: string) => void;
}

export function Sidebar({
  sessions,
  activeSessionId,
  activeSectionCount,
  activeView,
  trashCount,
  hasMoreStories = false,
  isLoadingMoreStories = false,
  isOpen,
  userEmail,
  onSignOut,
  onCloseMobile,
  onToggleDesktop,
  onSelectSession,
  onSelectTrash,
  onLoadOlderStories,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const startRename = (session: StorySession) => {
    setEditingId(session.id);
    setDraftTitle(session.title);
  };

  const commitRename = () => {
    if (!editingId) return;
    const trimmed = draftTitle.trim();
    onRenameSession(editingId, trimmed || 'Untitled Story');
    setEditingId(null);
  };

  const cancelRename = () => {
    setEditingId(null);
  };

  const sortedSessions = [...sessions].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

  const sidebarContent = (
    <aside className="safe-top safe-bottom flex h-full w-[268px] flex-col border-r border-[#E5E7EB] bg-[#F8F9FA]">
      {/* Brand header */}
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <div className="flex items-center gap-2.5">
          <img
            src={BRAND_LOGO_URL}
            alt="SarYay"
            width={32}
            height={32}
            className="h-8 w-8 shrink-0 rounded-full border border-[#E5E7EB] bg-white object-cover"
          />
          <span className="whitespace-nowrap text-[15px] font-semibold tracking-tight text-[#111827]">
            SarYay
          </span>
        </div>
        <button
          type="button"
          onClick={onToggleDesktop}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          className="hidden h-8 w-8 items-center justify-center rounded-md text-[#6B7280] transition-colors duration-150 hover:bg-[#ECEEF1] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] lg:inline-flex"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close sidebar"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#6B7280] transition-colors duration-150 hover:bg-[#ECEEF1] hover:text-[#111827] lg:hidden"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* New Story CTA */}
      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={() => {
            onCreateSession();
            onCloseMobile();
          }}
          className="flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[#4338CA] px-4 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-[#3730A3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA]"
        >
          <Plus className="h-4 w-4 shrink-0" />
          <span>New Story</span>
        </button>
      </div>

      {/* Stories list */}
      <div className="px-4 pb-2 pt-1">
        <p className="text-xs font-medium text-[#6B7280]">
          Stories ({sessions.length}
          {hasMoreStories ? '+' : ''})
        </p>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2.5 pb-4" aria-label="Saved stories">
        {sortedSessions.map((session) => {
          const isActive = activeView === 'story' && session.id === activeSessionId;
          const isEditing = editingId === session.id;
          const sectionCount =
            session.id === activeSessionId
              ? activeSectionCount
              : (session.sectionCount ?? session.sections.length);
          const styleShort = STYLE_SHORT_LABELS[session.defaultStyle] ?? 'Colloquial';

          return (
            <div
              key={session.id}
              className={`group rounded-lg transition-colors duration-150 ${
                isActive
                  ? 'border border-[#E5E7EB] bg-white'
                  : 'border border-transparent hover:bg-[#EFEFF2]/70'
              }`}
            >
              {isEditing ? (
                <div className="flex items-center gap-1.5 px-2.5 py-2">
                  <input
                    ref={editInputRef}
                    type="text"
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') cancelRename();
                    }}
                    onBlur={commitRename}
                    aria-label="Story title"
                    className="min-w-0 flex-1 rounded border border-[#4338CA] bg-white px-2 py-1 text-base text-[#111827] focus:outline-none lg:text-sm"
                  />
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={commitRename}
                    aria-label="Save title"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[#4338CA] hover:bg-[#EEF2FF]"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-1 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      onSelectSession(session.id);
                      onCloseMobile();
                    }}
                    className="min-w-0 flex-1 text-left focus-visible:outline-none"
                  >
                    <div
                      className={`truncate text-sm font-medium ${
                        isActive ? 'text-[#312E81]' : 'text-[#111827]'
                      }`}
                    >
                      {session.title || 'Untitled Story'}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[#6B7280] tabular-nums">
                      <span>
                        {sectionCount} {sectionCount === 1 ? 'section' : 'sections'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{styleShort}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatTimestamp(session.updatedAt)}</span>
                    </div>
                  </button>

                  <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity duration-150 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(session);
                      }}
                      aria-label={`Rename ${session.title}`}
                      title="Rename story"
                      className="flex h-7 w-7 items-center justify-center rounded text-[#6B7280] transition-colors hover:bg-[#E5E7EB]/70 hover:text-[#111827]"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(session.id);
                      }}
                      aria-label={`Move ${session.title} to Trash`}
                      title="Move story to Trash"
                      className="flex h-7 w-7 items-center justify-center rounded text-[#6B7280] transition-colors hover:bg-[#FEE2E2] hover:text-[#DC2626]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {hasMoreStories && onLoadOlderStories && (
          <div className="px-1 pt-2">
            <button
              type="button"
              disabled={isLoadingMoreStories}
              onClick={onLoadOlderStories}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[#E5E7EB] bg-white px-3 py-2 text-xs font-medium text-[#4B5563] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:cursor-wait disabled:opacity-60"
            >
              {isLoadingMoreStories ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-[#4338CA]" />
                  <span>Loading older stories…</span>
                </>
              ) : (
                <span>Load older stories</span>
              )}
            </button>
          </div>
        )}
      </nav>

      {/* 30-Day Trash Bin Navigation */}
      <div className="shrink-0 border-t border-[#E5E7EB] px-2.5 py-2">
        <button
          type="button"
          onClick={() => {
            onSelectTrash();
            onCloseMobile();
          }}
          className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] ${
            activeView === 'trash'
              ? 'border border-[#E5E7EB] bg-white text-[#111827]'
              : 'border border-transparent text-[#4B5563] hover:bg-[#EFEFF2]/70 hover:text-[#111827]'
          }`}
        >
          <span className="inline-flex items-center gap-2">
            <Trash2 className="h-3.5 w-3.5 text-[#6B7280]" aria-hidden="true" />
            <span>Trash</span>
          </span>
          {trashCount > 0 ? (
            <span className="rounded-md bg-[#E5E7EB]/80 px-1.5 py-0.5 text-[10px] font-semibold text-[#374151] tabular-nums">
              {trashCount}
            </span>
          ) : null}
        </button>
      </div>

      {/* Account & Sign Out footer */}
      <div className="shrink-0 border-t border-[#E5E7EB] px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            {userEmail ? (
              <p className="truncate text-xs font-medium text-[#374151]" title={userEmail}>
                {userEmail}
              </p>
            ) : null}
            <p className="text-[11px] text-[#6B7280]">Synced with Firebase Cloud</p>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[#E5E7EB] bg-white px-2.5 py-1.5 text-xs font-medium text-[#4B5563] transition-colors duration-150 hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA]"
            title="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </aside>
  );

  return (
    <>
      {/* Desktop collapsible sidebar */}
      <div
        className={`hidden shrink-0 transition-[width] duration-200 lg:block ${
          isOpen ? 'w-[268px]' : 'w-0 overflow-hidden'
        }`}
      >
        {isOpen && sidebarContent}
      </div>

      {/* Mobile smooth slide-over drawer */}
      <div
        className={`fixed inset-0 z-40 flex transition-opacity duration-200 lg:hidden ${
          isOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        }`}
        role="dialog"
        aria-modal="true"
        aria-hidden={!isOpen}
      >
        <div
          className={`fixed inset-0 bg-[#111827]/25 backdrop-blur-[1px] transition-opacity duration-200 ${
            isOpen ? 'opacity-100' : 'opacity-0'
          }`}
          onClick={onCloseMobile}
        />
        <div
          className={`relative z-10 h-full transition-transform duration-200 ease-out will-change-transform ${
            isOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {sidebarContent}
        </div>
      </div>
    </>
  );
}
