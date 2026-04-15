import { z } from "zod";

export const CreatePaymentSchema = z.object({
  orderId: z.string().min(1).max(255),
  customerId: z.string().min(1).max(255),
  amount: z
    .number()
    .int()
    .positive()
    .describe("Amount in minor units (cents/paise)"),
  currency: z.string().length(3).toUpperCase(),
  paymentMethod: z.enum(["CREDIT_CARD", "DEBIT_CARD", "UPI", "NET_BANKING"]),
  successUrl: z
    .string()
    .url()
    .refine(
      (u: string) => u.startsWith("https://"),
      "successUrl must use HTTPS",
    ),
  cancelUrl: z
    .string()
    .url()
    .refine(
      (u: string) => u.startsWith("https://"),
      "cancelUrl must use HTTPS",
    ),
  metadata: z.record(z.string()).optional().default({}),
});

export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;

export const ListPaymentsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum([
      "PENDING",
      "PROCESSING",
      "COMPLETED",
      "FAILED",
      "REFUNDED",
      "EXPIRED",
      "CANCELLED",
    ])
    .optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
});

export type ListPaymentsQuery = z.infer<typeof ListPaymentsQuerySchema>;
