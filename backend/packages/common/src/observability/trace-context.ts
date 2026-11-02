import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/). Every request gets a trace id, taken from a
 * well-formed incoming `traceparent` or generated at the first hop, and a span id of its own. Both are bound
 * to the request logger, and ServiceClient forwards `traceparent` on outgoing calls, so one user action can be
 * followed across the gateway and every service it touches, in logs today and in any OpenTelemetry backend
 * that understands the same header.
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** Trace flags, two hex digits ("01" = sampled) */
  flags: string;
}

declare global {
  namespace Express {
    interface Request {
      trace?: TraceContext;
    }
  }
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

export function parseTraceparent(header: string | undefined): { traceId: string; spanId: string; flags: string } | null {
  if (!header) return null;
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!match) return null;
  const [, traceId, spanId, flags] = match;
  // All-zero ids are explicitly invalid in the specification
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId, spanId, flags };
}

export function formatTraceparent(traceId: string, spanId: string, flags = '01'): string {
  return `00-${traceId}-${spanId}-${flags}`;
}

export const newTraceId = () => crypto.randomBytes(16).toString('hex');
export const newSpanId = () => crypto.randomBytes(8).toString('hex');

/** Must run after correlationIdMiddleware, whose request logger it extends */
export function traceContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const incoming = parseTraceparent(req.header('traceparent'));
  const trace: TraceContext = {
    traceId: incoming?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    parentSpanId: incoming?.spanId,
    flags: incoming?.flags ?? '01',
  };
  req.trace = trace;
  if (req.log) req.log = req.log.child({ traceId: trace.traceId, spanId: trace.spanId });
  next();
}

/** The `traceparent` for a call made while handling `req`: same trace, this request's span as the parent */
export function outgoingTraceparent(req: Pick<Request, 'trace'> | undefined): string {
  const trace = req?.trace;
  return trace ? formatTraceparent(trace.traceId, trace.spanId, trace.flags) : formatTraceparent(newTraceId(), newSpanId());
}
