import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, ShieldCheck, ShieldOff } from 'lucide-react';

import { Button } from '@client/src/components/ui/button';
import { Card, CardContent } from '@client/src/components/ui/card';
import { Input } from '@client/src/components/ui/input';
import { useTranslation } from '@client/src/i18n/useTranslation';
import * as api from '@client/src/api/auth';

/**
 * 账号安全 —— 两步验证（§12「MFA 网页闭环」）。
 *
 * 服务端的 MFA 早就完整实现了（TOTP、AES-256-GCM 加密存储、一次性恢复码、
 * 挑战令牌次数限制），但**网页端此前一行都没有**：登录页不处理 `mfaRequired`，
 * 也没有任何地方可以登记或解除绑定。也就是说，一个必须开 MFA 的账号（super_admin）
 * 在浏览器里既进不去、也没法自救 —— 只能靠直接改数据库。
 *
 * 这个页面把闭环补齐：查看状态 → 开始登记（显示密钥与 otpauth URI）→
 * 用验证码确认 → 拿到恢复码 → 可重新生成恢复码 / 解除绑定。
 *
 * 两条刻意的取舍：
 *   1. 密钥与恢复码**只在服务端返回的那一次**显示，之后不再尝试回读
 *      （服务端也只返回一次）。页面上明确写出"请现在保存"。
 *   2. 所有失败都如实显示服务端给的原因（例如"需要当前有效验证码"），
 *      不做统一的"操作失败" —— 那句话对用户没有任何行动价值。
 */
export default function AccountSecurityPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<api.MfaStatusResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // 登记流程
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [confirmCode, setConfirmCode] = useState<string>('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  // 重新生成 / 解除绑定都要重新输一次当前验证码
  const [currentCode, setCurrentCode] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await api.getMfaStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return (
    <div className="mx-auto max-w-[1280px] p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-[#2D2A3E]">{t('security.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('security.subtitle')}</p>
      </header>

      {error && (
        <div
          className="mb-4 flex items-start gap-2 rounded-xl border border-[#D98B8B] bg-white p-4"
          data-testid="security-error"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-[#D98B8B]" />
          <span className="break-words text-sm text-[#2D2A3E]">{error}</span>
        </div>
      )}

      <Card className="border-[#E8E4F0] shadow-sm">
        <CardContent className="p-6" data-testid="mfa-panel">
          {loading ? (
            <div className="flex items-center gap-3">
              <Loader2 className="size-5 animate-spin text-primary" />
              <span className="text-muted-foreground">{t('common.loading')}</span>
            </div>
          ) : !status ? (
            <p className="text-sm text-[#6B6878]">{t('security.loadFailed')}</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                {status.enabled ? (
                  <ShieldCheck className="size-6 text-[#7CB69C]" />
                ) : (
                  <ShieldOff className="size-6 text-[#E8B86B]" />
                )}
                <div>
                  <p className="text-lg font-semibold text-[#2D2A3E]" data-testid="mfa-state">
                    {status.enabled ? t('security.enabled') : t('security.disabled')}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {status.enabled
                      ? t('security.enabledDesc').replace(
                          '{count}',
                          String(status.recoveryCodesRemaining),
                        )
                      : t('security.disabledDesc')}
                  </p>
                </div>
              </div>

              {/* ---------- 已启用：重新生成恢复码 / 解除绑定 ---------- */}
              {status.enabled && (
                <div className="mt-6 space-y-4">
                  <div>
                    <label htmlFor="mfa-current" className="text-sm font-medium text-[#2D2A3E]">
                      {t('security.currentCode')}
                    </label>
                    <Input
                      id="mfa-current"
                      data-testid="mfa-current-code"
                      className="mt-1 max-w-xs"
                      value={currentCode}
                      onChange={(e) => setCurrentCode(e.target.value)}
                      placeholder="123456"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                    />
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      variant="outline"
                      data-testid="mfa-regen"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const r = await api.regenerateRecoveryCodes(currentCode.trim());
                          setRecoveryCodes(r.recoveryCodes);
                          setCurrentCode('');
                          await load();
                        })
                      }
                    >
                      {t('security.regenerate')}
                    </Button>
                    <Button
                      variant="outline"
                      data-testid="mfa-disable"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api.disableMfa(currentCode.trim());
                          setCurrentCode('');
                          setRecoveryCodes(null);
                          await load();
                        })
                      }
                    >
                      {t('security.disable')}
                    </Button>
                  </div>
                  {status.recoveryCodesRemaining === 0 && (
                    <p className="text-sm text-[#D98B8B]">{t('security.noRecoveryCodes')}</p>
                  )}
                </div>
              )}

              {/* ---------- 未启用：开始登记 ---------- */}
              {!status.enabled && !enrolment && (
                <div className="mt-6">
                  <Button
                    data-testid="mfa-enroll"
                    disabled={busy}
                    onClick={() => void run(async () => setEnrolment(await api.enrollMfa()))}
                  >
                    {t('security.enroll')}
                  </Button>
                </div>
              )}

              {!status.enabled && enrolment && (
                <div className="mt-6 space-y-4" data-testid="mfa-enrolment">
                  <div className="rounded-lg bg-[#FAF8FF] p-4">
                    <p className="text-sm text-[#6B6878]">{t('security.secretHint')}</p>
                    <p className="mt-2 break-all font-mono text-base text-[#2D2A3E]" data-testid="mfa-secret">
                      {enrolment.secret}
                    </p>
                    <p className="mt-3 break-all text-xs text-muted-foreground">
                      {enrolment.otpauthUri}
                    </p>
                  </div>
                  <div>
                    <label htmlFor="mfa-confirm" className="text-sm font-medium text-[#2D2A3E]">
                      {t('security.confirmCode')}
                    </label>
                    <Input
                      id="mfa-confirm"
                      data-testid="mfa-confirm-code"
                      className="mt-1 max-w-xs"
                      value={confirmCode}
                      onChange={(e) => setConfirmCode(e.target.value)}
                      placeholder="123456"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                    />
                  </div>
                  <Button
                    data-testid="mfa-confirm-submit"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const r = await api.confirmMfa(confirmCode.trim());
                        setRecoveryCodes(r.recoveryCodes);
                        setConfirmCode('');
                        setEnrolment(null);
                        await load();
                      })
                    }
                  >
                    {t('security.confirm')}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ---------- 恢复码：只显示这一次 ---------- */}
      {recoveryCodes && (
        <Card className="mt-6 border-[#E8B86B] shadow-sm" data-testid="mfa-recovery-codes">
          <CardContent className="p-6">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-[#7CB69C]" />
              <div>
                <p className="text-lg font-semibold text-[#2D2A3E]">{t('security.recoveryTitle')}</p>
                <p className="mt-1 text-sm text-[#6B6878]">{t('security.recoveryHint')}</p>
              </div>
            </div>
            <ul className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {recoveryCodes.map((c) => (
                <li key={c} className="rounded-lg bg-[#FAF8FF] px-3 py-2 font-mono text-sm text-[#2D2A3E]">
                  {c}
                </li>
              ))}
            </ul>
            <Button className="mt-4" variant="outline" onClick={() => setRecoveryCodes(null)}>
              {t('security.savedCodes')}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
