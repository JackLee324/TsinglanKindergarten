import React, { useEffect, useMemo, useRef, useState } from 'react';

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
import { extractApiErrorCode } from '@client/src/api/client';
import { createResource, getResource, getUploadUrl, putFileBytes, registerResourceFile, submitReview, updateResource } from '@client/src/api/resources';
import { getCurriculumStructure } from '@client/src/api/curriculum';
import { getDirectoryTree } from '@client/src/api/directories';
import type { DirectoryNode, FolderType, ProgramCode, ProgramStructure, Resource } from '@shared/api.interface';
import { FOLDER_TYPES } from '@shared/api.interface';

import { ResourceFileUpload } from './ResourceFileUpload';

const uploadSchema = z.object({
  title: z.string().min(1, 'upload.titleRequired'),
  titleEn: z.string().optional(),
  program: z.string().min(1, 'upload.programRequired'),
  subject: z.string().min(1, 'upload.subjectRequired'),
  subSubject: z.string().optional(),
  folderType: z.string().min(1, 'upload.folderRequired'),
  /**
   * §1 目录归属（可编辑目录树节点的 **id**）。
   * 可选 —— 留空表示"尚未归属"，而不是由客户端猜一个默认目录。
   * 注意它与上面 `folderType` 是**两个维度**：`folderType` 是 legacy 资料夹分类，
   * 这一项才是"放进哪个可编辑目录"。
   */
  directoryId: z.string().optional(),
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
  /**
   * 可编辑目录树（§1），拍平成"可选目录归属"的候选列表。
   *
   * 这是**页面自己不去维护课程数组**的另一半：候选目录全部来自
   * `GET /api/directories/tree`（服务端已按角色 scope 剪枝），
   * 因此老师只可能看到、也只可能选到他有权限的目录 ——
   * 页面既不复刻权限规则，也不预置任何目录名。
   */
  const [directoryOptions, setDirectoryOptions] = useState<
    Array<{ id: string; label: string; program: string | null; subject: string | null }>
  >([]);

  const form = useForm<UploadFormData>({
    resolver: zodResolver(uploadSchema),
    defaultValues: {
      title: '', titleEn: '', program: '', subject: '', subSubject: '',
      folderType: '', directoryId: '', semester: '', weekNumber: '', theme: '', description: '',
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

  // §1：拉一次目录树，拍平成下拉候选。
  // 失败时**不写死任何兜底目录**（那会变成一个凭空的归属），只是让下拉为空。
  useEffect(() => {
    const load = async () => {
      try {
        const tree = await getDirectoryTree();
        const out: Array<{ id: string; label: string; program: string | null; subject: string | null }> = [];
        const walk = (nodes: DirectoryNode[], prefix: string[]) => {
          for (const node of nodes) {
            // 根节点只用来提供路径前缀，本身不作为归属目标。
            const path = node.code.startsWith('root:') ? prefix : [...prefix, node.name];
            if (node.type !== 'root' && node.type !== 'section' && node.type !== 'program') {
              out.push({
                id: node.id,
                label: `${prefix.join(' / ')}${prefix.length ? ' / ' : ''}${node.name}`,
                program: node.program,
                subject: node.subject,
              });
            }
            walk(node.children ?? [], path);
          }
        };
        walk(tree.roots ?? [], []);
        setDirectoryOptions(out);
      } catch (error) {
        logger.error('[Upload] load directory tree failed', String(error));
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
          directoryId: r.directoryId ?? '',
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

  // 班型/科目变化时清掉下级选择 —— 但**只在用户真的换了**、且原选择在新班型里
  // 已不存在时才清。
  //
  // 这里以前是两段无条件清空：
  //     useEffect(() => { form.setValue('subject',''); form.setValue('subSubject',''); }, [programValue])
  //     useEffect(() => { form.setValue('subSubject',''); }, [subjectValue])
  //
  // 它们分不清"用户在换班型"和"编辑页刚把资源预填进来"：编辑页 `form.reset()`
  // 会把 program 从 '' 变成资源真实的班型，这个变化同样触发第一段，于是刚填好的
  // subject 立刻被清掉；第二段又把 subSubject 清掉。后果不是报错而是**点了没反应**：
  // 提交时 `form.trigger` 校验失败，`submitResource` 直接 return，既不保存也不提示。
  // 实测证据（编辑页，资源 prek/virtue）：点「保存草稿」后路径仍是 /upload?id=…，
  // 页面只多出 `upload.subjectRequired`，没有任何 toast。
  const prevProgramRef = useRef<string>(programValue);
  useEffect(() => {
    const prev = prevProgramRef.current;
    if (prev === programValue) return;
    prevProgramRef.current = programValue;
    // 首次落值（含编辑页预填）不清空：此时还没有"用户的选择"可以作废。
    if (!prev) return;
    const program = structures.find((s) => s.program === programValue);
    // 结构还没加载出来时不判断，避免把有效选择误清掉。
    if (!program) return;
    const stillValid = program.subjects.some((s) => s.key === subjectValue);
    if (!stillValid) {
      form.setValue('subject', '');
      form.setValue('subSubject', '');
    }
  }, [programValue, subjectValue, structures, form]);

  const prevSubjectRef = useRef<string>(subjectValue);
  useEffect(() => {
    const prev = prevSubjectRef.current;
    if (prev === subjectValue) return;
    prevSubjectRef.current = subjectValue;
    // 同上：首次落值（编辑页预填 subSubject）不清空。
    if (!prev) return;
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
    const valid = await form.trigger(['title', 'program', 'subject', 'folderType']);
    if (!valid) {
      // 以前这里是无声 `return`：点了「保存草稿」既不保存也不提示，用户看到的是
      // "点了没反应"，而日志里连一行都不会有。校验失败是**用户的输入问题**，
      // 必须说出来，否则他只会反复点同一个按钮。
      toast.error(
        L(
          '请先补全必填项（标题、班型、科目、资料夹）后再保存',
          'Please complete the required fields (title, program, subject, folder type) before saving',
        ),
      );
      return;
    }
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
        // §1：只在真的选了目录时才传；空字符串会被服务端当作"没传"（不归属）。
        directoryId: data.directoryId || undefined,
        fileName: selectedFile?.name,
        fileSize: selectedFile?.size,
        fileType: selectedFile?.type,
      };
      // §4/§23 真实上传：三步分开，失败位置不同、提示也必须不同。
      // 返回一个"上传结论"，最后由 toast 如实说清楚，而不是笼统的"成功/失败"。
      // 结论由**返回值**给出，而不是写在外层变量上：写在闭包里 TS 无法在闭包外
      // 收窄类型（实测报 TS2367 "no overlap"），而那种报错会诱使人用 as any 掩盖。
      let fileOutcome: 'none' | 'uploaded' | 'not_configured' | 'failed' = 'none';
      let fileError = '';

      /** 拿到资源 id 后真正把字节送上去并登记。 */
      const uploadSelectedFile = async (
        targetId: string,
      ): Promise<'none' | 'uploaded' | 'not_configured' | 'failed'> => {
        if (!selectedFile) return 'none';
        try {
          const loc = await getUploadUrl(targetId, selectedFile.name);
          await putFileBytes(loc.uploadUrl, selectedFile);
          await registerResourceFile(targetId, selectedFile, loc);
          return 'uploaded';
        } catch (uploadError) {
          // 存储未配置时服务端返回 503 —— 那是**能力边界**，不是错误操作。
          // 两者要分开提示，否则用户会以为是自己传错了文件。
          //
          // 必须按服务端的**机器可读错误码**判断，不能按错误文本：axios 错误的
          // `message` 只是 `Request failed with status code 503`，用文本匹配
          // 那条 `not_configured` 分支永远进不去（实测：未接存储时老师看到的是
          // 笼统的"文件上传失败：…503"，而不是"文件没有上传：服务端没有配置对象存储"）。
          const code = extractApiErrorCode(uploadError);
          const msg = uploadError instanceof Error ? uploadError.message : String(uploadError);
          fileError = msg;
          logger.warn('[Upload] file upload failed', `${code ?? '(no code)'} ${msg}`);
          // 文本匹配只作为兜底：代理若剥掉了响应体，码就取不到，
          // 但服务端那句"文件存储后端未接入"仍可能出现在消息里。
          const notConfigured =
            code === 'STORAGE_NOT_CONFIGURED' || /STORAGE_NOT_CONFIGURED|未接入|未配置/.test(msg);
          return notConfigured ? 'not_configured' : 'failed';
        }
      };

      if (editId) {
        await updateResource(editId, { ...base, status });
        fileOutcome = await uploadSelectedFile(editId);
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
        fileOutcome = await uploadSelectedFile(created.id);

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
      // 现在客户端确实会走真实上传（取预签名 URL → PUT 字节 → 登记），但上传是
      // 可能失败的：服务端没配对象存储时登记接口会 503 拒绝。所以"选了文件"与
      // "文件已在平台上"仍然是两件事，不能用一个绿色的「已保存」把区别盖掉 ——
      // 老师会以为文件已经在平台上了。四种结论分别如实播报。
      if (selectedFile && fileOutcome === 'uploaded') {
        toast.success(t('upload.fileUploaded'));
      } else if (fileOutcome === 'not_configured') {
        toast.warning(t('upload.storageNotConfigured'));
      } else if (fileOutcome === 'failed') {
        // 资源存下来了、文件没上去 —— 必须同时说清楚两件事。
        toast.warning(`${t('upload.fileUploadFailed')}${fileError ? '：' + fileError : ''}`);
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

              {/*
                §1 目录归属 —— 与上面的「资料夹」是**两个维度**，不是二选一：
                · 资料夹（folderType）是 legacy 分类，历史数据在用，保留；
                · 目录归属（directoryId）决定这份资源出现在可编辑目录树的哪个节点下。
                留空 = 尚未归属，服务端存 NULL，界面如实显示"未归属"。
              */}
              <FormField control={form.control} name="directoryId" render={({ field }) => (
                <FormItem className="max-w-xl">
                  <FormLabel>{L('目录归属', 'Directory')}</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value ?? ''}
                    disabled={!programValue || directoryOptions.length === 0}
                  >
                    <FormControl><SelectTrigger className="w-full">
                      <SelectValue placeholder={
                        directoryOptions.length === 0
                          ? L('暂无可选目录', 'No directory available')
                          : L('请选择所属目录（可留空）', 'Select a directory (optional)')
                      } />
                    </SelectTrigger></FormControl>
                    <SelectContent>
                      {directoryOptions
                        // 只列出与所选班型一致的目录。科目还不一致时也一并列出，
                        // 由**服务端**做最终判定 —— 前端筛选只是减少误选，
                        // 不是权限边界（服务端会 400 拒绝跨班型/跨科目的归属）。
                        .filter((o) => !programValue || o.program === null || o.program === programValue)
                        .map((o) => (
                          <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )} />

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
