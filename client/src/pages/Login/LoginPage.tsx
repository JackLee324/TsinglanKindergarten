import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BookOpen, AlertTriangle } from 'lucide-react';
import { logger } from '@client/src/lib/logger';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@client/src/components/ui/button';
import { Card, CardContent } from '@client/src/components/ui/card';
import { Input } from '@client/src/components/ui/input';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@client/src/components/ui/form';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { useAuth } from '@client/src/auth/useAuth';
import * as api from '@client/src/api/auth';
import { LanguageToggle } from '@client/src/i18n/LanguageToggle';

const loginSchema = z.object({
  username: z.string().min(1, 'login.usernamePlaceholder'),
  password: z.string().min(1, 'login.passwordPlaceholder'),
});

type LoginFormData = z.infer<typeof loginSchema>;

const LoginPage: React.FC = () => {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState<boolean>(false);
  const [formError, setFormError] = useState<string>('');
  const [searchParams] = useSearchParams();
  const externalError = searchParams.get('error');
  // 第二因素（§12）。服务端在启用 MFA 时**不签发会话**，只回一个一次性
  // challengeToken，所以这里必须真的走完第二步才可能进得去。
  const [mfa, setMfa] = useState<{ challengeToken: string; expiresAt: string } | null>(null);
  const [mfaCode, setMfaCode] = useState<string>('');

  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  });

  const onSubmit = useCallback(
    async (data: LoginFormData): Promise<void> => {
      try {
        setLoading(true);
        setFormError('');
        const result = await api.login(data.username.trim(), data.password);
        // 显式 `=== true`：本仓库的 tsconfig 是 `strict: false`，
        // 布尔字面量判别联合在真值判断下**不会**收窄（同一坑在
        // resources.service.ts 里也有注释记录）。写成 `if (result.mfaRequired)`
        // 会在 `result.teacher` 处报 TS2339。
        if (result.mfaRequired === true) {
          // 不设置 user、不跳转：此时**还没有会话**。
          setMfa({ challengeToken: result.challengeToken, expiresAt: result.expiresAt });
          return;
        }
        login(result.teacher);
        // §13：首次登录（或被重置密码后）必须先改密码。
        // 以前登录后一律去首页，而服务端只把 mustChangePassword 放在用户对象里、
        // 前端从不读它 —— 于是"强制改密"实际只是页面上一个可忽略的入口。
        navigate(result.teacher.mustChangePassword ? '/change-password' : '/', { replace: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('锁定')) {
          setFormError(t('login.error.locked'));
        } else if (msg.includes('停用')) {
          setFormError(t('login.error.inactive'));
        } else if (msg.includes('频繁')) {
          setFormError(t('login.error.rateLimit'));
        } else {
          setFormError(t('login.error.wrong'));
        }
        logger.warn('Login failed', String(err));
      } finally {
        setLoading(false);
      }
    },
    [login, navigate, t],
  );

  /** 第二步：提交 TOTP 或恢复码。 */
  const onVerifyMfa = useCallback(
    async (e: React.FormEvent): Promise<void> => {
      e.preventDefault();
      if (!mfa) return;
      const code = mfaCode.trim();
      if (code === '') {
        setFormError(t('login.mfa.codeRequired'));
        return;
      }
      try {
        setLoading(true);
        setFormError('');
        const teacher = await api.verifyMfa(mfa.challengeToken, code);
        login(teacher);
        setMfa(null);
        setMfaCode('');
        navigate(teacher.mustChangePassword ? '/change-password' : '/', { replace: true });
      } catch (err) {
        // 服务端会明确区分"验证码不对，还可尝试 N 次"与"尝试次数过多，请重新登录"，
        // 所以这里直接把它的消息显示出来，而不是笼统替换成"登录失败"。
        setFormError(err instanceof Error ? err.message : t('login.mfa.failed'));
        logger.warn('MFA verify failed', String(err));
      } finally {
        setLoading(false);
      }
    },
    [login, mfa, mfaCode, navigate, t],
  );

  useEffect(() => {
    if (externalError) {
      setFormError(externalError);
    }
  }, [externalError]);

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-4">
      <div className="absolute right-4 top-4">
        <LanguageToggle />
      </div>

      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <BookOpen className="size-8 text-primary" />
          </div>
          <h1 className="text-2xl font-semibold text-foreground">
            {t('login.title')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('login.subtitle')}
          </p>
        </div>

        <Card className="border-border shadow-sm">
          <CardContent className="p-6">
            {(formError || externalError) && (
              <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700 ring-1 ring-red-200">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span className="break-words">{formError || externalError}</span>
              </div>
            )}

            {/* 第二步：第二因素。整块**替换**账号密码表单，而不是并排显示 ——
                此时密码已校验完，再让用户看到密码框只会让人以为要重填。 */}
            {mfa ? (
              <form onSubmit={onVerifyMfa} className="space-y-4" data-testid="mfa-step">
                <p className="text-sm text-muted-foreground">{t('login.mfa.hint')}</p>
                <div>
                  <label htmlFor="mfa-code" className="text-sm font-medium text-foreground">
                    {t('login.mfa.code')}
                  </label>
                  <Input
                    id="mfa-code"
                    data-testid="mfa-code-input"
                    className="mt-1"
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    placeholder="123456"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    autoFocus
                  />
                </div>
                <Button
                  type="submit"
                  data-testid="mfa-submit"
                  className="w-full bg-primary hover:bg-primary-dark"
                  size="lg"
                  disabled={loading}
                >
                  {loading ? t('common.loading') : t('login.mfa.submit')}
                </Button>
                <button
                  type="button"
                  className="w-full text-sm text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => {
                    // 回到第一步：challengeToken 是一次性的，放弃后就作废。
                    setMfa(null);
                    setMfaCode('');
                    setFormError('');
                  }}
                >
                  {t('login.mfa.back')}
                </button>
              </form>
            ) : (
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-4"
              >
                <FormField
                  control={form.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('login.username')}</FormLabel>
                      <FormControl>
                        <Input
                          placeholder={t('login.usernamePlaceholder')}
                          autoComplete="username"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('login.password')}</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder={t('login.passwordPlaceholder')}
                          autoComplete="current-password"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button
                  type="submit"
                  data-testid="login-submit"
                  className="w-full bg-primary hover:bg-primary-dark"
                  size="lg"
                  disabled={loading}
                >
                  {loading ? t('common.loading') : t('login.submit')}
                </Button>
              </form>
            </Form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default LoginPage;
