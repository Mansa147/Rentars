'use client';

import { useEffect, useState } from 'react';
import { useBookingDetails } from '@/hooks/useBookingDetails';
import { useEscrowStatus } from '@/hooks/useEscrowStatus';
import EscrowStatusCard from './EscrowStatusCard';
import AddToCalendar from './AddToCalendar';
import BookingLifecycleActions from '@/components/booking/BookingLifecycleActions';
import { Mail, Phone, Download } from 'lucide-react';
import type { Booking } from '@/types/booking';
import type { Property } from '@/types/property';

interface BookingConfirmationPageProps {
  bookingId: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

function usePropertyDetails(propertyId: string | undefined) {
  const [property, setProperty] = useState<Property | null>(null);

  useEffect(() => {
    if (!propertyId) {
      setProperty(null);
      return;
    }

    let active = true;
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
    fetch(`${API_URL}/api/v1/properties/${propertyId}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (active && data) setProperty(data);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [propertyId]);

  return property;
}

/** Trigger a browser download of the PDF receipt for a booking. */
function useReceiptDownload() {
  const [downloading, setDownloading] = useState(false);

  async function downloadReceipt(bookingId: string) {
    setDownloading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/v1/bookings/${bookingId}/receipt.pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? 'Download failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `receipt-${bookingId}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  return { downloadReceipt, downloading };
}

export default function BookingConfirmationPage({
  bookingId,
}: BookingConfirmationPageProps) {
  const { booking: initialBooking, isLoading } = useBookingDetails(bookingId);
  const { escrow } = useEscrowStatus(bookingId);
  const { downloadReceipt, downloading } = useReceiptDownload();

  // Local booking state: allows lifecycle actions (confirm, dispute, cancel,
  // complete) to update the displayed status without a full page reload.
  const [booking, setBooking] = useState<Booking | null>(null);

  // Sync from the fetch result once available, but don't overwrite a
  // locally-updated booking (e.g. after a dispute is raised).
  useEffect(() => {
    if (initialBooking && !booking) {
      setBooking(initialBooking as Booking);
    }
  }, [initialBooking, booking]);

  const property = usePropertyDetails(booking?.property_id);

  if (isLoading) {
    return <div className="text-center py-8">Loading booking details...</div>;
  }

  if (!booking) {
    return <div className="text-center py-8 text-red-600">Booking not found</div>;
  }

  // Build a human-readable location string from whatever the property exposes
  const propertyLocation =
    property
      ? [
          (property as Property & { address?: string; city?: string; country?: string }).address,
          (property as Property & { city?: string }).city,
          (property as Property & { country?: string }).country,
        ]
          .filter(Boolean)
          .join(', ') || property.location
      : '';

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-md p-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">Booking Details</h1>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div>
            <p className="text-sm text-gray-600 dark:text-gray-400">Check-in</p>
            <p className="font-semibold text-gray-900 dark:text-white">
              {new Date(booking.check_in).toLocaleDateString()}
            </p>
            {(property as Property & { check_in_time?: string })?.check_in_time && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                from {(property as Property & { check_in_time?: string }).check_in_time}
              </p>
            )}
          </div>
          <div>
            <p className="text-sm text-gray-600 dark:text-gray-400">Check-out</p>
            <p className="font-semibold text-gray-900 dark:text-white">
              {new Date(booking.check_out).toLocaleDateString()}
            </p>
            {(property as Property & { check_out_time?: string })?.check_out_time && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                by {(property as Property & { check_out_time?: string }).check_out_time}
              </p>
            )}
          </div>
          <div>
            <p className="text-sm text-gray-600 dark:text-gray-400">Guests</p>
            <p className="font-semibold text-gray-900 dark:text-white">{booking.guest_count}</p>
          </div>
          <div>
            <p className="text-sm text-gray-600 dark:text-gray-400">Total Price</p>
            <p className="font-semibold text-blue-600 dark:text-blue-400">{booking.total_price} USDC</p>
          </div>
        </div>

        {/* Status */}
        <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mb-4">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">Status</p>
          <span
            className={`inline-block px-3 py-1 rounded-full text-sm font-medium ${
              booking.status === 'confirmed' || booking.status === 'Confirmed'
                ? 'bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
                : booking.status === 'disputed' || booking.status === 'Disputed'
                ? 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300'
                : booking.status === 'cancelled' || booking.status === 'Cancelled'
                ? 'bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300'
                : booking.status === 'completed' || booking.status === 'Completed'
                ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300'
                : 'bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300'
            }`}
          >
            {booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}
          </span>
        </div>

        {/* Lifecycle actions — dispute, cancel, complete, confirm */}
        <div className="border-t border-gray-200 dark:border-gray-700 pt-4 mb-4">
          <BookingLifecycleActions
            booking={booking}
            onBookingUpdated={setBooking}
          />
        </div>

        {/* Add to Calendar */}
        <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">Save your stay</p>
          <AddToCalendar
            bookingId={bookingId}
            propertyTitle={property?.title ?? 'Rental Stay'}
            propertyLocation={propertyLocation}
            checkIn={booking.check_in}
            checkOut={booking.check_out}
          />
        </div>
      </div>

      {escrow && (
        <EscrowStatusCard
          status={escrow.status}
          amount={escrow.amount}
          releaseDate={escrow.releaseDate}
        />
      )}

      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Host Contact</h2>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Mail size={18} className="text-gray-400" aria-hidden="true" />
            <span className="text-gray-600 dark:text-gray-400">host@example.com</span>
          </div>
          <div className="flex items-center gap-2">
            <Phone size={18} className="text-gray-400" aria-hidden="true" />
            <span className="text-gray-600 dark:text-gray-400">+1 (555) 000-0000</span>
          </div>
        </div>
      </div>

      {/* Receipt download */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => downloadReceipt(bookingId)}
          disabled={downloading}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300
            dark:border-gray-600 text-sm text-gray-700 dark:text-gray-300
            hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 transition
            focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
          <Download size={15} aria-hidden="true" />
          {downloading ? 'Downloading…' : 'Download receipt'}
        </button>
      </div>
    </div>
  );
}
