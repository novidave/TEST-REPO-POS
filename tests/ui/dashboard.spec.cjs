const { test, expect } = require("@playwright/test");
async function open(page) {
  await page.addInitScript(() => {
    const data = {
      connections: [],
      groups: [],
      history: [],
      jobs: [],
      conflicts: [],
      exportDirectory: "test/exports",
    };
    window.desktop = {
      snapshot: async () => structuredClone(data),
      saveConnection: async (v) => {
        data.connections.push({
          id: "connection-" + (data.connections.length + 1),
          ...Object.fromEntries(
            Object.entries(v).filter(
              ([key]) =>
                !["id", "token", "secret", "username", "password"].includes(
                  key,
                ),
            ),
          ),
          name: v.name,
          platform: v.platform,
          permission: v.permission,
          status: "not_tested",
        });
        return structuredClone(data.connections.at(-1));
      },
      testConnection: async () => ({
        state: "authenticated_read_ok",
        count: 1,
      }),
      setGroupEnabled: async (id, enabled) => {
        data.groups.find((g) => g.id === id).enabled = enabled;
        return { state: enabled ? "enabled" : "paused" };
      },
      saveGroup: async (v) => {
        data.groups.push(v);
        return v;
      },
      previewFile: async () => ({
        count: 1,
        rows: [
          { productKey: "SKU-A", sku: "SKU-A", location: "main", quantity: 2 },
        ],
      }),
      inspect: async () => [
        { productKey: "SKU-A", sku: "SKU-A", location: "main", quantity: 2 },
      ],
      export: async () => ({ state: "ok" }),
      chooseFile: async () => null,
      sync: async () => ({ state: "ok" }),
      dismissJob: async () => ({ state: "dismissed" }),
    };
    window.cacaduu = {
      config: async () => ({
        apiBaseUrl: "",
        paired: false,
        secureStorage: true,
      }),
    };
  });
  await page.goto("http://127.0.0.1:3199");
  await expect(page.locator("#stat-connections")).toHaveText("0");
}
test("all seven dashboard views navigate without renderer errors", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  for (const id of [
    "overview",
    "connections",
    "groups",
    "sync",
    "mapping",
    "history",
    "settings",
  ]) {
    await page.locator(`[data-page="${id}"]`).click();
    await expect(page.locator("#" + id)).toBeVisible();
  }
  expect(errors).toEqual([]);
});
test("file setup, connection test and product inspector work through bridge", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await page.getByRole("button", { name: "+ Add connection" }).click();
  await page.locator('[name="name"]').fill("<img src=x onerror=alert(1)>");
  await page.locator('[name="stockPath"]').fill("C:\\Inventory\\stock.csv");
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(page.locator("#stat-connections")).toHaveText("1");
  await expect(page.locator("#connection-list h3")).toHaveText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(page.locator("#connection-list img")).toHaveCount(0);
  await page.getByRole("button", { name: "Test read" }).click();
  await expect(page.locator("#notice")).toContainText("authenticated_read_ok");
  await page.locator('[data-page="mapping"]').click();
  await page
    .getByRole("button", { name: "Read inventory", exact: true })
    .click();
  await expect(page.locator("#inventory-table")).toContainText("SKU-A");
});
test("credentials use password fields and are cleared after save", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await page.locator("#new-connection").click();
  await page.locator('[name="platform"]').selectOption("woocommerce");
  await page.locator('[name="name"]').fill("Test store");
  await page.locator('[name="baseUrl"]').fill("https://example.test");
  await expect(page.locator('[name="token"]')).toHaveAttribute(
    "type",
    "password",
  );
  await page.locator('[name="token"]').fill("private-api-key");
  await page.locator('[name="secret"]').fill("private-api-secret");
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(page.locator('[name="token"]')).toHaveValue("");
  await expect(page.locator('[name="secret"]')).toHaveValue("");
  await expect(page.locator("#notice")).not.toContainText("private-api");
});
test("Shoptet and POS forms accurately explain setup requirements", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await page.locator("#new-connection").click();
  for (const platform of ["shoptet", "pos"]) {
    await page.locator('[name="platform"]').selectOption(platform);
    await expect(page.locator("#platform-help")).toContainText(
      "Setup required",
    );
    await expect(page.locator('[name="permission"]')).toBeDisabled();
  }
});

