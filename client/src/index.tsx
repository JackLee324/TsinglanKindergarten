import React from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { BrowserRouter } from 'react-router-dom';

import RoutesComponent from './app.tsx';
import { AppRoot } from './components/AppRoot';
import { Toaster } from '@client/src/components/ui/sonner';
import './index.css';

/**
 * The client entry point.
 * =======================
 *
 * TWO THINGS CHANGED HERE, AND BOTH ARE THE POINT OF THE MIGRATION
 * ---------------------------------------------------------------
 * 1. `basename` is gone. Until this change the router was mounted at
 *    `process.env.CLIENT_BASE_PATH || '/'`, which 妙搭 set to `/app/` at build time
 *    and injected into the document as `window.__BASENAME__`. Because the platform's
 *    paths are `/app/<appId>`, a request to `/` matched NO route and React rendered
 *    nothing — a 200 response with an empty `#root`, i.e. a white screen that every
 *    status-code-based check reported as healthy. The application now lives at `/`:
 *    `BrowserRouter` defaults to `basename="/"`, so it is not passed at all.
 * 2. `AppContainer` is replaced by `AppRoot`, this repository's own root component.
 *    See `components/AppRoot.tsx` for what the platform container did and which part
 *    of it was load-bearing.
 *
 * WHAT DELIBERATELY DID NOT CHANGE
 * --------------------------------
 * The order of providers, the Toaster portal into `document.body`, and the fact that
 * the error boundary lives INSIDE the router (`AppErrorBoundary`, mounted by
 * `app.tsx`, whose fallback calls `useNavigate`). Adding a second boundary here
 * would create a fallback that can never be reached and would change which message a
 * user sees when a page throws.
 */

const MainApp = () => {
  return (
    <BrowserRouter>
      <AppRoot>
        <RoutesComponent />
        {createPortal(<Toaster />, document.body)}
      </AppRoot>
    </BrowserRouter>
  );
};

createRoot(document.getElementById('root')!).render(<MainApp />);
