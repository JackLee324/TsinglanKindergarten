import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { logger } from '@lark-apaas/client-toolkit/logger';

import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { Badge } from '@client/src/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { useTranslation } from '@client/src/i18n/useTranslation';
import * as teachersApi from '@client/src/api/teachers';
import { ROLE_CODES } from '@shared/api.interface';

import type {
  CreateTeacherRequest,
  RoleCode,
  Teacher,
} from '@shared/api.interface';

const ROLE_BADGE_COLORS: Record<RoleCode, string> = {
  principal: 'bg-purple-100 text-purple-700 border-purple-200',
  curriculum_director: 'bg-blue-100 text-blue-700 border-blue-200',
  prek_head: 'bg-green-100 text-green-700 border-green-200',
  k_head: 'bg-orange-100 text-orange-700 border-orange-200',
  pe_specialist: 'bg-red-100 text-red-700 border-red-200',
  prek_assistant: 'bg-gray-100 text-gray-600 border-gray-200',
  k_assistant: 'bg-teal-100 text-teal-700 border-teal-200',
  visitor: 'bg-gray-100 text-gray-600 border-gray-200',
};

interface TeacherFormDialogProps {
  open: boolean;
  teacher: Teacher | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

const TeacherFormDialog: React.FC<TeacherFormDialogProps> = ({
  open,
  teacher,
  onOpenChange,
  onSuccess,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<Partial<CreateTeacherRequest>>({
    username: '',
    wecomUserId: '',
    name: '',
    nameEn: '',
    email: '',
    roles: [],
    status: 'active',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      if (teacher) {
        setForm({
          username: teacher.username,
          wecomUserId: teacher.wecomUserId,
          name: teacher.name,
          nameEn: teacher.nameEn,
          email: teacher.email,
          roles: [...teacher.roles],
          status: teacher.status,
        });
      } else {
        setForm({
          username: '',
          wecomUserId: '',
          name: '',
          nameEn: '',
          email: '',
          roles: [],
          status: 'active',
        });
      }
      setErrors({});
    }
  }, [open, teacher]);

  const toggleRole = (role: RoleCode) => {
    const current = form.roles ?? [];
    const next = current.includes(role)
      ? current.filter((r) => r !== role)
      : [...current, role];
    setForm({ ...form, roles: next });
  };

  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!form.name?.trim()) e.name = t('teacher.nameRequired');
    if (!form.roles || form.roles.length === 0) e.roles = t('teacher.rolesRequired');
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      if (teacher) {
        await teachersApi.updateTeacher(teacher.id, form);
        toast.success(t('teacher.updateSuccess'));
      } else {
        await teachersApi.createTeacher(form as CreateTeacherRequest);
        toast.success(t('teacher.addSuccess'));
      }
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      logger.error('[TeacherForm] Submit failed', String(err));
      toast.error(t('common.failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{teacher ? t('teacher.edit') : t('teacher.add')}</DialogTitle>
          <DialogDescription>
            {teacher ? t('teacher.edit') : t('teacher.add')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          <div>
            <label className="text-sm font-medium text-foreground">
              {t('teacher.username')}
            </label>
            <Input
              value={form.username ?? ''}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              className="mt-1.5"
              placeholder={t('teacher.usernamePlaceholder')}
              disabled={!!teacher}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t('teacher.usernameHint')}
            </p>
          </div>

          <div>
            <label className="text-sm font-medium text-foreground">
              {t('teacher.wecomUserId')}
            </label>
            <Input
              value={form.wecomUserId ?? ''}
              onChange={(e) => setForm({ ...form, wecomUserId: e.target.value })}
              className="mt-1.5"
              disabled={!!teacher}
            />
          </div>

          <div>
            <label className="text-sm font-medium text-foreground">
              {t('common.name')} <span className="text-red-500">*</span>
            </label>
            <Input
              value={form.name ?? ''}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="mt-1.5"
            />
            {errors.name && (
              <p className="mt-1 text-xs text-red-500">{errors.name}</p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium text-foreground">
              {t('teacher.nameEn')}
            </label>
            <Input
              value={form.nameEn ?? ''}
              onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
              className="mt-1.5"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-foreground">
              {t('common.email')}
            </label>
            <Input
              type="email"
              value={form.email ?? ''}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              className="mt-1.5"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-foreground">
              {t('common.role')} <span className="text-red-500">*</span>
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              {ROLE_CODES.map((role: RoleCode) => {
                const selected = form.roles?.includes(role);
                return (
                  <button
                    key={role}
                    type="button"
                    onClick={() => toggleRole(role)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                      selected
                        ? `${ROLE_BADGE_COLORS[role]} border-transparent`
                        : 'bg-white border-border text-muted-foreground hover:border-primary/50'
                    }`}
                  >
                    {t(`role.${role}`)}
                  </button>
                );
              })}
            </div>
            {errors.roles && (
              <p className="mt-1 text-xs text-red-500">{errors.roles}</p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium text-foreground">
              {t('common.status')}
            </label>
            <div className="mt-2">
              <Select
                value={form.status ?? 'active'}
                onValueChange={(v) =>
                  setForm({ ...form, status: v as 'active' | 'inactive' })
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t('teacher.statusActive')}</SelectItem>
                  <SelectItem value="inactive">
                    {t('teacher.statusInactive')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('btn.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={loading}
            className="bg-primary hover:bg-primary-dark"
          >
            {loading ? t('common.loading') : t('btn.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default TeacherFormDialog;
