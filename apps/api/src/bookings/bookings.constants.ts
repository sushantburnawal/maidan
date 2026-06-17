export const BOOKINGS_REPOSITORY = Symbol('BOOKINGS_REPOSITORY');

export const CANCELLABLE_BOOKING_STATUSES = ['pending', 'confirmed'] as const;

export const RESPONSIBLE_CANCELLATION_NOTE =
  'Maidan Way: responsible cancellation means cancelling as early as you can so hosts can plan and another explorer can take the spot.';
