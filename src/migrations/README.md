# 数据库迁移使用说明

## 一、迁移文件规范
- 基线文件：`collab_drawing_db.sql`（用于新环境一次性建库建表）
- 增量文件：`YYYY-MM-DD_描述.sql`（例如 `2026-05-16_add_performance_indexes.sql`）
- 已经在生产执行过的增量文件不要改内容；后续变更请新建一个新的增量文件

## 二、可用命令
- 部署前基础检查：`pnpm preflight`
- 部署前完整检查（含 MySQL/Redis 连通性）：`pnpm preflight:full`
- 查看迁移状态：`pnpm migrate:status`
- 执行增量迁移：`pnpm migrate`
- 执行基线迁移（仅新库初始化时使用）：`pnpm migrate:baseline`
- 数据库手工备份：`pnpm backup:once`
- 启动定时备份进程：`pnpm backup:daemon`

## 三、推荐流程
### 1) 本地开发（已有库）
1. 执行 `pnpm preflight`
2. 确认 `.env` 的数据库配置正确（`DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`）
3. 执行 `pnpm migrate`
4. 启动服务 `pnpm dev`

### 2) 新环境部署（空库）
1. 先创建数据库（例如 `collab_drawing_db`）
2. 执行 `pnpm preflight:full`
3. 执行 `pnpm migrate:baseline`
4. 再执行 `pnpm migrate`，补齐基线之后的增量变更
5. 启动服务 `pnpm start`

## 四、回滚建议（运维级）
- 当前迁移机制默认“只前进、不自动回滚”
- 若某次迁移失败：
  1. 先修复 SQL 或代码
  2. 重新执行 `pnpm migrate`（只会继续执行未成功的文件）
- 需要强回滚时，建议按备份恢复数据库，而不是在线写反向 SQL
