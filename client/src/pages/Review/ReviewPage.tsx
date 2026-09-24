import React, { useCallback, useEffect, useState } from 'react';

import { logger } from '@lark-apaas/client-toolkit/logger';
import { Table, type TableProps } from '@lark-apaas/client-toolkit/antd-table';
import { Check, History, RotateCcw, X, Eye } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent } from '@client/src/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { PageHeader } from '@client/src/components/ui/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import { Textarea } from '@client/src/components/ui/textarea';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { getResources } from '@client/src/api/resources';
import { getReviewHistory, reviewResource } from '@client/src/api/review';
import type { Resource, ResourceStatus, ReviewRecord } from '@shared/api.interface';

type TabKey = 'pending' | 'published' | 'rejected';

const TAB_MAP: Record<TabKey, ResourceStatus> = {
  pending: 'pending_review',
  published: 'published',
  rejected: 'rejected',
};

const ReviewPage: React.FC = () => {
  const { t, language } = useTranslation();
  const L = (zh: string, en: string) => (language === 'zh-CN' ? zh : en);

  const [activeTab, setActiveTab] = useState<TabKey>('pending');
  const [data, setData] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [total, setTotal] = useState(0);

  // Review dialogs
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [currentResource, setCurrentResource] = useState<Resource | null>(null);
  const [reviewComment, setReviewComment] = useState('');
  const [reviewLoading, setReviewLoading] = useState(false);
  const [historyRecords, setHistoryRecords] = useState<ReviewRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const status = TAB_MAP[activeTab];
      const resp = await getResources({ status, page, pageSize });
      setData(resp.items);
      setTotal(resp.total);
    } catch (error) {
      logger.error('[Review] fetch failed', String(error));
      toast.error(t('common.failed'));
    } finally {
      setLoading(false);
    }
  }, [activeTab, page, pageSize, t]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleTabChange = (val: string) => {
    setActiveTab(val as TabKey);
    setPage(1);
  };

  const openApprove = (r: Resource) => {
    setCurrentResource(r);
    setReviewComment('');
    setApproveOpen(true);
  };

  const openReject = (r: Resource) => {
    setCurrentResource(r);
    setReviewComment('');
    setRejectOpen(true);
  };

  const openDetail = (r: Resource) => {
    setCurrentResource(r);
    setDetailOpen(true);
  };

  const openHistory = async (r: Resource) => {
    setCurrentResource(r);
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const records = await getReviewHistory(r.id);
      setHistoryRecords(records);
    } catch (error) {
      logger.error('[Review] history failed', String(error));
      toast.error(t('common.failed'));
    } finally {
      setHistoryLoading(false);
    }
  };

  const doReview = async (action: 'approve' | 'reject') => {
    if (!currentResource) return;
    if (action === 'reject' && !reviewComment.trim()) {
      toast.error(L('请填写退回原因', 'Please provide rejection reason'));
      return;
    }
    setReviewLoading(true);
    try {
      await reviewResource(currentResource.id, action, reviewComment.trim() || undefined);
      toast.success(
        action === 'approve'
          ? L('已通过审核', 'Approved successfully')
          : L('已退回', 'Rejected successfully'),
      );
      setApproveOpen(false);
      setRejectOpen(false);
      void fetchData();
    } catch (error) {
      logger.error('[Review] action failed', String(error));
      toast.error(t('common.failed'));
    } finally {
      setReviewLoading(false);
    }
  };

  const handleRevoke = async (r: Resource) => {
    // Revoke published resource back to draft
    try {
      await reviewResource(r.id, 'reject', L('审核撤回', 'Revoked by reviewer'));
      toast.success(L('已撤回', 'Revoked successfully'));
      void fetchData();
    } catch (error) {
      logger.error('[Review] revoke failed', String(error));
      toast.error(t('common.failed'));
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

  const pendingColumns: TableProps<Resource>['columns'] = [
    {
      title: L('标题', 'Title'), dataIndex: 'title', fixed: 'left', width: 240,
      render: (_: unknown, record: Resource) => (
        <div className="font-medium text-foreground">{record.title}</div>
      ),
    },
    {
      title: L('班型/科目', 'Program/Subject'), key: 'ps', width: 160,
      render: (_: unknown, record: Resource) => (
        <div className="text-sm">
          <div className="font-medium text-foreground">{record.program.toUpperCase()}</div>
          <div className="text-muted-foreground">{record.subject}</div>
        </div>
      ),
    },
    {
      title: L('资料夹', 'Folder'), dataIndex: 'folderType', width: 160,
      render: (val: string) => t(`folder.${val}` as never),
    },
    {
      title: L('上传者', 'Uploader'), dataIndex: 'uploaderName', width: 120,
    },
    {
      title: L('提交时间', 'Submitted At'), dataIndex: 'createdAt', width: 170,
      render: (val: string) => new Date(val).toLocaleString(language),
    },
    {
      title: t('common.operation'), key: 'action', fixed: 'right', width: 200,
      render: (_: unknown, record: Resource) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => openApprove(record)} className="text-success">
            <Check className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openReject(record)} className="text-destructive">
            <X className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => openDetail(record)}>
            <Eye className="size-4" />
          </Button>
        </div>
      ),
    },
  ];

  const historyColumns: TableProps<Resource>['columns'] = [
    {
      title: L('标题', 'Title'), dataIndex: 'title', fixed: 'left', width: 240,
      render: (_: unknown, record: Resource) => (
        <div className="font-medium text-foreground">{record.title}</div>
      ),
    },
    {
      title: L('班型/科目', 'Program/Subject'), key: 'ps', width: 160,
      render: (_: unknown, record: Resource) => (
        <div className="text-sm">
          <div className="font-medium text-foreground">{record.program.toUpperCase()}</div>
          <div className="text-muted-foreground">{record.subject}</div>
        </div>
      ),
    },
    {
      title: L('资料夹', 'Folder'), dataIndex: 'folderType', width: 160,
      render: (val: string) => t(`folder.${val}` as never),
    },
    {
      title: L('上传者', 'Uploader'), dataIndex: 'uploaderName', width: 120,
    },
    {
      title: L('状态', 'Status'), dataIndex: 'status', width: 110,
      render: (status: ResourceStatus) => (
        <Badge className={`rounded-full border ${statusColor(status)}`}>
          {t(`status.${status}` as never)}
        </Badge>
      ),
    },
    {
      title: t('common.operation'), key: 'action', fixed: 'right', width: 180,
      render: (_: unknown, record: Resource) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => openDetail(record)}>
            <Eye className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void openHistory(record)}>
            <History className="size-4" />
          </Button>
          {record.status === 'published' && (
            <Button variant="ghost" size="sm" onClick={() => handleRevoke(record)} title={L('撤回', 'Revoke')}>
              <RotateCcw className="size-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  const tabs: { key: TabKey; zh: string; en: string }[] = [
    { key: 'pending', zh: '待审核', en: 'Pending Review' },
    { key: 'published', zh: '已发布', en: 'Published' },
    { key: 'rejected', zh: '已退回', en: 'Rejected' },
  ];

  const currentColumns = activeTab === 'pending' ? pendingColumns : historyColumns;

  return (
    <div>
      <PageHeader title={t('page.review')} description={t('page.reviewDesc')} />
      <Card className="border-border shadow-sm">
        <CardContent className="p-6">
          <Tabs value={activeTab} onValueChange={handleTabChange}>
            <TabsList className="mb-4">
              {tabs.map((tab) => (
                <TabsTrigger key={tab.key} value={tab.key}>
                  {language === 'zh-CN' ? tab.zh : tab.en}
                </TabsTrigger>
              ))}
            </TabsList>
            {tabs.map((tab) => (
              <TabsContent key={tab.key} value={tab.key}>
                <Table<Resource>
                  columns={currentColumns}
                  dataSource={data}
                  loading={loading}
                  rowKey="id"
                  scroll={{ x: 1050, y: 500 }}
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

      {/* Approve Dialog */}
      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{L('通过审核', 'Approve Review')}</DialogTitle>
            <DialogDescription>
              {L('确认通过该资源的审核？可填写审核意见。', 'Confirm approval? You may add an optional comment.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="text-sm font-medium text-foreground">
              {L('审核意见（可选）', 'Comment (optional)')}
            </label>
            <Textarea
              rows={3}
              value={reviewComment}
              onChange={(e) => setReviewComment(e.target.value)}
              placeholder={L('请输入审核意见', 'Enter review comment')}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveOpen(false)} disabled={reviewLoading}>
              {t('btn.cancel')}
            </Button>
            <Button
              className="bg-success hover:bg-success/90"
              onClick={() => doReview('approve')}
              disabled={reviewLoading}
            >
              <Check className="size-4" />
              {t('btn.approve')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{L('退回资源', 'Reject Resource')}</DialogTitle>
            <DialogDescription>
              {L('请填写退回原因，以便上传者了解修改方向。', 'Please provide a reason for rejection.')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="text-sm font-medium text-foreground">
              {L('退回原因', 'Rejection reason')}
              <span className="text-destructive">*</span>
            </label>
            <Textarea
              rows={4}
              value={reviewComment}
              onChange={(e) => setReviewComment(e.target.value)}
              placeholder={L('请输入退回原因', 'Enter rejection reason')}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)} disabled={reviewLoading}>
              {t('btn.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => doReview('reject')}
              disabled={reviewLoading}
            >
              <X className="size-4" />
              {t('btn.reject')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail Dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{L('资源详情', 'Resource Detail')}</DialogTitle>
          </DialogHeader>
          {currentResource && (
            <div className="space-y-4 text-sm">
              <div>
                <div className="font-medium text-foreground">{currentResource.title}</div>
                {currentResource.titleEn && (
                  <div className="text-muted-foreground">{currentResource.titleEn}</div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <DetailItem label={L('班型', 'Program')} value={currentResource.program.toUpperCase()} />
                <DetailItem label={L('科目', 'Subject')} value={currentResource.subject} />
                <DetailItem label={L('资料夹', 'Folder')} value={t(`folder.${currentResource.folderType}` as never)} />
                <DetailItem label={L('版本', 'Version')} value={`v${currentResource.version}`} />
                {currentResource.semester && (
                  <DetailItem label={L('学期', 'Semester')} value={t(`semester.${currentResource.semester.toLowerCase()}` as never)} />
                )}
                {currentResource.weekNumber && (
                  <DetailItem label={L('周次', 'Week')} value={`${currentResource.weekNumber}`} />
                )}
                <DetailItem label={L('上传者', 'Uploader')} value={currentResource.uploaderName} />
                <DetailItem label={t('common.status')} value={t(`status.${currentResource.status}` as never)} />
              </div>
              {currentResource.description && (
                <DetailItem label={t('common.description')} value={currentResource.description} />
              )}
              {currentResource.reviewComment && (
                <DetailItem label={L('审核意见', 'Review Comment')} value={currentResource.reviewComment} />
              )}
              {currentResource.fileName && (
                <DetailItem label={L('文件', 'File')} value={currentResource.fileName} />
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailOpen(false)}>
              {t('btn.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{L('审核历史', 'Review History')}</DialogTitle>
          </DialogHeader>
          <div className="max-h-[400px] space-y-3 overflow-y-auto">
            {historyLoading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t('common.loading')}
              </p>
            ) : historyRecords.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t('common.noData')}
              </p>
            ) : (
              historyRecords.map((record) => (
                <div
                  key={record.id}
                  className="rounded-lg border border-border p-3"
                >
                  <div className="flex items-center justify-between">
                    <Badge
                      className={`rounded-full border ${
                        record.action === 'approve'
                          ? 'bg-success/15 text-[#4a8a6e] border-success/30'
                          : 'bg-destructive/15 text-destructive border-destructive/30'
                      }`}
                    >
                      {record.action === 'approve' ? t('btn.approve') : t('btn.reject')}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {new Date(record.createdAt).toLocaleString(language)}
                    </span>
                  </div>
                  <div className="mt-2 text-sm text-foreground">
                    {record.reviewerName}
                  </div>
                  {record.comment && (
                    <div className="mt-1 text-sm text-muted-foreground">
                      {record.comment}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryOpen(false)}>
              {t('btn.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const DetailItem: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="text-xs text-muted-foreground">{label}</div>
    <div className="mt-0.5 text-sm text-foreground">{value}</div>
  </div>
);

export default ReviewPage;
