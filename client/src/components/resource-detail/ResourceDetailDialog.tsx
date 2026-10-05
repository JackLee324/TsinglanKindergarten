import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, X } from 'lucide-react';

import { resources as resourcesApi } from '../../api';
import { useTranslation } from '../../i18n/useTranslation';
import type { TranslationKey } from '../../i18n/translations';
import type { Resource, ResourceStatus, ResourceVersion } from '@shared/api.interface';

/**
 * 资源详情（§14）。
 *
 * 替换的是 `MyResourcesPage` 里的一句 `toast.info('详情功能开发中')` ——
 * 界面上有一个"查看"按钮，点下去只弹一句话。那是最典型的假成功：
 * 按钮存在、有反馈、但没有任何功能。§22/§27 要求把它清掉。
 *
 * 这里的数据**全部来自 `GET /api/resources/:id`**，没有任何前端拼装的字段：
 * 后端不返回的（例如审核意见），就显示"未填写"，而不是编一个看起来合理的值。
 */
export function ResourceDetailDialog({
  resourceId,
  onClose,
}: {
  resourceId: string | null;
  onClose: () => void;
}) {
  const { t, language } = useTranslation();
  const [resource, setResource] = useState<Resource | null>(null);
  // §15 版本历史。与详情分开取：历史取不到不应该让详情也打不开。
  const [versions, setVersions] = useState<ResourceVersion[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (resourceId === null) {
      setResource(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setResource(null);
    setVersions(null);
    setVersionsError(null);
    resourcesApi
      .getResourceVersions(resourceId)
      .then((list) => { if (!cancelled) setVersions(list); })
      .catch((e: unknown) => {
        if (!cancelled) setVersionsError(e instanceof Error ? e.message : String(e));
      });
    resourcesApi
      .getResource(resourceId)
      .then((data) => {
        if (!cancelled) setResource(data);
      })
      .catch((e: unknown) => {
        // 失败要如实显示。这里不 catch-and-ignore：否则用户看到的是一个
        // 永远"加载中"或空白的详情框，无法区分"没有数据"与"请求失败"。
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resourceId]);

  useEffect(() => {
    if (resourceId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [resourceId, onClose]);

  if (resourceId === null) return null;

  const dash = t('detail.notProvided');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      data-testid="resource-detail-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[#E8E4F0] bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-xl font-semibold text-[#2D2A3E]">
            {resource ? (language === 'en-US' ? resource.titleEn || resource.title : resource.title) : t('detail.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            data-testid="resource-detail-close"
            aria-label={t('detail.close')}
            className="rounded-lg p-1.5 text-[#6B6878] hover:bg-[#FAF8FF]"
          >
            <X className="size-5" />
          </button>
        </div>

        {loading && (
          <div className="flex items-center justify-center gap-3 p-10">
            <Loader2 className="size-5 animate-spin text-primary" />
            <span className="text-muted-foreground">{t('common.loading')}</span>
          </div>
        )}

        {!loading && error && (
          <div className="flex items-start gap-3 rounded-lg border border-[#D98B8B] p-4">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-[#D98B8B]" />
            <div>
              <p className="font-medium text-[#2D2A3E]">{t('detail.loadFailed')}</p>
              <p className="mt-1 text-sm text-muted-foreground break-all">{error}</p>
            </div>
          </div>
        )}

        {!loading && !error && resource && (
          <>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <Field label={t('detail.status')}>
                <StatusBadge status={resource.status} t={t} />
              </Field>
              <Field label={t('detail.version')}>v{resource.version}</Field>
              <Field label={t('detail.program')}>{resource.program}</Field>
              <Field label={t('detail.subject')}>
                {resource.subSubject ? `${resource.subject} / ${resource.subSubject}` : resource.subject}
              </Field>
              <Field label={t('detail.folderType')}>{resource.folderType}</Field>
              <Field label={t('detail.semester')}>
                {resource.semester ?? dash}
                {resource.weekNumber ? ` · ${t('detail.week')} ${resource.weekNumber}` : ''}
              </Field>
              <Field label={t('detail.uploader')}>{resource.uploaderName || dash}</Field>
              <Field label={t('detail.createdAt')}>{formatTime(resource.createdAt)}</Field>
              <Field label={t('detail.updatedAt')}>{formatTime(resource.updatedAt)}</Field>
              <Field label={t('detail.reviewer')}>{resource.reviewerName || dash}</Field>
              <Field label={t('detail.file')}>
                {/* hasFile 由数据库根据文件列算出（migration 0008）。
                    为 false 时说"未上传文件"，而不是给一个点了就失败的下载按钮。 */}
                {resource.hasFile
                  ? `${resource.fileName ?? ''} ${formatSize(resource.fileSize)}`.trim()
                  : t('detail.noFile')}
              </Field>
              <Field label={t('detail.theme')}>{resource.theme ?? dash}</Field>
            </dl>

            <div className="mt-5">
              <p className="mb-1 text-sm text-[#6B6878]">{t('detail.description')}</p>
              <p className="whitespace-pre-wrap text-base leading-relaxed text-[#2D2A3E]">
                {resource.description?.trim() ? resource.description : dash}
              </p>
            </div>

            {/* 审核意见只在真的有值时显示；空的时候显示"未填写"而不是隐藏整块 ——
                隐藏会让人以为"这一项不存在"。 */}
            <div className="mt-5">
              <p className="mb-1 text-sm text-[#6B6878]">{t('detail.reviewComment')}</p>
              <p className="whitespace-pre-wrap text-base leading-relaxed text-[#2D2A3E]">
                {resource.reviewComment?.trim() ? resource.reviewComment : dash}
              </p>
              {resource.reviewedAt && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('detail.reviewedAt')}: {formatTime(resource.reviewedAt)}
                </p>
              )}
            </div>

            {/* §15 版本历史。以前界面上那个"版本 v1"是个从不变化的装饰 ——
                现在它对应的是真实历史，所以把它列出来。 */}
            <div className="mt-5" data-testid="resource-version-history">
              <p className="mb-2 text-sm text-[#6B6878]">{t('detail.versionHistory')}</p>
              {versionsError && (
                <p className="text-sm text-[#D98B8B]">
                  {t('detail.versionHistoryFailed')}: {versionsError}
                </p>
              )}
              {!versionsError && versions === null && (
                <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
              )}
              {!versionsError && versions !== null && (
                <ul className="space-y-2">
                  {versions.map((v) => (
                    <li
                      key={v.id}
                      className="rounded-lg border border-[#E8E4F0] px-3 py-2 text-sm"
                      data-version={v.version}
                    >
                      <span className="font-medium text-[#2D2A3E]">v{v.version}</span>
                      <span className="ml-2 text-[#6B6878]">
                        {t(`detail.changeKind.${v.changeKind}` as TranslationKey)}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {formatTime(v.changedAt)}
                      </span>
                      {v.version === 1 && v.changeKind === 'backfilled' && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          · {t('detail.backfilled')}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-[#6B6878]">{label}</dt>
      <dd className="text-base text-[#2D2A3E]">{children}</dd>
    </div>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: ResourceStatus;
  t: (key: TranslationKey) => string;
}) {
  const styles: Record<ResourceStatus, string> = {
    draft: 'bg-gray-100 text-gray-700',
    pending_review: 'bg-orange-100 text-orange-700',
    published: 'bg-green-100 text-green-700',
    rejected: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-medium ${styles[status] ?? 'bg-gray-100'}`}>
      {t(`status.${status}` as TranslationKey)}
    </span>
  );
}

function formatTime(value: string | undefined): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function formatSize(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
