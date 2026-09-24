import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, ArrowRight, BookMarked } from 'lucide-react';
import { logger } from '@lark-apaas/client-toolkit/logger';

import { Card, CardContent } from '@client/src/components/ui/card';
import { Badge } from '@client/src/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { PageHeader } from '@client/src/components/ui/page-header';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { resources as resourcesApi } from '@client/src/api';

interface ThemeItem {
  name: string;
  tags: string[];
}

const THEMES: ThemeItem[] = [
  { name: 'Myself', tags: ['reading_comprehension', 'language_skills', 'math'] },
  { name: 'The Five Senses', tags: ['reading_comprehension', 'language_skills'] },
  { name: 'Community & Neighborhood', tags: ['reading_comprehension', 'language_skills', 'math'] },
  { name: 'The Natural World', tags: ['reading_comprehension', 'language_skills'] },
  { name: 'PBL Unit', tags: ['reading_comprehension', 'language_skills', 'math'] },
  { name: 'Around the World', tags: ['reading_comprehension', 'language_skills', 'math'] },
];

const EnglishPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let mounted = true;
    const loadCounts = async (): Promise<void> => {
      try {
        const countMap: Record<string, number> = {};
        await Promise.all(
          THEMES.map(async (theme: ThemeItem) => {
            try {
              const resp = await resourcesApi.getResources({
                program: 'k',
                subject: 'english',
                theme: theme.name,
                status: 'published',
                pageSize: 1,
              });
              countMap[theme.name] = resp.total;
            } catch {
              countMap[theme.name] = 0;
            }
          }),
        );
        if (mounted) setCounts(countMap);
      } catch (err) {
        logger.error('Failed to load theme counts', String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void loadCounts();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div>
      <PageHeader
        title={t('subject.english')}
        description={t('subject.englishDesc')}
      />

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" data-ai-section-type="card-list">
        {THEMES.map((theme: ThemeItem) => {
          const count = counts[theme.name] ?? 0;
          const themeSlug = theme.name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-');
          return (
            <Card
              key={theme.name}
              onClick={() => navigate(`/k/english/${themeSlug}`)}
              className="group cursor-pointer border-border shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg"
            >
              <CardContent className="p-6">
                <div className="mb-4 flex size-14 items-center justify-center rounded-xl bg-blue-100 text-blue-500">
                  <BookMarked className="size-6" />
                </div>
                <div className="mb-3 flex items-center gap-2">
                  <Badge variant="secondary">
                    {loading ? '—' : count} {t('theme.resources')}
                  </Badge>
                </div>
                <h3 className="text-lg font-semibold text-foreground">
                  {theme.name}
                </h3>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {theme.tags.map((tag: string) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
                    >
                      <Sparkles className="size-3" />
                      {t(`theme.tag.${tag}` as Parameters<typeof t>[0])}
                    </span>
                  ))}
                </div>
                <div className="mt-5 flex items-center justify-end">
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-primary transition-transform group-hover:translate-x-0.5">
                    <ArrowRight className="size-4" />
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
};

export default EnglishPage;
