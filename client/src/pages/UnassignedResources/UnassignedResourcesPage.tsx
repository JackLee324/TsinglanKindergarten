import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';

import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent } from '@client/src/components/ui/card';
import { PageHeader } from '@client/src/components/ui/page-header';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { assignResourcesToDirectory, listUnderFiledResources } from '@client/src/api/resources';
import { useDirectory } from '@client/src/directory/DirectoryProvider';
import type { UnderFiledListResponse, UnderFiledResource } from '@shared/api.interface';

/**
 * §8 待补齐目录归属（管理员）。
 *
 * WHY THIS PAGE EXISTS
 * --------------------
 * §9 的迁移报告实测出两件事，而这个页面就是它们的**出口**：
 *   · **1 条**资源完全没有目录归属（`directory_id IS NULL`）；
 *   · **348 条**资源挂在科目/子科节点上，而 PDF 规定资源要落在四个资料夹之下。
 *
 * 报告本身只报告、不改数据（§9 明令）；而"新建资源必须有 directoryId"这条规则
 * 只保证**不再产生新的**这类行，它对既有的 349 条一行都不管。
 * 于是必须有一个让人**看得见、点得动**的地方 —— 否则那 349 条会永远停在
 * "有归属但精确不到资料夹"，而界面上任何地方都不会提示。
 *
 * 两个关键设计：
 *   1. `reason` 区分两种债。界面把它们分开说明，因为**修法不同**：
 *      完全未归属要"选一个目录"，只到科目层要"下到资料夹"。
 *   2. `counts` 来自服务端而不是当前页 —— 页面上那句"共 N 条"必须是真的。
 */
const PAGE_SIZE = 20;

