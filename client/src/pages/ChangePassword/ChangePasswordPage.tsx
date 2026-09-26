import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, AlertTriangle, CheckCircle } from 'lucide-react';
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
import { UnauthorizedError } from '@client/src/api/client';
import { LanguageToggle } from '@client/src/i18n/LanguageToggle';

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, '请输入当前密码'),
    newPassword: z
      .string()
      .min(10, '密码至少10位')
      .regex(/[A-Z]/, '必须包含大写字母')
      .regex(/[a-z]/, '必须包含小写字母')
      .regex(/[0-9]/, '必须包含数字'),
    confirmPassword: z.string().min(1, '请确认新密码'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: '两次输入的新密码不一致',
    path: ['confirmPassword'],
  });

type PasswordFormData = z.infer<typeof passwordSchema>;

const ChangePasswordPage: React.FC = () => {
  const { t } = useTranslation();
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [success, setSuccess] = useState<boolean>(false);

  const form = useForm<PasswordFormData>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const onSubmit = useCallback(
    async (data: PasswordFormData): Promise<void> => {
      try {
        setLoading(true);
        setErrorMsg('');
        if (data.newPassword === data.currentPassword) {
          setErrorMsg(t('changePassword.error.sameAsOld'));
          return;
        }
        const result = await api.changePassword(data.currentPassword, data.newPassword);
        if (result.teacher) {
          login(result.teacher);
        }
        setSuccess(true);
        setTimeout(() => {
          navigate('/');
        }, 1500);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          setErrorMsg(t('changePassword.error.currentWrong'));
        } else if (err instanceof Error) {
          setErrorMsg(err.message || t('common.failed'));
        } else {
          setErrorMsg(t('common.failed'));
        }
        logger.warn('Change password failed', String(err));
      } finally {
        setLoading(false);
      }
    },
    [login, navigate, t],
  );

  if (!user) {
    return null;
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-4">
      <div className="absolute right-4 top-4">
        <LanguageToggle />
      </div>

      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <KeyRound className="size-8 text-primary" />
          </div>
          <h1 className="text-2xl font-semibold text-foreground">
            {t('changePassword.title')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('changePassword.subtitle')}
          </p>
        </div>

        <Card className="border-border shadow-sm">
          <CardContent className="p-6">
            {success && (
              <div className="mb-4 flex items-start gap-2 rounded-lg bg-green-50 p-3 text-sm text-green-700 ring-1 ring-green-200">
                <CheckCircle className="mt-0.5 size-4 shrink-0" />
                <span>{t('changePassword.success')}</span>
              </div>
            )}

            {errorMsg && (
              <div className="mb-4 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700 ring-1 ring-red-200">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span className="break-words">{errorMsg}</span>
              </div>
            )}

            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="space-y-4"
              >
                <FormField
                  control={form.control}
                  name="currentPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('changePassword.current')}</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          autoComplete="current-password"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="newPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('changePassword.new')}</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          autoComplete="new-password"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="confirmPassword"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t('changePassword.confirm')}</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          autoComplete="new-password"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="text-xs text-muted-foreground">
                  {t('changePassword.rule')}
                </div>

                <Button
                  type="submit"
                  className="w-full bg-primary hover:bg-primary-dark"
                  size="lg"
                  disabled={loading || success}
                >
                  {loading ? t('common.loading') : t('changePassword.submit')}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default ChangePasswordPage;
