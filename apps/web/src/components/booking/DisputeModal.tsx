'use client';

import { useState, useId } from 'react';
import { AlertCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { Modal, ModalHeader, ModalContent, ModalFooter } from '@/components/ui/modal';
import { useBookingActions } from '@/hooks/useBookingActions';
import type { Booking } from '@/types/booking';

// ─── Validation constants (mirror the backend raiseDisputeSchema) ─────────────

const REASON_MIN = 10;
const REASON_MAX = 2000;
const EVIDENCE_MAX = 5000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface DisputeModalProps {
  /** UUID of the booking being disputed. */
  bookingId: string;
  /** Whether the modal is currently visible. */
  isOpen: boolean;
  /** Called when the user dismisses the modal without submitting. */
  onClose: () => void;
  /**
   * Called after a successful dispute submission.
   * Receives the updated Booking returned by the API so the caller can
   * update any local state / timeline UI.
   */
  onDisputeRaised: (updated: Booking) => void;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function charCount(value: string, max: number): string {
  return `${value.length} / ${max}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * DisputeModal
 *
 * Collects the dispute reason (required, 10–2 000 chars) and optional
 * supporting evidence (0–5 000 chars) before calling
 * `useBookingActions(bookingId).dispute(reason, evidence)`.
 *
 * Behaviour:
 *  - Validates locally before submitting so the user sees inline feedback
 *    without a round-trip.
 *  - Prevents duplicate submissions: the submit button is disabled while
 *    `pendingAction === 'dispute'` and re-enabled on both success and failure.
 *  - On success, calls `onDisputeRaised` then `onClose` — the caller is
 *    responsible for updating the booking timeline.
 *  - On failure, displays the API error inline inside the modal without
 *    closing it, so the user can correct and retry.
 *  - The modal is not closeable while submission is in flight (X button and
 *    backdrop click are disabled) so the user cannot accidentally lose their
 *    in-progress form.
 *
 * Accessibility:
 *  - `aria-describedby` on the dialog element points to the intro paragraph.
 *  - All error messages are rendered in `role="alert"` regions.
 *  - Character counts use `aria-live="polite"`.
 *  - Labels are associated with inputs via htmlFor.
 */
export default function DisputeModal({
  bookingId,
  isOpen,
  onClose,
  onDisputeRaised,
}: DisputeModalProps) {
  const reasonId   = useId();
  const evidenceId = useId();
  const descId     = useId();

  const [reason,   setReason]   = useState('');
  const [evidence, setEvidence] = useState('');

  // Field-level validation errors (only shown after first submit attempt)
  const [touched,      setTouched]      = useState(false);
  const [submitted,    setSubmitted]    = useState(false);

  const { pendingAction, actionError, dispute, clearError } = useBookingActions(
    bookingId,
    (updated) => {
      onDisputeRaised(updated);
      // Reset form state on success
      setReason('');
      setEvidence('');
      setTouched(false);
      setSubmitted(false);
      onClose();
    },
  );

  const isSubmitting = pendingAction === 'dispute';

  // ── Validation ──────────────────────────────────────────────────────────────

  const reasonError: string | null =
    reason.trim().length === 0
      ? 'A reason is required.'
      : reason.trim().length < REASON_MIN
      ? `Reason must be at least ${REASON_MIN} characters.`
      : reason.length > REASON_MAX
      ? `Reason must be ${REASON_MAX} characters or fewer.`
      : null;

  const evidenceError: string | null =
    evidence.length > EVIDENCE_MAX
      ? `Supporting evidence must be ${EVIDENCE_MAX} characters or fewer.`
      : null;

  const canSubmit =
    !isSubmitting && reasonError === null && evidenceError === null;

  // ── Handlers ────────────────────────────────────────────────────────────────

  const handleReasonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setReason(e.target.value);
    if (actionError) clearError();
  };

  const handleEvidenceChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEvidence(e.target.value);
    if (actionError) clearError();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setSubmitted(true);

    if (!canSubmit) return;

    await dispute(reason.trim(), evidence.trim() ? { details: evidence.trim() } : undefined);
  };

  const handleClose = () => {
    if (isSubmitting) return; // block close while in flight
    setReason('');
    setEvidence('');
    setTouched(false);
    setSubmitted(false);
    clearError();
    onClose();
  };

  // Show field errors only after user has interacted or tried to submit
  const showReasonError   = (touched || submitted) && reasonError !== null;
  const showEvidenceError = evidenceError !== null; // always show length errors

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Modal
      open={isOpen}
      onOpenChange={(open) => { if (!open) handleClose(); }}
      title="Open a dispute"
      aria-describedby={descId}
    >
      <ModalHeader title="Open a dispute" onClose={isSubmitting ? undefined : handleClose} />

      <form onSubmit={handleSubmit} noValidate>
        <ModalContent>
          {/* Intro / context */}
          <div
            id={descId}
            className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30
              border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-sm"
          >
            <AlertTriangle
              size={16}
              className="flex-shrink-0 mt-0.5 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
            <p>
              Opening a dispute will place the escrowed funds on hold until an
              admin reviews your case. This action cannot be undone once submitted.
            </p>
          </div>

          {/* API error banner */}
          {actionError && (
            <div
              role="alert"
              className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950
                border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm"
            >
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
              <span>{actionError}</span>
              <button
                type="button"
                onClick={clearError}
                className="ml-auto text-red-500 hover:text-red-700 focus:outline-none"
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          )}

          {/* Reason field */}
          <div className="space-y-1">
            <label
              htmlFor={reasonId}
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Reason <span className="text-red-500" aria-hidden="true">*</span>
              <span className="sr-only">(required)</span>
            </label>
            <textarea
              id={reasonId}
              rows={4}
              required
              value={reason}
              onChange={handleReasonChange}
              onBlur={() => setTouched(true)}
              placeholder="Describe the issue with this booking…"
              aria-required="true"
              aria-invalid={showReasonError ? 'true' : 'false'}
              aria-describedby={showReasonError ? `${reasonId}-error` : `${reasonId}-count`}
              disabled={isSubmitting}
              className="w-full border rounded-lg px-3 py-2 text-sm resize-none
                bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                placeholder-gray-400 dark:placeholder-gray-500
                focus:outline-none focus:ring-2 focus:ring-amber-500
                disabled:opacity-50 disabled:cursor-not-allowed
                border-gray-300 dark:border-gray-600
                aria-[invalid=true]:border-red-400 dark:aria-[invalid=true]:border-red-600"
            />
            <div className="flex justify-between items-start gap-2">
              {showReasonError ? (
                <p
                  id={`${reasonId}-error`}
                  role="alert"
                  className="text-xs text-red-600 dark:text-red-400"
                >
                  {reasonError}
                </p>
              ) : (
                <span />
              )}
              <p
                id={`${reasonId}-count`}
                aria-live="polite"
                className={`text-xs ml-auto tabular-nums ${
                  reason.length > REASON_MAX
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-gray-400 dark:text-gray-500'
                }`}
              >
                {charCount(reason, REASON_MAX)}
              </p>
            </div>
          </div>

          {/* Evidence field (optional) */}
          <div className="space-y-1">
            <label
              htmlFor={evidenceId}
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Supporting evidence{' '}
              <span className="text-gray-400 dark:text-gray-500 font-normal">(optional)</span>
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Provide any additional context, timestamps, or references that support your claim.
            </p>
            <textarea
              id={evidenceId}
              rows={3}
              value={evidence}
              onChange={handleEvidenceChange}
              placeholder="Any additional context, references, or timeline of events…"
              aria-invalid={showEvidenceError ? 'true' : 'false'}
              aria-describedby={showEvidenceError ? `${evidenceId}-error` : `${evidenceId}-count`}
              disabled={isSubmitting}
              className="w-full border rounded-lg px-3 py-2 text-sm resize-none
                bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100
                placeholder-gray-400 dark:placeholder-gray-500
                focus:outline-none focus:ring-2 focus:ring-amber-500
                disabled:opacity-50 disabled:cursor-not-allowed
                border-gray-300 dark:border-gray-600
                aria-[invalid=true]:border-red-400 dark:aria-[invalid=true]:border-red-600"
            />
            <div className="flex justify-between items-start gap-2">
              {showEvidenceError ? (
                <p
                  id={`${evidenceId}-error`}
                  role="alert"
                  className="text-xs text-red-600 dark:text-red-400"
                >
                  {evidenceError}
                </p>
              ) : (
                <span />
              )}
              <p
                id={`${evidenceId}-count`}
                aria-live="polite"
                className={`text-xs ml-auto tabular-nums ${
                  evidence.length > EVIDENCE_MAX
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-gray-400 dark:text-gray-500'
                }`}
              >
                {charCount(evidence, EVIDENCE_MAX)}
              </p>
            </div>
          </div>
        </ModalContent>

        <ModalFooter className="justify-end">
          {/* Cancel */}
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm
              text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700
              disabled:opacity-50 disabled:cursor-not-allowed
              focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 transition"
          >
            Cancel
          </button>

          {/* Submit */}
          <button
            type="submit"
            disabled={!canSubmit}
            aria-busy={isSubmitting}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-amber-600 text-white
              text-sm font-medium hover:bg-amber-700 transition
              disabled:opacity-50 disabled:cursor-not-allowed
              focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            {isSubmitting ? (
              <>
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                Submitting…
              </>
            ) : (
              'Submit dispute'
            )}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
