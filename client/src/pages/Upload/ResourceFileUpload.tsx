import React, { useRef, useState } from 'react';

import { FileUp, Upload } from 'lucide-react';

import { Button } from '@client/src/components/ui/button';
import { Label } from '@client/src/components/ui/label';
import { useTranslation } from '@client/src/i18n/useTranslation';

interface ResourceFileUploadProps {
  file: File | null;
  onFileChange: (file: File | null) => void;
  required?: boolean;
  error?: string;
}

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const ResourceFileUpload: React.FC<ResourceFileUploadProps> = ({
  file,
  onFileChange,
  required,
  error,
}) => {
  const { t, language } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => fileInputRef.current?.click();
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    onFileChange(f ?? null);
  };
  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFileChange(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const labelText =
    language === 'zh-CN' ? '文件上传' : 'File Upload';
  const selectText =
    language === 'zh-CN' ? '点击选择文件' : 'Click to select file';
  const supportText =
    language === 'zh-CN'
      ? '支持 PDF、PPT、Word、图片、视频等格式'
      : 'Supports PDF, PPT, Word, images, videos, etc.';
  const removeText =
    language === 'zh-CN' ? '移除文件' : 'Remove file';

  return (
    <div>
      <Label className="mb-2 block">
        {labelText}
        {required && <span className="text-destructive">*</span>}
      </Label>
      <div
        className="rounded-lg border-2 border-dashed border-border p-8 text-center transition-colors hover:border-primary/50 cursor-pointer"
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') handleClick();
        }}
        role="button"
        tabIndex={0}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleChange}
          accept=".pdf,.ppt,.pptx,.doc,.docx,image/*,video/*"
        />
        {file ? (
          <div className="flex flex-col items-center gap-2">
            <FileUp className="size-8 text-primary" />
            <p className="text-sm font-medium text-foreground">{file.name}</p>
            <p className="text-xs text-muted-foreground">
              {formatFileSize(file.size)}
            </p>
            <Button variant="outline" size="sm" type="button" onClick={handleRemove}>
              {removeText}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <Upload className="size-10 text-muted-foreground" />
            <p className="text-sm text-foreground">{selectText}</p>
            <p className="text-xs text-muted-foreground">{supportText}</p>
          </div>
        )}
      </div>
      {error && <p className="mt-1 text-sm text-destructive">{error}</p>}
      <p className="mt-2 text-xs text-muted-foreground">
        <span className="font-medium">TODO:</span> {t('common.loading')} —{' '}
        {language === 'zh-CN'
          ? '后续接入 dataloom storage SDK 实现真实上传'
          : 'Integrate dataloom storage SDK for real upload later'}
      </p>
    </div>
  );
};
