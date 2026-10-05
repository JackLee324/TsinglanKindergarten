import React, { useEffect, useMemo, useState } from 'react';

import { zodResolver } from '@hookform/resolvers/zod';
import { logger } from '@client/src/lib/logger';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';

import { Button } from '@client/src/components/ui/button';
import { Card, CardContent } from '@client/src/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@client/src/components/ui/form';
import { Input } from '@client/src/components/ui/input';
import { PageHeader } from '@client/src/components/ui/page-header';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { Textarea } from '@client/src/components/ui/textarea';
import { useTranslation } from '@client/src/i18n/useTranslation';
import {
  createResource,
  getResource,
  submitReview,
  updateResource,
} from '@client/src/api/resources';
import { getCurriculumStructure } from '@client/src/api/curriculum';
import type {
  FolderType,
  ProgramCode,
  ProgramStructure,
  Resource,
} from '@shared/api.interface';
import { FOLDER_TYPES } from '@shared/api.interface';

import { ResourceFileUpload } from './ResourceFileUpload';

const uploadSchema = z.object({
  title: z.string().min(1, 'upload.titleRequired'),
  titleEn: z.string().optional(),
  program: z.string().min(1, 'upload.programRequired'),
  subject: z.string().min(1, 'upload.subjectRequired'),
  subSubject: z.string().optional(),
  folderType: z.string().min(1, 'upload.folderRequired'),
  semester: z.string().optional(),
  weekNumber: z.string().optional(),
  theme: z.string().optional(),
  description: z.string().optional(),
});

type UploadFormData = z.infer<typeof uploadSchema>;