const UnassignedResourcesPage: React.FC = () => {
  const { t, language } = useTranslation();
  const { flatten, loading: directoryLoading } = useDirectory();

  const [mode, setMode] = useState<'all' | 'unassigned' | 'subject_level'>('all');
  const [page, setPage] = useState<number>(1);
  const [data, setData] = useState<UnderFiledListResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [targetDirectoryId, setTargetDirectoryId] = useState<string>('');
  const [syncLegacy, setSyncLegacy] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const resp = await listUnderFiledResources({ mode, page, pageSize: PAGE_SIZE });
      setData(resp);
      // 换页/换筛选后清空勾选：留着一批看不见的选中项，
      // 下一次点"归档"会把它们一起改掉 —— 那是事故，不是功能。
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [mode, page]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [mode]);

  /** 归档目标候选：只有资料夹叶节点，与服务端 `requireLeafFolder` 同口径。 */
  const folderOptions = useMemo(
    () => flatten().filter((node) => node.type === 'folder'),
    [flatten],
  );

  const items: UnderFiledResource[] = data?.items ?? [];
  const totalPages = data === null ? 1 : Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  const toggleOne = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllOnPage = (): void => {
    setSelected((prev) => {
      const allSelected = items.length > 0 && items.every((item) => prev.has(item.id));
      const next = new Set(prev);
      for (const item of items) {
        if (allSelected) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    setNotice(null);
    if (targetDirectoryId === '') {
      setNotice({
        kind: 'err',
        text: language === 'zh-CN' ? '请先选择目标资料夹' : 'Please choose a target folder first',
      });
      return;
    }
    if (selected.size === 0) {
      setNotice({
        kind: 'err',
        text: language === 'zh-CN' ? '请先勾选要归档的资源' : 'Please select resources to file',
      });
      return;
    }
    setBusy(true);
    try {
      const result = await assignResourcesToDirectory({
        resourceIds: [...selected],
        directoryId: targetDirectoryId,
        syncLegacyFolderType: syncLegacy,
      });
      setNotice({
        kind: 'ok',
        text: t('underFiled.assigned')
          .replace('{count}', String(result.assigned))
          .replace('{code}', result.directoryCode)
          .replace('{legacy}', String(result.folderTypeUpdates)),
      });
      setSelected(new Set());
      setTargetDirectoryId('');
      await load();
    } catch (err) {
      // 服务端要么全成功要么一条都不动，所以这里可以如实说"没有改动"。
      setNotice({
        kind: 'err',
        text:
          (language === 'zh-CN' ? '归档失败（未做任何改动）：' : 'Filing failed (nothing changed): ') +
          (err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="under-filed-page">
      <PageHeader title={t('underFiled.title')} description={t('underFiled.desc')} />

      {/* 两种债分开说明。把它们并成一句话，管理员会按错误的方式去修。 */}
      <Card className="mb-6 border-border shadow-sm">
        <CardContent className="p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div data-testid="under-filed-count-unassigned">
              <p className="text-sm text-muted-foreground">{t('underFiled.reasonUnassigned')}</p>
              <p className="mt-1 text-2xl font-semibold text-[#2D2A3E]">
                {data?.counts.unassigned ?? '—'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t('underFiled.reasonUnassignedHint')}</p>
            </div>
            <div data-testid="under-filed-count-subject">
              <p className="text-sm text-muted-foreground">{t('underFiled.reasonSubjectLevel')}</p>
              <p className="mt-1 text-2xl font-semibold text-[#2D2A3E]">
                {data?.counts.subjectLevel ?? '—'}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t('underFiled.reasonSubjectLevelHint')}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={mode} onValueChange={(v: string) => setMode(v as typeof mode)}>
          <SelectTrigger className="w-56" size="sm" data-testid="under-filed-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('underFiled.modeAll')}</SelectItem>
            <SelectItem value="unassigned">{t('underFiled.modeUnassigned')}</SelectItem>
            <SelectItem value="subject_level">{t('underFiled.modeSubjectLevel')}</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => void load()} data-testid="under-filed-refresh">
          <RefreshCw className="size-4" />
          {t('common.refresh')}
        </Button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="size-5 animate-spin text-primary" />
          <span className="text-sm">{t('common.loading')}</span>
        </div>
      )}

      {!loading && error !== null && (
        <div
          className="rounded-xl border border-[#D98B8B] bg-[#FFF7F7] p-4"
          data-testid="under-filed-error"
        >
          <p className="text-sm text-[#2D2A3E]">{t('underFiled.loadFailed')}</p>
          <p className="mt-1 break-all text-xs text-muted-foreground">{error}</p>
        </div>
      )}

      {!loading && error === null && data !== null && data.total === 0 && (
        <div className="rounded-lg border border-dashed border-border p-12 text-center" data-testid="under-filed-empty">
          <p className="text-base font-medium text-foreground">{t('underFiled.empty')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('underFiled.emptyDesc')}</p>
        </div>
      )}

      {!loading && error === null && data !== null && data.total > 0 && (
        <>
          {/* 批量操作条 */}
          <Card className="mb-4 border-border shadow-sm">
            <CardContent className="flex flex-wrap items-center gap-3 p-4">
              <span className="text-sm text-[#6B6878]">
                {t('underFiled.selectedCount').replace('{count}', String(selected.size))}
              </span>
              <Select
                value={targetDirectoryId}
                onValueChange={setTargetDirectoryId}
                disabled={directoryLoading || folderOptions.length === 0}
              >
                <SelectTrigger className="w-80" size="sm" data-testid="under-filed-target">
                  <SelectValue placeholder={t('underFiled.targetPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {folderOptions.map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {node.name}（{node.code}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label className="flex items-center gap-2 text-sm text-[#6B6878]">
                <input
                  type="checkbox"
                  checked={syncLegacy}
                  onChange={(e) => setSyncLegacy(e.target.checked)}
                  data-testid="under-filed-sync-legacy"
                />
                {t('underFiled.syncLegacy')}
              </label>
              <Button
                size="sm"
                onClick={() => void submit()}
                disabled={busy || selected.size === 0 || targetDirectoryId === ''}
                data-testid="under-filed-submit"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('underFiled.submit')}
              </Button>
            </CardContent>
          </Card>

          {notice !== null && (
            <div
              className={`mb-4 rounded-lg border p-3 text-sm ${
                notice.kind === 'ok'
                  ? 'border-[#7CB69C] bg-[#F4FBF7] text-[#2D2A3E]'
                  : 'border-[#D98B8B] bg-[#FFF7F7] text-[#2D2A3E]'
              }`}
              data-testid={`under-filed-notice-${notice.kind}`}
            >
              {notice.text}
            </div>
          )}

          <Card className="border-border shadow-sm">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-[#FAF8FF] text-left">
                    <tr>
                      <th className="p-3">
                        <input
                          type="checkbox"
                          checked={items.length > 0 && items.every((i) => selected.has(i.id))}
                          onChange={toggleAllOnPage}
                          data-testid="under-filed-select-all"
                          aria-label={t('underFiled.selectAll')}
                        />
                      </th>
                      <th className="p-3">{t('underFiled.colTitle')}</th>
                      <th className="p-3">{t('underFiled.colSubject')}</th>
                      <th className="p-3">{t('underFiled.colCurrent')}</th>
                      <th className="p-3">{t('underFiled.colReason')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id} className="border-b border-border last:border-0" data-testid="under-filed-row">
                        <td className="p-3 align-top">
                          <input
                            type="checkbox"
                            checked={selected.has(item.id)}
                            onChange={() => toggleOne(item.id)}
                            data-testid="under-filed-row-check"
                            aria-label={item.title}
                          />
                        </td>
                        <td className="p-3 align-top">
                          <p className="font-medium text-[#2D2A3E]">{item.title}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {item.status} · {item.folderType}
                          </p>
                        </td>
                        <td className="p-3 align-top text-[#6B6878]">
                          {item.program}
                          {item.subject ? ` / ${item.subject}` : ''}
                          {item.subSubject ? ` / ${item.subSubject}` : ''}
                        </td>
                        <td className="p-3 align-top text-[#6B6878]">
                          {item.directoryCode === null ? (
                            <span className="text-[#D98B8B]">{t('underFiled.none')}</span>
                          ) : (
                            <>
                              {item.directoryName}
                              <span className="ml-1 text-xs">（{item.directoryCode}）</span>
                            </>
                          )}
                        </td>
                        <td className="p-3 align-top">
                          <Badge variant={item.reason === 'unassigned' ? 'destructive' : 'secondary'}>
                            {item.reason === 'unassigned'
                              ? t('underFiled.reasonUnassignedShort')
                              : t('underFiled.reasonSubjectLevelShort')}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <div className="mt-4 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {t('underFiled.pageOf')
                .replace('{page}', String(page))
                .replace('{pages}', String(totalPages))
                .replace('{total}', String(data.total))}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                data-testid="under-filed-prev"
              >
                {t('underFiled.prev')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                data-testid="under-filed-next"
              >
                {t('underFiled.next')}
              </Button>
            </div>
          </div>
        </>
      )}

      <div className="mt-8 flex items-start gap-2 rounded-lg border border-border bg-[#FAF8FF] p-3 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <p>{t('underFiled.footnote')}</p>
      </div>
    </div>
  );
};

export default UnassignedResourcesPage;
