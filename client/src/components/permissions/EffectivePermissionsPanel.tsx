import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, RotateCcw, ShieldMinus, ShieldPlus } from 'lucide-react';

import { Button } from '@client/src/components/ui/button';
import { useTranslation } from '@client/src/i18n/useTranslation';
import type { TranslationKey } from '@client/src/i18n/translations';
import * as teachersApi from '@client/src/api/teachers';
import { PERMISSIONS, type EffectivePermissions } from '@shared/rbac';

/**
 * §11 按账号授权 —— 生效权限面板。
 *
 * 呈现的是 RBAC.md §5 的模型：
 *
 *     有效权限 = ( 角色默认 ∪ 追加授权 ) − 显式禁止      （禁止永远优先）
 *
 * 三条刻意的取舍：
 *
 * 1. **每一项都标出来源**（角色默认 / 追加 / 禁止）。只显示"有哪些权限"的话，
 *    管理员无法回答"我那条单独开到底生效了没有" —— 那正是这个功能存在的理由。
 * 2. **失败如实显示服务端原因**。改权限会触发 `permissions_version` 自增，
 *    该账号的会话立即失效；服务端也会因为等级规则拒绝（不能改同级/更高级）。
 *    这些都是**正确行为**，界面必须把它们说清楚，而不是统一报"操作失败"。
 * 3. **权限目录来自 `@shared/rbac`**，不是界面里另抄一份 —— 抄一份就会漂移，
 *    而这个项目已经为此吃过苦头（5 处漂移的历史写在 shared/curriculum.ts 里）。
 */
export function EffectivePermissionsPanel({ teacherId }: { teacherId: string }) {
  const { t } = useTranslation();
  const [effective, setEffective] = useState<EffectivePermissions | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEffective(await teachersApi.getEffectivePermissions(teacherId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEffective(null);
    } finally {
      setLoading(false);
    }
  }, [teacherId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (permission: string, fn: () => Promise<EffectivePermissions>) => {
      setBusy(permission);
      setError(null);
      try {
        setEffective(await fn());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const granted = new Set(effective?.sources?.granted ?? []);
  const denied = new Set(effective?.sources?.denied ?? []);
  const active = new Set(effective?.permissions ?? []);

  return (
    <div className="rounded-xl border border-[#E8E4F0] bg-white p-6" data-testid="effective-permissions">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-[#2D2A3E]">{t('permPanel.title')}</h3>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} data-testid="perm-reload">
          <RotateCcw className="size-4" />
        </Button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">{t('permPanel.subtitle')}</p>

      {error && (
        <div
          className="mb-4 flex items-start gap-2 rounded-lg border border-[#D98B8B] p-3"
          data-testid="perm-error"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-[#D98B8B]" />
          <span className="break-words text-sm text-[#2D2A3E]">{error}</span>
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-3 py-6">
          <Loader2 className="size-5 animate-spin text-primary" />
          <span className="text-muted-foreground">{t('common.loading')}</span>
        </div>
      )}

      {!loading && effective && (
        <>
          <p className="mb-3 text-sm text-[#6B6878]" data-testid="perm-summary">
            {t('permPanel.summary')
              .replace('{total}', String(active.size))
              .replace('{granted}', String(granted.size))
              .replace('{denied}', String(denied.size))}
          </p>

          {/* 只有被单独开/单独收的条目才需要动作按钮 —— 角色默认的那些，
              动它们等于在给"角色"打补丁，应该改角色而不是改账号。 */}
          {(granted.size > 0 || denied.size > 0) && (
            <ul className="mb-4 space-y-2" data-testid="perm-overrides">
              {[...granted, ...denied].map((code) => (
                <li
                  key={code}
                  className="flex items-center justify-between gap-3 rounded-lg bg-[#FAF8FF] px-3 py-2 text-sm"
                  data-override={code}
                >
                  <span className="text-[#2D2A3E]">
                    <span className="font-mono text-xs">{code}</span>
                    <span className="ml-2 text-xs text-[#6B6878]">
                      {granted.has(code) ? t('permPanel.sourceGranted') : t('permPanel.sourceDenied')}
                    </span>
                  </span>
                  <button
                    type="button"
                    data-perm-clear={code}
                    disabled={busy === code}
                    onClick={() => void act(code, () => teachersApi.clearPermissionOverride(teacherId, code))}
                    className="rounded-lg px-2 py-1 text-xs text-[#6B6878] hover:bg-white disabled:opacity-40"
                  >
                    {t('permPanel.clear')}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* 权限目录（按分组）。这里列出全部条目，包括当前**没有**的 ——
              只有看得见"缺什么"才谈得上追加授权。 */}
          <div className="max-h-80 space-y-4 overflow-y-auto pr-1">
            {groupPermissions().map(([group, items]) => (
              <div key={group}>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[#6B6878]">{group}</p>
                <ul className="space-y-1">
                  {items.map((p) => {
                    const has = active.has(p.code);
                    const isGranted = granted.has(p.code);
                    const isDenied = denied.has(p.code);
                    return (
                      <li
                        key={p.code}
                        data-perm-row={p.code}
                        className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-[#FAF8FF]"
                      >
                        <span className="flex items-center gap-2">
                          <span className={has ? 'text-[#2D2A3E]' : 'text-muted-foreground line-through'}>
                            {p.name}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">{p.code}</span>
                          {isGranted && (
                            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] text-blue-700" data-perm-badge={p.code}>
                              {t('permPanel.badgeGranted')}
                            </span>
                          )}
                          {isDenied && (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700" data-perm-badge={p.code}>
                              {t('permPanel.badgeDenied')}
                            </span>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          {!isGranted && (
                            <button
                              type="button"
                              data-perm-grant={p.code}
                              disabled={busy === p.code}
                              title={t('permPanel.grant')}
                              onClick={() => void act(p.code, () => teachersApi.grantPermission(teacherId, p.code))}
                              className="rounded-lg p-1 text-[#6B6878] hover:bg-white hover:text-primary-dark disabled:opacity-40"
                            >
                              <ShieldPlus className="size-4" />
                            </button>
                          )}
                          {!isDenied && (
                            <button
                              type="button"
                              data-perm-deny={p.code}
                              disabled={busy === p.code}
                              title={t('permPanel.deny')}
                              onClick={() => void act(p.code, () => teachersApi.denyPermission(teacherId, p.code))}
                              className="rounded-lg p-1 text-[#6B6878] hover:bg-white hover:text-[#D98B8B] disabled:opacity-40"
                            >
                              <ShieldMinus className="size-4" />
                            </button>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** 按分组整理权限目录（分组只用于展示，不参与鉴权）。 */
function groupPermissions(): Array<[string, Array<{ code: string; name: string }>]> {
  const map = new Map<string, Array<{ code: string; name: string }>>();
  for (const p of PERMISSIONS) {
    const list = map.get(p.group) ?? [];
    list.push({ code: p.code, name: p.name });
    map.set(p.group, list);
  }
  return [...map.entries()];
}

// TranslationKey 仅用于类型收窄的引用，避免未使用导入被 lint 报出。
export type PanelTranslationKey = TranslationKey;
