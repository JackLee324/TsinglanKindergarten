import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sparkles,
  FileText,
  Upload,
  FolderOpen,
  ClipboardCheck,
  Calendar,
  BookOpen,
} from 'lucide-react';
import { logger } from '@lark-apaas/client-toolkit/logger';

import { Card, CardContent, CardHeader, CardTitle } from '@client/src/components/ui/card';
import { Skeleton } from '@client/src/components/ui/skeleton';
import { StatCard } from '@client/src/components/ui/stat-card';
import { ResourceListItem } from '@client/src/components/ui/resource-list-item';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { useAuth } from '@client/src/auth/useAuth';
import * as dashboardApi from '@client/src/api/dashboard';

interface TeacherDashboardStats {
  myResources: number;
  pendingReview: number;
  monthlyUpload: number;
  published: number;
  authorizedSubjects: number;
  prekCount?: number;
  kCount?: number;
  coverCount?: number;
}

interface RecentItem {
  id: string;
  title: string;
  titleEn?: string;
  program: string;
  subject: string;
  subSubject?: string;
  folderType: string;
  uploaderName: string;
  updatedAt: string;
}

const HomePage: React.FC = () => {
  const { t, language } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [statsLoading, setStatsLoading] = useState<boolean>(true);
  const [stats, setStats] = useState<TeacherDashboardStats>({
    myResources: 0,
    pendingReview: 0,
    monthlyUpload: 0,
    published: 0,
    authorizedSubjects: 0,
  });

  const [recentLoading, setRecentLoading] = useState<boolean>(true);
  const [recentItems, setRecentItems] = useState<RecentItem[]>([]);

  const getGreeting = (): string => {
    const hour = new Date().getHours();
    if (hour < 12) {
      return t('dashboard.goodMorning' as Parameters<typeof t>[0]);
    }
    return t('dashboard.goodAfternoon' as Parameters<typeof t>[0]);
  };

  const formatDateCN = (date: Date): string => {
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    return `${y}年${m}月${d}日 ${weekdays[date.getDay()]}`;
  };

  const formatDateEN = (date: Date): string => {
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  useEffect(() => {
    const loadStats = async (): Promise<void> => {
      try {
        const data = await dashboardApi.getStats();
        setStats(data);
      } catch (err) {
        logger.warn('[Home] Failed to load dashboard stats', String(err));
      } finally {
        setStatsLoading(false);
      }
    };
    void loadStats();
  }, []);

  useEffect(() => {
    const loadRecent = async (): Promise<void> => {
      try {
        const data = await dashboardApi.getRecentUpdates(5);
        setRecentItems(data.items || []);
      } catch (err) {
        logger.warn('[Home] Failed to load recent updates', String(err));
      } finally {
        setRecentLoading(false);
      }
    };
    void loadRecent();
  }, []);

  const now = new Date();
  const dateStr = language === 'zh-CN' ? formatDateCN(now) : formatDateEN(now);
  const userName = user?.name || '';

  const handleRecentClick = (item: RecentItem): void => {
    const program = item.program === 'k' ? 'k' : 'prek';
    let path = `/${program}/${item.subject}`;
    if (item.subSubject) {
      path += `/${item.subSubject}`;
    }
    navigate(path);
  };

  const isAdmin = user?.roles?.includes('principal') || user?.roles?.includes('curriculum_director');

  return (
    <div className="space-y-6">
      <Card className="border-[#E8E4F0] shadow-sm overflow-hidden">
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-4">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#8B7EC8] to-[#B8AEDB] text-white shadow-sm">
                <Sparkles className="size-7" />
              </div>
              <div>
                <h2 className="text-2xl font-semibold text-foreground">
                  {getGreeting()}，{userName}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('dashboard.todayIs' as Parameters<typeof t>[0])} {dateStr}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {isAdmin && (
        <div data-ai-section-type="card-stat" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {statsLoading ? (
            Array.from({ length: 3 }).map((_, i: number) => (
              <Card key={i} className="border-[#E8E4F0] shadow-sm">
                <CardContent className="p-6">
                  <Skeleton className="mb-2 h-4 w-24" />
                  <Skeleton className="h-8 w-16" />
                </CardContent>
              </Card>
            ))
          ) : (
            <>
              <StatCard
                label={t('dashboard.stat.prekResources' as Parameters<typeof t>[0])}
                value={stats.prekCount ?? 0}
                icon="resources"
                gradientFrom="from-[#8B7EC8]"
                gradientTo="to-[#B8AEDB]"
              />
              <StatCard
                label={t('dashboard.stat.kResources' as Parameters<typeof t>[0])}
                value={stats.kCount ?? 0}
                icon="subjects"
                gradientFrom="from-[#6B5BAE]"
                gradientTo="to-[#8B7EC8]"
              />
              <StatCard
                label={t('storybook.weeklyStorybooks' as Parameters<typeof t>[0])}
                value={stats.coverCount ?? 0}
                icon="calendar"
                gradientFrom="from-[#7CB69C]"
                gradientTo="to-[#A8D0BC]"
              />
            </>
          )}
        </div>
      )}

      <div data-ai-section-type="card-stat" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {statsLoading ? (
          Array.from({ length: 5 }).map((_, i: number) => (
            <Card key={i} className="border-[#E8E4F0] shadow-sm">
              <CardContent className="p-6">
                <Skeleton className="mb-2 h-4 w-24" />
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))
        ) : (
          <>
            <StatCard
              label={t('dashboard.stat.myResources' as Parameters<typeof t>[0])}
              value={stats.myResources}
              icon="resources"
              gradientFrom="from-[#8B7EC8]"
              gradientTo="to-[#B8AEDB]"
            />
            <StatCard
              label={t('dashboard.stat.pendingReview' as Parameters<typeof t>[0])}
              value={stats.pendingReview}
              icon="review"
              gradientFrom="from-[#E8B86B]"
              gradientTo="to-[#F0D090]"
            />
            <StatCard
              label={t('dashboard.stat.monthlyUpload' as Parameters<typeof t>[0])}
              value={stats.monthlyUpload}
              icon="upload"
              gradientFrom="from-[#7CB69C]"
              gradientTo="to-[#A8D0BC]"
            />
            <StatCard
              label={t('dashboard.stat.published' as Parameters<typeof t>[0])}
              value={stats.published}
              icon="subjects"
              gradientFrom="from-[#6B5BAE]"
              gradientTo="to-[#8B7EC8]"
            />
            <StatCard
              label={t('dashboard.stat.authorizedSubjects' as Parameters<typeof t>[0])}
              value={stats.authorizedSubjects}
              icon="calendar"
              gradientFrom="from-[#D98B8B]"
              gradientTo="to-[#E8B0B0]"
            />
          </>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-[#E8E4F0] shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-4">
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <FileText className="size-5 text-primary" />
              {t('dashboard.recentUpdates' as Parameters<typeof t>[0])}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, i: number) => (
                  <div key={i} className="rounded-xl border border-[#E8E4F0] p-4">
                    <Skeleton className="mb-3 h-5 w-2/3" />
                    <Skeleton className="h-4 w-1/3" />
                  </div>
                ))}
              </div>
            ) : recentItems.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#E8E4F0] p-10 text-center">
                <FileText className="mx-auto mb-3 size-10 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {t('dashboard.emptyResources' as Parameters<typeof t>[0])}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {recentItems.map((item: RecentItem) => (
                  <ResourceListItem
                    key={item.id}
                    resource={{
                      id: item.id,
                      title: item.title,
                      titleEn: item.titleEn,
                      program: item.program as 'prek' | 'k',
                      subject: item.subject,
                      subSubject: item.subSubject,
                      folderType: item.folderType as
                        | 'curriculum_outline'
                        | 'weekly_plans'
                        | 'courseware'
                        | 'materials'
                        | 'observation'
                        | 'research_archive',
                      uploaderName: item.uploaderName,
                      updatedAt: item.updatedAt,
                      uploaderId: '',
                      version: 1,
                      status: 'published',
                      createdAt: item.updatedAt,
                    }}
                    onClick={() => handleRecentClick(item)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="border-[#E8E4F0] shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-semibold flex items-center gap-2">
                <Upload className="size-5 text-primary" />
                {t('dashboard.quickUpload' as Parameters<typeof t>[0])}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <button
                onClick={() => navigate('/upload')}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-dark"
              >
                <Upload className="size-4" />
                {t('dashboard.quickUpload' as Parameters<typeof t>[0])}
              </button>
            </CardContent>
          </Card>

          <Card className="border-[#E8E4F0] shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg font-semibold flex items-center gap-2">
                <FolderOpen className="size-5 text-primary" />
                {t('dashboard.quickMyResources' as Parameters<typeof t>[0])}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <button
                onClick={() => navigate('/my-resources')}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-white px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent"
              >
                <FolderOpen className="size-4" />
                {t('dashboard.quickMyResources' as Parameters<typeof t>[0])}
              </button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default HomePage;
