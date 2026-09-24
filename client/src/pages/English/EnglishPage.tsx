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
import type { ThemeDefinition } from '@shared/curriculum';
import { themeDbValue, themeDefinitions } from '@shared/curriculum';

/**
 * The six K English Big Unit themes.
 *
 * The LIST is no longer written here. It used to be a local `THEMES` array whose
 * `name` was sent straight to `GET /api/resources?theme=Myself`, while the
 * database stores the Chinese theme labels (`主题1：我自己`). The comparison
 * matched nothing, so all 44 K English rows were unreachable and every theme card
 * showed "0 个资源" with a successful (empty) response.
 *
 * `themeDefinitions()` returns the canonical list from `@shared/curriculum`, the
 * same declaration the SubjectPage theme filter and the server's boundary
 * normaliser use. The `tags` (sub-subject chip labels) are the only per-card
 * presentation left here, keyed by canonical theme token.
 * Card order, labels, badges and layout are unchanged.
 */
const THEME_TAGS: Record<string, string[]> = {
  myself: ['reading_comprehension', 'language_skills', 'math'],
  the_five_senses: ['reading_comprehension', 'language_skills'],
  community_neighborhood: ['reading_comprehension', 'language_skills', 'math'],
  the_natural_world: ['reading_comprehension', 'language_skills'],
  pbl_unit: ['reading_comprehension', 'language_skills', 'math'],
  around_the_world: ['reading_comprehension', 'language_skills', 'math'],
};

interface ThemeItem {
  theme: ThemeDefinition;
  /** Value to filter by — the exact string `resources.theme` stores. */
  filterValue: string;
  /** Route slug for `/k/english/:theme` (unchanged from the previous builder). */
  slug: string;
  tags: string[];
}

const ENGLISH_PROGRAM = 'k' as const;
const ENGLISH_SUBJECT = 'english';

/** Slug builder for this page's routes — same output as the previous inline one. */
const slugFor = (theme: ThemeDefinition): string =>
  theme.nameEn
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');

const THEMES: ThemeItem[] = themeDefinitions(ENGLISH_PROGRAM, ENGLISH_SUBJECT).map((theme) => {
  const filterValue = themeDbValue(ENGLISH_PROGRAM, ENGLISH_SUBJECT, theme.key);
  if (filterValue === null) {
    // A theme in the canonical vocabulary with no stored value would produce a
    // filter that can only ever match nothing. Fail rather than render a card
    // that quietly shows zero.
    throw new Error(`EnglishPage: canonical theme "${theme.key}" has no stored value`);
  }
  const tags = THEME_TAGS[theme.key];
  if (!tags) {
    throw new Error(`EnglishPage: no tag presentation for the canonical theme "${theme.key}"`);
  }
  return { theme, filterValue, slug: slugFor(theme), tags };
});

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
                // The STORED value, not the English display name: sending
                // 'Myself' is what returned 0 for all 44 rows.
                theme: theme.filterValue,
                status: 'published',
                pageSize: 1,
              });
              countMap[theme.filterValue] = resp.total;
            } catch {
              countMap[theme.filterValue] = 0;
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
          const count = counts[theme.filterValue] ?? 0;
          return (
            <Card
              key={theme.theme.key}
              onClick={() => navigate(`/k/english/${theme.slug}`)}
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
                  {theme.theme.nameEn}
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
