import React, { useState } from 'react';

import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { useTranslation } from '@client/src/i18n/useTranslation';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  confirmVariant?: 'default' | 'destructive';
  onConfirm: () => void | Promise<void>;
  children?: React.ReactNode;
  /**
   * 确认按钮的 data-testid。
   *
   * 纯属性，不改任何视觉或行为 —— 但它是"真实浏览器 E2E 能可靠点到按钮"的前提：
   * 这类图标/文案按钮在多个对话框里长得一样，只能按文案定位就会互相串台。
   */
  testId?: string;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  cancelText,
  confirmVariant = 'default',
  onConfirm,
  children,
  testId,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children && <div className="mt-2">{children}</div>}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {cancelText ?? t('btn.cancel')}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={handleConfirm}
            disabled={loading}
            data-testid={testId}
          >
            {loading ? t('common.loading') : confirmText ?? t('btn.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
