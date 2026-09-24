import React from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';

import { Button } from '@client/src/components/ui/button';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { LanguageToggle } from '@client/src/i18n/LanguageToggle';

const UnauthorizedPage: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background p-4">
      <div className="absolute right-4 top-4">
        <LanguageToggle />
      </div>

      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 flex size-20 items-center justify-center rounded-2xl bg-destructive/10">
          <ShieldAlert className="size-10 text-destructive" />
        </div>
        <h1 className="mb-2 text-2xl font-semibold text-foreground">
          {t('unauthorized.title')}
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          {t('unauthorized.subtitle')}
        </p>
        <Button asChild className="bg-primary hover:bg-primary-dark">
          <Link to="/">{t('unauthorized.backHome')}</Link>
        </Button>
      </div>
    </div>
  );
};

export default UnauthorizedPage;
