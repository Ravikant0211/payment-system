import { Request, Response, NextFunction } from 'express';
import { PaymentService } from './payment.service';
import { CreatePaymentSchema, ListPaymentsQuerySchema } from './payment.schemas';
import { NotFoundError } from '@/common/errors';

/**
 * PaymentController: thin HTTP adapter layer.
 * No business logic here — delegates everything to PaymentService.
 * Follows the Single Responsibility Principle.
 */
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  createPayment = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const input = CreatePaymentSchema.parse(req.body);
      const merchantId = req.merchant!.id;

      const result = await this.paymentService.createPayment(merchantId, input);

      res.status(201).json({
        data: {
          paymentId: result.paymentId,
          checkoutUrl: result.checkoutUrl,
          message: 'Redirect the customer to checkoutUrl to complete payment',
        },
      });
    } catch (err) {
      next(err);
    }
  };

  getPayment = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { id } = req.params as { id: string };
      const merchantId = req.merchant!.id;

      const payment = await this.paymentService.getPayment(id, merchantId);

      res.json({ data: payment });
    } catch (err) {
      next(err);
    }
  };

  listPayments = async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const query = ListPaymentsQuerySchema.parse(req.query);
      const merchantId = req.merchant!.id;

      const page = await this.paymentService.listPayments(merchantId, query);

      res.json({
        data: page.payments,
        pagination: { nextCursor: page.nextCursor },
      });
    } catch (err) {
      next(err);
    }
  };
}
