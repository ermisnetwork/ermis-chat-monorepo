# Ermis Chat Monorepo Implementation Ledger

This ledger is authoritative for implementation order, dependency state, and
closure gates. Detailed design, history, and evidence live in the linked
canonical plan.

## UHM Chat invite navigation and startup responsiveness

- [ ] [`UHM-INVITE-001`](./uhm_chat_invite_startup_responsiveness_plan.md) Reveal the pending-invite chat view instead of leaving the URL skeleton over it.
- [ ] [`UHM-INVITE-002`](./uhm_chat_invite_startup_responsiveness_plan.md) Return the invite sidebar to the channel list after selecting an invite.
- [ ] [`UHM-PERF-001`](./uhm_chat_invite_startup_responsiveness_plan.md) Do not mount closed global pickers or issue an unsolicited GIPHY request during app startup.
- [ ] [`UHM-PERF-002`](./uhm_chat_invite_startup_responsiveness_plan.md) Yield a paint before synchronous E2EE startup work and capture live timing evidence before changing MLS/KeyPackage readiness semantics.
- [ ] [`UHM-VERIFY-001`](./uhm_chat_invite_startup_responsiveness_plan.md) Verify source, package builds, UHM production build, and targeted browser behavior against the reviewed artifacts.

## UHM API default for commits

- [x] `UHM-ENDPOINT-002-WEB` — [Shared canonical endpoint plan](../../../ios/ermis-chat-ios/docs/todo/uhm_dev_endpoint_plan.md#2026-10-07--cross-platform-defaults-restored-for-earlier-client-commits): restore the committable API fallback and private local override to `https://api-trieve.ermis.network`; verify the effective module on Web3001. Cross-platform requirement/status is `UHM-ENDPOINT-002` in the [owning iOS ledger](../../../ios/ermis-chat-ios/docs/todo/todo.md). No backend/auth/MLS production acceptance claim.
