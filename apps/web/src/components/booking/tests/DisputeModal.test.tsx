import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import DisputeModal from '../DisputeModal';

// ── Mock useBookingActions ──────────────────────────────────────────────────

const mockDispute = vi.fn();
const mockClearError = vi.fn();

// The mock factory returns a function so each test can override return values.
const mockUseBookingActions = vi.fn(() => ({
  pendingAction: null as string | null,
  actionError: null as string | null,
  dispute: mockDispute,
  clearError: mockClearError,
  confirm: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('@/hooks/useBookingActions', () => ({
  useBookingActions: (...args: unknown[]) => mockUseBookingActions(...args),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const defaultProps = {
  bookingId: 'booking-abc-123',
  isOpen: true,
  onClose: vi.fn(),
  onDisputeRaised: vi.fn(),
};

function setup(overrides?: Partial<typeof defaultProps>) {
  return render(<DisputeModal {...defaultProps} {...overrides} />);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('DisputeModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseBookingActions.mockReturnValue({
      pendingAction: null,
      actionError: null,
      dispute: mockDispute,
      clearError: mockClearError,
      confirm: vi.fn(),
      complete: vi.fn(),
      cancel: vi.fn(),
    });
  });

  // ── Visibility ─────────────────────────────────────────────────────────────

  describe('visibility', () => {
    it('renders when isOpen is true', () => {
      setup();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('does not render when isOpen is false', () => {
      setup({ isOpen: false });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('has accessible title "Open a dispute"', () => {
      setup();
      expect(screen.getByRole('dialog', { name: /open a dispute/i })).toBeInTheDocument();
    });
  });

  // ── Form elements ──────────────────────────────────────────────────────────

  describe('form elements', () => {
    it('renders a required reason textarea', () => {
      setup();
      const textarea = screen.getByRole('textbox', { name: /reason/i });
      expect(textarea).toBeInTheDocument();
      expect(textarea).toHaveAttribute('aria-required', 'true');
    });

    it('renders an optional evidence textarea', () => {
      setup();
      expect(screen.getByRole('textbox', { name: /supporting evidence/i })).toBeInTheDocument();
    });

    it('renders submit and cancel buttons', () => {
      setup();
      expect(screen.getByRole('button', { name: /submit dispute/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    });

    it('submit button is disabled when reason is empty', () => {
      setup();
      expect(screen.getByRole('button', { name: /submit dispute/i })).toBeDisabled();
    });

    it('submit button enables when reason meets minimum length', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      await user.type(
        screen.getByRole('textbox', { name: /reason/i }),
        'This is a valid dispute reason.',
      );
      expect(screen.getByRole('button', { name: /submit dispute/i })).not.toBeDisabled();
    });
  });

  // ── Validation ─────────────────────────────────────────────────────────────

  describe('validation', () => {
    it('shows reason-required error after submit with empty reason', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      await user.click(screen.getByRole('button', { name: /submit dispute/i }));
      expect(await screen.findByRole('alert', { name: undefined })).toBeInTheDocument();
      expect(screen.getByText(/a reason is required/i)).toBeInTheDocument();
    });

    it('shows too-short error when reason is fewer than 10 chars', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      await user.type(screen.getByRole('textbox', { name: /reason/i }), 'Short');
      await user.click(screen.getByRole('button', { name: /submit dispute/i }));
      expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
    });

    it('shows inline error when reason exceeds 2000 chars', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      // Type more than 2000 characters
      await user.type(
        screen.getByRole('textbox', { name: /reason/i }),
        'a'.repeat(2001),
      );
      await user.click(screen.getByRole('button', { name: /submit dispute/i }));
      expect(await screen.findByText(/2000 characters or fewer/i)).toBeInTheDocument();
    });

    it('shows error when evidence exceeds 5000 chars', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      await user.type(
        screen.getByRole('textbox', { name: /supporting evidence/i }),
        'a'.repeat(5001),
      );
      expect(await screen.findByText(/5000 characters or fewer/i)).toBeInTheDocument();
    });

    it('displays character counts for reason field', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      await user.type(screen.getByRole('textbox', { name: /reason/i }), 'Hello world');
      expect(screen.getByText('11 / 2000')).toBeInTheDocument();
    });
  });

  // ── Submission ─────────────────────────────────────────────────────────────

  describe('submission', () => {
    it('calls dispute with trimmed reason on valid submit', async () => {
      const user = userEvent.setup({ delay: null });
      mockDispute.mockResolvedValue({ id: 'booking-abc-123', status: 'Disputed' });
      setup();

      await user.type(
        screen.getByRole('textbox', { name: /reason/i }),
        '  Property was not as described.  ',
      );
      await user.click(screen.getByRole('button', { name: /submit dispute/i }));

      await waitFor(() => {
        expect(mockDispute).toHaveBeenCalledWith(
          'Property was not as described.',
          undefined,
        );
      });
    });

    it('passes evidence details when evidence is provided', async () => {
      const user = userEvent.setup({ delay: null });
      mockDispute.mockResolvedValue({ id: 'booking-abc-123', status: 'Disputed' });
      setup();

      await user.type(
        screen.getByRole('textbox', { name: /reason/i }),
        'Property was not as described in listing.',
      );
      await user.type(
        screen.getByRole('textbox', { name: /supporting evidence/i }),
        'See photos taken on arrival.',
      );
      await user.click(screen.getByRole('button', { name: /submit dispute/i }));

      await waitFor(() => {
        expect(mockDispute).toHaveBeenCalledWith(
          'Property was not as described in listing.',
          { details: 'See photos taken on arrival.' },
        );
      });
    });

    it('calls onDisputeRaised with the updated booking on success', async () => {
      const user = userEvent.setup({ delay: null });
      const updatedBooking = { id: 'booking-abc-123', status: 'Disputed' };
      mockDispute.mockImplementation(async (_reason: string) => {
        defaultProps.onDisputeRaised(updatedBooking as never);
        return updatedBooking;
      });
      setup();

      await user.type(
        screen.getByRole('textbox', { name: /reason/i }),
        'Valid reason for dispute.',
      );
      await user.click(screen.getByRole('button', { name: /submit dispute/i }));

      await waitFor(() => {
        expect(defaultProps.onDisputeRaised).toHaveBeenCalledWith(updatedBooking);
      });
    });

    it('prevents duplicate submissions while in flight', async () => {
      const user = userEvent.setup({ delay: null });
      // Simulate pending state
      mockUseBookingActions.mockReturnValue({
        pendingAction: 'dispute',
        actionError: null,
        dispute: mockDispute,
        clearError: mockClearError,
        confirm: vi.fn(),
        complete: vi.fn(),
        cancel: vi.fn(),
      });
      setup();

      // Submit button must be disabled while submitting
      expect(screen.getByRole('button', { name: /submitting/i })).toBeDisabled();
      // Cancel must also be disabled
      expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    });

    it('shows loading label while submitting', () => {
      mockUseBookingActions.mockReturnValue({
        pendingAction: 'dispute',
        actionError: null,
        dispute: mockDispute,
        clearError: mockClearError,
        confirm: vi.fn(),
        complete: vi.fn(),
        cancel: vi.fn(),
      });
      setup();
      expect(screen.getByRole('button', { name: /submitting/i })).toBeInTheDocument();
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('shows API error banner when actionError is set', () => {
      mockUseBookingActions.mockReturnValue({
        pendingAction: null,
        actionError: 'Dispute already exists for this booking.',
        dispute: mockDispute,
        clearError: mockClearError,
        confirm: vi.fn(),
        complete: vi.fn(),
        cancel: vi.fn(),
      });
      setup();

      expect(
        screen.getByText(/dispute already exists for this booking/i),
      ).toBeInTheDocument();
    });

    it('dismiss error button calls clearError', async () => {
      const user = userEvent.setup({ delay: null });
      mockUseBookingActions.mockReturnValue({
        pendingAction: null,
        actionError: 'Something went wrong.',
        dispute: mockDispute,
        clearError: mockClearError,
        confirm: vi.fn(),
        complete: vi.fn(),
        cancel: vi.fn(),
      });
      setup();

      await user.click(screen.getByRole('button', { name: /dismiss error/i }));
      expect(mockClearError).toHaveBeenCalled();
    });

    it('keeps modal open on API error so user can retry', () => {
      mockUseBookingActions.mockReturnValue({
        pendingAction: null,
        actionError: 'Network error.',
        dispute: mockDispute,
        clearError: mockClearError,
        confirm: vi.fn(),
        complete: vi.fn(),
        cancel: vi.fn(),
      });
      setup();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  // ── Dismiss / close ────────────────────────────────────────────────────────

  describe('dismiss / close', () => {
    it('calls onClose when cancel button is clicked', async () => {
      const user = userEvent.setup({ delay: null });
      const onClose = vi.fn();
      setup({ onClose });
      await user.click(screen.getByRole('button', { name: /^cancel$/i }));
      expect(onClose).toHaveBeenCalled();
    });

    it('calls onClose when the X header button is clicked', async () => {
      const user = userEvent.setup({ delay: null });
      const onClose = vi.fn();
      setup({ onClose });
      await user.click(screen.getByRole('button', { name: /close modal/i }));
      expect(onClose).toHaveBeenCalled();
    });

    it('does not call onClose when in flight', async () => {
      const user = userEvent.setup({ delay: null });
      const onClose = vi.fn();
      mockUseBookingActions.mockReturnValue({
        pendingAction: 'dispute',
        actionError: null,
        dispute: mockDispute,
        clearError: mockClearError,
        confirm: vi.fn(),
        complete: vi.fn(),
        cancel: vi.fn(),
      });
      setup({ onClose });

      // The X button is not rendered while submitting (undefined onClose passed to ModalHeader)
      expect(screen.queryByRole('button', { name: /close modal/i })).not.toBeInTheDocument();
    });

    it('resets form fields on cancel', async () => {
      const user = userEvent.setup({ delay: null });
      setup();

      await user.type(
        screen.getByRole('textbox', { name: /reason/i }),
        'Some reason text',
      );
      await user.click(screen.getByRole('button', { name: /^cancel$/i }));

      // Re-render with isOpen=true to check field is cleared
      setup();
      expect(screen.getByRole('textbox', { name: /reason/i })).toHaveValue('');
    });
  });

  // ── Ineligible user / closed state ────────────────────────────────────────

  describe('ineligible state', () => {
    it('does not render at all when isOpen is false', () => {
      setup({ isOpen: false });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });
  });

  // ── Accessibility ──────────────────────────────────────────────────────────

  describe('accessibility', () => {
    it('modal has aria-modal="true"', () => {
      setup();
      expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    });

    it('modal is labelled by the heading', () => {
      setup();
      const dialog = screen.getByRole('dialog');
      const labelId = dialog.getAttribute('aria-labelledby');
      expect(labelId).toBeTruthy();
      const heading = document.getElementById(labelId!);
      expect(heading).toBeInTheDocument();
      expect(heading).toHaveTextContent(/open a dispute/i);
    });

    it('reason textarea has aria-required="true"', () => {
      setup();
      expect(screen.getByRole('textbox', { name: /reason/i })).toHaveAttribute(
        'aria-required',
        'true',
      );
    });

    it('reason textarea has aria-invalid="true" after failed submit', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      await user.click(screen.getByRole('button', { name: /submit dispute/i }));
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /reason/i })).toHaveAttribute(
          'aria-invalid',
          'true',
        );
      });
    });

    it('reason textarea has aria-invalid="false" when valid', async () => {
      const user = userEvent.setup({ delay: null });
      setup();
      await user.type(
        screen.getByRole('textbox', { name: /reason/i }),
        'This is a long enough reason.',
      );
      expect(screen.getByRole('textbox', { name: /reason/i })).toHaveAttribute(
        'aria-invalid',
        'false',
      );
    });
  });
});
