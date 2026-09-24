import React, { useCallback, useEffect, useState } from 'react';
import { Table, type TableProps } from '@lark-apaas/client-toolkit/antd-table';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { toast } from 'sonner';
import { Search, Download, Check, X } from 'lucide-react';

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
import { PageHeader } from '@client/src/components/ui/page-header';
import { useTranslation } from '@client/src/i18n/useTranslation';
import * as auditApi from '@client/src/api/audit';

import type {
  AuditAction,
  AuditLog,
  AuditLogListParams,
} from '@shared/api.interface';

const AUDIT_ACTIONS: AuditAction[] = [
  'login',
  'login_failed',
  'login_denied',
  'logout',
  'resource_upload',
  'resource_download',
  'resource_download_denied',
  'resource_edit',
  'resource_submit_review',
  'resource_approve',
  'resource_reject',
  'permission_denied',
  'permission_change',
  'teacher_create',
  'teacher_update',
  'session_expired',
  'storybook_cover_view',
  'password_changed',
  'password_change_failed',
  'password_reset',
];

const ACTION_BADGE_COLORS: Record<AuditAction, string> = {
  login: 'bg-green-100 text-green-700 border-green-200',
  login_failed: 'bg-red-100 text-red-700 border-red-200',
  login_denied: 'bg-red-100 text-red-700 border-red-200',
  logout: 'bg-gray-100 text-gray-600 border-gray-200',
  resource_upload: 'bg-blue-100 text-blue-700 border-blue-200',
  resource_download: 'bg-purple-100 text-purple-700 border-purple-200',
  resource_download_denied: 'bg-red-100 text-red-700 border-red-200',
  resource_edit: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  resource_submit_review: 'bg-orange-100 text-orange-700 border-orange-200',
  resource_approve: 'bg-green-100 text-green-700 border-green-200',
  resource_reject: 'bg-red-100 text-red-700 border-red-200',
  permission_denied: 'bg-red-100 text-red-700 border-red-200',
  permission_change: 'bg-purple-100 text-purple-700 border-purple-200',
  teacher_create: 'bg-blue-100 text-blue-700 border-blue-200',
  teacher_update: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  session_expired: 'bg-orange-100 text-orange-700 border-orange-200',
  storybook_cover_view: 'bg-pink-100 text-pink-700 border-pink-200',
  password_changed: 'bg-teal-100 text-teal-700 border-teal-200',
  password_change_failed: 'bg-red-100 text-red-700 border-red-200',
  password_reset: 'bg-amber-100 text-amber-700 border-amber-200',
  // MFA (migration 0006). Positive second-factor events read teal; failures and
  // state removals read red/amber, so an operator scanning the log can tell a good
  // MFA event from a bad one at a glance.
  mfa_enrolled: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  mfa_enabled: 'bg-teal-100 text-teal-700 border-teal-200',
  mfa_disabled: 'bg-amber-100 text-amber-700 border-amber-200',
  mfa_reset: 'bg-amber-100 text-amber-700 border-amber-200',
  mfa_success: 'bg-teal-100 text-teal-700 border-teal-200',
  mfa_failed: 'bg-red-100 text-red-700 border-red-200',
  mfa_recovery_used: 'bg-orange-100 text-orange-700 border-orange-200',
  mfa_recovery_regenerated: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  mfa_challenge_issued: 'bg-blue-100 text-blue-700 border-blue-200',
};

