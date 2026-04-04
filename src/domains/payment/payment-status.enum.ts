export const PaymentStatus = {
  PENDING:    'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED:  'COMPLETED',
  FAILED:     'FAILED',
  REFUNDED:   'REFUNDED',
  EXPIRED:    'EXPIRED',
  CANCELLED:  'CANCELLED',
} as const;

export type PaymentStatusValue = typeof PaymentStatus[keyof typeof PaymentStatus];

export const PaymentMethod = {
  CREDIT_CARD:  'CREDIT_CARD',
  DEBIT_CARD:   'DEBIT_CARD',
  UPI:          'UPI',
  NET_BANKING:  'NET_BANKING',
} as const;

export type PaymentMethodValue = typeof PaymentMethod[keyof typeof PaymentMethod];
