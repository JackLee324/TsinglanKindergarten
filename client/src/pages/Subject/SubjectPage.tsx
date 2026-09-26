import React, { useEffect, useMemo, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { logger } from '@client/src/lib/logger';
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
import { readListResponse } from '@client/src/api/client';
import {
  FOLDER_TYPES,
  findNode,
  findTheme,
  normalizeSubSubject,
  normalizeTheme,
  themeDbValue,
} from '@shared/curriculum';

const FOLDER_KEYS: FolderType[] = FOLDER_TYPES;

const SEMESTER_OPTIONS = ['S1', 'S2'];
const WEEK_OPTIONS = Array.from({ length: 20 }, (_, i) => i + 1);

const SubjectPage: React.FC = () => {
  const { t, language } = useTranslation();
  const { pathname } = useLocation();
  const params = useParams<{ sub?: string; theme?: string }>();
  const [activeFolder, setActiveFolder] = useState<FolderType>(FOLDER_KEYS[0]);
  const [semester, setSemester] = useState<string>('');
  const [weekNumber, setWeekNumber] = useState<string>('');
  const [resources, setResources] = useState<Resource[]>([]);
  // 服务端拒绝时（403）不能说成「暂无资源」—— 那是在撒谎。单独记一个状态。
  const [forbidden, setForbidden] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  // Parse program and subject from pathname (routes use literal segments, not params)
  // Path patterns: /prek/virtue, /prek/montessori/:sub, /prek/pe,
  //                /k/virtue, /k/chinese/:sub, /k/english/:theme, /k/pe/:sub
  const segments = pathname.split('/').filter(Boolean);
  const program = segments[0] === 'k' ? 'k' : 'prek';
  const subject = segments[1] ?? '';
  const subSubjectRaw = params.sub;
  const themeRaw = params.theme;

  /**
   * The two route parameters, resolved to canonical tokens ONCE.
   *
   * `sub` arrives in whatever spelling the linking page used (the Montessori and
   * PE/Chinese card keys) and `theme` arrives as an English route slug. Both used
   * to be forwarded to the API verbatim, which is why `/prek/montessori/practical-life`
   * asked the database for a `sub_subject` value that does not exist and showed an
   * empty folder holding 80 rows.
   *
   * `normalizeSubSubject` / `normalizeTheme` accept every spelling that has ever
   * been linked to (see @shared/curriculum) and return null for anything else.
   * A null is reported in the console rather than being sent as a query that can
   * only ever match nothing — the old behaviour made a typo indistinguishable
   * from an empty folder.
   */
  const subSubject = useMemo(() => {
    if (!subSubjectRaw) return undefined;
    const token = normalizeSubSubject(program, subject, subSubjectRaw);
    if (token === null) {
      logger.error(
        'Unknown sub-subject in route',
        `program=${program} subject=${subject} sub=${subSubjectRaw}`,
      );
      return undefined;
    }
    return token;
  }, [program, subject, subSubjectRaw]);

  const themeToken = useMemo(() => {
    if (!themeRaw) return undefined;
    const token = normalizeTheme(program, subject, themeRaw);
    if (token === null) {
      logger.error(
        'Unknown theme in route',
        `program=${program} subject=${subject} theme=${themeRaw}`,
      );
      return undefined;
    }
    return token;
  }, [program, subject, themeRaw]);

  // What actually goes on the wire: the exact string `resources.theme` stores,
  // so the 44 existing K English rows are found without any row being rewritten.
  const themeFilterValue = themeToken
    ? themeDbValue(program, subject, themeToken) ?? undefined
    : undefined;

  // Label for the theme route. Themes are labelled in English (the K English
  // subject keeps its English terms in both UI languages), which is what the
  // previous THEME_SLUG_MAP produced — the difference is that this name is read
  // from the canonical definition instead of a second hand-written table.
  const themeDisplayName = themeToken
    ? findTheme(program, subject, themeToken)?.nameEn ?? themeRaw ?? ''
    : undefined;

  const displayName = useMemo(() => {
    if (themeDisplayName) return themeDisplayName;
    if (subSubject) {
      const node = findNode(program, subject, subSubject);
      return node?.i18nNameKey
        ? t(node.i18nNameKey as Parameters<typeof t>[0])
        : node?.name ?? subSubject;
    }
    const key = `subject.${subject}`;
    return t(key as Parameters<typeof t>[0]);
  }, [subject, subSubject, themeDisplayName, program, t]);

  const displayDesc = useMemo(() => {
    if (themeToken) return t('subject.englishDesc');
    if (subSubject) {
      const node = findNode(program, subject, subSubject);
      return node?.i18nDescKey ? t(node.i18nDescKey as Parameters<typeof t>[0]) : '';
    }
    const descKey = `subject.${subject}Desc`;
    return t(descKey as Parameters<typeof t>[0]);
  }, [subject, subSubject, themeToken, program, t]);

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
        // The STORED spelling, not the route slug. Sending 'Myself' here is what
        // made all 44 K English resources unreachable; 'themeFilterValue' is the
        // value those rows actually hold (e.g. 主题1：我自己).
        if (themeFilterValue) paramsObj.theme = themeFilterValue;
        if (semester) paramsObj.semester = semester;
        if (weekNumber) paramsObj.weekNumber = Number(weekNumber);

        const resp = await resourcesApi.getResources(paramsObj);
        if (mounted) {
          const page = readListResponse<Resource>(resp, 'resources.list(subject)');
          setResources(page.items);
          setForbidden(page.forbidden);
        }
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
  }, [activeFolder, program, subject, subSubject, themeFilterValue, semester, weekNumber]);

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
                      {forbidden ? t('unauthorized.title') : t('resource.noResources')}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {forbidden ? t('unauthorized.subtitle') : t('resource.noResourcesDesc')}
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
                        showTheme={!!themeToken}
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
