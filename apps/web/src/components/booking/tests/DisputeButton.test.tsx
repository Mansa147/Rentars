import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import DisputeButton from '../DisputeButton';

describe('DisputeButton', () => {
  const mockOnClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders with accessible label', () => {
      render(<DisputeButton onClick={mockOnClick} />);
      expect(screen.getByRole('button', { name: /open dispute/i })).toBeInTheDocument();
    });

    it('renders the alert-triangle icon as decorative', () => {
      render(<DisputeButton onClick={mockOnClick} />);
      const svgs = document.querySelectorAll('[aria-hidden="true"]');
      expect(svgs.length).toBeGreaterThan(0);
    });

    it('is enabled by default', () => {
      render(<DisputeButton onClick={mockOnClick} />);
      expect(screen.getByRole('button', { name: /open dispute/i })).not.toBeDisabled();
    });

    it('is disabled when disabled prop is true', () => {
      render(<DisputeButton onClick={mockOnClick} disabled />);
      expect(screen.getByRole('button', { name: /open dispute/i })).toBeDisabled();
    });

    it('applies additional className', () => {
      const { container } = render(
        <DisputeButton onClick={mockOnClick} className="extra-class" />,
      );
      expect(container.firstChild).toHaveClass('extra-class');
    });
  });

  // ── Interaction ────────────────────────────────────────────────────────────

  describe('interaction', () => {
    it('calls onClick when clicked', async () => {
      const user = userEvent.setup({ delay: null });
      render(<DisputeButton onClick={mockOnClick} />);

      await user.click(screen.getByRole('button', { name: /open dispute/i }));
      expect(mockOnClick).toHaveBeenCalledTimes(1);
    });

    it('does not call onClick when disabled', async () => {
      const user = userEvent.setup({ delay: null });
      render(<DisputeButton onClick={mockOnClick} disabled />);

      await user.click(screen.getByRole('button', { name: /open dispute/i }));
      expect(mockOnClick).not.toHaveBeenCalled();
    });

    it('is focusable and activatable via keyboard', async () => {
      const user = userEvent.setup({ delay: null });
      render(<DisputeButton onClick={mockOnClick} />);

      const btn = screen.getByRole('button', { name: /open dispute/i });
      btn.focus();
      await user.keyboard('{Enter}');
      expect(mockOnClick).toHaveBeenCalledTimes(1);
    });

    it('does not fire on keyboard when disabled', async () => {
      const user = userEvent.setup({ delay: null });
      render(<DisputeButton onClick={mockOnClick} disabled />);

      const btn = screen.getByRole('button', { name: /open dispute/i });
      btn.focus();
      await user.keyboard('{Enter}');
      expect(mockOnClick).not.toHaveBeenCalled();
    });
  });
});
