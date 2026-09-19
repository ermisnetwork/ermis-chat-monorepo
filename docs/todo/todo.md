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
