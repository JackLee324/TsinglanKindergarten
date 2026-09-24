import { logger } from '@lark-apaas/client-toolkit/logger';
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { AxiosError } from 'axios';

export const AUTH_UNAUTHORIZED_EVENT = 'qls:auth:unauthorized';

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

function extractErrorMessage(error: AxiosError): string {
  const data = error.response?.data as { error?: { message?: string } } | undefined;
  return data?.error?.message || error.message || 'Request failed';
}

export const handleApiError = (error: unknown, context: string): never => {
  const err = error as AxiosError;
  const status = err.response?.status;
  const message = extractErrorMessage(err);
  if (status === 401) {
    logger.debug(`[API] ${context}: unauthorized (401)`);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
    }
    throw new UnauthorizedError(message);
  }
  if (status === 403) {
    logger.warn(`[API] ${context}: forbidden (403)`);
    throw new ForbiddenError(message);
  }
  logger.error(`[API] ${context}`, message);
  throw error;
};

export const handleSilentUnauthorized = (
  error: unknown,
  context: string,
): null => {
  const err = error as AxiosError;
  const status = err.response?.status;
  if (status === 401) {
    logger.debug(`[API] ${context}: unauthorized (401), silent`);
    return null;
  }
  logger.error(`[API] ${context}`, extractErrorMessage(err));
  throw error;
};

export { axiosForBackend };
