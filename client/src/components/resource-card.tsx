import React, { useState } from 'react';
import {
  Download,
  FileText,
  User,
  Calendar,
  HardDrive,
  Loader2,
  ChevronDown,
} from 'lucide-react';
import { logger } from '@lark-apaas/client-toolkit/logger';

import { Card, CardContent } from '@client/src/components/ui/card';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { StorybookCover } from '@client/src/components/storybook-cover';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { resources as resourcesApi } from '@client/src/api';
import type { Resource, ResourceStatus } from '@shared/api.interface';

interface ResourceCardProps {
  resource: Resource;
  showSemester?: boolean;
  showWeek?: boolean;
  showTheme?: boolean;
  showStorybooksDefault?: boolean;
}

const statusVariantMap: Record<ResourceStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  published: 'default',
  pending_review: 'secondary',
  draft: 'outline',
  rejected: 'destructive',
};

function formatFileSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return iso;
  }
}

export const ResourceCard: React.FC<ResourceCardProps> = ({
  resource,
  showSemester = true,
  showWeek = true,
  showTheme = false,
  showStorybooksDefault = false,
}) => {
  const { t, language } = useTranslation();
  const [downloading, setDownloading] = useState<boolean>(false);
  const [showStorybooks, setShowStorybooks] = useState<boolean>(showStorybooksDefault);

  const isNotFilled = resource.title === '待补充' || resource.title === 'Not filled in source';

  const storybooks = React.useMemo(() => {
    if (!resource.description) return [];
    try {
      const parsed = JSON.parse(resource.description);
      if (Array.isArray(parsed.storybooks)) {
        return parsed.storybooks as Array<{ filePath: string; title: string; note?: string }>;
      }
      return [];
    } catch {
      return [];
    }
  }, [resource.description]);

  const hasStorybooks = storybooks.length > 0;

  const semesterLabel = React.useMemo(() => {
    if (!resource.semester) return '';
    const key = resource.semester === 'S1' ? 'semester.s1' : 'semester.s2';
    return t(key as Parameters<typeof t>[0]);
  }, [resource.semester, t]);

  const weekLabel = React.useMemo(() => {
    if (resource.weekNumber === undefined || resource.weekNumber === null) return '';
    if (language === 'zh-CN') {
      return `${t('semester.week')}${resource.weekNumber}${t('semester.weekSuffix')}`;
    }
    return `${t('semester.week')} ${resource.weekNumber}`;
  }, [resource.weekNumber, language, t]);

  const handleDownload = async (): Promise<void> => {
    if (downloading || !resource.fileName) return;
    setDownloading(true);
    try {
      const result = await resourcesApi.downloadResource(resource.id);
      if (result?.downloadUrl) {
        const a = document.createElement('a');
        a.href = result.downloadUrl;
        a.download = resource.fileName ?? 'resource';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } catch (err) {
      logger.error('Download failed', String(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card className="border-border shadow-sm transition-all hover:border-primary/30 hover:shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileText className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h4
                  className={`truncate text-base font-medium text-foreground ${
                    isNotFilled ? 'italic text-muted-foreground' : ''
                  }`}
                >
                  {resource.title}
                </h4>
              </div>
              {resource.fileName && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {resource.fileName}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge variant={statusVariantMap[resource.status]}>
                  {t(`status.${resource.status}` as Parameters<typeof t>[0])}
                </Badge>
                {showSemester && resource.semester && (
                  <Badge variant="secondary">{semesterLabel}</Badge>
                )}
                {showWeek && resource.weekNumber !== undefined && resource.weekNumber !== null && (
                  <Badge variant="outline">{weekLabel}</Badge>
                )}
                {showTheme && resource.theme && (
                  <Badge variant="outline">{resource.theme}</Badge>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <User className="size-3.5" />
                  {resource.uploaderName}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Calendar className="size-3.5" />
                  {formatDate(resource.createdAt)}
                </span>
                {resource.fileSize !== undefined && resource.fileSize !== null && (
                  <span className="inline-flex items-center gap-1">
                    <HardDrive className="size-3.5" />
                    {formatFileSize(resource.fileSize)}
                  </span>
                )}
              </div>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleDownload}
            disabled={downloading || !resource.fileName || resource.status !== 'published'}
            className="shrink-0"
          >
            {downloading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {t('btn.download')}
          </Button>
        </div>
        {hasStorybooks && (
          <button
            type="button"
            onClick={() => setShowStorybooks((v) => !v)}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
            aria-expanded={showStorybooks}
          >
            {t('storybook.weeklyStorybooks')} ({storybooks.length})
            <ChevronDown
              className={`size-4 transition-transform ${showStorybooks ? 'rotate-180' : ''}`}
            />
          </button>
        )}
        {hasStorybooks && showStorybooks && (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {storybooks.map((sb, i) => (
              <StorybookCover
                key={`${resource.id}-${i}`}
                resourceId={resource.id}
                index={i}
                title={sb.title}
                note={sb.note}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default ResourceCard;
