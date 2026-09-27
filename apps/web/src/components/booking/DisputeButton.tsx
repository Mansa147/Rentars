'use client';

import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DisputeButtonProps {
  /** Whether any booking action is currently in flight. */
  disabled?: boolean;
  /** Called when the user clicks the button. */
  onClick: () => void;
  /** Additional Tailwind classes forwarded to the button element. */
  className?: string;
}

/**
 * DisputeButton
 *
 * A single-purpose presentational button that opens the DisputeModal.
 * It is only rendered by BookingLifecycleActions when the booking is in a
 * state that permits a dispute (`TENANT_TRANSITIONS[status].includes('dispute')`).
 *
 * Accessibility:
 *  - Communicates its destructive-adjacent nature through amber colouring and
 *    the AlertTriangle icon.
 *  - The icon is aria-hidden; the visible label "Open dispute" is the
 *    accessible name.
 *  - focus-visible:ring provides a keyboard-visible focus indicator.
 *  - disabled state is conveyed both visually (opacity-50) and via the HTML
 *    `disabled` attribute so assistive technologies announce it.
 */
export default function DisputeButton({ disabled = false, onClick, className }: DisputeButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-amber-400',
        'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40',
        'text-sm font-medium transition',
        'hover:bg-amber-100 dark:hover:bg-amber-900/40',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500',
        className,
      )}
    >
      <AlertTriangle size={15} aria-hidden="true" />
      Open dispute
    </button>
  );
}
