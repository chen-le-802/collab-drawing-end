ALTER TABLE `operations`
  ADD COLUMN `batch_id` varchar(64) NULL DEFAULT NULL COMMENT '批量操作分组标识' AFTER `client_id`,
  ADD COLUMN `batch_index` int NULL DEFAULT NULL COMMENT '批量内序号（从0开始）' AFTER `batch_id`,
  ADD COLUMN `batch_size` int NULL DEFAULT NULL COMMENT '批量总数' AFTER `batch_index`,
  ADD COLUMN `batch_label` varchar(100) NULL DEFAULT NULL COMMENT '批量操作标签' AFTER `batch_size`;

CREATE INDEX `idx_operations_batch_id` ON `operations` (`batch_id`);
CREATE INDEX `idx_operations_session_batch` ON `operations` (`session_id`, `batch_id`, `server_version`);
