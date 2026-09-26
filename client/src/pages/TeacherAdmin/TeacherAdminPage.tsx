import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Table, type TableProps } from 'antd';
import { logger } from '@client/src/lib/logger';
import { toast } from 'sonner';
import { Search, UserPlus, Pencil, Shield, Ban, CheckCircle2, KeyRound } from 'lucide-react';

import { Card, CardContent } from '@client/src/components/ui/card';
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@client/src/components/ui/tooltip';
import { PageHeader } from '@client/src/components/ui/page-header';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { useAuth } from '@client/src/auth/useAuth';
import * as teachersApi from '@client/src/api/teachers';
import * as authApi from '@client/src/api/auth';
import TeacherFormDialog from './TeacherFormDialog';
import { ROLE_CODES } from '@shared/api.interface';

import type { RoleCode, Teacher } from '@shared/api.interface';

const ROLE_BADGE_COLORS: Record<RoleCode, string> = {
  super_admin: 'bg-rose-100 text-rose-700 border-rose-300',
  principal: 'bg-purple-100 text-purple-700 border-purple-200',
  curriculum_director: 'bg-blue-100 text-blue-700 border-blue-200',
  prek_head: 'bg-green-100 text-green-700 border-green-200',
  k_head: 'bg-orange-100 text-orange-700 border-orange-200',
  pe_specialist: 'bg-red-100 text-red-700 border-red-200',
  prek_assistant: 'bg-gray-100 text-gray-600 border-gray-200',
  k_assistant: 'bg-teal-100 text-teal-700 border-teal-200',
  visitor: 'bg-gray-100 text-gray-600 border-gray-200',
};

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700 border-green-200',
  inactive: 'bg-gray-100 text-gray-500 border-gray-200',
};

