import { AsyncLocalStorage } from 'async_hooks';

export interface TraceContext {
  traceId: string;
  correlationId: string;
  merchantId?: string;
}

const store = new AsyncLocalStorage<TraceContext>();

export function runWithTraceContext<T>(
  ctx: TraceContext,
  fn: () => T,
): T {
  return store.run(ctx, fn);
}

export function getTraceContext(): TraceContext | undefined {
  return store.getStore();
}
