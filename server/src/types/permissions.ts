/**
 * Granular admin permissions (issue #674).
 *
 * Each admin endpoint requires a specific permission. Admins are granted
 * permissions via the `admin_permissions` JSON array column in the users table.
 * This provides least-privilege access control compared to a binary is_admin flag.
 *
 * Permission naming convention: <resource>.<action>
 * - resource: The domain object being accessed (trades, users, fraud_flags, etc.)
 * - action: The operation being performed (view, resolve, approve, etc.)
 */

export const enum AdminPermission {
  // Queue monitoring
  QUEUES_VIEW = "queues.view",

  // Trade management
  TRADES_VIEW = "trades.view",
  TRADES_RESOLVE = "trades.resolve",

  // User management
  USERS_VIEW = "users.view",
  USERS_KYC_APPROVE = "users.kyc_approve",

  // Fraud flag management
  FRAUD_FLAGS_VIEW = "fraud_flags.view",
  FRAUD_FLAGS_REVIEW = "fraud_flags.review",

  // Webhook management
  WEBHOOKS_VIEW = "webhooks.view",
  WEBHOOKS_REPLAY = "webhooks.replay",

  // Audit logs (super-admin only - most sensitive)
  AUDIT_LOGS_VIEW = "audit_logs.view",
}
