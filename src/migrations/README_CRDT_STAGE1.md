# CRDT Stage 1 Notes

This stage introduces an operation-driven collaboration flow while keeping backward-compatible graphic broadcasts.

## Required schema

Code in stage 1 expects the following migration to be applied:

- `src/migrations/001_crdt_collaboration_schema.sql`

Specifically, it relies on:

- `operations.operation_id`
- `operations.base_version`
- `operations.server_version`
- `operations.lamport_time`
- `operations.client_id`
- `operations.resolved_result`
- `operations.conflict_type`
- `operations.resolved_at`
- `graphic_objects.deleted_version`
- `graphic_objects.deleted_by`
- `graphic_objects.deleted_at`
- table `graphic_field_versions`
- table `conflict_logs`

`canvas_snapshots` is prepared by migration but not used by stage 1 runtime yet.

## Runtime behavior

1. WebSocket `create_graphic` / `update_graphic` / `delete_graphic` now goes through `operationService`.
2. Server records operation metadata and conflict resolution result.
3. Server sends `operation_resolved` back to the initiator.
4. Server still broadcasts `graphic_created` / `graphic_updated` / `graphic_deleted` to keep current frontend behavior.

## Compatibility

Client message metadata fields are optional in stage 1:

- `operationId`
- `baseVersion`
- `lamportTime`
- `clientId`

If omitted, server generates fallback values and still processes the operation.

