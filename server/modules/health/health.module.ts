import { Controller, Get, Inject, Injectable, Logger, Module, Res } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';

import { Public } from '@server/modules/auth/auth.guard';
import {
  describeCoverAssetsResolution,
  isCoverAssetsFound,
  resolveCoverAssets,
  type CoverAssetsResolution,
  type CoverAssetsSource,
} from './cover-assets';

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
 *                                     Checks the database, the presence of the
 *                                     tables the application needs, and the cover
 *                                     asset tree. Returns 503 when not ready so a
 *                                     load balancer stops routing to this instance
 *                                     instead of users receiving 500s.
 *
 * WHY THE COVER ASSET TREE IS A READINESS CHECK
 *   `GET /api/resources/:id/storybook-cover/:index` streams a JPEG from the served
 *   file tree, NOT from the database and NOT from storage. A build that copied the
 *   modules but not the assets therefore produces an instance that answers 200 to
 *   every probe that only looks at the database and 404s to every Pre-K English
 *   cover — silently. Verified history: `nest-cli.json` publishes the covers to
 *   `dist/server/assets/prek-english-covers/`, while the old lookup guessed
 *   `dist/assets/…` first, so the asset check is the difference between "this
 *   deployment is complete" and "an unverifiable 404 at request time".
 *   Readiness is the loud, non-fatal signal for it: a missing asset tree stops
 *   traffic from being routed here, but does NOT get the process killed (that is
 *   liveness, and liveness stays dependency-free by design).
 *
 * WHAT IS DELIBERATELY NOT RETURNED
 *   No connection string, host, port, database name, user, migration file paths,
 *   storage credentials or environment values. A health endpoint is frequently
 *   reachable without authentication, so it reports STATE, never CONFIGURATION.
 *   This matters: audit finding G-11 was exactly this class of leak via 5xx bodies.
 *   The asset check obeys the same rule: it reports `source` and a file COUNT, and
 *   never the directory path (the path goes to the log, where it is useful).
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
    /**
     * The served cover asset tree. `source` says which documented candidate matched
     * ('env' | 'compiled' | 'source-tree'); `files` is the number of `.jpg` covers
     * found. No path: see the header.
     */
    assets: {
      ok: boolean;
      source?: CoverAssetsSource;
      files?: number;
      error?: 'cover_assets_missing' | 'cover_assets_empty';
    };
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

  /**
   * Resolve the cover asset tree from THIS module's own location.
   *
   * `__dirname` here is `<build>/server/modules/health`, one level below the
   * `modules/` directory nest-cli publishes assets beside, so the anchor is stable
   * regardless of the working directory. Re-resolved per call (two `stat` calls)
   * rather than cached: a cached path that a rebuild deleted would report a
   * directory that no longer exists, which is exactly the kind of quiet staleness
   * a readiness probe must not have.
   */
  private coverAssets(): CoverAssetsResolution {
    return resolveCoverAssets({ moduleDir: __dirname, appRoot: process.cwd() });
  }

  /**
   * The startup report: whether the cover asset tree was found, where, and how many
   * files it holds. `diagnostic` carries the absolute path and is for the LOG only —
   * an HTTP handler must never return it (see the header).
   *
   * A directory that EXISTS but holds no cover is reported as not-ok, with its own
   * error code: the shipped product has 34 covers, so an empty tree means the build
   * (or the `STORYBOOK_COVER_ASSETS_DIR` override) dropped them. Saying "found, 0
   * files" would let exactly the broken deployment this check exists for pass as
   * ready.
   */
  coverAssetsReport(): {
    ok: boolean;
    source?: CoverAssetsSource;
    fileCount?: number;
    error?: 'cover_assets_missing' | 'cover_assets_empty';
    diagnostic: string;
  } {
    const resolution = this.coverAssets();
    const diagnostic = describeCoverAssetsResolution(resolution);
    if (!isCoverAssetsFound(resolution)) {
      return { ok: false, error: 'cover_assets_missing', diagnostic };
    }
    if (resolution.fileCount === 0) {
      return {
        ok: false,
        source: resolution.source,
        fileCount: 0,
        error: 'cover_assets_empty',
        diagnostic,
      };
    }
    return {
      ok: true,
      source: resolution.source,
      fileCount: resolution.fileCount,
      diagnostic,
    };
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
        assets: { ok: false },
      },
    };

    // ---- cover asset tree --------------------------------------------------
    // Checked FIRST, because the database branch below returns early on failure:
    // reporting `assets: { ok: false }` for a check that never ran would be a lie in
    // the probe output, and the probe output is what an operator reads at 3am.
    const assets = this.coverAssetsReport();
    if (assets.ok) {
      report.checks.assets = {
        ok: true,
        source: assets.source,
        files: assets.fileCount,
      };
    } else {
      report.checks.assets = { ok: false, error: assets.error };
      this.logger.error(`Readiness: ${assets.diagnostic}`);
    }

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

    // ---- cover asset tree --------------------------------------------------
    // It was already resolved at the top of this method (see the comment there):
    // `report.checks.assets` is final by now, and it participates in `ready`.
    const ready =
      report.checks.database.ok &&
      report.checks.schema.ok &&
      report.checks.migrations.ok &&
      report.checks.assets.ok;

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
  // `main.ts` reads the resolved cover asset tree from here for the startup log, so
  // that the boot report and the request path can never disagree about where the
  // covers are.
  exports: [HealthService],
})
export class HealthModule {}
