import React from 'react';
import {
  BookOpen,
  ClipboardCheck,
  CalendarDays,
  FolderKanban,
  Upload,
  type LucideIcon,
} from 'lucide-react';

import { Card, CardContent } from '@client/src/components/ui/card';

interface StatCardProps {
  label: string;
  value: number;
  icon: 'resources' | 'review' | 'calendar' | 'subjects' | 'upload';
  gradientFrom?: string;
  gradientTo?: string;
}

const ICON_MAP: Record<string, LucideIcon> = {
  resources: BookOpen,
  review: ClipboardCheck,
  calendar: CalendarDays,
  subjects: FolderKanban,
  upload: Upload,
};

export const StatCard: React.FC<StatCardProps> = ({
  label,
  value,
  icon,
  gradientFrom = 'from-[#8B7EC8]',
  gradientTo = 'to-[#B8AEDB]',
}) => {
  const IconComponent = ICON_MAP[icon];

  return (
    <Card className="border-[#E8E4F0] shadow-sm overflow-hidden">
      <CardContent className="p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground mb-2">{label}</p>
            <p className="text-3xl font-semibold text-foreground tracking-tight">
              {value}
            </p>
          </div>
          <div
            className={`flex size-12 items-center justify-center rounded-xl bg-gradient-to-br ${gradientFrom} ${gradientTo} text-white shadow-sm`}
          >
            {IconComponent && <IconComponent className="size-6" />}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};
