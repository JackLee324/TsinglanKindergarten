import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';

import { useTranslation } from '@client/src/i18n/useTranslation';

interface BreadcrumbItem {
  label: string;
  path?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export const Breadcrumb: React.FC<BreadcrumbProps> = ({ items }) => {
  const { t } = useTranslation();

  const allItems: BreadcrumbItem[] = [
    { label: t('breadcrumb.home'), path: '/' },
    ...items,
  ];

  return (
    <nav aria-label="breadcrumb" className="mb-4">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
        {allItems.map((item: BreadcrumbItem, index: number) => {
          const isLast = index === allItems.length - 1;
          const content = (
            <span
              className={`inline-flex items-center gap-1 ${
                isLast ? 'font-medium text-foreground' : 'hover:text-primary'
              }`}
            >
              {index === 0 && <Home className="size-3.5" />}
              {item.label}
            </span>
          );

          return (
            <li key={`${item.label}-${index}`} className="inline-flex items-center">
              {index > 0 && (
                <ChevronRight className="mx-1 size-3.5 text-muted-foreground/60" />
              )}
              {item.path && !isLast ? (
                <Link to={item.path} className="transition-colors">
                  {content}
                </Link>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};