test("group mappings, roles, schedule and manual sync flow", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  for (const platform of ["file", "shopify"]) {
    await page.locator("#new-connection").click();
    await page.locator('[name="platform"]').selectOption(platform);
    await page.locator('[name="name"]').fill(platform);
    if (platform === "file")
      await page.locator('[name="stockPath"]').fill("fixture.csv");
    else {
      await page.locator('[name="shopDomain"]').fill("test.myshopify.com");
      await page.locator('[name="token"]').fill("test-fixture-token");
      await page.locator('[name="permission"]').selectOption("read_write");
    }
    await page
      .getByRole("button", { name: "Save connection", exact: true })
      .click();
    await expect(page.locator("#stat-connections")).toHaveText(
      platform === "file" ? "1" : "2",
    );
  }
  await page.locator('[data-page="groups"]').click();
  await page.locator("#new-group").click();
  await page.locator('#group-form [name="id"]').fill("test-group");
  await page.locator('#group-form [name="enabled"]').check();
  const members = page.locator("#group-members .member");
  for (let i = 0; i < 2; i++) {
    await members.nth(i).locator(".member-enabled").check();
    await members
      .nth(i)
      .locator(".member-role")
      .selectOption(i === 0 ? "source" : "destination");
    await members.nth(i).locator(".product-map").fill("LOCAL = SHARED");
    await members
      .nth(i)
      .locator(".warehouse-map")
      .fill("main = canonical-warehouse");
  }
  await page.getByRole("button", { name: "Save group", exact: true }).click();
  await expect(page.locator("#stat-groups")).toHaveText("1");
  await page
    .locator("#group-list")
    .getByRole("button", { name: "Pause", exact: true })
    .click();
  await expect(page.locator("#stat-groups")).toHaveText("0");
  await expect(
    page
      .locator("#group-list")
      .getByRole("button", { name: "Sync Now", exact: true }),
  ).toBeDisabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator("#group-list")
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await expect(page.locator("#stat-groups")).toHaveText("1");
  const group = await page.evaluate(
    async () => (await window.desktop.snapshot()).groups[0],
  );
  expect(group.members[1].role).toBe("destination");
  expect(group.locationMappings["connection-2"].main).toBe(
    "canonical-warehouse",
  );
  await page.locator('[data-page="sync"]').click();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator("#sync-list")
    .getByRole("button", { name: "Sync Now" })
    .click();
  await expect(page.locator("#notice")).toContainText('"state": "ok"');
});
test("POS wizard previews files, stores mapping templates and saves a supported file connection", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await expect(
    page.locator("#integration-types .integration-tile"),
  ).toHaveCount(6);
  await page.locator("#new-pos-connection").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.locator('#wizard-types [data-integration="file"]').click();
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-name").fill("POS export");
  await page.locator("#wizard-file").fill("fixture.csv");
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-preview").click();
  await expect(page.locator("#wizard-inventory")).toContainText("SKU-A");
  await page
    .locator("#wizard-product-mappings")
    .fill("SKU-A = canonical-product");
  await page
    .locator("#wizard-warehouse-mappings")
    .fill("main = shared-warehouse");
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-test").click();
  await expect(page.locator("#wizard-test-result")).toContainText(
    "File read validated",
  );
  await page.locator("#wizard-save").click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const state = await page.evaluate(() => window.desktop.snapshot());
  expect(state.connections[0].productMappings).toEqual({
    "SKU-A": "canonical-product",
  });
  await expect(page.locator("#connection-list")).toContainText("POS export");
  await page.locator('[data-page="groups"]').click();
  await page.locator("#new-group").click();
  await expect(page.locator(".product-map").first()).toHaveValue(
    "SKU-A = canonical-product",
  );
});
test("local API wizard reports setup required, clears passwords on cancel and never claims authentication", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await page.locator("#new-pos-connection").click();
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-name").fill("POHODA");
  await page.locator("#wizard-endpoint").fill("http://localhost:444/xml");
  await page.locator("#wizard-username").fill("private-user");
  await page.locator("#wizard-password").fill("private-password");
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-test").click();
  await expect(page.locator("#wizard-test-result")).toContainText(
    "Setup required",
  );
  await expect(page.locator("#wizard-test-result")).not.toContainText(
    "successful",
  );
  await expect(page.locator("#wizard-review")).not.toContainText(
    "private-password",
  );
  await page.locator("#wizard-close").click();
  await expect(page.locator("#wizard-password")).toHaveValue("");
  await expect(page.locator("#wizard-username")).toHaveValue("");
});
test("POS connection type/search filters and unsupported method guidance work", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await expect(
    page.locator("#integration-guides .integration-guide"),
  ).toHaveCount(6);
  await page.locator("#new-connection").click();
  await page.locator('[name="name"]').fill("Main warehouse");
  await page.locator('[name="stockPath"]').fill("stock.csv");
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await page.locator("#connection-search").fill("unknown");
  await expect(page.locator("#connection-list")).toContainText(
    "No connections match",
  );
  await page.locator("#connection-search").fill("warehouse");
  await expect(page.locator("#connection-list")).toContainText(
    "Main warehouse",
  );
  await page
    .locator("#connection-type-filter")
    .selectOption("hardware_database");
  await expect(page.locator("#connection-list")).toContainText(
    "No connections match",
  );
  await page
    .locator('#integration-types [data-integration="gui_automation"]')
    .click();
  await page.locator("#wizard-next").click();
  await expect(page.locator("#wizard-config-help")).toContainText(
    "no automated clicks",
  );
});
test("cloud wizard saves once, tests through the bridge, and clears its API credential", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await page
    .locator('#integration-types [data-integration="cloud_api"]')
    .click();
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-name").fill("Development Shopify");
  await page.locator("#wizard-provider").selectOption("Shopify");
  await page.locator("#wizard-domain").fill("development.myshopify.com");
  await page.locator("#wizard-username").fill("private-api-fixture");
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-next").click();
  await expect(page.locator("#wizard-test")).toHaveText(
    "Save & Test Connection",
  );
  await page.locator("#wizard-test").click();
  await expect(page.locator("#wizard-test-result")).toContainText(
    "authenticated_read_ok",
  );
  await expect(page.locator("#wizard-username")).toHaveValue("");
  await expect(page.locator("#wizard-save")).toHaveText("Done");
  await page.locator("#wizard-save").click();
  const data = await page.evaluate(() => window.desktop.snapshot());
  expect(data.connections.length).toBe(1);
  expect(JSON.stringify(data)).not.toContain("private-api-fixture");
});
