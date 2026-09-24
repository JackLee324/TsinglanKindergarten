import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Hand,
  Eye,
  Calculator,
  Globe,
  BookOpenCheck,
  Palette,
  ArrowRight,
} from 'lucide-react';

import { Card, CardContent } from '@client/src/components/ui/card';
import { PageHeader } from '@client/src/components/ui/page-header';
import { useTranslation } from '@client/src/i18n/useTranslation';

interface SubSubject {
  key: string;
  subKey: string;
  nameKey: string;
  descKey: string;
  icon: React.ReactNode;
  iconBg: string;
}

const MONTESSORI_SUBJECTS: SubSubject[] = [
  {
    key: 'practical-life',
    subKey: 'practicalLife',
    nameKey: 'subject.practicalLife',
    descKey: 'subject.practicalLifeDesc',
    icon: <Hand className="size-6" />,
    iconBg: 'bg-amber-100 text-amber-600',
  },
  {
    key: 'sensorial',
    subKey: 'sensorial',
    nameKey: 'subject.sensorial',
    descKey: 'subject.sensorialDesc',
    icon: <Eye className="size-6" />,
    iconBg: 'bg-blue-100 text-blue-500',
  },
  {
    key: 'math',
    subKey: 'mathDesc',
    nameKey: 'nav.montessori.math',
    descKey: 'subject.mathDesc',
    icon: <Calculator className="size-6" />,
    iconBg: 'bg-green-100 text-green-600',
  },
  {
    key: 'english-language',
    subKey: 'englishLanguage',
    nameKey: 'subject.englishLanguage',
    descKey: 'subject.englishLanguageDesc',
    icon: <BookOpenCheck className="size-6" />,
    iconBg: 'bg-purple-100 text-primary',
  },
  {
    key: 'chinese-language',
    subKey: 'chineseLanguage',
    nameKey: 'subject.chineseLanguage',
    descKey: 'subject.chineseLanguageDesc',
    icon: <BookOpenCheck className="size-6" />,
    iconBg: 'bg-red-100 text-red-500',
  },
  {
    key: 'culture',
    subKey: 'culture',
    nameKey: 'subject.culture',
    descKey: 'subject.cultureDesc',
    icon: <Globe className="size-6" />,
    iconBg: 'bg-cyan-100 text-cyan-600',
  },
];

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
