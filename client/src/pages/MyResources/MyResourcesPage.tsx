import React, { useCallback, useEffect, useState } from 'react';

import { logger } from '@client/src/lib/logger';
import { Table, type TableProps } from 'antd';
import { Eye, Pencil, Send, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent } from '@client/src/components/ui/card';
import { ConfirmDialog } from '@client/src/components/ui/confirm-dialog';
import { PageHeader } from '@client/src/components/ui/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { deleteResource, getMyResources, submitReview } from '@client/src/api/resources';
import type { Resource, ResourceStatus } from '@shared/api.interface';
import { readListResponse } from '@client/src/api/client';

const STATUS_TABS: { key: ResourceStatus | 'all'; zh: string; en: string }[] = [
  { key: 'all', zh: '全部', en: 'All' },
  { key: 'draft', zh: '草稿', en: 'Draft' },
  { key: 'pending_review', zh: '待审核', en: 'Pending Review' },
  { key: 'published', zh: '已发布', en: 'Published' },
  { key: 'rejected', zh: '退回', en: 'Rejected' },
];

const statusVariant = (status: ResourceStatus) => {
  switch (status) {
    case 'draft': return 'secondary';
    case 'pending_review': return 'default';
    case 'published': return 'default';
    case 'rejected': return 'destructive';
  }
};

const statusColor = (status: ResourceStatus): string => {
  switch (status) {
    case 'draft': return 'bg-secondary text-secondary-foreground';
    case 'pending_review': return 'bg-primary/15 text-primary-dark border-primary/20';
    case 'published': return 'bg-success/15 text-[#4a8a6e] border-success/30';
    case 'rejected': return 'bg-destructive/15 text-destructive border-destructive/30';
  }
};

interface MyResourcesPageProps {
  // no props
}

const MyResourcesPage: React.FC<MyResourcesPageProps> = () => {
  const { t, language } = useTranslation();
  const navigate = useNavigate();
  const L = (zh: string, en: string) => (language === 'zh-CN' ? zh : en);

  const [activeTab, setActiveTab] = useState<ResourceStatus | 'all'>('all');
  const [data, setData] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [submitId, setSubmitId] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await getMyResources({
        status: activeTab === 'all' ? undefined : activeTab,
        page,
        pageSize,
      });
      const listResult = readListResponse<Resource>(resp, 'resources.list(mine)');
      setData(listResult.items);
      setTotal(listResult.total);
    } catch (error) {
      logger.error('[MyResources] fetch failed', String(error));
      toast.error(t('common.failed'));
    } finally {
      setLoading(false);
    }
  }, [activeTab, page, pageSize, t]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleTabChange = (val: string) => {
    setActiveTab(val as ResourceStatus | 'all');
    setPage(1);
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteResource(deleteId);
      toast.success(L('删除成功', 'Deleted successfully'));
      setDeleteId(null);
      void fetchData();
    } catch (error) {
      logger.error('[MyResources] delete failed', String(error));
      toast.error(t('common.failed'));
    }
  };

  const handleSubmitReview = async () => {
    if (!submitId) return;
    try {
      await submitReview(submitId);
      toast.success(L('已提交审核', 'Submitted for review'));
      setSubmitId(null);
      void fetchData();
    } catch (error) {
      logger.error('[MyResources] submit review failed', String(error));
      toast.error(t('common.failed'));
    }
  };

  const canEdit = (status: ResourceStatus) =>
    status === 'draft' || status === 'rejected';
  const canSubmit = (status: ResourceStatus) =>
    status === 'draft' || status === 'rejected';

  const columns: TableProps<Resource>['columns'] = [
    {
      title: L('标题', 'Title'),
      dataIndex: 'title',
      fixed: 'left',
      width: 240,
      render: (_: unknown, record: Resource) => (
        <div className="font-medium text-foreground">{record.title}</div>
      ),
    },
    {
      title: L('班型/科目', 'Program/Subject'),
      key: 'programSubject',
      width: 180,
      render: (_: unknown, record: Resource) => (
        <div className="text-sm">
          <div className="font-medium text-foreground">
            {record.program.toUpperCase()}
          </div>
          <div className="text-muted-foreground">{record.subject}</div>
        </div>
      ),
    },
    {
      title: L('资料夹', 'Folder'),
      dataIndex: 'folderType',
      width: 160,
      render: (val: string) => t(`folder.${val}` as never),
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 110,
      render: (status: ResourceStatus) => (
        <Badge
          variant={statusVariant(status) as never}
          className={`rounded-full ${statusColor(status)} border`}
        >
          {t(`status.${status}` as never)}
        </Badge>
      ),
    },
    {
      title: L('版本', 'Version'),
      dataIndex: 'version',
      width: 80,
      render: (v: number) => `v${v}`,
    },
    {
      title: L('上传时间', 'Uploaded At'),
      dataIndex: 'createdAt',
      width: 170,
      render: (val: string) => new Date(val).toLocaleString(language),
    },
    {
      title: t('common.operation'),
      key: 'action',
      fixed: 'right',
      width: 220,
      render: (_: unknown, record: Resource) => (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/upload?id=${record.id}`)}
            disabled={!canEdit(record.status)}
            title={L('编辑', 'Edit')}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSubmitId(record.id)}
            disabled={!canSubmit(record.status)}
            title={t('btn.submitReview')}
          >
            <Send className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // View detail - open in new tab for now
              logger.info('[MyResources] view resource', record.id);
              toast.info(L('详情功能开发中', 'Detail view coming soon'));
            }}
            title={t('btn.view')}
          >
            <Eye className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDeleteId(record.id)}
            className="text-destructive hover:text-destructive"
            title={t('btn.delete')}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title={t('page.myResources')} description={t('page.myResourcesDesc')} />
      <Card className="border-border shadow-sm">
        <CardContent className="p-6">
          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList className="mb-4">
              {STATUS_TABS.map((tab) => (
                <TabsTrigger key={tab.key} value={tab.key}>
                  {language === 'zh-CN' ? tab.zh : tab.en}
                </TabsTrigger>
              ))}
            </TabsList>
            {STATUS_TABS.map((tab) => (
              <TabsContent key={tab.key} value={tab.key}>
                <Table<Resource>
                  columns={columns}
                  dataSource={data}
                  loading={loading}
                  rowKey="id"
                  scroll={{ x: 1100, y: 500 }}
                  pagination={{
                    current: page,
                    pageSize,
                    total,
                    showSizeChanger: true,
                    showTotal: (totalNum) =>
                      `${t('common.total')} ${totalNum} ${t('common.items')}`,
                    onChange: (p, ps) => {
                      setPage(p);
                      setPageSize(ps);
                    },
                  }}
                />
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title={L('确认删除', 'Confirm Delete')}
        description={L('删除后无法恢复，确定要删除该资源吗？', 'This action cannot be undone. Delete this resource?')}
        confirmText={t('btn.delete')}
        confirmVariant="destructive"
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={!!submitId}
        onOpenChange={(open) => !open && setSubmitId(null)}
        title={L('提交审核', 'Submit for Review')}
        description={L('确认提交该资源进入审核流程？', 'Confirm submitting this resource for review?')}
        confirmText={t('btn.submitReview')}
        onConfirm={handleSubmitReview}
      />
    </div>
  );
};

export default MyResourcesPage;
