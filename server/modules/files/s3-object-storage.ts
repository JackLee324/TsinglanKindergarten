import { createHash, createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  STORAGE_UNAVAILABLE_CODE,
  STORAGE_UNAVAILABLE_MESSAGE,
  storageUnavailable,
  type ObjectStorage,
  type SignedUrlRequest,
} from './object-storage';

/**
 * S3 兼容对象存储（AWS S3 / Cloudflare R2 / MinIO / 阿里云 OSS …）。
 * =============================================================================
 *
 * WHY THIS IS HAND-WRITTEN INSTEAD OF USING @aws-sdk/client-s3
 * -----------------------------------------------------------
 * 本机**不能**再跑 `npm install` —— 它会按当前平台的 lockfile 裁剪掉
 * `*-darwin-arm64` 一类平台二进制（这个项目的构建已经因此坏过一次，见
 * BEFORE_FINAL_AUDIT 的环境注意事项）。所以"加一个 SDK"这条路是关着的。
 *
 * 而 S3 的**预签名 URL** 本身并不需要 SDK：它就是 AWS Signature V4 ——
 * 一组确定性的哈希与 HMAC 链，`node:crypto` 足够。手写反而少了一层依赖，
 * 也让"签名到底签了什么"是可见的。
 *
 * 关于正确性的诚实说明：手写签名容易在**边界**上出错（特殊字符的编码、
 * 会话令牌、非默认端口、路径风格 vs 虚拟主机风格）。因此本实现：
 *   · 只支持 path-style 寻址（MinIO / R2 的 S3 端点都支持，配置简单、无歧义）；
 *   · 明确支持 STS 会话令牌（`X-Amz-Security-Token` 参与签名）；
 *   · 用**真实字节往返**验证过（PUT 上传 → GET 下载 → 内容逐字节一致），
 *     而不是只看"URL 拼出来了"。
 *
 * ⚠️ 已验证的环境是**本机 MinIO**，不是生产 bucket。生产上仍需用真实凭据跑一次
 *    同一套验证（scripts/verify-storage-put-get.mjs）。
 */

export const S3_ENV = {
  endpoint: 'S3_ENDPOINT',
  region: 'S3_REGION',
  bucket: 'S3_BUCKET',
  accessKeyId: 'S3_ACCESS_KEY_ID',
  secretAccessKey: 'S3_SECRET_ACCESS_KEY',
  sessionToken: 'S3_SESSION_TOKEN',
  forcePathStyle: 'S3_FORCE_PATH_STYLE',
} as const;

interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** 读取配置；缺任何一项都返回 null（**不猜测**、不给默认凭据）。 */
export function readS3Config(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const endpoint = (env[S3_ENV.endpoint] ?? '').trim();
  const bucket = (env[S3_ENV.bucket] ?? '').trim();
  const accessKeyId = (env[S3_ENV.accessKeyId] ?? '').trim();
  const secretAccessKey = (env[S3_ENV.secretAccessKey] ?? '').trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: (env[S3_ENV.region] ?? 'us-east-1').trim() || 'us-east-1',
    sessionToken: (env[S3_ENV.sessionToken] ?? '').trim() || undefined,
  };
}

// ---------------------------------------------------------------------------
// AWS Signature V4（presigned query 形式）
// ---------------------------------------------------------------------------

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * S3 的 URI 编码规则（与 `encodeURIComponent` **不同**）：保留 `-_.~`，
 * 其余全部百分号编码，且空格必须是 `%20` 而不是 `+`。
 * 用 `encodeURIComponent` 会漏掉 `!'()*` 这几个字符，签名与服务端算出来的不一致 ——
 * 这正是手写签名最常见的失败点之一。
 */
function s3Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 对象键必须逐段编码，`/` 保留。 */
function encodeKeyPath(key: string): string {
  return key.split('/').map(s3Encode).join('/');
}

