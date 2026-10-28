const { test, expect } = require("@playwright/test");
async function open(page) {
  await page.addInitScript(() => {
    const credentialIds = new Set();
    const data = {
      connections: [],
      groups: [],
      history: [],
      jobs: [],
      conflicts: [],
      exportDirectory: "test/exports",
      regionalConnectors: [
        {
          id: "dotykacka",
          name: "Dotykačka",
          countries: ["SK", "CZ", "PL"],
          priority: 1,
          method: "cloud_api",
          nativeState: "setup_required",
          access:
            "Official stock API and merchant authorization must be verified.",
          stockCaveat: "Complete inventory required.",
        },
        {
          id: "pohoda",
          name: "POHODA (mServer)",
          countries: ["SK", "CZ"],
          priority: 1,
          method: "local_api",
          nativeState: "setup_required",
          access: "Configured mServer and pinned XML schema required.",
          stockCaveat: "Vendor XML needs explicit conversion.",
        },
        {
          id: "subiekt_gt",
          name: "InsERT Subiekt GT",
          countries: ["PL"],
          priority: 2,
          method: "hardware_database",
          nativeState: "setup_required",
          access: "Paid Sfera SDK/license and Windows bridge required.",
          stockCaveat: "No speculative database writes.",
        },
      ],
    };
    window.desktop = {
      snapshot: async () => structuredClone(data),
      csvHeaders: async (path, format) => {
        data.lastHeaderInspection = { path, format };
        return {
          headers: [
            " Code ",
            "Qty",
            "Warehouse",
            "Time",
            "<img src=x onerror=alert(1)>",
          ],
          rowCount: 2,
        };
      },
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
        if (v.token) credentialIds.add(data.connections.at(-1).id);
        return structuredClone(data.connections.at(-1));
      },
      testConnection: async (id) => {
        const c = data.connections.find((c) => c.id === id);
        if (
          c?.platform === "shoptet" &&
          (!c.shoptetEshopId || !credentialIds.has(id))
        )
          return {
            state: "setup_required",
            message: "Shoptet API access required",
          };
        return { state: "authenticated_read_ok", count: 1 };
      },
      setGroupEnabled: async (id, enabled) => {
        data.groups.find((g) => g.id === id).enabled = enabled;
        return { state: enabled ? "enabled" : "paused" };
      },
      saveGroup: async (v) => {
        data.groups.push(v);
        return v;
      },
      previewFile: async (path, csvImport) => {
        data.lastPreview = { path, csvImport };
        return {
          count: 1,
          rows: [
            {
              productKey: "SKU-A",
              sku: "SKU-A",
              location: "main",
              quantity: 2,
            },
          ],
        };
      },
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
      platform === "shoptet" ? "API access required" : "Setup required",
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
test("POS dashboard lists and searches 120 configured connections", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(async () => {
    for (let i = 0; i < 120; i++)
      await window.desktop.saveConnection({
        name: "Scale fixture " + String(i).padStart(3, "0"),
        platform: "file",
        permission: "read",
        stockPath: "fixture.csv",
      });
  });
  await page.locator("#refresh").click();
  await expect(page.locator("#stat-connections")).toHaveText("120");
  await page.locator('[data-page="connections"]').click();
  await expect(page.locator("#connection-list .connection-row")).toHaveCount(
    120,
  );
  await page.locator("#connection-search").fill("Scale fixture 119");
  await expect(page.locator("#connection-list .connection-row")).toHaveCount(1);
  await expect(page.locator("#connection-list")).toContainText(
    "Scale fixture 119",
  );
});
test("regional catalog filters markets and opens accurate native setup requirements", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await page.locator(".regional-support summary").click();
  await expect(page.locator("#regional-connectors .card")).toHaveCount(3);
  await page.locator("#regional-country").selectOption("PL");
  await expect(page.locator("#regional-connectors")).toContainText(
    "InsERT Subiekt GT",
  );
  await expect(page.locator("#regional-connectors")).not.toContainText(
    "POHODA",
  );
  await page.locator("#regional-country").selectOption("CZ");
  const pohoda = page.locator("#regional-connectors .card").filter({
    has: page.getByRole("heading", { name: "POHODA (mServer)", exact: true }),
  });
  await pohoda.getByRole("button", { name: "Prepare setup" }).click();
  await expect(page.locator("#wizard-name")).toHaveValue("POHODA (mServer)");
  await expect(page.locator("#wizard-config-help")).toContainText(
    "Native driver is setup required",
  );
  await expect(page.locator("#wizard-config-help")).toContainText(
    "pinned XML schema",
  );
  await expect(page.locator("#wizard-provider")).toHaveValue(
    "POHODA (mServer)",
  );
  await expect(page.locator("#wizard-permission")).toBeDisabled();
});
test("ERPNext and Odoo setup stays read-only and clears authentication fields", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  for (const platform of ["erpnext", "odoo"]) {
    await page.locator("#new-connection").click();
    await page.locator('[name="platform"]').selectOption(platform);
    await page.locator('[name="name"]').fill(platform);
    await page.locator('[name="baseUrl"]').fill("https://erp.example.test");
    await expect(page.locator('[name="permission"]')).toBeDisabled();
    await expect(page.locator('[name="permission"]')).toHaveValue("read");
    if (platform === "odoo") {
      await page.locator('[name="database"]').fill("merchant");
      await page.locator('[name="username"]').fill("private-user");
      await page.locator('[name="password"]').fill("private-api-key");
    } else {
      await page.locator('[name="token"]').fill("private-api-key");
      await page.locator('[name="secret"]').fill("private-api-secret");
    }
    await page
      .getByRole("button", { name: "Save connection", exact: true })
      .click();
    await expect(page.locator("#connection-form")).toBeHidden();
    for (const field of ["username", "password", "token", "secret"])
      await expect(page.locator(`[name="${field}"]`)).toHaveValue("");
    await expect(page.locator("#connection-list")).not.toContainText(
      "private-",
    );
  }
});
test("advanced CSV profile previews explicit mappings and restores them when editing", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await page.locator("#new-connection").click();
  await page.locator('[name="name"]').fill("Regional mapped export");
  await page.locator('[name="stockPath"]').fill("regional.csv");
  await page.locator("#csv-mode").selectOption("mapped");
  await page.locator("#csv-delimiter").selectOption(";");
  await page.locator("#csv-encoding").selectOption("windows-1250");
  await page.locator("#csv-decimal").selectOption(",");
  await page
    .locator("#csv-columns")
    .fill(
      "source_code = Kód\nquantity = Počet\nwarehouse = Sklad\nobserved_at = Čas",
    );
  await page.locator("#preview-import").click();
  await expect(page.locator("#notice")).toContainText("Choose whether");
  await page.locator("#csv-quantity-kind").selectOption("available");
  await page.locator("#preview-import").click();
  await expect(page.locator("#notice")).toContainText("Validated 1 stock rows");
  let state = await page.evaluate(() => window.desktop.snapshot());
  expect(state.connections).toHaveLength(0);
  expect(state.lastPreview.csvImport.columns.quantity).toBe("Počet");
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(page.locator("#connection-form")).toBeHidden();
  state = await page.evaluate(() => window.desktop.snapshot());
  expect(state.connections[0].csvImport.encoding).toBe("windows-1250");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#csv-mode")).toHaveValue("mapped");
  await expect(page.locator("#csv-columns")).toHaveValue(/quantity = Počet/);
  await expect(page.locator("#csv-quantity-kind")).toHaveValue("available");
});
test("wizard carries mapped CSV format through preview and save without claiming a native regional driver", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await page.locator("#new-pos-connection").click();
  await page.locator('#wizard-types [data-integration="file"]').click();
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-name").fill("Mapped file");
  await page.locator("#wizard-file").fill("file.csv");
  await page.locator("#wizard-csv-mode").selectOption("mapped");
  await page.locator("#wizard-csv-quantity-kind").selectOption("on_hand");
  await page
    .locator("#wizard-csv-columns")
    .fill(
      "source_code = Code\nquantity = Qty\nwarehouse = Warehouse\nobserved_at = Time",
    );
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-preview").click();
  await expect(page.locator("#wizard-inventory")).toContainText("SKU-A");
  const preview = (await page.evaluate(() => window.desktop.snapshot()))
    .lastPreview;
  expect(preview.csvImport.quantityKind).toBe("on_hand");
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-test").click();
  await expect(page.locator("#wizard-test-result")).toContainText(
    "File read validated",
  );
  await page.locator("#wizard-save").click();
  await expect(page.getByRole("dialog")).toBeHidden();
  const state = await page.evaluate(() => window.desktop.snapshot());
  expect(state.connections[0].platform).toBe("file");
  expect(state.connections[0].csvImport.columns.quantity).toBe("Qty");
});
test("CSV header dropdowns preserve exact whitespace and render untrusted names as text", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await page.locator("#new-connection").click();
  await page.locator('[name="name"]').fill("Header mapping");
  await page.locator('[name="stockPath"]').fill("sample.csv");
  await page.locator("#csv-mode").selectOption("mapped");
  await page.locator("#csv-delimiter").selectOption(";");
  await page.locator("#csv-load-headers").click();
  await expect(page.locator("#csv-header-status")).toContainText(
    "stock not yet validated",
  );
  const pane = page.locator("#csv-header-selectors");
  await expect(pane.locator("select")).toHaveCount(8);
  await expect(pane.locator("img")).toHaveCount(0);
  for (const [field, column] of Object.entries({
    source_code: " Code ",
    quantity: "Qty",
    warehouse: "Warehouse",
    observed_at: "Time",
  }))
    await pane.locator(`[data-csv-target="${field}"]`).selectOption(column);
  await page.locator("#csv-quantity-kind").selectOption("available");
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(page.locator("#connection-form")).toBeHidden();
  const state = await page.evaluate(() => window.desktop.snapshot());
  expect(state.connections[0].csvImport.columns.source_code).toBe(" Code ");
  expect(state.lastHeaderInspection.format).toEqual({
    delimiter: ";",
    encoding: "utf-8",
  });
});
test("late header inspection results are discarded after the file format changes", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await page.locator("#new-connection").click();
  await page.locator('[name="stockPath"]').fill("sample.csv");
  await page.locator("#csv-mode").selectOption("mapped");
  await page.evaluate(() => {
    window.desktop.csvHeaders = () =>
      new Promise((resolve) => {
        window.releaseInspection = () =>
          resolve({ headers: ["Code", "Qty"], rowCount: 1 });
      });
  });
  await page.locator("#csv-load-headers").click();
  await page.waitForFunction(
    () => typeof window.releaseInspection === "function",
  );
  await page.locator("#csv-delimiter").selectOption(";");
  await page.evaluate(() => window.releaseInspection());
  await expect(page.locator("#notice")).toContainText("changed");
  await expect(page.locator("#csv-header-selectors select")).toHaveCount(0);
  expect(
    (await page.evaluate(() => window.desktop.snapshot())).connections,
  ).toHaveLength(0);
});
test("Shoptet without API access saves preparation and never claims successful authentication", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await page.locator("#new-connection").click();
  await page.locator('[name="platform"]').selectOption("shoptet");
  await page.locator('[name="name"]').fill("Shoptet preparation");
  await expect(page.locator("#platform-help")).toContainText(
    "API access required",
  );
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(page.locator("#connection-form")).toBeHidden();
  await page.getByRole("button", { name: "Test read", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("setup_required");
  await expect(page.locator("#notice")).not.toContainText(
    "authenticated_read_ok",
  );
});
test("Shoptet wizard captures shop binding and encrypted-token input with fixed read permission", async ({
  page,
}) => {
  await open(page);
  await page.locator('[data-page="connections"]').click();
  await page.locator("#new-pos-connection").click();
  await page.locator('#wizard-types [data-integration="cloud_api"]').click();
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-provider").selectOption("Shoptet");
  await page.locator("#wizard-name").fill("Shoptet test source");
  await page.locator("#wizard-shoptet-id").fill("123");
  await page.locator("#wizard-shoptet-access").selectOption("private");
  await page.locator("#wizard-username").fill("synthetic-shoptet-token");
  await expect(page.locator("#wizard-permission")).toBeDisabled();
  await expect(page.locator("#wizard-permission")).toHaveValue("read");
  await expect(page.locator("#wizard-endpoint")).toBeHidden();
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-next").click();
  await page.locator("#wizard-test").click();
  await expect(page.locator("#wizard-test-result")).toContainText(
    "authenticated_read_ok",
  );
  await expect(page.locator("#wizard-username")).toHaveValue("");
  const state = await page.evaluate(() => window.desktop.snapshot());
  expect(state.connections[0].platform).toBe("shoptet");
  expect(Number(state.connections[0].shoptetEshopId)).toBe(123);
  expect(state.connections[0].shoptetAccess).toBe("private");
  expect(JSON.stringify(state)).not.toContain("synthetic-shoptet-token");
});
