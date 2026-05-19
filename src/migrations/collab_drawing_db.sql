/*
 Navicat Premium Dump SQL

 Source Server         : mysql
 Source Server Type    : MySQL
 Source Server Version : 80042 (8.0.42)
 Source Host           : localhost:3306
 Source Schema         : collab_drawing_db

 Target Server Type    : MySQL
 Target Server Version : 80042 (8.0.42)
 File Encoding         : 65001

 Date: 17/05/2026 20:29:10
*/

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- Table structure for auth_tokens
-- ----------------------------
DROP TABLE IF EXISTS `auth_tokens`;
CREATE TABLE `auth_tokens`  (
  `id` int NOT NULL AUTO_INCREMENT COMMENT '记录编号',
  `user_id` int NOT NULL COMMENT '用户编号',
  `token` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '登录凭证',
  `expires_at` datetime NOT NULL COMMENT '失效时间',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_auth_tokens_token`(`token` ASC) USING BTREE,
  INDEX `idx_auth_tokens_user_id`(`user_id` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 309 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '认证表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for canvas_snapshots
-- ----------------------------
DROP TABLE IF EXISTS `canvas_snapshots`;
CREATE TABLE `canvas_snapshots`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '快照编号',
  `session_id` int NOT NULL COMMENT '会话编号',
  `version` bigint NOT NULL COMMENT '快照对应服务端版本',
  `snapshot_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT '' COMMENT '快照名称',
  `snapshot_data` json NOT NULL COMMENT '画布快照数据',
  `graphic_count` int NOT NULL DEFAULT 0 COMMENT '快照内图形数量',
  `created_by` int NULL DEFAULT NULL COMMENT '创建用户编号，系统快照可为空',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_canvas_snapshots_session_version`(`session_id` ASC, `version` ASC) USING BTREE,
  INDEX `idx_canvas_snapshots_session_created`(`session_id` ASC, `created_at` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 36 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '画布历史快照表' ROW_FORMAT = DYNAMIC;

-- ----------------------------
-- Table structure for conflict_logs
-- ----------------------------
DROP TABLE IF EXISTS `conflict_logs`;
CREATE TABLE `conflict_logs`  (
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
  INDEX `idx_conflict_logs_operation_ref_id`(`operation_ref_id` ASC) USING BTREE,
  INDEX `idx_conflict_logs_session_object`(`session_id` ASC, `object_key` ASC) USING BTREE,
  INDEX `idx_conflict_logs_conflict_type`(`conflict_type` ASC) USING BTREE,
  INDEX `idx_conflict_logs_created_at`(`created_at` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 24 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = 'CRDT 冲突解决记录表' ROW_FORMAT = DYNAMIC;

-- ----------------------------
-- Table structure for graphic_field_versions
-- ----------------------------
DROP TABLE IF EXISTS `graphic_field_versions`;
CREATE TABLE `graphic_field_versions`  (
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
  UNIQUE INDEX `uk_graphic_field_versions_object_field`(`session_id` ASC, `object_key` ASC, `field_name` ASC) USING BTREE,
  INDEX `idx_graphic_field_versions_session_object`(`session_id` ASC, `object_key` ASC) USING BTREE,
  INDEX `idx_graphic_field_versions_server_version`(`session_id` ASC, `server_version` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 10578 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '图形字段版本表，用于字段级 CRDT 合并' ROW_FORMAT = DYNAMIC;

-- ----------------------------
-- Table structure for graphic_objects
-- ----------------------------
DROP TABLE IF EXISTS `graphic_objects`;
CREATE TABLE `graphic_objects`  (
  `id` int NOT NULL AUTO_INCREMENT COMMENT '图形编号',
  `session_id` int NOT NULL COMMENT '所属会话编号',
  `object_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '图元类型：line/rect/circle/text',
  `object_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '图元唯一标识',
  `position_x` decimal(10, 2) NOT NULL DEFAULT 0.00 COMMENT '位置X坐标',
  `position_y` decimal(10, 2) NOT NULL DEFAULT 0.00 COMMENT '位置Y坐标',
  `width` decimal(10, 2) NULL DEFAULT NULL COMMENT '宽度',
  `height` decimal(10, 2) NULL DEFAULT NULL COMMENT '高度',
  `stroke_color` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT '#000000' COMMENT '边框颜色',
  `line_style` varchar(16) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'solid' COMMENT '线型：solid/dashed',
  `fill_color` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT '填充颜色',
  `stroke_width` decimal(5, 2) NOT NULL DEFAULT 2.00 COMMENT '线条粗细',
  `text_content` text CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL COMMENT '文本内容',
  `font_size` int NULL DEFAULT NULL COMMENT '字体大小',
  `path_points` json NULL COMMENT '画笔路径点数组，path 图元使用',
  `is_locked` tinyint NOT NULL DEFAULT 0 COMMENT '是否锁定：1-锁定，0-未锁定',
  `rotation` decimal(6, 2) NOT NULL DEFAULT 0.00 COMMENT '旋转角度（度）',
  `z_index` int NOT NULL DEFAULT 0 COMMENT '层级',
  `version` bigint NOT NULL DEFAULT 0 COMMENT '版本号',
  `creator_id` int NOT NULL COMMENT '创建者用户编号',
  `is_deleted` tinyint NOT NULL DEFAULT 0 COMMENT '软删除标记',
  `deleted_version` bigint NULL DEFAULT NULL COMMENT '删除墓碑版本号',
  `deleted_by` int NULL DEFAULT NULL COMMENT '执行删除的用户编号',
  `deleted_at` datetime NULL DEFAULT NULL COMMENT '删除时间',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_graphic_objects_object_key`(`object_key` ASC) USING BTREE,
  INDEX `idx_graphic_objects_session_id`(`session_id` ASC) USING BTREE,
  INDEX `idx_graphic_objects_creator_id`(`creator_id` ASC) USING BTREE,
  INDEX `idx_graphic_objects_z_index`(`z_index` ASC) USING BTREE,
  INDEX `idx_graphic_objects_session_version`(`session_id` ASC, `version` ASC) USING BTREE,
  INDEX `idx_graphic_objects_deleted`(`session_id` ASC, `is_deleted` ASC, `deleted_version` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 248 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '图形对象表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for operations
-- ----------------------------
DROP TABLE IF EXISTS `operations`;
CREATE TABLE `operations`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '操作编号',
  `operation_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT '客户端生成的操作唯一标识',
  `session_id` int NOT NULL COMMENT '所属会话编号',
  `user_id` int NOT NULL COMMENT '操作者用户编号',
  `object_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '目标图形唯一标识Key',
  `operation_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '操作类型：create/update/delete',
  `base_version` bigint NOT NULL DEFAULT 0 COMMENT '客户端提交操作时已知的服务端版本',
  `server_version` bigint NULL DEFAULT NULL COMMENT '服务端确认后的全局版本',
  `lamport_time` bigint NOT NULL DEFAULT 0 COMMENT '客户端 Lamport 逻辑时钟',
  `client_id` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT '客户端实例标识',
  `operation_data` json NOT NULL COMMENT '操作内容',
  `resolved_result` json NULL COMMENT 'CRDT 合并后的服务端解决结果',
  `conflict_type` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'none' COMMENT '冲突类型：none/field_merge/field_conflict/delete_wins/duplicate_operation',
  `resolved_at` datetime NULL DEFAULT NULL COMMENT '服务端完成冲突解决的时间',
  `version` bigint NOT NULL COMMENT '操作版本号',
  `timestamp` bigint NOT NULL COMMENT '操作时间戳',
  `undoable` tinyint NOT NULL DEFAULT 1 COMMENT '是否可撤销',
  `redoable` tinyint NOT NULL DEFAULT 0 COMMENT '是否可重做',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_operations_operation_id`(`operation_id` ASC) USING BTREE,
  INDEX `idx_operations_session_id`(`session_id` ASC) USING BTREE,
  INDEX `idx_operations_user_id`(`user_id` ASC) USING BTREE,
  INDEX `idx_operations_object_key`(`object_key` ASC) USING BTREE,
  INDEX `idx_operations_session_version`(`session_id` ASC, `version` ASC) USING BTREE,
  INDEX `idx_operations_timestamp`(`timestamp` ASC) USING BTREE,
  INDEX `idx_operations_session_server_version`(`session_id` ASC, `server_version` ASC) USING BTREE,
  INDEX `idx_operations_client_id`(`client_id` ASC) USING BTREE,
  INDEX `idx_operations_conflict_type`(`conflict_type` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 3075 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '操作记录表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for session_invites
-- ----------------------------
DROP TABLE IF EXISTS `session_invites`;
CREATE TABLE `session_invites`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '邀请编号',
  `session_id` int NOT NULL COMMENT '会话编号',
  `invite_token` varchar(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '邀请令牌',
  `role` tinyint NOT NULL COMMENT '入会角色：0-viewer，1-editor，2-manager',
  `created_by` int NOT NULL COMMENT '邀请创建者',
  `max_uses` int NULL DEFAULT 1 COMMENT '最大可使用次数，NULL 表示不限',
  `used_count` int NOT NULL DEFAULT 0 COMMENT '已使用次数',
  `status` enum('active','disabled') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'active' COMMENT '邀请状态',
  `expires_at` datetime NULL DEFAULT NULL COMMENT '过期时间',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_session_invites_token`(`invite_token` ASC) USING BTREE,
  INDEX `idx_session_invites_session_id`(`session_id` ASC) USING BTREE,
  INDEX `idx_session_invites_session_status`(`session_id` ASC, `status` ASC) USING BTREE,
  INDEX `idx_session_invites_expires_at`(`expires_at` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 44 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '会话邀请表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for session_members
-- ----------------------------
DROP TABLE IF EXISTS `session_members`;
CREATE TABLE `session_members`  (
  `id` int NOT NULL AUTO_INCREMENT COMMENT '记录编号',
  `session_id` int NOT NULL COMMENT '会话编号',
  `user_id` int NOT NULL COMMENT '用户编号',
  `role` tinyint NOT NULL DEFAULT 1 COMMENT '会话角色：0-viewer，1-editor，2-manager，3-owner',
  `membership_status` enum('active','left','removed') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'active' COMMENT '成员关系状态：active-有效成员，left-主动退出，removed-被移除',
  `online_status` tinyint NOT NULL DEFAULT 0 COMMENT '在线状态：1-在线，0-离线',
  `last_active_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最后活跃时间',
  `left_at` datetime NULL DEFAULT NULL COMMENT '主动退出时间',
  `removed_at` datetime NULL DEFAULT NULL COMMENT '被移除时间',
  `joined_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '加入时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_session_members_session_user`(`session_id` ASC, `user_id` ASC) USING BTREE,
  INDEX `idx_session_members_user_id`(`user_id` ASC) USING BTREE,
  INDEX `idx_session_members_session_online`(`session_id` ASC, `online_status` ASC) USING BTREE,
  INDEX `idx_session_members_user_status`(`user_id` ASC, `membership_status` ASC) USING BTREE,
  INDEX `idx_session_members_session_status`(`session_id` ASC, `membership_status` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 227 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '会话成员表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for sessions
-- ----------------------------
DROP TABLE IF EXISTS `sessions`;
CREATE TABLE `sessions`  (
  `id` int NOT NULL AUTO_INCREMENT COMMENT '会话编号',
  `session_key` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '会话标识Key',
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '会话名称',
  `creator_id` int NOT NULL COMMENT '创建者用户编号',
  `status` tinyint NOT NULL DEFAULT 1 COMMENT '状态：1-活跃，0-已结束',
  `current_version` bigint NOT NULL DEFAULT 0 COMMENT '当前版本号',
  `is_paused` tinyint NOT NULL DEFAULT 0 COMMENT '是否暂停画布：1-暂停，0-正常',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_sessions_session_key`(`session_key` ASC) USING BTREE,
  INDEX `idx_sessions_creator_id`(`creator_id` ASC) USING BTREE,
  INDEX `idx_sessions_status`(`status` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 167 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '会话表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for system_logs
-- ----------------------------
DROP TABLE IF EXISTS `system_logs`;
CREATE TABLE `system_logs`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '日志编号',
  `log_level` tinyint NOT NULL DEFAULT 1 COMMENT '日志级别：1-INFO，2-WARN，3-ERROR',
  `log_type` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '日志类型',
  `user_id` int NULL DEFAULT NULL COMMENT '操作用户编号',
  `session_id` int NULL DEFAULT NULL COMMENT '关联会话编号',
  `target_id` int NULL DEFAULT NULL COMMENT '目标对象编号',
  `target_type` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT '目标对象类型',
  `description` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT '日志描述',
  `ip_address` varchar(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT 'IP地址',
  `user_agent` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT '浏览器信息',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`) USING BTREE,
  INDEX `idx_system_logs_user_id`(`user_id` ASC) USING BTREE,
  INDEX `idx_system_logs_session_id`(`session_id` ASC) USING BTREE,
  INDEX `idx_system_logs_log_type`(`log_type` ASC) USING BTREE,
  INDEX `idx_system_logs_log_level`(`log_level` ASC) USING BTREE,
  INDEX `idx_system_logs_created_at`(`created_at` ASC) USING BTREE
) ENGINE = InnoDB CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '系统日志表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for user_operation_history
-- ----------------------------
DROP TABLE IF EXISTS `user_operation_history`;
CREATE TABLE `user_operation_history`  (
  `id` bigint NOT NULL AUTO_INCREMENT COMMENT '记录编号',
  `user_id` int NOT NULL COMMENT '用户编号',
  `session_id` int NOT NULL COMMENT '会话编号',
  `operation_id` bigint NOT NULL COMMENT '操作编号',
  `undo_operation_id` bigint NULL DEFAULT NULL COMMENT '撤销所需操作编号',
  `can_undo` tinyint NOT NULL DEFAULT 1 COMMENT '是否可撤销',
  `can_redo` tinyint NOT NULL DEFAULT 0 COMMENT '是否可重做',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (`id`) USING BTREE,
  INDEX `idx_user_op_history_user_session`(`user_id` ASC, `session_id` ASC) USING BTREE,
  INDEX `idx_user_op_history_user_session_undo`(`user_id` ASC, `session_id` ASC, `can_undo` ASC) USING BTREE,
  INDEX `idx_user_op_history_operation_id`(`operation_id` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 2905 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '用户操作历史表' ROW_FORMAT = Dynamic;

-- ----------------------------
-- Table structure for users
-- ----------------------------
DROP TABLE IF EXISTS `users`;
CREATE TABLE `users`  (
  `id` int NOT NULL AUTO_INCREMENT COMMENT '用户编号',
  `username` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '用户名',
  `password` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL COMMENT '密码哈希',
  `role` tinyint NOT NULL DEFAULT 1 COMMENT '角色：1-普通用户，2-管理员',
  `status` tinyint NOT NULL DEFAULT 1 COMMENT '状态：1-正常，0-禁用',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `avatar` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL DEFAULT NULL COMMENT '用户头像URL',
  PRIMARY KEY (`id`) USING BTREE,
  UNIQUE INDEX `uk_users_username`(`username` ASC) USING BTREE
) ENGINE = InnoDB AUTO_INCREMENT = 256 CHARACTER SET = utf8mb4 COLLATE = utf8mb4_0900_ai_ci COMMENT = '用户表' ROW_FORMAT = Dynamic;

SET FOREIGN_KEY_CHECKS = 1;
