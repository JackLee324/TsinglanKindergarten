import React from 'react';
import { Languages } from 'lucide-react';

import { Button } from '@client/src/components/ui/button';
import { useTranslation } from './useTranslation';

export const LanguageToggle: React.FC = () => {
  const { language, toggleLanguage, t } = useTranslation();

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggleLanguage}
      className="gap-2 text-muted-foreground hover:text-foreground"
    >
      <Languages className="h-4 w-4" />
      <span className="text-sm font-medium">
        {language === 'zh-CN' ? t('lang.en') : t('lang.zh')}
      </span>
    </Button>
  );
};
