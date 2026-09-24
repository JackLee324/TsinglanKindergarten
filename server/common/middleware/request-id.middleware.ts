import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Sanitise a client-supplied request id before trusting it. */
function sanitizeIncoming(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Bound the length and restrict the character set. An unbounded, arbitrary
  // string from a client is a log-injection vector: it is written into logs and
  // into audit rows, so control characters and absurd lengths must not survive.
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Correlates a request across the access log, the error filter and audit rows.
 *
 * Accepts a request id from upstream when a trusted proxy or gateway supplied a
 * well-formed one (so a trace started at the edge stays intact); otherwise
 * generates one. The value is echoed in the `x-request-id` response header so a
 * user reporting a failure can quote it, and a 500 response carries it too —
 * which is what makes it possible to find the corresponding server log line
 * without asking the user for a timestamp.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = sanitizeIncoming(req.headers[REQUEST_ID_HEADER]);
    const requestId = incoming ?? randomUUID();

    (req as Request & { requestId?: string }).requestId = requestId;

    // ALSO stored on `res.locals`. The platform's RequestContextMiddleware runs
    // later and assigns its own `req.requestId`, which was verified to silently
    // replace ours: the response header carried id A while the error body carried
    // id B, so the correlation value shown to the user did not match the value in
    // the log — defeating the entire purpose of a request id.
    // `res.locals` is per-response and is not overwritten by the platform.
    res.locals = { ...(res.locals ?? {}), requestId };

    // Exposed so a client-side error report and a server log line can be matched.
    res.setHeader(REQUEST_ID_HEADER, requestId);

    next();
  }
}
