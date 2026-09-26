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

  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  });

  const onSubmit = useCallback(
    async (data: LoginFormData): Promise<void> => {
      try {
        setLoading(true);
        setFormError('');
        const user = await api.login(data.username.trim(), data.password);
        login(user);
        navigate('/', { replace: true });
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
                  className="w-full bg-primary hover:bg-primary-dark"
                  size="lg"
                  disabled={loading}
                >
                  {loading ? t('common.loading') : t('login.submit')}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default LoginPage;
