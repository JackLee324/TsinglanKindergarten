import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Heart, Puzzle, Dumbbell, ArrowRight, BookOpen } from 'lucide-react';
import { logger } from '@lark-apaas/client-toolkit/logger';

import { Card, CardContent } from '@client/src/components/ui/card';
import { Badge } from '@client/src/components/ui/badge';
import { PageHeader } from '@client/src/components/ui/page-header';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { curriculum as curriculumApi, resources as resourcesApi } from '@client/src/api';
import type { ProgramStructure, SubjectNode } from '@shared/api.interface';

interface SubjectCardInfo {
  /** i18n / identity key. May be an alias of the canonical subject token. */
  key: string;
  /** Canonical subject token, used for API queries. */
  canonical: string;
  path: string;
  icon: React.ReactNode;
  iconBg: string;
}

/**
 * The three Pre-K subject cards. `key` is what `nav.<key>` / `subject.<key>Desc`
 * i18n lookups and the card identity use; `canonical` is the token the database
 * and the REST API use, and is what the count request must send. They differ for
 * 体能 only ('pe' vs 'physical_education') — see @shared/curriculum.
 */
const PREK_SUBJECTS: SubjectCardInfo[] = [
  {
    key: 'virtue',
    canonical: 'virtue',
    path: '/prek/virtue',
    icon: <Heart className="size-6" />,
    iconBg: 'bg-pink-100 text-pink-500',
  },
  {
    key: 'montessori',
    canonical: 'montessori',
    path: '/prek/montessori',
    icon: <Puzzle className="size-6" />,
    iconBg: 'bg-purple-100 text-primary',
  },
  {
    // canonical: physical_education
    key: 'pe',
    canonical: 'physical_education',
    path: '/prek/pe',
    icon: <Dumbbell className="size-6" />,
    iconBg: 'bg-orange-100 text-orange-500',
  },
];

const PreKHomePage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [structure, setStructure] = useState<ProgramStructure | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let mounted = true;
    const load = async (): Promise<void> => {
      try {
        const structures = await curriculumApi.getCurriculumStructure();
        const prek = structures.find((s: ProgramStructure) => s.program === 'prek') ?? null;
        if (mounted) setStructure(prek);

        const countMap: Record<string, number> = {};
        await Promise.all(
          PREK_SUBJECTS.map(async (sub: SubjectCardInfo) => {
            try {
              const resp = await resourcesApi.getResources({
                program: 'prek',
                // The CANONICAL subject token: the API and the database compare
                // against `physical_education`, and asking for 'pe' returned 0.
                subject: sub.canonical,
                status: 'published',
                pageSize: 1,
              });
              countMap[sub.canonical] = resp.total;
            } catch {
              countMap[sub.canonical] = 0;
            }
          }),
        );
        if (mounted) setCounts(countMap);
      } catch (err) {
        logger.error('Failed to load PreK structure', String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  const findSubject = (key: string): SubjectNode | undefined => {
    return structure?.subjects.find((s: SubjectNode) => s.key === key);
  };

  return (
    <div>
      <PageHeader
        title={t('page.prek')}
        description={t('page.prekDesc')}
      >
        <div className="flex items-center gap-2">
          <BookOpen className="size-4 text-primary" />
          <span className="text-sm text-muted-foreground">
            {structure?.name ?? 'Pre-K'}
          </span>
        </div>
      </PageHeader>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" data-ai-section-type="card-list">
        {PREK_SUBJECTS.map((sub: SubjectCardInfo) => {
          const subjectNode = findSubject(sub.key);
          const count = counts[sub.canonical] ?? 0;
          return (
            <Card
              key={sub.key}
              onClick={() => navigate(sub.path)}
              className="group cursor-pointer border-border shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg"
            >
              <CardContent className="p-6">
                <div className={`mb-4 flex size-14 items-center justify-center rounded-xl ${sub.iconBg}`}>
                  {sub.icon}
                </div>
                <h3 className="text-lg font-semibold text-foreground">
                  {subjectNode?.name ?? t(`nav.${sub.key}` as Parameters<typeof t>[0])}
                </h3>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {subjectNode?.nameEn ?? ''}
                </p>
                <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
                  {t(`subject.${sub.key}Desc` as Parameters<typeof t>[0])}
                </p>
                <div className="mt-5 flex items-center justify-between">
                  <Badge variant="secondary">
                    {loading ? '—' : count} {t('resource.publishedCount')}
                  </Badge>
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

export default PreKHomePage;
