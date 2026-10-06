import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import { useDirectory } from '@client/src/directory/DirectoryProvider';
import { extractApiErrorCode } from '@client/src/api/client';
import { createResource, getResource, getUploadUrl, putFileBytes, registerResourceFile, submitReview, updateResource } from '@client/src/api/resources';
import type { DirectoryNode, FolderType, ProgramCode, Resource } from '@shared/api.interface';
import { normalizeSubSubject } from '@shared/curriculum';

import { ResourceFileUpload } from './ResourceFileUpload';

const uploadSchema = z.object({
  title: z.string().min(1, 'upload.titleRequired'),
  titleEn: z.string().optional(),
  program: z.string().min(1, 'upload.programRequired'),
  subject: z.string().min(1, 'upload.subjectRequired'),
  subSubject: z.string().optional(),
  /**
   * legacy 资料夹分类。**上传时不再让老师选**（§7）。
   *
   * 它仍然留在表单里，只因为**编辑历史资源**时要能把库里已有的值原样带回去、
   * 保存时不丢。新建时它是空字符串，服务端按 `directoryId` 自动推导。
   */
  folderType: z.string().optional(),
  /**
   * 目录归属（可编辑目录树节点的 **id**）。**必填**（§8）。
   *
   * 「没有 directoryId → 不能提交保存」是业主的硬要求：资源必须落在目录树上，
   * 否则就会出现"库里有这条资源、老师在目录里怎么点都找不到"。
   * 留空不再表示"尚未归属"，而是**交不上去**。
   */
  directoryId: z.string().min(1, 'upload.directoryRequired'),
  semester: z.string().optional(),
  weekNumber: z.string().optional(),
  theme: z.string().optional(),
  description: z.string().optional(),
});

type UploadFormData = z.infer<typeof uploadSchema>;

