import { Controller, Get, NotFoundException, Req, Res, Render } from '@nestjs/common';
import type { Request, Response } from 'express';

import { Public } from '../auth/auth.guard';
import { isApiRequestPath } from '../../common/http/request-paths';

/**
 * The SPA fallback: serves the built `client/index.html` for every page route.
 * ==========================================================================
 *
 * This is the route that makes a browser refresh on `/admin/teachers` work: React
 * Router owns the path, the server owns the document.
 *
 * TWO THINGS IT MUST DO, BOTH OF THEM LEARNED THE HARD WAY
 * -------------------------------------------------------
 * 1. **Never answer an API path with HTML.** This controller owns the catch-all
 *    `@Get(['/', '*'])`, so `/api/typo` lands here too. Answering 200 with the SPA
 *    shell makes a typo'd endpoint look like a success to every HTTP client — the
 *    status code is green, the body is a document, and the failure only shows up as
 *    a parse error somewhere far away. The platform handled this by overriding
 *    `res.render` for its API prefixes; this repository states the same rule in the
 *    handler, where it can be read next to the route it applies to.
 * 2. **Not redirect anywhere.** Until this migration the root URL answered 302 to
 *    `/app/` because the platform hard-coded React Router's basename to `/app/`, so
 *    a request to `/` matched no route and rendered nothing at all (a white screen
 *    behind a 200). The basename is `/` now, `/` matches the index route, and the
 *    redirect is gone. `scripts/verify-e2e-deploy.sh` asserts the render, not the
 *    status code, because a redirect can hide a blank page behind a green 302.
 *
 * The template is `dist/client/index.html` relative to the process working
 * directory (the app starts with cwd = `dist/`, so that is `dist/dist/client/`,
 * where `scripts/build.sh` publishes it). `tests/cover-asset-root.test.mjs` boots
 * the compiled server from an unrelated working directory and asserts this path
 * resolution, which is why it is `process.cwd()` and not `__dirname`.
 */
@Controller()
export class ViewController {
  @Public()
  @Get(['/', '*'])
  @Render('index')
  async render(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, never>> {
    // The platform's HTML was indexable; this one is not. Same header as before.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    if (isApiRequestPath(req.path || '/')) {
      throw new NotFoundException('接口不存在');
    }

    // An empty context on purpose. `csrfToken` reaches the document through
    // `res.locals` (see `common/http/csrf-token.middleware.ts`), and the platform's
    // `__platform__` blob is gone with the platform: nothing in the client reads
    // `window.__platform__`, `window.__BASENAME__` or `window._appInfo` any more.
    return {};
  }
}
