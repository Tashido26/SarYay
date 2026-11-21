import { useEffect } from 'react';
import { Loader2, Trash2 } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = true,
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#111827]/30 px-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="w-full max-w-[400px] rounded-xl border border-[#E5E7EB] bg-white p-6 shadow-sm"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${
              destructive
                ? 'border-[#FECACA] bg-[#FEF2F2] text-[#DC2626]'
                : 'border-[#E5E7EB] bg-[#F8F9FA] text-[#4B5563]'
            }`}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id="confirm-dialog-title"
              className="text-sm font-semibold text-[#111827]"
            >
              {title}
            </h2>
            <p
              id="confirm-dialog-message"
              className="mt-1.5 text-xs leading-relaxed text-[#6B7280]"
            >
              {message}
            </p>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg border border-[#E5E7EB] bg-white px-3.5 py-2 text-xs font-medium text-[#374151] transition-colors hover:border-[#D1D5DB] hover:bg-[#F9FAFB] hover:text-[#111827] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4338CA] disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60 ${
              destructive
                ? 'bg-[#DC2626] hover:bg-[#B91C1C] focus-visible:outline-[#DC2626]'
                : 'bg-[#4338CA] hover:bg-[#3730A3] focus-visible:outline-[#4338CA]'
            }`}
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            <span>{confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
