# Web history pagination

[Implementation ledger](./todo.md#web-history-pagination) · WEB-HISTORY-SEQ-001

## Goal and acceptance

Users can scroll through older and newer messages in the Ermis-hosted Web client. A failed history fetch must stop the current automatic pagination chain and allow a later scroll to retry. Successful requests that fill the viewport must continue to load pages as needed. Verify project-scoped HTTP payloads, self-hosted behavior, older and newer request failures, and real Chrome QA pagination.

## Design and scope

`useLoadMessages` and gap backfill call SDK `Channel.queryMessagesBySeq`. On a local cache miss, the method sends `POST /channels/{type}/{id}/query`. Use the SDK's existing `_withProjectId` serializer so the Ermis-hosted request supplies the configured project and self-hosted requests keep their existing body. Bellboy already requires the field for Ermis claims. No API, database, or token changes are required.

Keep the in-flight refs and per-anchor deduplication. Schedule a continuation only when the request produced a nonempty page and the view is still current. A failure unlocks the anchor for a later scroll. A timer or backoff would continue to send a permanently invalid request and add load while the user is idle. Successful pagination and cache hits keep their existing path. Rollback is limited to the two Web changes.

## Journal

- 2026-11-25. The QA browser showed repeated HTTP 400 responses with `project_id is required in ermis`. The retained gateway log contains a burst at roughly one request per frame. Source review found a missing project field in the SDK's HTTP sequence fallback and a React continuation in `finally` that ran after errors. The QA preview runs with self-hosted mode disabled and the fixture project configured.
- 2026-11-25. Git attributes the missing request field to Web commit `2eb8c883` on 2026-08-03. The same commit scheduled automatic pagination after a request settled. Commit `dc5375fd` clears the previous anchor when that request fails. Bellboy's validation predates both changes. The active QA token has `ermis=true`. The failure surfaces when the scroll uses the HTTP sequence fallback instead of a cache hit. Earlier deployed configuration and reproductions are unverified.
- 2026-11-25. Added the existing project serializer to the sequence HTTP fallback and stopped scheduling continuation after failure, end of history, or a retired view. The initial transport test fixture lacked a connected user and failed before hitting the request. Corrected the fixture and kept the first result. Two adjacent E2EE latest-page tests fail on both the baseline and final code because their mock lacks `restoreHistoryPage`.

## Traceability and verification

WEB-HISTORY-SEQ-001 maps to `packages/ermis-chat-sdk/src/channel.ts::queryMessagesBySeq` and `test/channel_sequence_query.test.cjs`, `packages/ermis-chat-react/src/hooks/useLoadMessages.ts::useLoadMessages` and `test/channel_pagination_retry.test.cjs`. The SDK tests assert the Ermis and self-hosted request bodies. The React tests exercise failure, a subsequent explicit call with the same anchor, successful continuation, and end of history in both directions.

The reviewed base was `729a35277efec4a5e6d166ad939a1f230a03641b`, with a clean Web tree before the patch. `npm run build:uhm` passed SDK, React, and UHM builds. The post-fix targeted suite had 22 passed, 0 failed, 0 skipped. Both focused retry cases fail against the original hook. The adjacent suite had 6 passed and 2 failed both before and after. Normal scrolling in the signed-in Vite preview generated one older sequence HTTP request with the expected project and HTTP 200. It produced no further sequence requests during the remaining 3.5-second observation. [Commands and evidence](../../../.task-artifacts/qa/runs/20261125T071259Z-5506ed663ec7/report.md#web-history-pagination).

## Status

Local requirement complete. Live production is unverified.
