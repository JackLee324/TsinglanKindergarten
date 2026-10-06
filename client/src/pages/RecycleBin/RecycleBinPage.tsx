import React, { useCallback, useEffect, useState } from 'react';

import { Table, type TableProps } from 'antd';
import { RotateCcw } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent } from '@client/src/components/ui/card';
import { ConfirmDialog } from '@client/src/components/ui/confirm-dialog';
import { PageHeader } from '@client/src/components/ui/page-header';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { logger } from '@client/src/lib/logger';
import { getRecycleBin, restoreResource } from '@client/src/api/resources';
import type { Resource } from '@shared/api.interface';

/**
 * 回收站（§回收站 / §7）。
 *
 * 为什么需要这个页面：资源删除是**软删除**（migration 0007），行还在、只是
 * `deleted_at` 非空。后端一直提供 `GET /api/resources/recycle-bin` 与
 * `POST /api/resources/:id/restore`，但**前端从未调用过它们** ——
 * 也就是说老师误删之后，界面上无路可走，只能由管理员直接打接口。
 *
 * 这是管理员能力：服务端在这两个路由上要求 `resource.restore`
 * （principal / curriculum_director / super_admin 默认持有），
 * 所以侧边栏入口与路由守卫都按**同一个权限码**判断，而不是另抄一份角色数组。
 */
const RecycleBinPage: React.FC = () => {
  const { t, language } = useTranslation();
  const L = (zh: string, en: string) => (language === 'zh-CN' ? zh : en);

  const [items, setItems] = useState<Resource[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await getRecycleBin({ page, pageSize });
      setItems(resp.items ?? []);
      setTotal(resp.total ?? 0);
    } catch (error) {
      logger.error('[RecycleBin] load failed', String(error));
      toast.error(t('common.failed'));
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleRestore = async () => {
    if (!restoreId) return;
    setRestoring(true);
    try {
      await restoreResource(restoreId);
      toast.success(L('已恢复', 'Restored'));
      setRestoreId(null);
      await load();
    } catch (error) {
      logger.error('[RecycleBin] restore failed', String(error));
      toast.error(t('common.failed'));
    } finally {
      setRestoring(false);
    }
  };

  const columns: TableProps<Resource>['columns'] = [
    {
      title: L('标题', 'Title'),
      dataIndex: 'title',
      key: 'title',
      render: (_: unknown, record: Resource) => (
        <div>
          <p className="font-medium">{record.title}</p>
          {record.titleEn ? (
            <p className="text-xs text-muted-foreground">{record.titleEn}</p>
          ) : null}
        </div>
      ),
    },
    {
      title: L('班型', 'Program'),
      dataIndex: 'program',
      key: 'program',
      width: 120,
      render: (value: string) => <Badge variant="outline">{value}</Badge>,
    },
    {
      title: L('科目', 'Subject'),
      dataIndex: 'subject',
      key: 'subject',
      width: 160,
    },
    {
      title: L('资料夹（legacy）', 'Folder (legacy)'),
      dataIndex: 'folderType',
      key: 'folderType',
      width: 160,
      // 直接显示**原始值**而不是翻译后的名字：这个页面是给管理员排查用的，
      // 显示库里真正存的东西比显示一个好听的标签更有用。
      render: (value: string) => <span className="text-xs">{value}</span>,
    },
    {
      title: t('common.operation'),
      key: 'action',
      fixed: 'right',
      width: 140,
      render: (_: unknown, record: Resource) => (
        <Button
          variant="outline"
          size="sm"
          data-testid="recycle-restore"
          onClick={() => setRestoreId(record.id)}
        >
          <RotateCcw className="size-4" />
          {L('恢复', 'Restore')}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={L('回收站', 'Recycle Bin')}
        description={L(
          '这里列出已删除的资源。恢复后它会回到原来的位置；到期未处理的会被自动清理。',
          'Deleted resources appear here. Restoring returns them to where they were; expired ones are purged automatically.',
        )}
      />
      <Card className="border-border shadow-sm">
        <CardContent className="p-6">
          <Table<Resource>
            rowKey="id"
            columns={columns}
            dataSource={items}
            loading={loading}
            scroll={{ x: 'max-content' }}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              onChange: (nextPage: number, nextSize: number) => {
                setPage(nextPage);
                setPageSize(nextSize);
              },
            }}
            locale={{
              emptyText: loading ? t('common.loading') : L('回收站是空的', 'The recycle bin is empty'),
            }}
          />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!restoreId}
        onOpenChange={(open) => !open && setRestoreId(null)}
        title={L('恢复资源', 'Restore Resource')}
        description={L(
          '确认把这条资源从回收站恢复？它会重新出现在原来的列表里。',
          'Restore this resource from the recycle bin? It will reappear in its original list.',
        )}
        confirmText={L('恢复', 'Restore')}
        onConfirm={handleRestore}
        testId="confirm-restore"
      />
      {restoring ? <span className="sr-only">{t('common.loading')}</span> : null}
    </div>
  );
};

export default RecycleBinPage;