const UploadPage: React.FC = () => {
  const { t, language } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const editId = searchParams.get('id');

  const [structures, setStructures] = useState<ProgramStructure[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const form = useForm<UploadFormData>({
    resolver: zodResolver(uploadSchema),
    defaultValues: {
      title: '', titleEn: '', program: '', subject: '', subSubject: '',
      folderType: '', semester: '', weekNumber: '', theme: '', description: '',
    },
  });

  const programValue = form.watch('program');
  const subjectValue = form.watch('subject');

  useEffect(() => {
    const load = async () => {
      try {
        setStructures(await getCurriculumStructure());
      } catch (error) {
        logger.error('[Upload] load curriculum failed', String(error));
      }
    };
    void load();
  }, []);

  useEffect(() => {
    if (!editId) return;
    const load = async () => {
      setLoading(true);
      try {
        const r: Resource = await getResource(editId);
        form.reset({
          title: r.title,
          titleEn: r.titleEn ?? '',
          program: r.program,
          subject: r.subject,
          subSubject: r.subSubject ?? '',
          folderType: r.folderType,
          semester: r.semester ?? '',
          weekNumber: r.weekNumber ? String(r.weekNumber) : '',
          theme: r.theme ?? '',
          description: r.description ?? '',
        });
        if (r.fileName) {
          const f = new File([], r.fileName, { type: r.fileType ?? '' });
          Object.defineProperty(f, 'size', { value: r.fileSize ?? 0 });
          setSelectedFile(f);
        }
      } catch (error) {
        logger.error('[Upload] load resource failed', String(error));
        toast.error(t('common.failed'));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [editId, form, t]);

  // Reset subject/subject on program or subject change
  useEffect(() => {
    form.setValue('subject', '');
    form.setValue('subSubject', '');
  }, [programValue, form]);
  useEffect(() => {
    form.setValue('subSubject', '');
  }, [subjectValue, form]);

  const currentProgram = useMemo(
    () => structures.find((s) => s.program === programValue),
    [structures, programValue],
  );
  const currentSubjectNode = useMemo(() => {
    if (!currentProgram) return null;
    return currentProgram.subjects.find((s) => s.key === subjectValue) ?? null;
  }, [currentProgram, subjectValue]);
  const hasSubSubjects = !!currentSubjectNode?.children?.length;
  const isEnglish = subjectValue === 'english';

  const L = (zh: string, en: string) => (language === 'zh-CN' ? zh : en);
  const reqStar = <span className="text-destructive">*</span>;

  const submitResource = async (status: 'draft' | 'pending_review') => {
    if (status === 'pending_review' && !selectedFile) {
      toast.error(L('请上传文件', 'Please upload a file'));
      return;
    }
    const ok = await form.trigger(['title', 'program', 'subject', 'folderType']);
    if (!ok) return;
    const data = form.getValues();
    setSubmitLoading(true);
    try {
      // 这里**不再**编造 bucket 与存储路径。
      //
      // 以前是 `fileBucketId = 'placeholder-bucket'` + 一个凭空拼出来的
      // `uploads/<时间戳>/<文件名>`，直接交给 createResource。后果很具体：
      // `resources.has_stored_file` 是由「path 与 bucket 都非空」生成的
      // （migration 0008），所以这些行立刻声称"有可下载的文件"，界面亮起"下载"，
      // 而下载必然失败 —— 一个"看起来成功、其实什么也没发生"的假成功。
      //
      // 现在改为：元数据照常保存（草稿是真实存在的），但**不声明任何文件**；
      // 真正的字节上传要走 POST /api/resources/:id/file（服务端会先判断本进程
      // 有没有对象存储后端，没有就直接 503 并拒绝登记）。见下方 uploadFileToStorage。
      const base = {
        title: data.title,
        titleEn: data.titleEn || undefined,
        description: data.description || undefined,
        semester: data.semester || undefined,
        weekNumber: data.weekNumber ? Number(data.weekNumber) : undefined,
        theme: data.theme || undefined,
        fileName: selectedFile?.name,
        fileSize: selectedFile?.size,
        fileType: selectedFile?.type,
      };
      if (editId) {
        await updateResource(editId, { ...base, status });
      } else {
        const created = await createResource({
          ...base,
          program: data.program as ProgramCode,
          subject: data.subject,
          subSubject: data.subSubject || undefined,
          folderType: data.folderType as FolderType,
        });

        // §5：创建接口**只**产生草稿（服务端 `status: 'draft' as const`）。
        // 以前这里两个分支都不传 status，于是点「提交审核」新建的资源在库里仍是 draft，
        // 而下面的 toast 却显示「已提交审核」—— API 没做成的事，UI 说做成了；
        // 审核台也永远看不到它。想真正提交审核，必须再调一次 submit-review（走
        // resource.submit_review 权限校验）。
        if (status === 'pending_review') {
          try {
            await submitReview(created.id);
          } catch (submitError) {
            // 诚实报告：草稿确实建好了，但提交审核失败（例如缺少 resource.submit_review）。
            // 不能笼统说"操作失败"（那会让人以为资源没保存），也不能说"已提交审核"。
            logger.error('[Upload] submit-review failed', String(submitError));
            toast.error(
              L(
                '草稿已保存，但提交审核失败，请在「我的资源」重试',
                'Draft saved, but submitting for review failed — retry from My Resources',
              ),
            );
            navigate('/my-resources');
            return;
          }
        }
      }
      // 选了文件但**没有上传字节**时必须说清楚。
      //
      // 这一版客户端不再伪造 bucket/path（见上面的注释），也还没有真实的对象存储
      // 上传流程（服务端的登记接口在缺少存储后端时会 503 拒绝）。所以"选了文件"
      // 与"文件已上传"是两件事，不能用一个绿色的「已保存」把区别盖掉 ——
      // 老师会以为文件已经在平台上了。
      if (selectedFile) {
        toast.warning(t('upload.storageNotConfigured'));
      } else {
        toast.success(
          status === 'draft'
            ? L('草稿已保存', 'Draft saved')
            : L('已提交审核', 'Submitted for review'),
        );
      }
      navigate('/my-resources');
    } catch (error) {
      logger.error('[Upload] submit failed', String(error));
      toast.error(t('common.failed'));
    } finally {
      setSubmitLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={editId ? L('编辑资源', 'Edit Resource') : t('page.upload')}
        description={t('page.uploadDesc')}
      />
      <Card className="border-border shadow-sm">
        <CardContent className="p-6">
          <Form {...form}>
            <form className="space-y-5">
              {/* Titles */}
              <div className="flex flex-wrap gap-4">
                <FormField control={form.control} name="title" render={({ field }) => (
                  <FormItem className="flex-1 min-w-[280px]">
                    <FormLabel>{L('资源标题（中文）', 'Title (Chinese)')}{reqStar}</FormLabel>
                    <FormControl><Input placeholder={L('请输入中文标题', 'Enter Chinese title')} {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="titleEn" render={({ field }) => (
                  <FormItem className="flex-1 min-w-[280px]">
                    <FormLabel>{L('资源标题（英文）', 'Title (English)')}</FormLabel>
                    <FormControl><Input placeholder={L('请输入英文标题', 'Enter English title')} {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              {/* Program / Subject / Sub-subject */}
              <div className="flex flex-wrap gap-4">
                <FormField control={form.control} name="program" render={({ field }) => (
                  <FormItem className="flex-1 min-w-[200px]">
                    <FormLabel>{L('班型', 'Program')}{reqStar}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger className="w-full">
                        <SelectValue placeholder={L('请选择班型', 'Select program')} />
                      </SelectTrigger></FormControl>
                      <SelectContent>
                        {structures.map((s) => (
                          <SelectItem key={s.program} value={s.program}>
                            {language === 'zh-CN' ? s.name : s.nameEn}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="subject" render={({ field }) => (
                  <FormItem className="flex-1 min-w-[200px]">
                    <FormLabel>{L('科目', 'Subject')}{reqStar}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value} disabled={!programValue}>
                      <FormControl><SelectTrigger className="w-full">
                        <SelectValue placeholder={L('请选择科目', 'Select subject')} />
                      </SelectTrigger></FormControl>
                      <SelectContent>
                        {currentProgram?.subjects.map((s) => (
                          <SelectItem key={s.key} value={s.key}>
                            {language === 'zh-CN' ? s.name : s.nameEn}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                {hasSubSubjects && (
                  <FormField control={form.control} name="subSubject" render={({ field }) => (
                    <FormItem className="flex-1 min-w-[200px]">
                      <FormLabel>{L('子科目', 'Sub-subject')}</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl><SelectTrigger className="w-full">
                          <SelectValue placeholder={L('请选择子科目', 'Select sub-subject')} />
                        </SelectTrigger></FormControl>
                        <SelectContent>
                          {currentSubjectNode?.children?.map((s) => (
                            <SelectItem key={s.key} value={s.key}>
                              {language === 'zh-CN' ? s.name : s.nameEn}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )} />
                )}
              </div>

              {/* Folder / Semester / Week */}
              <div className="flex flex-wrap gap-4">
                <FormField control={form.control} name="folderType" render={({ field }) => (
                  <FormItem className="flex-1 min-w-[200px]">
                    <FormLabel>{L('资料夹', 'Folder Type')}{reqStar}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger className="w-full">
                        <SelectValue placeholder={L('请选择资料夹', 'Select folder type')} />
                      </SelectTrigger></FormControl>
                      <SelectContent>
                        {FOLDER_TYPES.map((f) => (
                          <SelectItem key={f} value={f}>
                            {t(`folder.${f}` as never)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="semester" render={({ field }) => (
                  <FormItem className="flex-1 min-w-[160px]">
                    <FormLabel>{L('学期', 'Semester')}</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl><SelectTrigger className="w-full">
                        <SelectValue placeholder={L('请选择学期', 'Select semester')} />
                      </SelectTrigger></FormControl>
                      <SelectContent>
                        <SelectItem value="S1">{t('semester.s1')}</SelectItem>
                        <SelectItem value="S2">{t('semester.s2')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="weekNumber" render={({ field }) => (
                  <FormItem className="flex-1 min-w-[140px]">
                    <FormLabel>{L('周次', 'Week Number')}</FormLabel>
                    <FormControl>
                      <Input type="number" min={1} max={40} placeholder="1-40" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              {/* Theme (only for English) */}
              {isEnglish && (
                <FormField control={form.control} name="theme" render={({ field }) => (
                  <FormItem className="max-w-md">
                    <FormLabel>Theme</FormLabel>
                    <FormControl>
                      <Input placeholder={L('请输入 Theme 名称', 'Enter theme name')} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              )}

              {/* Description */}
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('common.description')}</FormLabel>
                  <FormControl>
                    <Textarea rows={4} placeholder={L('请输入描述', 'Enter description')} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              {/* File upload */}
              <ResourceFileUpload
                file={selectedFile}
                onFileChange={setSelectedFile}
                required
              />

              <div className="flex justify-end gap-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => submitResource('draft')}
                  disabled={submitLoading}
                >
                  {L('保存草稿', 'Save as Draft')}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  onClick={() => submitResource('pending_review')}
                  disabled={submitLoading}
                  className="bg-primary hover:bg-primary-dark"
                >
                  {t('btn.submitReview')}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
};

export default UploadPage;
