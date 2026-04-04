/**
 * Money value object.
 * All amounts are stored as integers in minor units (e.g. cents, paise).
 * No floating-point arithmetic is performed anywhere in this system.
 */
export class Money {
  private constructor(
    public readonly amount: number,
    public readonly currency: string,
  ) {
    if (!Number.isInteger(amount)) {
      throw new Error(`Money amount must be an integer (minor units), got: ${amount}`);
    }
    if (amount < 0) {
      throw new Error(`Money amount must be non-negative, got: ${amount}`);
    }
    if (currency.length !== 3) {
      throw new Error(`Currency must be a 3-letter ISO code, got: ${currency}`);
    }
  }

  static of(amount: number, currency: string): Money {
    return new Money(amount, currency.toUpperCase());
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    if (other.amount > this.amount) {
      throw new Error(
        `Insufficient funds: cannot subtract ${other.format()} from ${this.format()}`,
      );
    }
    return new Money(this.amount - other.amount, this.currency);
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency;
  }

  isZero(): boolean {
    return this.amount === 0;
  }

  format(): string {
    return `${this.currency} ${this.amount}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} vs ${other.currency}`,
      );
    }
  }
}
