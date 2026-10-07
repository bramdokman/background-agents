/**
 * The SQL behind the workspace Owner bootstrap, shared by the two operator
 * entry points that run it: `scripts/bootstrap-workspace-owner.ts` against
 * D1 through Wrangler, and `bootstrap-owner.ts` here against the Node host's
 * global store. D1 is SQLite, so one text serves both.
 *
 * It is SQLite-dialect by design: the preflight proves the RBAC schema is
 * present through `pragma_table_info`, and the audit row's payload is
 * assembled with `json_object` inside the same statement as the mutation so
 * it records exactly the state the write saw. That is why it lives beside
 * the SQLite adapter rather than with the engine-neutral stores.
 *
 * Every value is inlined as a literal rather than bound: Wrangler's
 * `--command` takes SQL text only, and the Node host runs the same text so
 * the two cannot drift.
 */

/** A canonical user ID: 32 lowercase hexadecimal characters. */
export const CANONICAL_USER_ID = /^[0-9a-f]{32}$/;

const OWNER_ROLE_ID = "role_builtin_owner";

/** Inputs shared by the Owner bootstrap mutation and its verification query. */
export interface BootstrapSqlOptions {
  userId: string;
  auditId: string;
  now: number;
}

/** What `run` on either host executes: one preflight, then one atomic batch. */
export interface BootstrapSql {
  preflight: string;
  execution: readonly [string, string, string];
}

/** The preflight row, and the final row of the execution batch. */
export interface BootstrapReport {
  report: "preflight" | "postcondition";
  status: "ready" | "no-op" | "refused" | "executed";
  detail?: string;
  user_id: string;
  suspended_at: number | null;
  role_id: string | null;
  audit_written?: number;
}