const AuditLogPage: React.FC = () => {
  const { t, language } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);

  const [actionFilter, setActionFilter] = useState<string>('all');
  const [programFilter, setProgramFilter] = useState<string>('all');
  const [teacherIdFilter, setTeacherIdFilter] = useState('');
  const [teacherKeyword, setTeacherKeyword] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params: AuditLogListParams = {
        page,
        pageSize,
      };
      if (actionFilter !== 'all') params.action = actionFilter as AuditAction;
      if (programFilter !== 'all') params.program = programFilter;
      if (teacherIdFilter) params.teacherId = teacherIdFilter;
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;

      const resp = await auditApi.getAuditLogs(params);
      setItems(resp.items);
      setTotal(resp.total);
    } catch (err) {
      logger.error('[AuditLog] Failed to fetch logs', String(err));
      toast.error(t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, actionFilter, programFilter, teacherIdFilter, startDate, endDate, t]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  const handleReset = () => {
    setActionFilter('all');
    setProgramFilter('all');
    setTeacherIdFilter('');
    setTeacherKeyword('');
    setStartDate('');
    setEndDate('');
    setPage(1);
  };

  const formatTime = (dateStr: string): string => {
    return new Date(dateStr).toLocaleString(
      language === 'zh-CN' ? 'zh-CN' : 'en-US',
      {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      },
    );
  };

  const getResourceText = (log: AuditLog): string => {
    if (log.resourceTitle) return log.resourceTitle;
    if (log.subject) {
      const subjKey = `subject.${log.subject}`;
      // Try translation, fallback to subject
      try {
        return t(subjKey as never) || log.subject;
      } catch {
        return log.subject;
      }
    }
    if (log.program) return log.program.toUpperCase();
    return '-';
  };

  const columns: TableProps<AuditLog>['columns'] = [
    {
      title: t('audit.time'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      fixed: 'left',
      width: 180,
      render: (val: string) => (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatTime(val)}
        </span>
      ),
    },
    {
      title: t('audit.action'),
      dataIndex: 'action',
      key: 'action',
      width: 140,
      render: (action: AuditAction) => (
        <Badge
          variant="outline"
          className={`${ACTION_BADGE_COLORS[action]} border rounded-full`}
        >
          {t(`audit.action.${action}`)}
        </Badge>
      ),
    },
    {
      title: t('audit.teacher'),
      dataIndex: 'teacherName',
      key: 'teacherName',
      width: 120,
      render: (val: string) => val || '-',
    },
    {
      title: t('teacher.wecomUserId'),
      dataIndex: 'wecomUserId',
      key: 'wecomUserId',
      width: 140,
      className: 'font-mono text-xs',
      render: (val: string) => val || '-',
    },
    {
      title: t('audit.ip'),
      dataIndex: 'ipAddress',
      key: 'ipAddress',
      width: 130,
      className: 'font-mono text-xs',
      render: (val: string) => val || '-',
    },
    {
      title: t('audit.resource'),
      dataIndex: 'resourceTitle',
      key: 'resource',
      width: 200,
      render: (_val: string, record: AuditLog) => (
        <div className="max-w-[200px]">
          <span className="text-sm truncate block">{getResourceText(record)}</span>
          {record.program && (
            <span className="text-xs text-muted-foreground">
              {record.program.toUpperCase()}
            </span>
          )}
        </div>
      ),
    },
    {
      title: t('audit.success'),
      dataIndex: 'success',
      key: 'success',
      width: 80,
      align: 'center',
      render: (val: boolean) =>
        val ? (
          <span className="inline-flex items-center justify-center size-6 rounded-full bg-green-100 text-green-600">
            <Check className="size-4" />
          </span>
        ) : (
          <span className="inline-flex items-center justify-center size-6 rounded-full bg-red-100 text-red-600">
            <X className="size-4" />
          </span>
        ),
    },
    {
      title: t('audit.detail'),
      dataIndex: 'errorMessage',
      key: 'detail',
      width: 200,
      render: (_val: string, record: AuditLog) => (
        <div className="max-w-[200px]">
          {record.errorMessage ? (
            <span className="text-xs text-red-500">{record.errorMessage}</span>
          ) : record.detail ? (
            <span className="text-xs text-muted-foreground">{record.detail}</span>
          ) : (
            <span className="text-xs text-muted-foreground">-</span>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t('page.auditLog')}
        description={t('page.auditLogDesc')}
        actions={
          <Button variant="outline" disabled>
            <Download className="size-4" />
            {t('audit.export')}
          </Button>
        }
      />

      <Card className="border-border shadow-sm">
        <CardContent className="p-6">
          {/* Filters */}
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="w-[180px]">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t('audit.action')}
              </label>
              <Select
                value={actionFilter}
                onValueChange={(v) => {
                  setActionFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('audit.all')}</SelectItem>
                  {AUDIT_ACTIONS.map((action) => (
                    <SelectItem key={action} value={action}>
                      {t(`audit.action.${action}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="w-[140px]">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t('audit.program')}
              </label>
              <Select
                value={programFilter}
                onValueChange={(v) => {
                  setProgramFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('audit.all')}</SelectItem>
                  <SelectItem value="prek">Pre-K</SelectItem>
                  <SelectItem value="k">K</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="w-[220px]">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t('audit.teacher')}
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  value={teacherKeyword}
                  onChange={(e) => setTeacherKeyword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setTeacherIdFilter(teacherKeyword.trim());
                      setPage(1);
                    }
                  }}
                  placeholder={t('teacher.searchPlaceholder')}
                  className="pl-9"
                />
              </div>
            </div>

            <div className="w-[160px]">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t('audit.startDate')}
              </label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setPage(1);
                }}
              />
            </div>

            <div className="w-[160px]">
              <label className="text-xs font-medium text-muted-foreground mb-1 block">
                {t('audit.endDate')}
              </label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setPage(1);
                }}
              />
            </div>

            <Button variant="outline" onClick={handleReset}>
              {t('btn.reset')}
            </Button>
          </div>

          <Table
            rowKey="id"
            columns={columns}
            dataSource={items}
            loading={loading}
            scroll={{ x: 1200, y: 500 }}
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
    </div>
  );
};

export default AuditLogPage;
