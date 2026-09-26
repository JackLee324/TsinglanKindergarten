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
import { readListResponse } from '@client/src/api/client';
import PermissionMatrix from './PermissionMatrix';

import type {
  ProgramCode,
  RoleCode,
  SubjectPermission,
  SubjectPermissionInput,
  Teacher,
} from '@shared/api.interface';

interface SubjectNode {
  key: string;
  name: string;
  nameEn: string;
  children?: SubjectNode[];
}

interface ProgramDef {
  program: ProgramCode;
  name: string;
  nameEn: string;
  subjects: SubjectNode[];
}

const PREK_SUBJECTS: SubjectNode[] = [
  { key: 'virtue', name: '美德', nameEn: 'Virtue' },
  {
    key: 'montessori',
    name: '蒙特梭利',
    nameEn: 'Montessori',
    children: [
      { key: 'practical_life', name: '日常生活', nameEn: 'Practical Life' },
      { key: 'sensorial', name: '感官', nameEn: 'Sensorial' },
      { key: 'math', name: '数学', nameEn: 'Math' },
      { key: 'english_language', name: '英文语言', nameEn: 'English Language' },
      { key: 'chinese_language', name: '中文语言', nameEn: 'Chinese Language' },
      { key: 'culture', name: '文化', nameEn: 'Culture' },
    ],
  },
  { key: 'pe', name: '体能', nameEn: 'Physical Education' },
];

const K_SUBJECTS: SubjectNode[] = [
  { key: 'virtue', name: '美德', nameEn: 'Virtue' },
  {
    key: 'chinese',
    name: '中文',
    nameEn: 'Chinese',
    children: [
      { key: 'poetry', name: '古诗', nameEn: 'Ancient Poetry' },
      { key: 'picture_books', name: '绘本', nameEn: 'Picture Books' },
      { key: 'drama', name: '戏剧', nameEn: 'Drama' },
      { key: 'stem', name: '科学与工程', nameEn: 'STEM' },
    ],
  },
  {
    key: 'english',
    name: '英文',
    nameEn: 'English',
    children: [
      { key: 'reading_comprehension', name: '阅读理解', nameEn: 'Reading Comprehension' },
      { key: 'language_skills', name: '语言技能', nameEn: 'Language Skills' },
      { key: 'math', name: '数学', nameEn: 'Math' },
    ],
  },
  {
    key: 'pe',
    name: '体能',
    nameEn: 'Physical Education',
    children: [
      { key: 'pe_special', name: '体能专项', nameEn: 'PE Special' },
      { key: 'sports', name: '体育', nameEn: 'Sports' },
      { key: 'rock_climbing', name: '攀岩', nameEn: 'Rock Climbing' },
    ],
  },
];

const PROGRAMS: ProgramDef[] = [
  { program: 'prek', name: 'Pre-K', nameEn: 'Pre-K', subjects: PREK_SUBJECTS },
  { program: 'k', name: 'K', nameEn: 'K', subjects: K_SUBJECTS },
];

const ROLE_AUTO_PERMISSIONS: Record<string, { program: ProgramCode; canView: boolean; canUpload: boolean }[]> = {
  principal: [
    { program: 'prek', canView: true, canUpload: true },
    { program: 'k', canView: true, canUpload: true },
  ],
  curriculum_director: [
    { program: 'prek', canView: true, canUpload: false },
    { program: 'k', canView: true, canUpload: false },
  ],
  prek_head: [{ program: 'prek', canView: true, canUpload: true }],
  k_head: [{ program: 'k', canView: true, canUpload: true }],
  pe_specialist: [],
  prek_assistant: [{ program: 'prek', canView: true, canUpload: false }],
  visitor: [],
};

const PermissionAdminPage: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const urlTeacherId = searchParams.get('teacherId');

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
    (program: ProgramCode, _subject: string, type: 'view' | 'upload'): boolean => {
      if (!selectedTeacher) return false;
      const perms = selectedTeacher.roles.flatMap(
        (role) => ROLE_AUTO_PERMISSIONS[role] ?? [],
      );
      return perms.some(
        (p) => p.program === program && (type === 'view' ? p.canView : p.canUpload),
      );
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
    for (const prog of PROGRAMS) {
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
                  programs={PROGRAMS}
                  permissions={permissions}
                  isAutoGranted={isAutoGranted}
                  onPermChange={handlePermChange}
                  selectedTeacherId={selectedTeacherId}
                />
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default PermissionAdminPage;