const TeacherAdminPage: React.FC = () => {
  const { t, language } = useTranslation();
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const canEdit = hasRole(['principal']);

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Teacher[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [keyword, setKeyword] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTeacher, setEditingTeacher] = useState<Teacher | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    teacher: Teacher | null;
    action: 'activate' | 'deactivate';
  }>({ open: false, teacher: null, action: 'deactivate' });

  const [resetDialog, setResetDialog] = useState<{
    open: boolean;
    teacher: Teacher | null;
    tempPassword: string;
    loading: boolean;
  }>({ open: false, teacher: null, tempPassword: '', loading: false });

  const fetchTeachers = useCallback(async () => {
    setLoading(true);
    try {
      const params: {
        page: number;
        pageSize: number;
        keyword?: string;
        role?: string;
        status?: 'active' | 'inactive';
      } = { page, pageSize };
      if (keyword) params.keyword = keyword;
      if (roleFilter !== 'all') params.role = roleFilter;
      if (statusFilter !== 'all')
        params.status = statusFilter as 'active' | 'inactive';

      const resp = await teachersApi.getTeachers(params);
      setItems(resp.items);
      setTotal(resp.total);
    } catch (err) {
      logger.error('[TeacherAdmin] Failed to fetch teachers', String(err));
      toast.error(t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, keyword, roleFilter, statusFilter, t]);

  useEffect(() => {
    void fetchTeachers();
  }, [fetchTeachers]);

  const handleSearch = () => {
    setKeyword(searchInput.trim());
    setPage(1);
  };

  const openAddDialog = () => {
    setEditingTeacher(null);
    setDialogOpen(true);
  };

  const openEditDialog = (teacher: Teacher) => {
    setEditingTeacher(teacher);
    setDialogOpen(true);
  };

  const handleToggleStatus = async () => {
    if (!confirmDialog.teacher) return;
    const teacher = confirmDialog.teacher;
    const newStatus = confirmDialog.action === 'activate' ? 'active' : 'inactive';
    try {
      await teachersApi.updateTeacher(teacher.id, { status: newStatus });
      toast.success(
        newStatus === 'active'
          ? t('teacher.activateSuccess')
          : t('teacher.deactivateSuccess'),
      );
      setConfirmDialog({ ...confirmDialog, open: false });
      void fetchTeachers();
    } catch (err) {
      logger.error('[TeacherAdmin] Toggle status failed', String(err));
      toast.error(t('common.failed'));
    }
  };

  const goToPermissions = (teacherId: string) => {
    navigate(`/admin/permissions?teacherId=${teacherId}`);
  };

  const openResetDialog = (teacher: Teacher): void => {
    setResetDialog({ open: true, teacher, tempPassword: '', loading: false });
  };

  const handleResetPassword = async (): Promise<void> => {
    if (!resetDialog.teacher) return;
    try {
      setResetDialog({ ...resetDialog, loading: true });
      const resp = await authApi.resetPassword(resetDialog.teacher.id);
      setResetDialog({
        ...resetDialog,
        tempPassword: resp.temporaryPassword,
        loading: false,
      });
      toast.success(t('resetPassword.success'));
    } catch (err) {
      logger.error('[TeacherAdmin] Reset password failed', String(err));
      toast.error(t('common.failed'));
      setResetDialog({ ...resetDialog, loading: false });
    }
  };

  const formatDate = (dateStr?: string): string => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleString(
      language === 'zh-CN' ? 'zh-CN' : 'en-US',
    );
  };

  const columns: TableProps<Teacher>['columns'] = [
    {
      title: t('common.name'),
      dataIndex: 'name',
      key: 'name',
      fixed: 'left',
      width: 180,
      render: (_val: string, record: Teacher) => (
        <div className="leading-tight">
          <div className="font-medium text-foreground">{record.name}</div>
          {record.nameEn && (
            <div className="text-xs text-muted-foreground">{record.nameEn}</div>
          )}
        </div>
      ),
    },
    {
      title: t('teacher.username'),
      dataIndex: 'username',
      key: 'username',
      width: 160,
      render: (val: string) => val || '-',
    },
    {
      title: t('teacher.wecomUserId'),
      dataIndex: 'wecomUserId',
      key: 'wecomUserId',
      width: 160,
      className: 'font-mono text-xs',
      render: (val: string) => val || '-',
    },
    {
      title: t('common.email'),
      dataIndex: 'email',
      key: 'email',
      width: 200,
      render: (val: string) => val || '-',
    },
    {
      title: t('common.role'),
      dataIndex: 'roles',
      key: 'roles',
      width: 280,
      render: (roles: RoleCode[]) => (
        <div className="flex flex-wrap gap-1.5">
          {roles.map((role: RoleCode) => (
            <Badge
              key={role}
              variant="outline"
              className={`${ROLE_BADGE_COLORS[role]} border rounded-full`}
            >
              {t(`role.${role}`)}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => (
        <Badge
          variant="outline"
          className={`${STATUS_COLORS[status]} border rounded-full`}
        >
          {status === 'active'
            ? t('teacher.statusActive')
            : t('teacher.statusInactive')}
        </Badge>
      ),
    },
    {
      title: t('teacher.lastLogin'),
      dataIndex: 'lastLoginAt',
      key: 'lastLoginAt',
      width: 180,
      render: (val: string) => formatDate(val),
    },
    {
      title: t('common.createdAt'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (val: string) => formatDate(val),
    },
    {
      title: t('common.operation'),
      key: 'action',
      fixed: 'right',
      width: 280,
      render: (_val: unknown, record: Teacher) => (
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={!canEdit}
                onClick={() => openEditDialog(record)}
              >
                <Pencil className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('btn.edit')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={!canEdit}
                onClick={() => goToPermissions(record.id)}
              >
                <Shield className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('teacher.permissions')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={!canEdit}
                onClick={() => openResetDialog(record)}
              >
                <KeyRound className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('resetPassword.title')}</TooltipContent>
          </Tooltip>
          {record.status === 'active' ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!canEdit}
                  onClick={() =>
                    setConfirmDialog({
                      open: true,
                      teacher: record,
                      action: 'deactivate',
                    })
                  }
                  className="text-red-500 hover:text-red-600 hover:bg-red-50"
                >
                  <Ban className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('teacher.deactivate')}</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!canEdit}
                  onClick={() =>
                    setConfirmDialog({
                      open: true,
                      teacher: record,
                      action: 'activate',
                    })
                  }
                  className="text-green-600 hover:text-green-700 hover:bg-green-50"
                >
                  <CheckCircle2 className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('teacher.activate')}</TooltipContent>
            </Tooltip>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t('page.teacherAdmin')}
        description={t('page.teacherAdminDesc')}
        actions={
          canEdit ? (
            <Button
              onClick={openAddDialog}
              className="bg-primary hover:bg-primary-dark"
            >
              <UserPlus className="size-4" />
              {t('teacher.add')}
            </Button>
          ) : null
        }
      />

      <Card className="border-border shadow-sm">
        <CardContent className="p-6">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[240px] max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder={t('teacher.searchPlaceholder')}
                className="pl-9"
              />
            </div>
            <Button variant="secondary" onClick={handleSearch}>
              <Search className="size-4" />
              {t('btn.search')}
            </Button>

            <div className="w-[160px]">
              <Select
                value={roleFilter}
                onValueChange={(v) => {
                  setRoleFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('teacher.filterRole')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('teacher.filterAll')}</SelectItem>
                  {ROLE_CODES.map((role: RoleCode) => (
                    <SelectItem key={role} value={role}>
                      {t(`role.${role}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-[140px]">
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t('teacher.filterStatus')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('teacher.filterAll')}</SelectItem>
                  <SelectItem value="active">
                    {t('teacher.statusActive')}
                  </SelectItem>
                  <SelectItem value="inactive">
                    {t('teacher.statusInactive')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Table
            rowKey="id"
            columns={columns}
            dataSource={items}
            loading={loading}
            scroll={{ x: 1400, y: 500 }}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: false,
              onChange: (p: number) => setPage(p),
            }}
          />
        </CardContent>
      </Card>

      <TeacherFormDialog
        open={dialogOpen}
        teacher={editingTeacher}
        onOpenChange={setDialogOpen}
        onSuccess={() => fetchTeachers()}
      />

      <Dialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog({ ...confirmDialog, open })}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmDialog.action === 'activate'
                ? t('teacher.activate')
                : t('teacher.deactivate')}
            </DialogTitle>
            <DialogDescription>
              {confirmDialog.action === 'activate'
                ? t('teacher.confirmActivate')
                : t('teacher.confirmDeactivate')}
            </DialogDescription>
          </DialogHeader>
          {confirmDialog.teacher && (
            <p className="text-sm text-foreground font-medium">
              {confirmDialog.teacher.name} ({confirmDialog.teacher.wecomUserId})
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                setConfirmDialog({ ...confirmDialog, open: false })
              }
            >
              {t('btn.cancel')}
            </Button>
            <Button
              onClick={handleToggleStatus}
              variant={
                confirmDialog.action === 'deactivate' ? 'destructive' : 'default'
              }
              className={
                confirmDialog.action === 'activate'
                  ? 'bg-primary hover:bg-primary-dark'
                  : ''
              }
            >
              {t('btn.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resetDialog.open}
        onOpenChange={(open) => setResetDialog({ ...resetDialog, open })}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('resetPassword.title')}</DialogTitle>
            <DialogDescription>
              {t('resetPassword.confirm')}
            </DialogDescription>
          </DialogHeader>
          {resetDialog.teacher && (
            <p className="text-sm font-medium text-foreground">
              {resetDialog.teacher.name} ({resetDialog.teacher.username || '-'})
            </p>
          )}
          {resetDialog.tempPassword && (
            <div className="rounded-lg border border-green-200 bg-green-50 p-4">
              <p className="text-sm font-medium text-green-800">
                {t('resetPassword.success')}
              </p>
              <p className="mt-2 font-mono text-lg font-semibold text-green-900">
                {resetDialog.tempPassword}
              </p>
              <p className="mt-2 text-xs text-green-700">
                {t('resetPassword.tip')}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                setResetDialog({
                  open: false,
                  teacher: null,
                  tempPassword: '',
                  loading: false,
                })
              }
            >
              {resetDialog.tempPassword ? t('btn.close') : t('btn.cancel')}
            </Button>
            {!resetDialog.tempPassword && (
              <Button
                onClick={handleResetPassword}
                disabled={resetDialog.loading}
                className="bg-primary hover:bg-primary-dark"
              >
                {resetDialog.loading
                  ? t('common.loading')
                  : t('resetPassword.title')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TeacherAdminPage;
