-- CRDT collaboration schema migration draft.
-- Review and back up the database before executing.
-- Target: MySQL 8.0+

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- 1. Enhance operations so it can store client operations and resolved CRDT results.
ALTER TABLE `operations`
  ADD COLUMN `operation_id` varchar(64) NULL COMMENT '客户端生成的操作唯一标识' AFTER `id`,
  ADD COLUMN `base_version` bigint NOT NULL DEFAULT 0 COMMENT '客户端提交操作时已知的服务端版本' AFTER `operation_type`,
  ADD COLUMN `server_version` bigint NULL DEFAULT NULL COMMENT '服务端确认后的全局版本' AFTER `base_version`,
  ADD COLUMN `lamport_time` bigint NOT NULL DEFAULT 0 COMMENT '客户端 Lamport 逻辑时钟' AFTER `server_version`,
  ADD COLUMN `client_id` varchar(64) NULL COMMENT '客户端实例标识' AFTER `lamport_time`,
  ADD COLUMN `resolved_result` json NULL COMMENT 'CRDT 合并后的服务端解决结果' AFTER `operation_data`,
  ADD COLUMN `conflict_type` varchar(30) NOT NULL DEFAULT 'none' COMMENT '冲突类型：none/field_merge/field_conflict/delete_wins/duplicate_operation' AFTER `resolved_result`,
  ADD COLUMN `resolved_at` datetime NULL DEFAULT NULL COMMENT '服务端完成冲突解决的时间' AFTER `conflict_type`;

-- Existing code still uses operations.version. Keep it as a compatibility alias for now.
UPDATE `operations`
SET `server_version` = `version`
WHERE `server_version` IS NULL;

CREATE UNIQUE INDEX `uk_operations_operation_id` ON `operations` (`operation_id`);
CREATE INDEX `idx_operations_session_server_version` ON `operations` (`session_id`, `server_version`);
CREATE INDEX `idx_operations_client_id` ON `operations` (`client_id`);
CREATE INDEX `idx_operations_conflict_type` ON `operations` (`conflict_type`);

-- 2. Enhance graphic_objects with tombstone metadata for Delete-Wins.
ALTER TABLE `graphic_objects`
  ADD COLUMN `deleted_version` bigint NULL DEFAULT NULL COMMENT '删除墓碑版本号' AFTER `is_deleted`,
  ADD COLUMN `deleted_by` int NULL DEFAULT NULL COMMENT '执行删除的用户编号' AFTER `deleted_version`,
  ADD COLUMN `deleted_at` datetime NULL DEFAULT NULL COMMENT '删除时间' AFTER `deleted_by`;

CREATE INDEX `idx_graphic_objects_session_version` ON `graphic_objects` (`session_id`, `version`);
CREATE INDEX `idx_graphic_objects_deleted` ON `graphic_objects` (`session_id`, `is_deleted`, `deleted_version`);

-- 3. Field-level version table for Canvas-CRDT LWW-Register.
CREATE TABLE IF NOT EXISTS `graphic_field_versions` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '记录编号',
  `session_id` int NOT NULL COMMENT '会话编号',
  `object_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '图形对象唯一标识',
  `field_name` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '字段名称',
  `lamport_time` bigint NOT NULL DEFAULT 0 COMMENT '字段胜出版本的 Lamport 时间',
  `server_version` bigint NOT NULL DEFAULT 0 COMMENT '字段胜出版本的服务端版本',
  `client_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT '字段胜出版本的客户端标识',
  `updated_by` int NULL DEFAULT NULL COMMENT '最后更新用户编号',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_graphic_field_versions_object_field` (`session_id`, `object_key`, `field_name`) USING BTREE,
  INDEX `idx_graphic_field_versions_session_object` (`session_id`, `object_key`) USING BTREE,
  INDEX `idx_graphic_field_versions_server_version` (`session_id`, `server_version`) USING BTREE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '图形字段版本表，用于字段级 CRDT 合并' ROW_FORMAT = Dynamic;

-- Backfill field versions from the current graphic materialized view.
INSERT INTO `graphic_field_versions` (
  `session_id`, `object_key`, `field_name`, `lamport_time`, `server_version`, `client_id`, `updated_by`
)
SELECT
  g.`session_id`,
  g.`object_key`,
  fields.`field_name`,
  g.`version`,
  g.`version`,
  'migration',
  g.`creator_id`
FROM `graphic_objects` g
JOIN (
  SELECT 'objectType' AS `field_name`
  UNION ALL SELECT 'positionX'
  UNION ALL SELECT 'positionY'
  UNION ALL SELECT 'width'
  UNION ALL SELECT 'height'
  UNION ALL SELECT 'strokeColor'
  UNION ALL SELECT 'fillColor'
  UNION ALL SELECT 'strokeWidth'
  UNION ALL SELECT 'textContent'
  UNION ALL SELECT 'fontSize'
  UNION ALL SELECT 'pathPoints'
  UNION ALL SELECT 'zIndex'
) fields
WHERE g.`is_deleted` = 0
ON DUPLICATE KEY UPDATE
  `server_version` = VALUES(`server_version`),
  `lamport_time` = VALUES(`lamport_time`),
  `client_id` = VALUES(`client_id`),
  `updated_by` = VALUES(`updated_by`);

-- 4. Conflict logs for algorithm demonstration and audit.
CREATE TABLE IF NOT EXISTS `conflict_logs` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '冲突记录编号',
  `operation_ref_id` bigint NULL DEFAULT NULL COMMENT 'operations.id',
  `operation_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT '客户端操作唯一标识',
  `session_id` int NOT NULL COMMENT '会话编号',
  `object_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '图形对象唯一标识',
  `conflict_type` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '冲突类型',
  `field_name` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT '冲突字段',
  `current_value` json NULL COMMENT '当前字段值',
  `incoming_value` json NULL COMMENT '传入字段值',
  `resolved_value` json NULL COMMENT '最终采用字段值',
  `resolve_strategy` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '解决策略',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`) USING BTREE,
  INDEX `idx_conflict_logs_operation_ref_id` (`operation_ref_id`) USING BTREE,
  INDEX `idx_conflict_logs_session_object` (`session_id`, `object_key`) USING BTREE,
  INDEX `idx_conflict_logs_conflict_type` (`conflict_type`) USING BTREE,
  INDEX `idx_conflict_logs_created_at` (`created_at`) USING BTREE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = 'CRDT 冲突解决记录表' ROW_FORMAT = Dynamic;

-- 5. Canvas snapshots for history replay and restore.
CREATE TABLE IF NOT EXISTS `canvas_snapshots` (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '快照编号',
  `session_id` int NOT NULL COMMENT '会话编号',
  `version` bigint NOT NULL COMMENT '快照对应服务端版本',
  `snapshot_data` json NOT NULL COMMENT '画布快照数据',
  `graphic_count` int NOT NULL DEFAULT 0 COMMENT '快照内图形数量',
  `created_by` int NULL DEFAULT NULL COMMENT '创建用户编号，系统快照可为空',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_canvas_snapshots_session_version` (`session_id`, `version`) USING BTREE,
  INDEX `idx_canvas_snapshots_session_created` (`session_id`, `created_at`) USING BTREE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '画布历史快照表' ROW_FORMAT = Dynamic;

SET FOREIGN_KEY_CHECKS = 1;

