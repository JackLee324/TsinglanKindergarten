import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2, RotateCcw, ShieldMinus, ShieldPlus } from 'lucide-react';

import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { useTranslation } from '@client/src/i18n/useTranslation';
import type { TranslationKey } from '@client/src/i18n/translations';
import * as teachersApi from '@client/src/api/teachers';
import { PERMISSIONS, SCOPE_KINDS, type EffectivePermissions, type ScopeKind, type WritableScopeBinding } from '@shared/rbac';

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

  /**
   * §12 数据范围（ALL / PROGRAM / SUBJECT / OWN）的编辑态。
   *
   * `scopes` 直接来自 `effective.scopes` —— 不另存一份副本，
   * 否则"面板显示的范围"与"服务端认为的范围"会在刷新后不一致，
   * 而权限界面上显示不一致是最危险的一类问题：管理员会按错的那份做决定。
   * `draft` 只在用户**正在编辑**时存在，保存成功后丢弃。
   */
  const [scopeDraft, setScopeDraft] = useState<WritableScopeBinding[] | null>(null);

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

  const scopes = effective?.scopes ?? [];
  const editingScopes = scopeDraft !== null;
  const scopeRows = scopeDraft ?? scopes;

  const saveScopes = useCallback(
    async (next: WritableScopeBinding[]) => {
      setBusy('__scopes__');
      setError(null);
      try {
        await teachersApi.setAccountScopes(teacherId, next);
        setScopeDraft(null);
        // 保存后**重新读一次**服务端的生效快照，而不是本地拼一份 ——
        // 服务端可能在写路径上做了归一化（例如补上 program），
        // 本地拼的那份就会与真实状态分叉。
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [teacherId, load],
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

          {/* §12 数据范围（ALL / PROGRAM / SUBJECT / OWN）。
              以前这里只有权限的"有/没有"，完全没有"能看到哪些班型/科目" ——
              而 `account_scopes` 表与 `setScopes()` 早就存在，只是没人能调用它。
              范围与权限是**两个维度**：`resource.update` 是"能不能改"，
              范围是"改得了哪些"。只有前者没有后者，管理员就只能靠猜。 */}
          <div className="mt-6 border-t border-[#E8E4F0] pt-4" data-testid="scope-section">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-[#2D2A3E]">{t('permPanel.scopeTitle')}</h4>
              <div className="flex gap-2">
                {!editingScopes && (
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="scope-edit"
                    onClick={() => setScopeDraft(scopes.map((x) => ({ ...x })))}
                  >
                    {t('permPanel.scopeEdit')}
                  </Button>
                )}
                {editingScopes && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="scope-add"
                      onClick={() =>
                        setScopeDraft([...(scopeDraft ?? []), { permission: null, kind: 'ALL' }])
                      }
                    >
                      {t('permPanel.scopeAdd')}
                    </Button>
                    <Button
                      size="sm"
                      data-testid="scope-save"
                      disabled={busy === '__scopes__'}
                      onClick={() => void saveScopes(scopeDraft ?? [])}
                    >
                      {busy === '__scopes__' ? <Loader2 className="size-4 animate-spin" /> : null}
                      {t('permPanel.scopeSave')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="scope-cancel"
                      onClick={() => setScopeDraft(null)}
                    >
                      {t('permPanel.scopeCancel')}
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/*
              空数组的语义必须写出来。它是"按角色默认"，**不是**"没有权限" ——
              把这两者混为一谈，管理员会以为这个账号什么都看不到，
              然后去"修"一个根本没坏的东西。
            */}
            {scopeRows.length === 0 && (
              <p className="text-sm text-muted-foreground" data-testid="scope-empty">
                {t('permPanel.scopeEmpty')}
              </p>
            )}

            <ul className="space-y-2">
              {scopeRows.map((row, index) => (
                <li
                  key={`${row.permission ?? '__all__'}-${index}`}
                  className="flex flex-wrap items-center gap-2 rounded-lg bg-[#FAF8FF] px-3 py-2 text-sm"
                  data-testid="scope-row"
                >
                  <Select
                    value={row.kind}
                    disabled={!editingScopes}
                    onValueChange={(v: string) => {
                      /**
                       * 切换范围类型时**清掉不再适用的字段**。
                       *
                       * 数据库约束 `account_scopes_shape_check` 规定：
                       * ALL / OWN 不得带任何目标、PROGRAM 只能带 program、
                       * SUBJECT 必须同时有 program 与 subject。
                       * 若从 PROGRAM 切到 ALL 却留着 program，服务端会（正确地）
                       * 以 400 拒绝，而用户只看到"保存失败"、看不出是哪一格的问题。
                       * 在这里顺手清掉，比让用户自己猜要诚实。
                       */
                      const nextKind = v as ScopeKind;
                      setScopeDraft(
                        (scopeDraft ?? []).map((x, i) => {
                          if (i !== index) return x;
                          if (nextKind === 'ALL' || nextKind === 'OWN') {
                            return { permission: x.permission ?? null, kind: nextKind };
                          }
                          if (nextKind === 'PROGRAM') {
                            return {
                              permission: x.permission ?? null,
                              kind: nextKind,
                              program: x.program ?? null,
                            };
                          }
                          return {
                            permission: x.permission ?? null,
                            kind: nextKind,
                            program: x.program ?? null,
                            subject: x.subject ?? null,
                          };
                        }),
                      );
                    }}
                  >
                    <SelectTrigger className="w-32" size="sm" data-testid="scope-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SCOPE_KINDS.map((k) => (
                        <SelectItem key={k} value={k}>
                          {t(`permPanel.scopeKind.${k}` as Parameters<typeof t>[0])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* PROGRAM / SUBJECT 需要一个具体目标；ALL 与 OWN 不需要
                      （ALL = 全部，OWN = 只有自己创建的）。 */}
                  {/*
                    ⚠️ 这两个输入框以前是 `defaultValue` + `onBlur`（非受控）——
                    那不是风格问题，是一个真实的竞态：用户打完字**直接点「保存」**时，
                    blur 与 click 的先后决定了这个值会不会进到待保存的草稿里；
                    丢了的话服务端会因为缺 program/subject 而 400，而界面上
                    看不出"我刚打的字没被带上"。
                    实测就是这样：浏览器断言里填了 prek、点了保存，库里仍是空的。
                    改成受控输入（onChange 直接写草稿），行为就是确定的。
                  */}
                  {(row.kind === 'PROGRAM' || row.kind === 'SUBJECT') && (
                    <Input
                      className="w-40"
                      disabled={!editingScopes}
                      data-testid="scope-program"
                      value={row.program ?? ''}
                      placeholder="prek / k"
                      onChange={(e) =>
                        setScopeDraft(
                          (scopeDraft ?? []).map((x, i) =>
                            i === index ? { ...x, program: e.target.value || null } : x,
                          ),
                        )
                      }
                    />
                  )}
                  {row.kind === 'SUBJECT' && (
                    <Input
                      className="w-40"
                      disabled={!editingScopes}
                      data-testid="scope-subject"
                      value={row.subject ?? ''}
                      placeholder="virtue / chinese"
                      onChange={(e) =>
                        setScopeDraft(
                          (scopeDraft ?? []).map((x, i) =>
                            i === index ? { ...x, subject: e.target.value || null } : x,
                          ),
                        )
                      }
                    />
                  )}

                  <span className="text-xs text-[#6B6878]">
                    {row.permission === null || row.permission === undefined
                      ? t('permPanel.scopeAllPermissions')
                      : row.permission}
                  </span>

                  {editingScopes && (
                    <button
                      type="button"
                      data-testid="scope-remove"
                      onClick={() =>
                        setScopeDraft((scopeDraft ?? []).filter((_, i) => i !== index))
                      }
                      className="ml-auto rounded-lg px-2 py-1 text-xs text-[#6B6878] hover:bg-white"
                    >
                      {t('permPanel.clear')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {editingScopes && (
              <p className="mt-2 text-xs text-muted-foreground">{t('permPanel.scopeWriteOnce')}</p>
            )}
          </div>

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
