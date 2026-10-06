import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { logger } from '@client/src/lib/logger';
import { toast } from 'sonner';
import { Search, Save, CheckCircle2, AlertCircle, Users } from 'lucide-react';

import { Card, CardContent } from '@client/src/components/ui/card';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Badge } from '@client/src/components/ui/badge';
import { PageHeader } from '@client/src/components/ui/page-header';
import { useTranslation } from '@client/src/i18n/useTranslation';
import * as teachersApi from '@client/src/api/teachers';
import { getCurriculumStructure } from '@client/src/api/curriculum';
// 单一真相：角色、权限、班型/科目覆盖范围全部来自 shared/rbac.ts，页面不再自己抄一份。
import { roleDefaults, roleScopeCovers, roleSubjectScope } from '@shared/rbac';
import type { PermissionCode } from '@shared/rbac';
import { readListResponse } from '@client/src/api/client';
import PermissionMatrix from './PermissionMatrix';
import { EffectivePermissionsPanel } from '@client/src/components/permissions/EffectivePermissionsPanel';

import type {
  ProgramCode,
  ProgramStructure,
  RoleCode,
  SubjectPermission,
  SubjectPermissionInput,
  Teacher,
} from '@shared/api.interface';

/**
 * 角色 → 该角色是否**自动**覆盖某个班型下的科目（§3：页面不得自维护角色权限）。
 *
 * 这里以前是一张页面自己维护的 `ROLE_AUTO_PERMISSIONS` 表。那是**第二份真相**：
 * 服务端 `shared/rbac.ts` 里的 `ROLE_PERMISSIONS` / `roleSubjectScope` 已经定义了
 * 同一件事，两处一旦分叉，界面就会显示与服务端判定不一致的"自动已授权"，
 * 而管理员据此操作会得到看不懂的结果。
 *
 * 现在全部**从 shared/rbac.ts 推导**（前端直接 import 那份单一真相）：
 *   · 班型/科目覆盖范围 ← roleSubjectScope + roleScopeCovers
 *   · 能不能看/能不能传 ← 该角色的权限集合里有没有 resource.view / resource.create
 * 页面不再持有任何角色或课程的字面量。
 */
function roleAutoCovers(
  roles: readonly RoleCode[],
  program: ProgramCode,
  subject: string,
  type: 'view' | 'upload',
): boolean {
  const scope = roleSubjectScope(roles);
  if (!roleScopeCovers(scope, program, subject)) return false;
  const needed: PermissionCode = type === 'view' ? 'resource.view' : 'resource.create';
  return roleDefaults(roles).has(needed);
}

