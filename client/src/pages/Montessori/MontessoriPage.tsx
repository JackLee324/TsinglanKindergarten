import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Hand,
  Eye,
  Calculator,
  Globe,
  BookOpenCheck,
  ArrowRight,
} from 'lucide-react';

import { Card, CardContent } from '@client/src/components/ui/card';
import { PageHeader } from '@client/src/components/ui/page-header';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { subSubjectNodes } from '@shared/curriculum';

interface SubSubject {
  key: string;
  nameKey: string;
  descKey: string;
  icon: React.ReactNode;
  iconBg: string;
}

/**
 * The six Montessori areas, with their per-card presentation.
 *
 * The KEYS are no longer written here. They used to be hand-typed kebab-case
 * (`practical-life`, `english-language`, `chinese-language`) while the database
 * and the REST API both use the snake_case tokens (`practical_life`,
 * `english_language`, `chinese_language`). The card's `key` is what ends up in
 * the URL `/prek/montessori/<key>`, and SubjectPage forwarded it to
 * `GET /api/resources?subSubject=<key>` unchanged — so those three cards returned
 * ZERO resources out of the 80 / 43 / 1 rows that exist, and rendered "暂无资源"
 * with no error anywhere.
 *
 * The keys now come from `@shared/curriculum`, the same declaration the server
 * serves through `GET /api/curriculum/structure` and the same tokens the
 * `resources.sub_subject` column stores, so a card can no longer point at a
 * spelling that does not exist. Card ORDER, icons, colours and copy are unchanged.
 */
const MONTESSORI_PRESENTATION: Record<string, Omit<SubSubject, 'key' | 'nameKey' | 'descKey'>> = {
  practical_life: { icon: <Hand className="size-6" />, iconBg: 'bg-amber-100 text-amber-600' },
  sensorial: { icon: <Eye className="size-6" />, iconBg: 'bg-blue-100 text-blue-500' },
  math: { icon: <Calculator className="size-6" />, iconBg: 'bg-green-100 text-green-600' },
  english_language: { icon: <BookOpenCheck className="size-6" />, iconBg: 'bg-purple-100 text-primary' },
  chinese_language: { icon: <BookOpenCheck className="size-6" />, iconBg: 'bg-red-100 text-red-500' },
  culture: { icon: <Globe className="size-6" />, iconBg: 'bg-cyan-100 text-cyan-600' },
};

const MONTESSORI_SUBJECTS: SubSubject[] = subSubjectNodes('prek', 'montessori').map((node) => {
  const presentation = MONTESSORI_PRESENTATION[node.key];
  if (!presentation) {
    // Adding a sub-subject to the canonical vocabulary without giving it a card
    // here would silently drop it from the page, so say so instead.
    throw new Error(
      `MontessoriPage has no presentation entry for the canonical sub-subject "${node.key}"`,
    );
  }
  return {
    key: node.key,
    nameKey: node.i18nNameKey ?? `subject.${node.key}`,
    descKey: node.i18nDescKey ?? '',
    ...presentation,
  };
});

const MontessoriPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div>
      <PageHeader
        title={t('subject.montessori')}
        description={t('subject.montessoriDesc')}
      />

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" data-ai-section-type="card-list">
        {MONTESSORI_SUBJECTS.map((sub: SubSubject) => (
          <Card
            key={sub.key}
            onClick={() => navigate(`/prek/montessori/${sub.key}`)}
            className="group cursor-pointer border-border shadow-sm transition-all duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-lg"
          >
            <CardContent className="p-6">
              <div className={`mb-4 flex size-14 items-center justify-center rounded-xl ${sub.iconBg}`}>
                {sub.icon}
              </div>
              <h3 className="text-lg font-semibold text-foreground">
                {t(sub.nameKey as Parameters<typeof t>[0])}
              </h3>
              <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
                {t(sub.descKey as Parameters<typeof t>[0])}
              </p>
              <div className="mt-5 flex items-center justify-end">
                <span className="inline-flex items-center gap-1 text-sm font-medium text-primary transition-transform group-hover:translate-x-0.5">
                  <ArrowRight className="size-4" />
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};

export default MontessoriPage;
