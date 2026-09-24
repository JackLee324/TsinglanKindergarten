import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Dumbbell, Target, Mountain, ArrowRight } from 'lucide-react';

import { Card, CardContent } from '@client/src/components/ui/card';
import { PageHeader } from '@client/src/components/ui/page-header';
import { useTranslation } from '@client/src/i18n/useTranslation';

interface SubSubject {
  key: string;
  nameKey: string;
  descKey: string;
  icon: React.ReactNode;
  iconBg: string;
}

const PE_SUBJECTS: SubSubject[] = [
  {
    key: 'pe-special',
    nameKey: 'subject.peSpecial',
    descKey: 'subject.peSpecialDesc',
    icon: <Target className="size-6" />,
    iconBg: 'bg-orange-100 text-orange-500',
  },
  {
    key: 'sports',
    nameKey: 'subject.sports',
    descKey: 'subject.sportsDesc',
    icon: <Dumbbell className="size-6" />,
    iconBg: 'bg-green-100 text-green-600',
  },
  {
    key: 'rock-climbing',
    nameKey: 'subject.rockClimbing',
    descKey: 'subject.rockClimbingDesc',
    icon: <Mountain className="size-6" />,
    iconBg: 'bg-slate-100 text-slate-600',
  },
];

const PEPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div>
      <PageHeader
        title={t('subject.pe')}
        description={t('subject.peDesc')}
      />

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" data-ai-section-type="card-list">
        {PE_SUBJECTS.map((sub: SubSubject) => (
          <Card
            key={sub.key}
            onClick={() => navigate(`/k/pe/${sub.key}`)}
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

export default PEPage;