function formatAmzDate(d: Date): { amzDate: string; dateStamp: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export interface PresignedUrlOptions {
  method: 'GET' | 'PUT';
  bucketId: string;
  filePath: string;
  ttlSeconds: number;
  now?: Date;
}

/**
 * 生成预签名 URL。
 *
 * 只签 `host` 一个头（外加会话令牌），不签 `content-type` 等 —— 这样调用方
 * 传字节时不必精确复刻请求头，而安全性不受影响：能改的是未参与签名的头，
 * 而 S3 对 PUT 的内容校验本就由 bucket 策略/校验和负责。
 */
export function presignS3Url(cfg: S3Config, opts: PresignedUrlOptions): string {
  const now = opts.now ?? new Date();
  const { amzDate, dateStamp } = formatAmzDate(now);
  const ttl = Math.max(1, Math.min(7 * 24 * 3600, Math.floor(opts.ttlSeconds)));
  const service = 's3';

  const url = new URL(cfg.endpoint);
  const host = url.host;
  const scheme = url.protocol.replace(':', '');
  // path-style：/{bucket}/{key}
  const canonicalUri = `/${s3Encode(opts.bucketId)}/${encodeKeyPath(opts.filePath)}`;

  const scope = `${dateStamp}/${cfg.region}/${service}/aws4_request`;
  const query = new Map<string, string>([
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${cfg.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(ttl)],
    ['X-Amz-SignedHeaders', 'host'],
  ]);
  if (cfg.sessionToken) query.set('X-Amz-Security-Token', cfg.sessionToken);

  const canonicalQuery = [...query.entries()]
    .map(([k, v]) => [s3Encode(k), s3Encode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const basePath = url.pathname.replace(/\/+$/, '');
  return `${scheme}://${host}${basePath}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * 已配置的 S3 后端。
 *
 * `createSignedUrl` 只在 `bucketId` 与配置的 bucket **一致**时签名 ——
 * 否则就是拿 A 桶的凭据去给 B 桶签名，看似能生成 URL，实际必然 403
 * （或者更糟：如果凭据恰好对另一个桶有效，就等于越权）。
 * 这也正是之前"客户端随便编一个 bucket 名"能写进行里的那条路径，必须堵住。
 */
export class S3ObjectStorage implements ObjectStorage {
  readonly name = 's3';
  private readonly logger = new Logger(S3ObjectStorage.name);
  private readonly cfg: S3Config;

  constructor(cfg: S3Config) {
    this.cfg = cfg;
  }

  isConfigured(): Promise<boolean> {
    return Promise.resolve(true);
  }

  /** 配置里指定的那个 bucket（用于校验客户端传来的 bucketId）。 */
  get bucket(): string {
    return this.cfg.bucket;
  }

  async createSignedUrl(request: SignedUrlRequest): Promise<string> {
    if (request.bucketId !== this.cfg.bucket) {
      // 不静默改用配置的桶：那会把"写错了桶"变成一个看不见的行为差异。
      this.logger.error(
        `refusing to sign a URL for bucket '${request.bucketId}': this deployment is configured for '${this.cfg.bucket}'`,
      );
      throw storageUnavailable(
        STORAGE_UNAVAILABLE_CODE,
        `${STORAGE_UNAVAILABLE_MESSAGE}（bucket 不匹配：请求的是 ${request.bucketId}，本部署配置的是 ${this.cfg.bucket}）`,
      );
    }
    return presignS3Url(this.cfg, {
      method: 'GET',
      bucketId: request.bucketId,
      filePath: request.filePath,
      ttlSeconds: request.ttlSeconds,
    });
  }

  /** 预签名 PUT：供客户端直传字节（服务端不中转文件内容）。 */
  createPresignedUploadUrl(request: SignedUrlRequest): string {
    if (request.bucketId !== this.cfg.bucket) {
      throw storageUnavailable(
        STORAGE_UNAVAILABLE_CODE,
        `${STORAGE_UNAVAILABLE_MESSAGE}（bucket 不匹配）`,
      );
    }
    return presignS3Url(this.cfg, {
      method: 'PUT',
      bucketId: request.bucketId,
      filePath: request.filePath,
      ttlSeconds: request.ttlSeconds,
    });
  }
}
