#!/usr/bin/env node
/**
 * deploy/rehearsal-v1-bridge.mjs —— 本地演练专用：把宿主机回环上的 V1 库暴露给容器
 * ============================================================================
 * **只用于本机演练。** 生产不需要它：生产的 V1 库对应用机器是可达的
 * （Zeabur 内网，或迁移当天开一条只读隧道）。
 *
 * 为什么需要：本机 Postgres 只监听 127.0.0.1，而容器里的 `host.docker.internal`
 * 到不了宿主机的回环地址。于是这里起一个**只转发不存数据**的 TCP 桥：
 *
 *     容器 → host.docker.internal:15543 → 127.0.0.1:55432
 *
 * 这样导入就可以**在应用容器里跑**（`docker compose exec app node scripts/import-v1.mjs`），
 * 存储/密钥环境与应用完全一致 —— 这一步很重要：本地就踩过"导入脚本用了默认的 local
 * 存储驱动、把文件写到了另一个地方，而库里已经登记好了行"的坑。
 *
 * 用法：node deploy/rehearsal-v1-bridge.mjs        # 前台（Ctrl-C 停）
 */
import { createServer, connect } from 'node:net'

const LISTEN_PORT = Number(process.env.BRIDGE_PORT ?? 15543)
const TARGET_HOST = '127.0.0.1'
const TARGET_PORT = Number(process.env.BRIDGE_TARGET_PORT ?? 55432)

let connections = 0
const server = createServer((client) => {
  const upstream = connect(TARGET_PORT, TARGET_HOST)
  connections += 1
  client.pipe(upstream)
  upstream.pipe(client)
  const close = () => {
    client.destroy()
    upstream.destroy()
  }
  client.on('error', close)
  upstream.on('error', close)
  client.on('close', () => upstream.destroy())
  upstream.on('close', () => client.destroy())
})

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`V1 桥已启动：0.0.0.0:${LISTEN_PORT} → ${TARGET_HOST}:${TARGET_PORT}（当前连接 ${connections}）`)
})
process.on('SIGINT', () => {
  console.log('桥已停止')
  process.exit(0)
})
