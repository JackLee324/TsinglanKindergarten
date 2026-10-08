import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { FolderPlus, Upload } from 'lucide-react'
import { useAuth } from '../auth/useAuth'
import { Button } from '../components/ui/Button'
import { UploadResourceDialog } from '../components/resource/UploadResourceDialog'
import { useDirectory } from '../directory/DirectoryProvider'
import { directoryUrl } from '../directory/path'
import { DirectoryBrowser } from '../directory/DirectoryBrowser'
import { Breadcrumb } from '../components/Breadcrumb'
import { Spinner } from '../components/ui/Spinner'
import { EmptyState } from '../components/ui/EmptyState'
import { ResourceList } from '../components/resource/ResourceList'
import { CreateFolderDialog } from '../components/directory/CreateFolderDialog'

/**
 * 目录浏览页。
 *
 * 路由是 `/directory/*`，把通配段交给目录树解析 —— **路由里没有任何目录名**。
 * 因此管理员新增一级栏目时，这里一行都不用改。
 *
 * 解析不到时显示"已回到最近可解析的祖先"，而不是 404：
 * 目录被改名/停用/移动之后，老链接仍然要能落到一个有意义的位置。
 */
export function DirectoryBrowsePage() {
  const params = useParams()
  const navigate = useNavigate()
  const segments = (params['*'] ?? '').split('/').filter((s) => s.length > 0)
  const { roots, ready, loading, resolve, refresh, error: treeError } = useDirectory()
  const { capabilities } = useAuth()
  const [uploading, setUploading] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)

  if (!ready && loading) return <Spinner label="正在加载目录…" />

  /*
    目录树没加载成功（断网、超时、服务端 5xx）时，**不能**掉进"找不到这个目录" ——
    那会把"网络问题"说成"这个目录不存在"，老师会以为目录被删了。
    （阶段 11 的手机验收就是这么抓到的：断网后页面写的是
     「地址里的 education / pre-k / virtue 已不存在或已被停用」。）

    判据是 `treeError !== null && roots.length === 0`：树根本没拿到 → 说清原因 + 重试。
    如果只是"已经有树、但某次刷新失败"，那就继续用手里这份树（不要把人踢到错误页）。
  */
  if (treeError !== null && roots.length === 0) {
    return (
      <div data-testid="directory-page">
        <div
          className="mt-6 flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-6"
          data-testid="directory-load-error"
        >
          <p className="text-sm text-destructive">目录没能加载出来：{treeError}</p>
          <Button type="button" variant="outline" onClick={() => void refresh()} data-testid="directory-retry">
            重试
          </Button>
        </div>
      </div>
    )
  }

  const target = resolve(segments)
  const unresolved = segments.slice(target.resolvedCount).join('/')

  if (target.node === null && segments.length > 0) {
    return (
      <div data-testid="directory-page">
        <div className="mb-5">
          <Breadcrumb chain={[]} />
        </div>
        <EmptyState
          title="找不到这个目录"
          description={`地址里的「${segments.join(' / ')}」已不存在或已被停用。请从左侧导航重新进入。`}
          testId="directory-not-found"
        />
      </div>
    )
  }

  const notice =
    unresolved.length > 0
      ? `地址中的「${unresolved}」已不存在或已被停用，已回到「${target.node?.name ?? '课程目录'}」。`
      : null

  return (
    <div data-testid="directory-page" data-directory-path={target.node?.path ?? ''}>
      <div className="mb-5">
        <Breadcrumb chain={target.chain} />
      </div>

      {target.node !== null && (
        <div className="mb-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1
              className="text-2xl font-semibold text-foreground"
              data-testid="directory-title"
              data-directory-id={target.node.id}
              data-directory-slug={target.node.slug}
            >
              {target.node.name}
            </h1>
            {/*
              「上传资源」只出现在**能放文件**的目录里（资料夹层），
              而且只有服务端说"你可以上传"（canUpload = resource.create）时才出现。
              这仍然不是安全边界 —— 接口自己会拒 —— 但界面不该把一个必然失败的操作摆出来。
            */}
            <div className="flex items-center gap-2">
              {/*
                「新建文件夹」只在**服务端说可以**的时候出现
                （`canCreateFolder` = 该目录 allow_custom_folders + 本人有
                `directory.create_folder` 且覆盖到这个目录）。
                它不是安全边界 —— 接口自己会拒 —— 但界面不该摆出一个必然失败的操作。
              */}
              {target.node.capabilities.canCreateFolder && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCreatingFolder(true)}
                  data-testid="directory-create-folder"
                >
                  <FolderPlus className="size-4" /> 新建文件夹
                </Button>
              )}
              {target.node.allowFiles && capabilities?.canUpload === true && (
                <Button
                  type="button"
                  onClick={() => setUploading(true)}
                  data-testid="directory-upload"
                >
                  <Upload className="size-4" /> 上传资源
                </Button>
              )}
            </div>
          </div>
          {target.node.description !== null && target.node.description !== '' ? (
            <p className="mt-1 text-sm text-muted-foreground" data-testid="directory-description">
              {target.node.description}
            </p>
          ) : (
            target.node.nameEn !== null && (
              <p className="mt-1 text-sm text-muted-foreground">{target.node.nameEn}</p>
            )
          )}
        </div>
      )}

      {target.node !== null && target.node.enabled === false && (
        <div
          className="mb-5 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
          data-testid="directory-disabled-notice"
        >
          这个目录已停用，普通教师看不到它。你是因为有管理权限才看得到。
        </div>
      )}

      <DirectoryBrowser node={target.node} roots={roots} notice={notice} />

      {/*
        资料夹层同时列出资源（业主 §2：进 教学资源 应该看到该 Directory 下的资源）。
        资源列表只认 `directoryId`，不再用 program + subject + folderType 推导。
      */}
      {target.node !== null && target.node.allowFiles && (
        <ResourceList directoryId={target.node.id} />
      )}

      {/*
        上传弹窗：`directoryId` 与路径都来自**当前这个目录页** ——
        老师不需要（也没有机会）在这里重选班型/科目/资料夹。
      */}
      {/* 新建文件夹：名称 + 可选英文名。建完直接进去（老师建它的目的就是往里放东西）。 */}
      <CreateFolderDialog
        open={creatingFolder}
        parent={target.node}
        onClose={() => setCreatingFolder(false)}
        onCreated={(node) => {
          setCreatingFolder(false)
          refresh()
          navigate(directoryUrl(node.path))
        }}
      />

      {uploading && target.node !== null && (
        <UploadResourceDialog
          open={uploading}
          directoryId={target.node.id}
          directoryPath={target.node.path}
          onClose={() => setUploading(false)}
          onCreated={(resourceId) => {
            setUploading(false)
            // 上传完直接进详情页：业主要的"上传成功之后能立刻看到它在哪、有什么"。
            navigate(`/resources/${resourceId}`)
          }}
        />
      )}
    </div>
  )
}
