-- App performance (docs/decisions-pending/app-performance.md): indexes for the hot lookups —
-- /api/media and /api/thumb resolve every request by storage key; list/to-do gathers filter
-- ContentItem by state; the calendar reads ScheduleEntry by date range. Indexes only (additive,
-- no data change); at current table sizes the planner may still seq-scan — these are for growth.

-- CreateIndex
CREATE INDEX "ContentItem_currentState_idx" ON "ContentItem"("currentState");

-- CreateIndex
CREATE INDEX "MediaAsset_storageKey_idx" ON "MediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "Render_storageKey_idx" ON "Render"("storageKey");

-- CreateIndex
CREATE INDEX "ScheduleEntry_scheduledDate_idx" ON "ScheduleEntry"("scheduledDate");
