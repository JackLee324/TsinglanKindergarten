import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { eq, and, lt, sql } from 'drizzle-orm';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';

import { sessions } from '@server/database/schema';

const DEFAULT_COOKIE_NAME = 'qls_session';
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STATE_TTL_MS = 5 * 60 * 1000;

interface StateData {
  expiresAt: number;
}

function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

@Injectable()
export class SessionService {
  private readonly states = new Map<string, StateData>();
  private readonly sessionTtlMs: number;
  private readonly stateTtlMs: number;
  private readonly cookieName: string;
  private readonly isHttps: boolean;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {
    const ttlSeconds = parseInt(process.env.SESSION_TTL_SECONDS || '86400', 10);
    this.sessionTtlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0
      ? ttlSeconds * 1000
      : DEFAULT_SESSION_TTL_MS;

    const stateTtlSeconds = parseInt(
      process.env.CSRF_STATE_TTL_SECONDS || '300',
      10,
    );
    this.stateTtlMs = Number.isFinite(stateTtlSeconds) && stateTtlSeconds > 0
      ? stateTtlSeconds * 1000
      : DEFAULT_STATE_TTL_MS;

    this.cookieName =
      process.env.SESSION_COOKIE_NAME?.trim() || DEFAULT_COOKIE_NAME;

    if (process.env.NODE_ENV === 'production') {
      this.isHttps = true;
    } else {
      this.isHttps = process.env.HTTPS_ENABLED === 'true';
    }
  }

  getCookieName(): string {
    return this.cookieName;
  }

  async createSession(
    teacherId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<string> {
    const sessionId = randomBytes(32).toString('hex');
    const sessionHash = hashSessionId(sessionId);
    const expiresAt = new Date(Date.now() + this.sessionTtlMs);

    await this.db.insert(sessions).values({
      sessionHash,
      teacherId,
      expiresAt,
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    });

    return sessionId;
  }

  async getSession(sessionId: string): Promise<string | null> {
    const sessionHash = hashSessionId(sessionId);
    const now = new Date();

    const rows = await this.db
      .select({
        teacherId: sessions.teacherId,
        expiresAt: sessions.expiresAt,
        revoked: sessions.revoked,
      })
      .from(sessions)
      .where(eq(sessions.sessionHash, sessionHash))
      .limit(1);

    if (rows.length === 0) return null;

    const row = rows[0];
    if (row.revoked) return null;
    if (row.expiresAt.getTime() < now.getTime()) return null;

    return row.teacherId;
  }

  async touchSession(sessionId: string): Promise<void> {
    const sessionHash = hashSessionId(sessionId);

    await this.db
      .update(sessions)
      .set({ lastAccessedAt: new Date() })
      .where(eq(sessions.sessionHash, sessionHash));
  }

  async destroySession(sessionId: string): Promise<number> {
    const sessionHash = hashSessionId(sessionId);

    const updated = await this.db
      .update(sessions)
      .set({ revoked: true })
      .where(eq(sessions.sessionHash, sessionHash))
      .returning({ id: sessions.id });
    return updated.length;
  }

  async revokeOtherSessions(
    teacherId: string,
    exceptSessionId: string | null,
  ): Promise<void> {
    if (exceptSessionId) {
      const exceptHash = hashSessionId(exceptSessionId);
      await this.db
        .update(sessions)
        .set({ revoked: true })
        .where(
          and(
            eq(sessions.teacherId, teacherId),
            eq(sessions.revoked, false),
            sql`${sessions.sessionHash} != ${exceptHash}`,
          ),
        );
    } else {
      await this.db
        .update(sessions)
        .set({ revoked: true })
        .where(and(eq(sessions.teacherId, teacherId), eq(sessions.revoked, false)));
    }
  }

  generateState(): string {
    const state = randomBytes(16).toString('hex');
    const expiresAt = Date.now() + this.stateTtlMs;
    this.states.set(state, { expiresAt });
    return state;
  }

  validateState(state: string): boolean {
    const stateData = this.states.get(state);
    if (!stateData) return false;

    this.states.delete(state);

    if (Date.now() > stateData.expiresAt) {
      return false;
    }

    return true;
  }

  getCookieOptions(): {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'none' | 'lax' | 'strict';
    path: string;
    maxAge: number;
  } {
    const sameSite: 'none' | 'lax' | 'strict' = this.isHttps ? 'none' : 'lax';
    return {
      httpOnly: true,
      secure: this.isHttps,
      sameSite,
      path: '/',
      maxAge: this.sessionTtlMs,
    };
  }

  getClearCookieOptions(): {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'none' | 'lax' | 'strict';
    path: string;
  } {
    const sameSite: 'none' | 'lax' | 'strict' = this.isHttps ? 'none' : 'lax';
    return {
      httpOnly: true,
      secure: this.isHttps,
      sameSite,
      path: '/',
    };
  }

  async cleanup(): Promise<void> {
    const now = new Date();

    await this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, now));

    for (const [key, value] of this.states.entries()) {
      if (Date.now() > value.expiresAt) {
        this.states.delete(key);
      }
    }
  }
}
