import React, { useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import { logger } from '@client/src/lib/logger';

import { resources as resourcesApi } from '@client/src/api';
import { Image } from '@client/src/components/ui/image';

interface StorybookCoverProps {
  resourceId: string;
  index: number;
  title: string;
  note?: string;
}

const PLACEHOLDER_ALT_ZH = '封面图：书名待核对';
const PLACEHOLDER_ALT_EN = 'Cover image: title to be verified';

function isTitleVerified(title: string, note?: string): boolean {
  if (!title.trim()) return false;
  if (!note) return true;
  const lowerNote = note.toLowerCase();
  if (lowerNote.includes('verify') || lowerNote.includes('inferred')) {
    return false;
  }
  return true;
}

export const StorybookCover: React.FC<StorybookCoverProps> = ({
  resourceId,
  index,
  title,
  note,
}) => {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<boolean>(false);

  const verified = isTitleVerified(title, note);
  const altText = verified
    ? title
    : `${PLACEHOLDER_ALT_ZH} / ${PLACEHOLDER_ALT_EN}`;

  const src = resourcesApi.getStorybookCoverUrl(resourceId, index);

  const handleLoad = (): void => {
    setLoading(false);
    setError(false);
  };

  const handleError = (): void => {
    logger.warn(`Storybook cover failed: ${resourceId} index=${index}`);
    setLoading(false);
    setError(true);
  };

  return (
    <div className="group relative flex flex-col items-center">
      <div className="relative flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/30">
        {loading && !error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-5 animate-spin text-primary/50" />
          </div>
        )}
        {error ? (
          <div className="flex flex-col items-center gap-1 px-2 text-center">
            <ImageOff className="size-6 text-muted-foreground/50" />
            <span className="text-[10px] text-muted-foreground">
              封面加载失败
            </span>
          </div>
        ) : (
          <Image
            src={src}
            alt={altText}
            title={altText}
            onLoad={handleLoad}
            onError={handleError}
            className={`h-full w-full object-cover transition-opacity duration-200 ${
              loading ? 'opacity-0' : 'opacity-100'
            }`}
            loading="lazy"
          />
        )}
      </div>
      <div className="mt-1.5 w-full text-center">
        <p className="line-clamp-2 text-xs text-foreground/80">
          {verified ? title : <span className="italic text-muted-foreground">{PLACEHOLDER_ALT_ZH}</span>}
        </p>
      </div>
    </div>
  );
};

export default StorybookCover;