const PermissionAdminPage: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const urlTeacherId = searchParams.get('teacherId');

  /**
   * 课程结构（班型 → 科目 → 子科）**来自服务端规范接口**，
   * 页面不再自维护一份数组。
   *
   * 以前这里有两份写死的 `PREK_SUBJECTS` / `K_SUBJECTS`。它不仅违反 §3，
   * 而且**已经漂移了**：本轮按决策新增的 `prek:english`（Pre-K 英文）与
   * `k:chinese:arts`（美育）在这份手抄数组里根本不存在 —— 于是权限管理界面
   * 给不了这两个科目的权限，而服务端认为它们存在。抄一份的下场就是这样。
   */
  const [programs, setPrograms] = useState<ProgramStructure[]>([]);

  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [teachersLoading, setTeachersLoading] = useState(false);
  const [teacherSearch, setTeacherSearch] = useState('');
  const [selectedTeacherId, setSelectedTeacherId] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<SubjectPermission[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  const filteredTeachers = useMemo(() => {
    if (!teacherSearch.trim()) return teachers;
    const q = teacherSearch.toLowerCase();
    return teachers.filter(
      (tch) =>
        tch.name.toLowerCase().includes(q) ||
        tch.wecomUserId.toLowerCase().includes(q) ||
        (tch.nameEn?.toLowerCase() ?? '').includes(q),
    );
  }, [teachers, teacherSearch]);

  const selectedTeacher = teachers.find((t) => t.id === selectedTeacherId) ?? null;

  // 课程结构只加载一次：它是规范词汇，不随界面状态变化。
  useEffect(() => {
    const load = async () => {
      try {
        setPrograms(await getCurriculumStructure());
      } catch (error) {
        // 失败时**不写死兜底数组**（那正是刚删掉的那份手抄表）。
        // 留空 + 记录错误：界面会因此没有科目可勾，而不是给出一份可能过时的假列表。
        logger.error('[PermissionAdmin] load curriculum structure failed', String(error));
      }
    };
    void load();
  }, []);

  useEffect(() => {
    const load = async () => {
      setTeachersLoading(true);
      try {
        const resp = await teachersApi.getTeachers({
          page: 1,
          pageSize: 100,
          status: 'active',
        });
        setTeachers(readListResponse<Teacher>(resp, 'teachers.list(permissions)').items);
      } catch (err) {
        logger.error('[PermissionAdmin] Failed to load teachers', String(err));
      } finally {
        setTeachersLoading(false);
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (urlTeacherId && teachers.length > 0 && !selectedTeacherId) {
      const found = teachers.find((t) => t.id === urlTeacherId);
      if (found) setSelectedTeacherId(found.id);
    }
  }, [urlTeacherId, teachers, selectedTeacherId]);

  const loadPermissions = useCallback(async (teacherId: string) => {
    setPermissionsLoading(true);
    setDirty(false);
    setSaved(false);
    try {
      const detail = await teachersApi.getTeacher(teacherId);
      setPermissions(detail.permissions ?? []);
    } catch (err) {
      logger.error('[PermissionAdmin] Failed to load permissions', String(err));
      toast.error(t('common.error'));
    } finally {
      setPermissionsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (selectedTeacherId) void loadPermissions(selectedTeacherId);
  }, [selectedTeacherId, loadPermissions]);

  const isAutoGranted = useCallback(
    (program: ProgramCode, subject: string, type: 'view' | 'upload'): boolean => {
      if (!selectedTeacher) return false;
      // 直接问单一真相（shared/rbac.ts），页面不再持有任何角色→权限的字面量。
      return roleAutoCovers(selectedTeacher.roles, program, subject, type);
    },
    [selectedTeacher],
  );

  const handlePermChange = (
    program: ProgramCode,
    subject: string,
    subSubject: string | undefined,
    type: 'view' | 'upload',
    value: boolean,
  ) => {
    setDirty(true);
    setSaved(false);
    setPermissions((prev) => {
      const idx = prev.findIndex(
        (p) =>
          p.program === program &&
          p.subject === subject &&
          (subSubject ? p.subSubject === subSubject : !p.subSubject),
      );
      if (idx === -1) {
        return [
          ...prev,
          {
            id: '',
            teacherId: selectedTeacherId ?? '',
            program,
            subject,
            subSubject,
            canView: type === 'view' ? value : false,
            canUpload: type === 'upload' ? value : false,
          },
        ];
      }
      const next = [...prev];
      next[idx] = {
        ...next[idx],
        [type === 'view' ? 'canView' : 'canUpload']: value,
      };
      return next;
    });
  };

  const batchSet = (type: 'view' | 'upload', value: boolean) => {
    setDirty(true);
    setSaved(false);
    const next: SubjectPermission[] = [];
    for (const prog of programs) {
      for (const subj of prog.subjects) {
        const targets = subj.children?.length
          ? subj.children.map((c) => ({ subKey: c.key }))
          : [{ subKey: undefined }];
        for (const target of targets) {
          if (isAutoGranted(prog.program, subj.key, type)) continue;
          next.push({
            id: '',
            teacherId: selectedTeacherId ?? '',
            program: prog.program,
            subject: subj.key,
            subSubject: target.subKey,
            canView:
              type === 'view' ? value : isAutoGranted(prog.program, subj.key, 'view'),
            canUpload:
              type === 'upload' ? value : isAutoGranted(prog.program, subj.key, 'upload'),
          });
        }
      }
    }
    setPermissions(next);
  };

  const handleSave = async () => {
    if (!selectedTeacherId) return;
    setSaving(true);
    try {
      const inputs: SubjectPermissionInput[] = permissions
        .filter((p) => p.canView || p.canUpload)
        .map((p) => ({
          program: p.program,
          subject: p.subject,
          subSubject: p.subSubject,
          canView: p.canView,
          canUpload: p.canUpload,
        }));
      await teachersApi.updateTeacherPermissions(selectedTeacherId, inputs);
      setDirty(false);
      setSaved(true);
      toast.success(t('permission.saved'));
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      logger.error('[PermissionAdmin] Save failed', String(err));
      toast.error(t('common.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={t('page.permissionAdmin')}
        description={t('page.permissionAdminDesc')}
        actions={
          selectedTeacherId && dirty ? (
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary hover:bg-primary-dark"
            >
              {saving ? (
                t('permission.saving')
              ) : saved ? (
                <>
                  <CheckCircle2 className="size-4" />
                  {t('permission.saved')}
                </>
              ) : (
                <>
                  <Save className="size-4" />
                  {t('permission.save')}
                </>
              )}
            </Button>
          ) : null
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        {/* 左侧教师列表 */}
        <Card className="border-border shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <Users className="size-4 text-primary" />
              <h3 className="font-semibold text-foreground">
                {t('nav.admin.teachers')}
              </h3>
            </div>
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={teacherSearch}
                onChange={(e) => setTeacherSearch(e.target.value)}
                placeholder={t('teacher.searchPlaceholder')}
                className="pl-9"
              />
            </div>
            <div className="max-h-[600px] overflow-y-auto -mx-2">
              {teachersLoading ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  {t('common.loading')}
                </div>
              ) : filteredTeachers.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  {t('permission.noTeacher')}
                </div>
              ) : (
                <ul className="space-y-1">
                  {filteredTeachers.map((teacher) => (
                    <li key={teacher.id}>
                      <button
                        // data-testid / data-teacher-id：浏览器 E2E 需要能稳定地
                        // "选中某个账号"。这个列表是 <button> 而非 <table>，
                        // 用文本或结构去猜元素既脆弱、也容易点到导航栏
                        // （我在目录页踩过同一个坑）。
                        data-testid="teacher-option"
                        data-teacher-id={teacher.id}
                        onClick={() => setSelectedTeacherId(teacher.id)}
                        className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                          selectedTeacherId === teacher.id
                            ? 'bg-primary/10 border border-primary/20'
                            : 'hover:bg-muted/50 border border-transparent'
                        }`}
                      >
                        <div className="font-medium text-sm text-foreground">
                          {teacher.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {teacher.wecomUserId}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {teacher.roles.slice(0, 2).map((role: RoleCode) => (
                            <Badge
                              key={role}
                              variant="outline"
                              className="text-[10px] px-2 py-0 rounded-full border border-border bg-muted/30 text-muted-foreground"
                            >
                              {t(`role.${role}`)}
                            </Badge>
                          ))}
                          {teacher.roles.length > 2 && (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-2 py-0 rounded-full border border-border bg-muted/30 text-muted-foreground"
                            >
                              +{teacher.roles.length - 2}
                            </Badge>
                          )}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 右侧权限矩阵 */}
        <Card className="border-border shadow-sm">
          <CardContent className="p-6">
            {!selectedTeacher ? (
              <div className="py-16 text-center">
                <AlertCircle className="size-12 text-muted-foreground/50 mx-auto mb-4" />
                <p className="text-muted-foreground">
                  {t('permission.selectTeacher')}
                </p>
              </div>
            ) : permissionsLoading ? (
              <div className="py-16 text-center">
                <p className="text-muted-foreground">{t('common.loading')}</p>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between mb-6 pb-4 border-b border-border flex-wrap gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">
                      {selectedTeacher.name}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {selectedTeacher.wecomUserId} · {selectedTeacher.email}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {selectedTeacher.roles.map((role: RoleCode) => (
                        <Badge
                          key={role}
                          variant="outline"
                          className="rounded-full border border-border bg-muted/30 text-xs"
                        >
                          {t(`role.${role}`)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => batchSet('view', true)}
                    >
                      {t('permission.batchGrant')} · {t('permission.view')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => batchSet('upload', true)}
                    >
                      {t('permission.batchGrant')} · {t('permission.upload')}
                    </Button>
                  </div>
                </div>

                <div className="mb-4 flex items-start gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/10">
                  <AlertCircle className="size-4 text-primary mt-0.5 shrink-0" />
                  <p className="text-xs text-muted-foreground">
                    {t('permission.autoGrantedTip')}
                  </p>
                </div>

                <PermissionMatrix
                  programs={programs}
                  permissions={permissions}
                  isAutoGranted={isAutoGranted}
                  onPermChange={handlePermChange}
                  selectedTeacherId={selectedTeacherId}
                />
              </>
            )}
          </CardContent>
        </Card>

        {/* §11 按账号授权：科目权限管的是"能对哪些数据做"，
            这里管的是"能不能做这个动作" —— 两者是 RBAC.md 的三层模型里不同的两层，
            所以分成两块而不是塞进同一张表。 */}
        {selectedTeacherId && (
          <div className="mt-6">
            <EffectivePermissionsPanel teacherId={selectedTeacherId} />
          </div>
        )}
      </div>
    </div>
  );
};

export default PermissionAdminPage;
