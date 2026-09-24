import { Controller, Get, Inject, Injectable, Logger, Module, Res } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';

import { Public } from '@server/modules/auth/auth.guard';

/**
 * Health endpoints.
 * ================
 *
 * Liveness vs readiness (they answer different questions and must not be merged):
 *
 *   GET /api/health        liveness  — "is this process alive and serving?"
 *                                     No dependencies are touched, so a slow or
 *                                     briefly unavailable database does NOT cause
 *                                     the orchestrator to kill a perfectly healthy
 *                                     process. Used by Docker HEALTHCHECK and by
 *                                     an upstream load balancer's liveness probe.
 *
 *   GET /api/health/ready  readiness — "can this process actually serve traffic?"
 *                                     Checks the database and the presence of the
 *                                     tables the application needs. Returns 503
 *                                     when not ready so a load balancer stops
 *                                     routing to this instance instead of users
 *                                     receiving 500s.
 *
 * WHAT IS DELIBERATELY NOT RETURNED
 *   No connection string, host, port, database name, user, migration file paths,
 *   storage credentials or environment values. A health endpoint is frequently
 *   reachable without authentication, so it reports STATE, never CONFIGURATION.
 *   This matters: audit finding G-11 was exactly this class of leak via 5xx bodies.
 */

const REQUIRED_TABLES = [
  'teachers',
  'resources',
  'subject_permissions',
  'review_records',
  'audit_logs',
  'sessions',
] as const;

interface LivenessReport {
  status: 'ok';
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

interface ReadinessReport {
  status: 'ready' | 'not_ready';
  version: string;
  uptimeSeconds: number;
  timestamp: string;
  checks: {
    database: { ok: boolean; latencyMs?: number; error?: string };
    schema: { ok: boolean; missingTables?: string[] };
    migrations: { ok: boolean; applied?: number; pending?: number };
  };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startedAt = Date.now();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  private version(): string {
    return (
      process.env.APP_VERSION ||
      process.env.npm_package_version ||
      'unknown'
    );
  }

  private uptimeSeconds(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  liveness(): LivenessReport {
    return {
      status: 'ok',
      version: this.version(),
      uptimeSeconds: this.uptimeSeconds(),
      timestamp: new Date().toISOString(),
    };
  }

  async readiness(): Promise<{ report: ReadinessReport; httpStatus: number }> {
    const report: ReadinessReport = {
      status: 'not_ready',
      version: this.version(),
      uptimeSeconds: this.uptimeSeconds(),
      timestamp: new Date().toISOString(),
      checks: {
        database: { ok: false },
        schema: { ok: false },
        migrations: { ok: false },
      },
    };

    // ---- database ----------------------------------------------------------
    const started = Date.now();
    try {
      await this.db.execute(sql`SELECT 1`);
      report.checks.database = { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      // Report that it failed; never echo the driver error, which contains the
      // host/user/database in its message.
      report.checks.database = {
        ok: false,
        error: 'database_unreachable',
      };
      this.logger.error(
        `Readiness: database check failed: ${(err as Error)?.message ?? String(err)}`,
      );
      return { report, httpStatus: 503 };
    }

    // ---- required tables ---------------------------------------------------
    try {
      const rows = await this.db.execute(sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
      `);
      const list = (rows as unknown as { table_name?: string }[]) ?? [];
      const present = new Set(list.map((r) => r.table_name));
      const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
      report.checks.schema = missing.length === 0
        ? { ok: true }
        : { ok: false, missingTables: missing };
    } catch (err) {
      report.checks.schema = { ok: false };
      this.logger.error(
        `Readiness: schema check failed: ${(err as Error)?.message ?? String(err)}`,
      );
    }

    // ---- migrations --------------------------------------------------------
    try {
      const rows = await this.db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM schema_migrations) AS applied,
          (SELECT count(*)::int FROM schema_migrations) AS applied_only
      `);
      const first = ((rows as unknown as { applied?: number }[]) ?? [])[0];
      report.checks.migrations = {
        ok: true,
        applied: first?.applied ?? 0,
      };
    } catch {
      // schema_migrations absent means the migration framework has never run
      // against this database. Reported as not-ok rather than crashing.
      report.checks.migrations = { ok: false };
    }

    const ready =
      report.checks.database.ok &&
      report.checks.schema.ok &&
      report.checks.migrations.ok;

    report.status = ready ? 'ready' : 'not_ready';
    return { report, httpStatus: ready ? 200 : 503 };
  }
}

@Controller('api/health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness. Public by necessity: a probe cannot authenticate. */
  @Public()
  @Get()
  liveness(): LivenessReport {
    return this.health.liveness();
  }

  /** Readiness. 503 when the instance cannot serve real traffic. */
  @Public()
  @Get('ready')
  async readiness(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const { report, httpStatus } = await this.health.readiness();
    res.status(httpStatus);
    return report;
  }
}

@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