function sqlLiteral(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`Unsafe SQL integer: ${value}`);
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** Build preflight and a result-bearing atomic batch from one audit identity. */
export function buildBootstrapSql(options: BootstrapSqlOptions): BootstrapSql {
  const userId = sqlLiteral(options.userId);
  const auditId = sqlLiteral(options.auditId);
  const requestId = sqlLiteral(`operator-cli:${options.auditId}`);
  const now = sqlLiteral(options.now);
  const ownerRoleId = sqlLiteral(OWNER_ROLE_ID);
  const targetIsOwner = `EXISTS (
    SELECT 1 FROM user_role_assignments assignment
    WHERE assignment.user_id = ${userId} AND assignment.role_id = ${ownerRoleId}
  )`;
  const anotherUnsuspendedOwner = `EXISTS (
    SELECT 1 FROM users owner
    JOIN user_role_assignments assignment ON assignment.user_id = owner.id
    WHERE assignment.role_id = ${ownerRoleId}
      AND owner.suspended_at IS NULL AND owner.id <> ${userId}
  )`;
  const schemaReady = `(SELECT COUNT(*) FROM pragma_table_info('users')
    WHERE name IN ('id', 'suspended_at')) = 2
  AND (SELECT COUNT(*) FROM pragma_table_info('roles')
    WHERE name IN ('id', 'key', 'is_system')) = 3
  AND (SELECT COUNT(*) FROM pragma_table_info('user_role_assignments')
    WHERE name IN ('user_id', 'role_id')) = 2
  AND (SELECT COUNT(*) FROM pragma_table_info('authorization_audit_events')
    WHERE name IN (
      'id', 'occurred_at', 'request_id', 'principal_kind',
       'actor_user_id_snapshot', 'actor_service_snapshot', 'action', 'resource_type',
       'resource_id', 'target_user_id_snapshot', 'reason_code',
       'operation_result', 'metadata_json'
    )) = 13`;
  const commonPreconditions = `${schemaReady}
  AND (SELECT COUNT(*) FROM users WHERE id = ${userId}) = 1
  AND (SELECT COUNT(*) FROM user_role_assignments WHERE user_id = ${userId}) = 1
  AND EXISTS (
    SELECT 1 FROM users WHERE id = ${userId} AND suspended_at IS NULL
  )
  AND EXISTS (
    SELECT 1 FROM roles
    WHERE id = ${ownerRoleId} AND key = 'owner' AND is_system = 1
  )`;
  const ready = `${commonPreconditions}
  AND NOT (${targetIsOwner})
  AND NOT (${anotherUnsuspendedOwner})`;
  const exactAudit = `EXISTS (
    SELECT 1 FROM authorization_audit_events
    WHERE id = ${auditId}
      AND occurred_at = ${now}
      AND request_id = ${requestId}
      AND principal_kind = 'service'
      AND actor_user_id_snapshot IS NULL
      AND actor_service_snapshot = 'operator-cli'
      AND action = 'workspace.owner_bootstrapped'
      AND resource_type = 'workspace'
      AND resource_id IS NULL
      AND target_user_id_snapshot = ${userId}
      AND reason_code = 'operator_cli'
      AND operation_result = 'applied'
      AND json_extract(metadata_json, '$.before.roleId') <> ${ownerRoleId}
      AND json_extract(metadata_json, '$.requested.roleId') = ${ownerRoleId}
      AND json_extract(metadata_json, '$.after.roleId') = ${ownerRoleId}
  )`;

  const preflight = `SELECT 'preflight' AS report,
  CASE
    WHEN NOT (${schemaReady}) THEN 'refused'
    WHEN (SELECT COUNT(*) FROM users WHERE id = ${userId}) <> 1 THEN 'refused'
    WHEN (SELECT COUNT(*) FROM user_role_assignments WHERE user_id = ${userId}) <> 1 THEN 'refused'
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND suspended_at IS NULL) THEN 'refused'
    WHEN NOT EXISTS (
      SELECT 1 FROM roles WHERE id = ${ownerRoleId} AND key = 'owner' AND is_system = 1
    ) THEN 'refused'
    WHEN ${anotherUnsuspendedOwner} THEN 'refused'
    WHEN ${targetIsOwner} THEN 'no-op'
    ELSE 'ready'
  END AS status,
  CASE
    WHEN NOT (${schemaReady}) THEN 'required RBAC schema is missing or incomplete'
    WHEN (SELECT COUNT(*) FROM users WHERE id = ${userId}) <> 1 THEN 'target user does not exist exactly once'
    WHEN (SELECT COUNT(*) FROM user_role_assignments WHERE user_id = ${userId}) <> 1 THEN 'target must have exactly one role assignment'
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND suspended_at IS NULL) THEN 'target user is suspended'
    WHEN NOT EXISTS (
      SELECT 1 FROM roles WHERE id = ${ownerRoleId} AND key = 'owner' AND is_system = 1
    ) THEN 'built-in Owner role is missing or inconsistent'
    WHEN ${anotherUnsuspendedOwner} THEN 'another unsuspended Owner already exists'
    WHEN ${targetIsOwner} THEN 'selected user is already the current unsuspended Owner'
    ELSE 'selected user can be bootstrapped'
  END AS detail,
  ${userId} AS user_id,
  (SELECT suspended_at FROM users WHERE id = ${userId}) AS suspended_at,
  (SELECT role_id FROM user_role_assignments WHERE user_id = ${userId}) AS role_id;`;

  const insertAudit = `INSERT INTO authorization_audit_events
  (id, occurred_at, request_id, principal_kind,
   actor_service_snapshot, action, resource_type,
    target_user_id_snapshot, reason_code, operation_result, metadata_json)
SELECT ${auditId}, ${now}, ${requestId}, 'service',
       'operator-cli', 'workspace.owner_bootstrapped', 'workspace',
       ${userId}, 'operator_cli', 'applied',
       json_object(
         'before', json_object('roleId', (
           SELECT role_id FROM user_role_assignments WHERE user_id = ${userId}
         )),
         'requested', json_object('roleId', ${ownerRoleId}),
         'after', json_object('roleId', ${ownerRoleId})
       )
WHERE ${ready};
`;

  const assignOwner = `UPDATE user_role_assignments
SET role_id = ${ownerRoleId}
WHERE user_id = ${userId} AND (${ready}) AND ${exactAudit};
`;

  const verification = `SELECT 'postcondition' AS report,
  CASE
    WHEN NOT (${commonPreconditions}) OR (${anotherUnsuspendedOwner}) THEN 'refused'
    WHEN (${targetIsOwner}) AND (${exactAudit}) THEN 'executed'
    WHEN ${targetIsOwner} THEN 'no-op'
    ELSE 'refused'
  END AS status,
  u.id AS user_id,
  u.suspended_at,
  assignment.role_id,
  ${exactAudit} AS audit_written
FROM users u
JOIN user_role_assignments assignment ON assignment.user_id = u.id
WHERE u.id = ${userId};
`;

  return { preflight, execution: [insertAudit, assignOwner, verification] };
}
