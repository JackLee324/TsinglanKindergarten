import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { PackageOpen } from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import { Card, CardContent } from '@client/src/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { PageHeader } from '@client/src/components/ui/page-header';
import { ResourceCard } from '@client/src/components/resource-card';
import { useTranslation } from '@client/src/i18n/useTranslation';
import { resources as resourcesApi } from '@client/src/api';
import type { FolderType, Resource } from '@shared/api.interface';

const FOLDER_KEYS: FolderType[] = [
  'curriculum_outline',
  'weekly_plans',
  'courseware',
  'materials',
  'observation',
  'research_archive',
];

const SEMESTER_OPTIONS = ['S1', 'S2'];
const WEEK_OPTIONS = Array.from({ length: 20 }, (_, i) => i + 1);

// Theme slug → name mapping (must match EnglishPage THEMES)
const THEME_SLUG_MAP: Record<string, string> = {
  myself: 'Myself',
  'the-five-senses': 'The Five Senses',
  'community-neighborhood': 'Community & Neighborhood',
  'the-natural-world': 'The Natural World',
  'pbl-unit': 'PBL Unit',
  'around-the-world': 'Around the World',
};

const SubjectPage: React.FC = () => {
  const { t, language } = useTranslation();
  const { pathname } = useLocation();
  const params = useParams<{ sub?: string; theme?: string }>();
  const [activeFolder, setActiveFolder] = useState<FolderType>(FOLDER_KEYS[0]);
  const [semester, setSemester] = useState<string>('');
  const [weekNumber, setWeekNumber] = useState<string>('');
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Parse program and subject from pathname (routes use literal segments, not params)
  // Path patterns: /prek/virtue, /prek/montessori/:sub, /prek/pe,
  //                /k/virtue, /k/chinese/:sub, /k/english/:theme, /k/pe/:sub
  const segments = pathname.split('/').filter(Boolean);
  const program = segments[0] === 'k' ? 'k' : 'prek';
  const subject = segments[1] ?? '';
  const subSubject = params.sub;
  const theme = params.theme;

  const themeName = theme ? THEME_SLUG_MAP[theme] ?? theme : undefined;

  const displayName = useMemo(() => {
    if (themeName) return themeName;
    if (subSubject) {
      // Try known sub-subject keys, fallback to the raw sub param
      const knownKeys: Record<string, string> = {
        'practical-life': 'subject.practicalLife',
        sensorial: 'subject.sensorial',
        math: 'nav.montessori.math',
        'english-language': 'subject.englishLanguage',
        'chinese-language': 'subject.chineseLanguage',
        culture: 'subject.culture',
        'ancient-poetry': 'subject.ancientPoetry',
        'picture-books': 'subject.pictureBooks',
        drama: 'subject.drama',
        stem: 'subject.stem',
        'pe-special': 'subject.peSpecial',
        sports: 'subject.sports',
        'rock-climbing': 'subject.rockClimbing',
      };
      const key = knownKeys[subSubject];
      return key ? t(key as Parameters<typeof t>[0]) : subSubject;
    }
    const key = `subject.${subject}`;
    return t(key as Parameters<typeof t>[0]);
  }, [subject, subSubject, themeName, t]);

  const displayDesc = useMemo(() => {
    if (themeName) return t('subject.englishDesc');
    if (subSubject) {
      const descKeys: Record<string, string> = {
        'practical-life': 'subject.practicalLifeDesc',
        sensorial: 'subject.sensorialDesc',
        math: 'subject.mathDesc',
        'english-language': 'subject.englishLanguageDesc',
        'chinese-language': 'subject.chineseLanguageDesc',
        culture: 'subject.cultureDesc',
        'ancient-poetry': 'subject.ancientPoetryDesc',
        'picture-books': 'subject.pictureBooksDesc',
        drama: 'subject.dramaDesc',
        stem: 'subject.stemDesc',
        'pe-special': 'subject.peSpecialDesc',
        sports: 'subject.sportsDesc',
        'rock-climbing': 'subject.rockClimbingDesc',
      };
      const key = descKeys[subSubject];
      return key ? t(key as Parameters<typeof t>[0]) : '';
    }
    const descKey = `subject.${subject}Desc`;
    return t(descKey as Parameters<typeof t>[0]);
  }, [subject, subSubject, themeName, t]);

  const semesterLabel = (s: string): string => {
    if (s === 'S1') return t('semester.s1');
    if (s === 'S2') return t('semester.s2');
    return s;
  };

  const weekLabel = (w: number): string => {
    if (language === 'zh-CN') {
      return `${t('semester.week')}${w}${t('semester.weekSuffix')}`;
    }
    return `${t('semester.week')} ${w}`;
  };

  useEffect(() => {
    let mounted = true;
    const fetchResources = async (): Promise<void> => {
      setLoading(true);
      try {
        const paramsObj: Record<string, string | number> = {
          folderType: activeFolder,
          status: 'published',
          pageSize: 50,
        };
        if (program) paramsObj.program = program;
        if (subject) paramsObj.subject = subject;
        if (subSubject) paramsObj.subSubject = subSubject;
        if (themeName) paramsObj.theme = themeName;
        if (semester) paramsObj.semester = semester;
        if (weekNumber) paramsObj.weekNumber = Number(weekNumber);

        const resp = await resourcesApi.getResources(paramsObj);
        if (mounted) setResources(resp.items);
      } catch (err) {
        logger.error('Failed to load resources', String(err));
        if (mounted) setResources([]);
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void fetchResources();
    return () => {
      mounted = false;
    };
  }, [activeFolder, program, subject, subSubject, theme, semester, weekNumber]);

  return (
    <div>
      <PageHeader title={displayName} description={displayDesc} />

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('filter.semester')}:</span>
          <Select value={semester} onValueChange={setSemester}>
            <SelectTrigger className="w-36" size="sm">
              <SelectValue placeholder={t('filter.allSemesters')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{t('filter.allSemesters')}</SelectItem>
              {SEMESTER_OPTIONS.map((s: string) => (
                <SelectItem key={s} value={s}>
                  {semesterLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('filter.week')}:</span>
          <Select value={weekNumber} onValueChange={setWeekNumber}>
            <SelectTrigger className="w-32" size="sm">
              <SelectValue placeholder={t('filter.allWeeks')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{t('filter.allWeeks')}</SelectItem>
              {WEEK_OPTIONS.map((w: number) => (
                <SelectItem key={w} value={String(w)}>
                  {weekLabel(w)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="border-border shadow-sm">
        <CardContent className="p-6">
          <Tabs value={activeFolder} onValueChange={(v: string) => setActiveFolder(v as FolderType)}>
            <TabsList className="mb-6 flex w-full flex-wrap h-auto gap-1 bg-transparent p-0">
              {FOLDER_KEYS.map((key: FolderType) => (
                <TabsTrigger
                  key={key}
                  value={key}
                  className="rounded-full border border-transparent data-[state=active]:border-primary/30 data-[state=active]:bg-primary/10 data-[state=active]:text-primary"
                >
                  {t(`folder.${key}` as Parameters<typeof t>[0])}
                </TabsTrigger>
              ))}
            </TabsList>

            {FOLDER_KEYS.map((key: FolderType) => (
              <TabsContent key={key} value={key}>
                {loading ? (
                  <div className="space-y-3">
                    {[0, 1, 2].map((i: number) => (
                      <div
                        key={i}
                        className="animate-pulse rounded-lg border border-border p-5"
                      >
                        <div className="flex items-center gap-3">
                          <div className="size-10 rounded-lg bg-muted" />
                          <div className="flex-1 space-y-2">
                            <div className="h-4 w-1/3 rounded bg-muted" />
                            <div className="h-3 w-1/4 rounded bg-muted" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : resources.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-12 text-center">
                    <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-muted">
                      <PackageOpen className="size-6 text-muted-foreground" />
                    </div>
                    <p className="text-base font-medium text-foreground">
                      {t('resource.noResources')}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t('resource.noResourcesDesc')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {resources.map((r: Resource) => (
                      <ResourceCard
                        key={r.id}
                        resource={r}
                        showSemester={!!semester}
                        showWeek={!!weekNumber}
                        showTheme={!!theme}
                        showStorybooksDefault={activeFolder === 'weekly_plans'}
                      />
                    ))}
                  </div>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
};

export default SubjectPage;
