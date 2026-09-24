#!/usr/bin/env bash
# ============================================================
# 本地验证用 PostgreSQL（生产加固期间的验证环境）
# ============================================================
# 用途：在**没有 Docker / Homebrew / 系统 PostgreSQL** 的机器上，
#       拉起一个真实的 PostgreSQL 16 服务端，用于：
#         - 执行 migration
#         - 验证 RLS / 权限
#         - 跑真实数据库集成测试
#
# 说明：
#   * 该脚本安装的 PostgreSQL 二进制与数据目录都在 .devtools/ 下，
#     **不属于生产部署方案**，也不会进入 git（见 .gitignore）。
#   * 生产部署请使用 DEPLOYMENT_PRODUCTION.md。
#   * 本脚本不会修改任何业务数据；start/stop 只影响本地验证库。
#
# 用法：
#   bash scripts/dev-postgres.sh start     # 安装(首次)+初始化+启动
#   bash scripts/dev-postgres.sh stop      # 停止
#   bash scripts/dev-postgres.sh status    # 状态
#   bash scripts/dev-postgres.sh psql      # 用 node 打开交互式查询（无 psql 客户端）
#   bash scripts/dev-postgres.sh destroy   # 删除本地验证库与数据（不可恢复）
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVTOOLS="${QLS_DEVTOOLS_DIR:-$ROOT_DIR/.devtools}"
PGROOT="$DEVTOOLS/pg"
PGDATA="$PGROOT/pgdata"
LOGDIR="$PGROOT/logs"
PGBIN="$PGROOT/node_modules/@embedded-postgres/darwin-arm64/native/bin"
PGPORT="${QLS_DEV_PGPORT:-55432}"
PGUSER="${QLS_DEV_PGUSER:-qlsadmin}"
PGPASSWORD="${QLS_DEV_PGPASSWORD:-qlsdev_local_only}"
PGDATABASE="${QLS_DEV_PGDATABASE:-qls_kindergarten}"

log() { printf '[dev-postgres] %s\n' "$*"; }
die() { printf '[dev-postgres] ERROR: %s\n' "$*" >&2; exit 1; }

ensure_binaries() {
  if [ -x "$PGBIN/postgres" ]; then return 0; fi
  log "首次运行：安装真实 PostgreSQL 16 二进制到 $PGROOT"
  mkdir -p "$PGROOT"
  [ -f "$PGROOT/package.json" ] || (cd "$PGROOT" && npm init -y >/dev/null)
  (cd "$PGROOT" && npm install --no-fund --no-audit embedded-postgres@16.14.0-beta.17 >/dev/null)
  [ -x "$PGBIN/postgres" ] || die "安装失败：找不到 $PGBIN/postgres"
  log "PostgreSQL 二进制就绪：$("$PGBIN/postgres" --version)"
}

cmd_start() {
  ensure_binaries
  mkdir -p "$LOGDIR"
  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    log "initdb 到 $PGDATA"
    rm -rf "$PGDATA"
    "$PGBIN/initdb" -D "$PGDATA" -U "$PGUSER" \
      --auth-local=trust --auth-host=scram-sha-256 \
      --encoding=UTF8 --locale=C >"$LOGDIR/initdb.log" 2>&1
  fi
  if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    log "已经在运行（端口 $PGPORT）"
  else
    log "启动 PostgreSQL（127.0.0.1:$PGPORT，仅本地回环）"
    "$PGBIN/pg_ctl" -D "$PGDATA" -l "$LOGDIR/postgres.log" \
      -o "-p $PGPORT -c listen_addresses=127.0.0.1" start >/dev/null
    sleep 2
  fi
  # 设置密码 + 建库（走本地 trust socket）
  node -e "
    const postgres=require('$ROOT_DIR/node_modules/postgres');
    const admin=postgres({host:'/tmp',port:$PGPORT,user:'$PGUSER',database:'postgres',onnotice:()=>{}});
    (async()=>{
      await admin.unsafe(\"ALTER USER $PGUSER WITH PASSWORD '$PGPASSWORD'\");
      const ex=await admin\`select 1 from pg_database where datname='$PGDATABASE'\`;
      if(!ex.length) await admin.unsafe('CREATE DATABASE $PGDATABASE OWNER $PGUSER');
      await admin.end();
    })().catch(e=>{console.error(e.message);process.exit(1)});
  "
  log "就绪：postgres://$PGUSER@127.0.0.1:$PGPORT/$PGDATABASE"
  log "DATABASE_URL=postgres://$PGUSER:$PGPASSWORD@127.0.0.1:$PGPORT/$PGDATABASE"
}

cmd_stop() {
  [ -s "$PGDATA/PG_VERSION" ] || { log "尚未初始化"; return 0; }
  "$PGBIN/pg_ctl" -D "$PGDATA" stop -m fast >/dev/null 2>&1 && log "已停止" || log "未在运行"
}

cmd_status() {
  if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    log "RUNNING  (127.0.0.1:$PGPORT, data=$PGDATA)"
  else
    log "STOPPED"
  fi
}

cmd_psql() {
  node -e "
    const postgres=require('$ROOT_DIR/node_modules/postgres');
    const sql=postgres('postgres://$PGUSER:$PGPASSWORD@127.0.0.1:$PGPORT/$PGDATABASE',{onnotice:()=>{}});
    (async()=>{ const r=await sql.unsafe(process.argv[1]||'select 1 as ok');
      console.log(JSON.stringify(r,null,2)); await sql.end(); })()
      .catch(e=>{console.error(e.message);process.exit(1)});
  " "${1:-select current_database(), current_user, version()}"
}

cmd_destroy() {
  cmd_stop || true
  rm -rf "$PGROOT"
  log "已删除 $PGROOT（本地验证数据全部丢失）"
}

case "${1:-start}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  psql)    shift; cmd_psql "$@" ;;
  destroy) cmd_destroy ;;
  *) die "未知命令：$1（可用：start|stop|status|psql|destroy）" ;;
esac
