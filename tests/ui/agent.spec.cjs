const { test, expect } = require("@playwright/test");
async function open(page) {
  await page.addInitScript(() => {
    const calls = [];
    window.__calls = calls;
    const data = {
      connections: [
        {
          id: "pos-1",
          name: "Shop POS export",
          platform: "file",
          permission: "read",
          status: "authenticated_read_ok",
        },
        {
          id: "prep",
          name: "POHODA setup",
          platform: "pos",
          permission: "read",
          status: "setup_required",
        },
      ],
      groups: [],
      history: [],
      jobs: [],
      conflicts: [],
      exportDirectory: "C:/Users/x/AppData/exports",
      settings: {
        exportRoot: null,
        defaultIntervalMinutes: 15,
        schedulerPaused: false,
        openAtLogin: false,
        startInBackground: true,
        closeToTray: true,
        language: "en",
        cloudSnapshotsEnabled: false,
        cloudCommandsEnabled: false,
        cloudSourceConnectionId: null,
      },
      exportJobs: [],
      exportStatus: { paused: false, scheduled: [], running: [] },
      exportRuns: [
        {
          id: 2,
          connection_id: "pos-1",
          trigger: "schedule",
          started_at: "2026-11-06T08:00:00Z",
          finished_at: "2026-11-06T08:00:01Z",
          state: "held",
          product_count: null,
          sha256: null,
          message:
            'Held: 1 validation error(s). Currency "EUX" is not an ISO 4217 code Previous export preserved.',
        },
        {
          id: 1,
          connection_id: "pos-1",
          trigger: "manual",
          started_at: "2026-11-06T07:45:00Z",
          finished_at: "2026-11-06T07:45:01Z",
          state: "ok",
          product_count: 120,
          sha256: "a".repeat(64),
          message: "Published",
        },
      ],
      overview: {
        connections: [
          {
            id: "pos-1",
            name: "Shop POS export",
            platform: "file",
            health: "error",
            lastReadAt: "2026-11-06T08:00:00Z",
            lastExportAt: "2026-11-06T07:45:01Z",
            exportedCount: 120,
            intervalMinutes: 15,
            nextRunAt: null,
            lastError: "Held: invalid currency",
          },
        ],
        lastReadAt: "2026-11-06T08:00:00Z",
        lastExportAt: "2026-11-06T07:45:01Z",
        exportedProducts: 120,
        intervals: [15],
        errors: [
          {
            id: "pos-1",
            name: "Shop POS export",
            message: "Held: invalid currency",
          },
        ],
        warnings: [],
      },
      logs: [
        {
          id: 3,
          event: "export_held",
          level: "warning",
          category: "validation",
          detail_json: '{"id":"pos-1"}',
          created_at: "2026-11-06T08:00:01Z",
        },
        {
          id: 2,
          event: "read_completed",
          level: "info",
          category: "read",
          detail_json: '{"id":"pos-1","rows":120}',
          created_at: "2026-11-06T08:00:00Z",
        },
        {
          id: 1,
          event: "export_failed",
          level: "error",
          category: "export",
          detail_json: '{"id":"pos-1"}',
          created_at: "2026-11-06T07:30:00Z",
        },
      ],
      app: {
        version: "0.1.0",
        platform: "win32",
        loginItem: { supported: true, openAtLogin: false },
        tray: true,
      },
    };
    const record = (name, value) => {
      calls.push([name, value]);
      return value;
    };
    window.desktop = {
      snapshot: async () => structuredClone(data),
      saveExportJob: async (v) => {
        record("saveExportJob", v);
        data.exportJobs = [
          {
            ...v,
            consecutiveFailures: 0,
            running: false,
            nextRunAt: "2026-11-06T08:15:00Z",
            effectiveDirectory:
              v.directory || "C:/Users/x/AppData/exports/pos-1",
          },
        ];
        return v;
      },
      exportNow: async (id) =>
        record("exportNow", {
          state: "ok",
          message: "Published 120 products",
          count: 120,
          sha256: "b".repeat(64),
          directory: "C:/out",
        }),
      setSchedulerPaused: async (paused) => {
        data.settings.schedulerPaused = paused;
        return record("setSchedulerPaused", { paused });
      },
      updateSettings: async (v) => {
        Object.assign(data.settings, v);
        return record("updateSettings", data.settings);
      },
      chooseFolder: async () => "D:/Handover",
      products: async () => ({ identities: [], lastSnapshot: [] }),
    };
    window.cacaduu = {
      config: async () => ({ paired: false, secureStorage: true }),
    };
  });
  await page.goto("http://127.0.0.1:3199/");
}
test("overview shows health, errors, last export and exported product count", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator("#stat-exported")).toHaveText("120");
  await expect(page.locator("#overview-alerts .alert")).toContainText(
    "Held: invalid currency",
  );
  await expect(page.locator("#overview-health")).toContainText("● Error");
  await expect(page.locator("#recent-exports")).toContainText("held");
});
test("export card saves a custom schedule, folder and warehouse, and Sync Now reports the checksum", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="sync"]').click();
  const card = page.locator('[data-export-card="pos-1"]');
  await expect(page.locator("[data-export-card]")).toHaveCount(1); // setup-required POS has no export card
  await expect(card).toContainText('Currency "EUX"');
  await card.locator('[name="intervalPreset"]').selectOption("custom");
  await card.locator('[name="intervalCustom"]').fill("45");
  await card.locator("button", { hasText: "Choose folder" }).click();
  await card.locator('[name="warehouse"]').fill("Bratislava");
  await card.locator('[name="enabled"]').check();
  await card.locator("button", { hasText: "Save schedule" }).click();
  await expect(page.locator("#notice")).toContainText("Export schedule saved");
  const calls = await page.evaluate(() => window.__calls);
  expect(calls.find(([n]) => n === "saveExportJob")[1]).toEqual({
    connectionId: "pos-1",
    enabled: true,
    intervalMinutes: 45,
    directory: "D:/Handover",
    warehouse: "Bratislava",
    shrinkGuard: true,
  });
  await page
    .locator('[data-export-card="pos-1"] button', { hasText: "Sync Now" })
    .click();
  await expect(page.locator("#notice")).toContainText("SHA-256 bbbbbbbbbbbb");
  await page
    .locator('[data-export-card="pos-1"] [name="intervalPreset"]')
    .selectOption("custom");
  await page
    .locator('[data-export-card="pos-1"] [name="intervalCustom"]')
    .fill("3");
  await page
    .locator('[data-export-card="pos-1"] button', { hasText: "Save schedule" })
    .click();
  await expect(page.locator("#notice")).toHaveClass(/error/);
  await page.locator("#scheduler-toggle").click();
  await expect(page.locator("#scheduler-toggle")).toHaveText("Start schedules");
});
test("logs filter by category and level; settings save startup, interval and language", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="history"]').click();
  await expect(page.locator("#history-table tbody tr")).toHaveCount(3);
  await page.locator("#log-level").selectOption("error");
  await expect(page.locator("#history-table tbody tr")).toHaveCount(1);
  await expect(page.locator("#history-table")).toContainText("export_failed");
  await page.locator("#log-level").selectOption("all");
  await page.locator("#log-category").selectOption("read");
  await expect(page.locator("#history-table")).toContainText("read_completed");
  await page.locator('[data-page="settings"]').click();
  await expect(page.locator("#agent-state")).toContainText("Tray icon active");
  const form = page.locator("#settings-form");
  await form.locator('[name="defaultIntervalPreset"]').selectOption("30");
  await form.locator('[name="openAtLogin"]').check();
  await form.locator('[name="language"]').selectOption("sk");
  await form.locator('[type="submit"]').click();
  await expect(page.locator("#page-title")).toHaveText("Nastavenia");
  await expect(page.locator('[data-page="sync"] span')).toHaveText(
    "Synchronizácia skladu",
  );
  const update = (await page.evaluate(() => window.__calls)).find(
    ([n]) => n === "updateSettings",
  )[1];
  expect(update).toMatchObject({
    defaultIntervalMinutes: 30,
    openAtLogin: true,
    language: "sk",
    closeToTray: true,
    exportRoot: null,
  });
});
