import React from 'react';
import { FileText, CalendarDays, User } from 'lucide-react';

import { Badge } from '@client/src/components/ui/badge';
import { useTranslation } from '@client/src/i18n/useTranslation';
import type { ProgramCode, Resource } from '@shared/api.interface';

interface ResourceListItemProps {
  resource: Resource;
  onClick?: () => void;
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

const PROGRAM_LABELS: Record<ProgramCode, string> = {
  prek: 'Pre-K',
  k: 'K',
};

export const ResourceListItem: React.FC<ResourceListItemProps> = ({
  resource,
  onClick,
}) => {
  const { t } = useTranslation();

  return (
    <div
      className="group flex items-start gap-4 rounded-xl border border-[#E8E4F0] bg-white p-4 transition-all hover:border-primary/30 hover:shadow-sm cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && onClick) onClick();
      }}
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <FileText className="size-5" />
      </div>

      <div className="min-w-0 flex-1">
        <h4 className="truncate font-medium text-foreground group-hover:text-primary transition-colors">
          {resource.title || resource.titleEn}
        </h4>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="font-normal">
            {PROGRAM_LABELS[resource.program]}
          </Badge>
          <Badge variant="outline" className="font-normal">
            {resource.subject}
            {resource.subSubject ? ` · ${resource.subSubject}` : ''}
          </Badge>
          <Badge
            variant="outline"
            className="font-normal bg-muted/30"
          >
            {t(`folder.${resource.folderType}` as Parameters<typeof t>[0])}
          </Badge>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <User className="size-3.5" />
            {resource.uploaderName}
          </span>
          <span className="inline-flex items-center gap-1">
            <CalendarDays className="size-3.5" />
            {formatDate(resource.updatedAt)}
          </span>
        </div>
      </div>
    </div>
  );
};
