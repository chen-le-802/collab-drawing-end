# 生产运维最小清单

## 一、部署前必跑
1. `pnpm preflight:full`
2. `pnpm migrate:status`
3. 新库首次部署：`pnpm migrate:baseline && pnpm migrate`
4. 旧库增量部署：`pnpm migrate`
5. 启动服务：`pnpm start`

## 二、生产环境必配变量
- `NODE_ENV=production`
- `JWT_SECRET`（建议 >= 32 字符）
- `REDIS_ENABLED=true` 时必须配置 `REDIS_PASSWORD`
- 上传限制：
  - `AVATAR_MAX_SIZE_MB`
  - `SESSION_IMAGE_MAX_SIZE_MB`
- 限流：
  - `LOGIN_RATE_LIMIT_WINDOW_SECONDS`
  - `LOGIN_RATE_LIMIT_MAX`
  - `INVITE_RATE_LIMIT_WINDOW_SECONDS`
  - `INVITE_RATE_LIMIT_MAX`
  - `EXPORT_RATE_LIMIT_WINDOW_SECONDS`
  - `EXPORT_RATE_LIMIT_MAX`

## 三、备份策略
### 1) 手工执行一次备份
- `pnpm backup:once`

### 2) 启动定时备份进程
- `pnpm backup:daemon`
- 相关配置：
  - `DB_BACKUP_DIR`（默认 `backups/mysql`）
  - `DB_BACKUP_RETENTION_DAYS`（默认 7）
  - `DB_BACKUP_SCHEDULE_MINUTES`（默认 1440）

## 四、告警与日志关注点
- 4001 服务器错误：日志中 `type=system_alert`，key 包含：
  - `api.error.4001.user`
  - `api.error.4001.session`
  - `api.error.4001.graphic`
- Redis 断连/重连：
  - `redis.connection.end`
  - `redis.connection.reconnecting`
  - `redis.connection.error`
- DB 巡检失败：
  - `db.connection.error`

## 五、答辩可讲的稳定性点
- 迁移有执行记录与校验（`schema_migrations + checksum`）
- 协同主链路有回归测试（create/update/delete -> undo/redo -> restore）
- 生产配置有硬校验（runtime guard）
- 备份 + 告警形成最小故障恢复闭环
