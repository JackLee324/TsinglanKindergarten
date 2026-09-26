import React from 'react';
import { AlertTriangle, RefreshCw, Home, LogIn } from 'lucide-react';
import { ErrorBoundary } from 'react-error-boundary';
import { logger } from '@client/src/lib/logger';
import { useNavigate } from 'react-router-dom';

interface AppErrorFallbackProps {
  error: Error;
  resetErrorBoundary: () => void;
}

const AppErrorFallback: React.FC<AppErrorFallbackProps> = ({ error, resetErrorBoundary }) => {
  const navigate = useNavigate();

  const handleRefresh = (): void => {
    window.location.reload();
  };

  const handleGoHome = (): void => {
    resetErrorBoundary();
    navigate('/');
  };

  const handleGoLogin = (): void => {
    resetErrorBoundary();
    navigate('/login');
  };

  const isChunkError = /chunk|loading chunk|chunkLoadError|Loading CSS chunk/i.test(error.message);
  const isAuthError = /401|unauthorized|session.*expired|token.*expired/i.test(error.message);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-red-50">
            <AlertTriangle className="size-8 text-red-500" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">
            {isChunkError
              ? '页面版本已更新'
              : isAuthError
                ? '登录已过期'
                : '页面出现错误'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {isChunkError
              ? '检测到新版本，请刷新页面以继续使用'
              : isAuthError
                ? '您的登录状态已过期，请重新登录'
                : '抱歉，页面遇到了意外问题，请尝试刷新或返回首页'}
          </p>
        </div>

        <div className="space-y-2">
          {isAuthError ? (
            <button
              onClick={handleGoLogin}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-dark"
            >
              <LogIn className="size-4" />
              重新登录
            </button>
          ) : (
            <button
              onClick={handleRefresh}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-dark"
            >
              <RefreshCw className="size-4" />
              {isChunkError ? '刷新页面' : '刷新重试'}
            </button>
          )}
          <button
            onClick={handleGoHome}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-white px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
          >
            <Home className="size-4" />
            返回首页
          </button>
        </div>

        {error.message && (
          <details className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              错误详情
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto break-all text-red-600">
              {error.message}
              {error.stack ? `\n${error.stack}` : ''}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
};

interface AppErrorBoundaryProps {
  children: React.ReactNode;
}

export const AppErrorBoundary: React.FC<AppErrorBoundaryProps> = ({ children }) => {
  const handleError = (error: Error): void => {
    logger.error('[ErrorBoundary] Uncaught error', error.message, error.stack ?? '');
  };

  return (
    <ErrorBoundary FallbackComponent={AppErrorFallback} onError={handleError}>
      {children}
    </ErrorBoundary>
  );
};