const UploadPage: React.FC = () => {
  const { t, language } = useTranslation();
  const { roots, flatten, pathTo } = useDirectory();
  const navigate = useNavigate();

  /** 目录下拉的显示文案：从根到自己的名字用 ` / ` 连接。 */
  const nodePathLabel = useCallback(
    (node: DirectoryNode): string => pathTo(node.code).map((x) => x.name).join(' / '),
    [pathTo],
  );
  const [searchParams] = useSearchParams();
  const editId = searchParams.get('id');

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

  const form = useForm<UploadFormData>({
    resolver: zodResolver(uploadSchema),
    defaultValues: {
      title: '', titleEn: '', program: '', subject: '', subSubject: '',
      folderType: '', directoryId: '', semester: '', weekNumber: '', theme: '', description: '',
    },
  });

  const programValue = form.watch('program');
  const subjectValue = form.watch('subject');

  /**
   * 班型 / 科目 / 子科目的候选**全部来自数据库那棵目录树**。
   *
   * 以前这里读的是 `getCurriculumStructure()` —— 也就是 `shared/curriculum.ts`
   * 里的**常量**。于是上传页是最后一份"另一套课程结构"：管理员在
   * `/directory/manage` 把「美德」改名成「美德课程」，侧边栏、首页、目录页、
   * 面包屑都跟着变了，**唯独上传页的下拉还写着「美德」**。
   * 这恰好就是业主说的「目录页叫 A、首页叫 B、侧边栏叫 C」的第三份副本。
   *
   * 现在它与其它页面读同一份数据（`useDirectory()`），
   * 而且候选只列**真的有资料夹可放**的科目 —— 一个连资料夹都没有的科目，
   * 让老师选了也只会得到"没地方放"。
   */
  const uploadScope = useMemo(() => {
    const eduRoot = roots.find((r) => r.code === 'root:edu');
    const programs: Array<{ code: string; name: string; nameEn: string }> = [];
    const subjectsByProgram: Record<string, Array<{ token: string; name: string; nameEn: string; node: DirectoryNode }>> = {};
    const subSubjectsByNode: Record<string, Array<{ token: string; name: string; nameEn: string }>> = {};

    for (const program of eduRoot?.children ?? []) {
      if (program.type !== 'program' || program.program === null) continue;
      const programCode = program.program;
      const subjects: Array<{ token: string; name: string; nameEn: string; node: DirectoryNode }> = [];

      for (const subjectNode of program.children) {
        if (subjectNode.type !== 'subject' || subjectNode.subject === null) continue;
        // 只保留"往下能找到资料夹"的科目 —— 资源只能挂在资料夹上。
        const reachable = flatten(subjectNode).some((n) => n.type === 'folder');
        if (!reachable) continue;
        subjects.push({
          token: subjectNode.subject,
          name: subjectNode.name,
          nameEn: subjectNode.nameEn,
          node: subjectNode,
        });

        const subs: Array<{ token: string; name: string; nameEn: string }> = [];
        for (const child of flatten(subjectNode)) {
          if (child.type !== 'sub_subject') continue;
          // 数据库里存的是规范子科目 token（`reading` 等），而目录节点只给出
          // 路径式 code，所以用 shared/curriculum 的归一化函数换算 ——
          // 与读取路径用的是同一个函数，不自己拼字符串。
          const lastSegment = child.code.split(':').pop() ?? '';
          const token = normalizeSubSubject(programCode as ProgramCode, subjectNode.subject, lastSegment);
          if (token === null) continue;
          subs.push({ token, name: child.name, nameEn: child.nameEn });
        }
        if (subs.length > 0) subSubjectsByNode[subjectNode.code] = subs;
      }

      if (subjects.length === 0) continue;
      programs.push({ code: programCode, name: program.name, nameEn: program.nameEn });
      subjectsByProgram[programCode] = subjects;
    }

    const currentProgramSubjects = subjectsByProgram[programValue] ?? [];
    const currentSubject = currentProgramSubjects.find((x) => x.token === subjectValue) ?? null;
    const currentSubSubjects = currentSubject === null ? [] : subSubjectsByNode[currentSubject.node.code] ?? [];

    return {
      programs,
      currentProgramSubjects,
      currentSubject,
      currentSubSubjects,
      hasSubSubjects: currentSubSubjects.length > 0,
    };
  }, [roots, flatten, programValue, subjectValue]);

  /**
   * 目录下拉的候选 = **资料夹叶节点**（含老师自建的子文件夹）。
   *
   * 与 §7 之后服务端的口径逐字一致：资源只能挂在具体资料夹下，不能挂在科目/子科上。
   * 前端只列可选项是**减少误选**，不是权限边界 —— 真正拒绝越权与非法层级的
   * 仍然是服务端（见 resolveDirectoryAssignment 的 `requireLeafFolder`）。
   * 两边若不一致，用户会看到"能选、但提交被拒"，那是最难自查的一类缺陷；
   * 所以这里刻意与 `requireLeafFolder` 对齐。
   *
   * 数据来自 `useDirectory()`（与侧边栏、首页、目录页同一份），
   * 而**不是**再单独 `getDirectoryTree()` 拉一次 —— 后者会拿到另一份快照，
   * 改名之后两个页面可能显示不同的名字。
   */
  const directoryOptions = useMemo(
    () =>
      flatten()
        .filter((node) => node.type === 'folder')
        .map((node) => ({ id: node.id, label: nodePathLabel(node), program: node.program, subject: node.subject })),
    [flatten, nodePathLabel],
  );

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
    const subjects = uploadScope.currentProgramSubjects;
    // 目录树还没加载出来时不判断，避免把有效选择误清掉。
    if (subjects.length === 0) return;
    const stillValid = subjects.some((x) => x.token === subjectValue);
    if (!stillValid) {
      form.setValue('subject', '');
      form.setValue('subSubject', '');
    }
  }, [programValue, subjectValue, uploadScope, form]);

  const prevSubjectRef = useRef<string>(subjectValue);
  useEffect(() => {
    const prev = prevSubjectRef.current;
    if (prev === subjectValue) return;
    prevSubjectRef.current = subjectValue;
    // 同上：首次落值（编辑页预填 subSubject）不清空。
    if (!prev) return;
    form.setValue('subSubject', '');
  }, [subjectValue, form]);

  const hasSubSubjects = uploadScope.hasSubSubjects;
  const isEnglish = subjectValue === 'english';

  const L = (zh: string, en: string) => (language === 'zh-CN' ? zh : en);
  const reqStar = <span className="text-destructive">*</span>;

  const submitResource = async (status: 'draft' | 'pending_review') => {
    if (status === 'pending_review' && !selectedFile) {
      toast.error(L('请上传文件', 'Please upload a file'));
      return;
    }
    const valid = await form.trigger(['title', 'program', 'subject', 'directoryId']);
    if (!valid) {
      // 以前这里是无声 `return`：点了「保存草稿」既不保存也不提示，用户看到的是
      // "点了没反应"，而日志里连一行都不会有。校验失败是**用户的输入问题**，
      // 必须说出来，否则他只会反复点同一个按钮。
      toast.error(
        L(
          '请先补全必填项（标题、班型、科目、所属目录）后再保存',
          'Please complete the required fields (title, program, subject, directory) before saving',
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
        // §8：目录归属必填，原样传给服务端（服务端再判存在性/层级/scope）。
        directoryId: data.directoryId,
        // §7：folderType 不再要求老师选。只有当**编辑历史资源**带着库里已有的值
        // 回来时才原样回传（否则会把它改掉）；新建时留空是正常情况，
        // 由服务端按目录推导。**前端不做推导** —— 推导规则只有服务端那一份。
        folderType: (data.folderType || undefined) as FolderType | undefined,
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
                        {uploadScope.programs.map((s) => (
                          <SelectItem key={s.code} value={s.code}>
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
                        {uploadScope.currentProgramSubjects.map((s) => (
                          <SelectItem key={s.token} value={s.token}>
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
                          {uploadScope.currentSubSubjects.map((s) => (
                            <SelectItem key={s.token} value={s.token}>
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

              {/*
                §7：这里**不再有「资料夹」下拉**。
                以前老师必须从 6 个 legacy 值（课程大纲/周次教案/课件与示范/
                素材与工作单/观察与评价/教研归档）里选一个，而 PDF 只规定了
                4 个资料夹 —— 于是同一份东西在哪一栏，取决于当时是谁上传的。
                现在老师只选「所属目录」，`folder_type` 由服务端按目录推导
                （映射表只有一份，见 server/modules/directories/legacy-folder-mapping.ts）。
                编辑历史资源时，库里已有的值仍会原样带回并保留。
              */}
              <div className="flex flex-wrap gap-4">
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
                §8 目录归属 —— **必填**。
                「没有 directoryId → 不能提交保存」是业主的硬要求：资源必须落在
                目录树上，否则就会出现"库里有这条资源、老师在目录里怎么点都找不到"。
                历史资源允许 directory_id 为 NULL（由管理员在
                /admin/unassigned-resources 批量补），但**新建不再产生新的 NULL**。
              */}
              <FormField control={form.control} name="directoryId" render={({ field }) => (
                <FormItem className="max-w-xl">
                  <FormLabel>{L('所属目录', 'Directory')}{reqStar}</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value ?? ''}
                    disabled={!programValue || directoryOptions.length === 0}
                  >
                    <FormControl><SelectTrigger className="w-full" data-testid="upload-directory">
                      <SelectValue placeholder={
                        directoryOptions.length === 0
                          ? L('暂无可选目录', 'No directory available')
                          : L('请选择所属目录', 'Select a directory')
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
                  <p className="text-xs text-muted-foreground" data-testid="upload-directory-note">
                    {L(
                      '资源会出现在该目录下。历史资料夹分类由系统按目录自动归类，无需选择。',
                      'The resource will appear under this directory. The legacy folder classification is derived automatically from it.',
                    )}
                  </p>
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
