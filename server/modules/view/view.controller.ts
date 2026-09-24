import { Controller, Get, Render, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { Public } from '../auth/auth.guard';

@Controller()
export class ViewController {

  @Public()
  @Get(['/', '*'])
  @Render('index')
  async render(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ __platform__: string }>  {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const platformData = req.__platform_data__ ?? {};
    return {
      // don't delete this line, it's used by client to get platform info
      __platform__: JSON.stringify(platformData),
    };
  }
}
