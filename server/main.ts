import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { configureApp } from '@lark-apaas/fullstack-nestjs-core';
import { join } from 'path';
import { __express as hbsExpressEngine } from 'hbs';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import {
  resolveTrustProxySetting,
  describeTrustProxy,
} from './common/http/client-ip';
import {
  securityHeaders,
  describeSecurityHeaders,
} from './common/http/security-headers.middleware';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    abortOnError: process.env.NODE_ENV !== 'development',
  });

  // ---------------------------------------------------------------------------
  // Trust proxy  (audit finding D-10)
  // ---------------------------------------------------------------------------
  // `X-Forwarded-For` is client-supplied. Express derives `req.ip` by walking the
  // forwarded chain from the RIGHT and discarding untrusted hops — but only when
  // told which hops to trust. `common/http/client-ip.ts` returns `req.ip` and
  // never parses the header, so the application's behaviour is entirely governed
  // by this setting.
  //
  // The default (unset -> false) is the SAFE one: Express ignores the header and
  // `req.ip` is the unforgeable socket address. That matters because the client IP
  // feeds the per-IP login rate limit and every `audit_logs.ip_address` row; if it
  // can be forged, brute-force protection is bypassed and intrusions cannot be
  // attributed.
  const trustProxy = resolveTrustProxySetting();

  await configureApp(app, {
    disableSwagger: true,
  });

  // ---------------------------------------------------------------------------
  // Trust proxy — MUST be set AFTER configureApp()
  // ---------------------------------------------------------------------------
  // `configureApp()` from @lark-apaas/fullstack-nestjs-core ends with
  //     app.set('trust proxy', true)
  // (verified in the installed package, dist/index.js). Setting the value before
  // calling it is therefore silently discarded, and Express then believes EVERY
  // hop of the client-supplied `X-Forwarded-For` chain.
  //
  // Observed live before this fix: a request sending
  //     X-Forwarded-For: 203.0.113.99, 10.0.0.1
  // was recorded in `audit_logs.ip_address` as 203.0.113.99 — an attacker-chosen
  // value. That makes the per-IP login rate limit bypassable by rotating the
  // header and makes every audit row unattributable (audit finding D-10).
  //
  // On the 妙搭 platform this default is presumably harmless because their ingress
  // overwrites the header. It is NOT safe for a standalone / VPS deployment, which
  // is why the application must own this setting explicitly.
  //
  // Default (TRUST_PROXY unset -> false) is the safe one: Express ignores the
  // header and `req.ip` is the unforgeable socket address.
  app.set('trust proxy', trustProxy);

  // ---------------------------------------------------------------------------
  // Security response headers (audit finding Q-6)
  // ---------------------------------------------------------------------------
  // `configureApp()` does NOT install `helmet`, and neither this project's
  // `package.json` nor the platform package depends on it (verified). Before this
  // middleware the application sent NO security headers at all: no nosniff, no
  // frame protection, no referrer policy, no HSTS, no CSP - and it advertised
  // itself via `X-Powered-By`.
  //
  // Deliberately dependency-free; see security-headers.middleware.ts for why
  // installing `helmet` is unsafe for this repository's lockfile.
  //
  // Registered with `app.use()` BEFORE `app.listen()` because Nest mounts its
  // router during listen; middleware added afterwards would not run for matched
  // routes.
  app.use(securityHeaders);

  const host = process.env.SERVER_HOST || 'localhost';
  const port = Number(process.env.SERVER_PORT || '3000');

  // 注册视图引擎, 渲染 client 目录下的 html 文件
  app.setBaseViewsDir(join(process.cwd(), 'dist/client'));
  app.setViewEngine('html');
  app.engine('html', hbsExpressEngine);

  await app.listen(port, host);

  logger.log(`Server running on ${host}:${port}`);
  logger.log(`API endpoints ready at http://${host}:${port}/api`);
  logger.log(`trust proxy: ${describeTrustProxy(trustProxy)}`);
  logger.log(describeSecurityHeaders());
  logger.log(
    `environment: NODE_ENV=${process.env.NODE_ENV ?? 'undefined'} ` +
      `HTTPS_ENABLED=${process.env.HTTPS_ENABLED ?? 'unset'}`,
  );

  if (trustProxy === true && process.env.NODE_ENV === 'production') {
    logger.warn(
      'TRUST_PROXY=true in production: every X-Forwarded-For hop is believed. ' +
        'This is only correct when a reverse proxy you control always strips or ' +
        'overwrites the header. Prefer TRUST_PROXY=loopback or an explicit CIDR list.',
    );
  }
}

bootstrap();
