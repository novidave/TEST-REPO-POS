"use strict";
const $ = (id) => document.getElementById(id);
let snapshot = {
  connections: [],
  groups: [],
  jobs: [],
  history: [],
  conflicts: [],
};
const names = {
  overview: "Overview",
  connections: "POS Connections",
  groups: "Connection Groups",
  sync: "Inventory Sync",
  mapping: "Products & Mapping",
  history: "Sync History & Logs",
  settings: "Settings",
};
function navigate(page) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== page));
  document
    .querySelectorAll("[data-page]")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $("page-title").textContent = names[page];
}
document
  .querySelectorAll("[data-page]")
  .forEach((b) => (b.onclick = () => navigate(b.dataset.page)));
function notice(value, error = false) {
  $("notice").hidden = false;
  $("notice").classList.toggle("error", error);
  $("notice").textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
async function run(action, button) {
  if (button) button.disabled = true;
  try {
    const result = await action();
    if (result !== undefined) notice(result);
    await refresh();
    return result;
  } catch (e) {
    notice(e.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}
function element(tag, text, className) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function button(text, action, secondary = true) {
  const b = element("button", text, secondary ? "secondary" : "");
  b.type = "button";
  b.onclick = () => run(() => action(), b);
  return b;
}
function table(target, columns, rows) {
  const root = $(target);
  root.replaceChildren();
  if (!rows.length) {
    root.append(element("div", "No records yet.", "empty"));
    return;
  }
  const wrapper = element("div", undefined, "table-scroll"),
    t = element("table"),
    head = element("tr");
  columns.forEach(([label]) => head.append(element("th", label)));
  const thead = element("thead");
  thead.append(head);
  t.append(thead);
  const body = element("tbody");
  rows.forEach((row) => {
    const tr = element("tr");
    columns.forEach(([, key]) => tr.append(element("td", row[key] ?? "—")));
    body.append(tr);
  });
  t.append(body);
  wrapper.append(t);
  root.append(wrapper);
  if (target === "job-table")
    rows
      .filter((r) => r.state === "blocked")
      .forEach((row) =>
        root.append(
          button("Dismiss held job " + row.id.slice(0, 8), async () => {
            if (
              !window.confirm(
                "Dismiss this held job without changing remote inventory? Review actual quantities before the next Sync Now. Two-way baseline will be reset.",
              )
            )
              return;
            return window.desktop.dismissJob(row.id);
          }),
        ),
      );
}
function option(select, value, text) {
  const o = element("option", text);
  o.value = value;
  select.append(o);
}
const connectionName = (id) =>
  snapshot.connections.find((c) => c.id === id)?.name || id;
async function refresh() {
  snapshot = await window.desktop.snapshot();
  render();
  const c = await window.cacaduu.config();
  $("url").value = c.apiBaseUrl || "";
  $("state").textContent = c.paired
    ? "Paired with " + (c.shopName || "shop")
    : "Not paired";
  $("secure-state").textContent = c.secureStorage
    ? "OS encrypted credential storage is available."
    : "OS secure storage unavailable. Saving credentials and pairing are blocked.";
  $("pair").disabled = c.paired || !c.secureStorage;
  ["status", "heartbeat", "rotate", "unpair"].forEach(
    (id) => ($(id).disabled = !c.paired),
  );
}
function render() {
  $("stat-connections").textContent = snapshot.connections.length;
  $("stat-groups").textContent = snapshot.groups.filter(
    (g) => g.enabled,
  ).length;
  $("stat-jobs").textContent =
    snapshot.outstandingJobs ??
    snapshot.jobs.filter((j) => j.state !== "done").length;
  $("export-path").textContent =
    snapshot.exportDirectory + " / <group or connection ID>";
  renderPosConnections();
  const groupList = $("group-list"),
    syncList = $("sync-list");
  groupList.replaceChildren();
  syncList.replaceChildren();
  if (!snapshot.groups.length) {
    groupList.append(
      element("div", "No connection groups configured.", "empty"),
    );
    syncList.append(
      element("div", "Configure a connection group before syncing.", "empty"),
    );
  }
  snapshot.groups.forEach((g) => {
    for (const [target, isSync] of [
      [groupList, false],
      [syncList, true],
    ]) {
      const card = element("article", undefined, "card");
      card.append(
        element("span", g.enabled ? "ENABLED" : "PAUSED", "badge"),
        element("h3", g.id),
        element(
          "p",
          (g.mode === "master"
            ? "Master: " + connectionName(g.masterId)
            : "Two-way · atomic writes") +
            " · Every " +
            g.intervalMinutes +
            " min",
          "muted",
        ),
        element(
          "p",
          g.members
            .map((m) => connectionName(m.connectionId) + " (" + m.role + ")")
            .join(" → "),
        ),
      );
      const actions = element("div", undefined, "actions");
      actions.append(
        button("Configure", () => {
          editGroup(g);
          navigate("groups");
        }),
      );
      const sync = button(
        "Sync Now",
        async () => {
          if (
            !window.confirm(
              "Run group " +
                g.id +
                "? This may update inventory at destinations with read/write permission.",
            )
          )
            return;
          return window.desktop.sync(g.id);
        },
        false,
      );
      sync.disabled = !g.enabled;
      actions.append(
        sync,
        button(g.enabled ? "Pause" : "Resume", async () => {
          if (
            !g.enabled &&
            !window.confirm(
              "Resume this group? Scheduled synchronization may update configured destinations.",
            )
          )
            return;
          return window.desktop.setGroupEnabled(g.id, !g.enabled);
        }),
      );
      card.append(actions);
      target.append(card);
    }
  });
  const logs = snapshot.history.map((r) => ({ ...r, detail: r.detail_json }));
  const logColumns = [
    ["Time", "created_at"],
    ["Event", "event"],
    ["Details", "detail"],
  ];
  table("history-table", logColumns, logs);
  table("recent", logColumns, logs.slice(0, 5));
  const jobColumns = [
    ["Group", "group_id"],
    ["Destination", "destination"],
    ["Product", "product_key"],
    ["Warehouse", "location"],
    ["Quantity", "quantity"],
    ["State", "state"],
    ["Attempts", "attempts"],
    ["Detail", "last_error"],
  ];
  table("job-table", jobColumns, snapshot.jobs);
  table(
    "sync-jobs",
    jobColumns,
    snapshot.jobs.filter((j) => j.state !== "done"),
  );
  table(
    "conflict-table",
    [
      ["Time", "created_at"],
      ["Group", "group_id"],
      ["Product", "product_key"],
      ["Warehouse", "location"],
      ["Reason", "reason"],
    ],
    snapshot.conflicts,
  );
  const select = $("inspect-connection"),
    old = select.value;
  select.replaceChildren();
  snapshot.connections.forEach((c) => option(select, c.id, c.name));
  if ([...select.options].some((o) => o.value === old)) select.value = old;
}
const cf = $("connection-form");
function platformFields() {
  const platform = cf.elements.platform.value;
  const visible = {
    file: ["stockPath"],
    woocommerce: ["baseUrl", "token", "secret"],
    shopify: ["shopDomain", "token"],
    pos: [],
    shoptet: [],
    cacaduu: [],
  }[platform];
  document.querySelectorAll("[data-field]").forEach((e) => {
    e.hidden = !visible.includes(e.dataset.field);
  });
  const permission = cf.elements.permission;
  permission.disabled = ["file", "pos", "shoptet", "cacaduu"].includes(
    platform,
  );
  if (permission.disabled) permission.value = "read";
  $("platform-help").textContent = {
    file: "CSV/XML handover fields: source_code, name, price, currency, quantity, warehouse, observed_at. JSON stock observations are also supported.",
    woocommerce:
      "Stock-managed products and variants. No atomic compare-and-swap: master mode only. Use sandbox stores to verify write access.",
    shopify:
      "Admin API inventory read/write scopes required. Atomic compareQuantity writes. Test with a development store first.",
    shoptet:
      "Setup required: merchant-specific API/add-on authorization and verified inventory endpoints are not implemented.",
    pos: "Setup required: no vendor driver is bundled. Use a verified CSV/XML export from your POS.",
    cacaduu:
      "Optional Phase A pairing is available in Settings. Cloud inventory is not an active group destination.",
  }[platform];
}
function editConnection(c) {
  cf.reset();
  for (const key of [
    "id",
    "name",
    "platform",
    "baseUrl",
    "shopDomain",
    "stockPath",
    "permission",
  ])
    if (c[key] !== undefined) cf.elements[key].value = c[key];
  cf.elements.platform.disabled = true;
  cf.elements.baseUrl.readOnly = true;
  cf.elements.shopDomain.readOnly = true;
  cf.hidden = false;
  $("connection-heading").textContent = "Edit connection";
  platformFields();
}
$("new-connection").onclick = () => {
  cf.reset();
  cf.elements.id.value = "";
  cf.elements.platform.disabled = false;
  cf.elements.baseUrl.readOnly = false;
  cf.elements.shopDomain.readOnly = false;
  cf.hidden = false;
  $("connection-heading").textContent = "Add connection";
  platformFields();
};
cf.elements.platform.onchange = platformFields;
$("cancel-connection").onclick = () => {
  cf.reset();
  cf.hidden = true;
};
$("choose-file").onclick = () =>
  run(async () => {
    const path = await window.desktop.chooseFile();
    if (path) cf.elements.stockPath.value = path;
  });
cf.onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    const data = {};
    for (const key of [
      "id",
      "name",
      "platform",
      "baseUrl",
      "shopDomain",
      "stockPath",
      "permission",
      "token",
      "secret",
    ])
      data[key] = cf.elements[key].value;
    try {
      await window.desktop.saveConnection(data);
      cf.hidden = true;
      return "Connection saved. Run a read test before configuring synchronization.";
    } finally {
      cf.elements.token.value = "";
      cf.elements.secret.value = "";
    }
  }, cf.querySelector("[type=submit]"));
};
const gf = $("group-form");
function mappingText(map) {
  return Object.entries(map || {})
    .map(([local, shared]) => local + " = " + shared)
    .join("\n");
}
function parseMapping(value) {
  const entries = value
    .split("\n")
    .filter((v) => v.trim())
    .map((line) => {
      const split = line.indexOf("=");
      if (split < 1) throw new Error("Mapping must be local ID = shared ID");
      const key = line.slice(0, split).trim(),
        value = line.slice(split + 1).trim();
      if (!key || !value) throw new Error("Both mapping IDs are required");
      return [key, value];
    });
  if (new Set(entries.map((e) => e[0])).size !== entries.length)
    throw new Error("Duplicate local mapping ID");
  return Object.fromEntries(entries);
}
function editGroup(g) {
  gf.reset();
  gf.hidden = false;
  gf.elements.id.readOnly = Boolean(g);
  gf.elements.id.value = g?.id || "";
  gf.elements.mode.value = g?.mode || "master";
  gf.elements.intervalMinutes.value = g?.intervalMinutes || 15;
  gf.elements.enabled.checked = g?.enabled || false;
  const master = gf.elements.masterId;
  master.replaceChildren();
  snapshot.connections.forEach((c) => option(master, c.id, c.name));
  if (g?.masterId) master.value = g.masterId;
  const root = $("group-members");
  root.replaceChildren();
  snapshot.connections.forEach((c) => {
    const m = g?.members.find((m) => m.connectionId === c.id);
    const card = element("div", undefined, "member");
    card.dataset.connection = c.id;
    const check = element("input");
    check.type = "checkbox";
    check.className = "member-enabled";
    check.checked = Boolean(m);
    const label = element("label", undefined, "check");
    label.append(check, document.createTextNode(c.name + " · " + c.platform));
    const grid = element("div", undefined, "form-grid"),
      roleLabel = element("label", "Role"),
      role = element("select");
    role.className = "member-role";
    [
      ["source", "Source (read only in group)"],
      ["destination", "Destination"],
      ["both", "Both (two-way)"],
    ].forEach(([v, t]) => option(role, v, t));
    role.value = m?.role || "source";
    roleLabel.append(role);
    grid.append(roleLabel);
    for (const [field, title, value] of [
      [
        "product-map",
        "Product IDs → shared product IDs",
        g?.mappings[c.id] ?? c.productMappings,
      ],
      [
        "warehouse-map",
        "Warehouse IDs → shared warehouse IDs",
        g?.locationMappings?.[c.id] ?? c.warehouseMappings,
      ],
    ]) {
      const l = element("label", title),
        area = element("textarea");
      area.className = field;
      area.value = mappingText(value);
      area.placeholder =
        field === "product-map"
          ? "LOCAL-SKU = SHARED-SKU"
          : "local-warehouse = shared-warehouse";
      l.append(area);
      grid.append(l);
    }
    card.append(label, grid);
    root.append(card);
  });
  navigate("groups");
}
$("new-group").onclick = () => editGroup();
$("cancel-group").onclick = () => {
  gf.hidden = true;
};
gf.onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    const members = [],
      mappings = {},
      locationMappings = {};
    document.querySelectorAll("[data-connection]").forEach((card) => {
      if (!card.querySelector(".member-enabled").checked) return;
      const id = card.dataset.connection;
      members.push({
        connectionId: id,
        role: card.querySelector(".member-role").value,
      });
      mappings[id] = parseMapping(card.querySelector(".product-map").value);
      locationMappings[id] = parseMapping(
        card.querySelector(".warehouse-map").value,
      );
    });
    await window.desktop.saveGroup({
      id: gf.elements.id.value,
      mode: gf.elements.mode.value,
      masterId: gf.elements.masterId.value,
      intervalMinutes: Number(gf.elements.intervalMinutes.value),
      enabled: gf.elements.enabled.checked,
      members,
      mappings,
      locationMappings,
    });
    gf.hidden = true;
    return "Group saved.";
  }, gf.querySelector("[type=submit]"));
};
$("inspect").onclick = () =>
  run(async () => {
    const rows = await window.desktop.inspect($("inspect-connection").value);
    table(
      "inventory-table",
      [
        ["Product ID", "productKey"],
        ["SKU", "sku"],
        ["Warehouse", "location"],
        ["Quantity", "quantity"],
      ],
      rows,
    );
    return "Inventory read. Copy exact IDs into your group mappings.";
  }, $("inspect"));
$("edit-mappings").onclick = () => navigate("groups");
$("get-started").onclick = () => navigate("connections");
$("refresh").onclick = () =>
  run(async () => {
    await refresh();
    return "Workspace refreshed.";
  }, $("refresh"));
$("save").onclick = () =>
  run(async () => {
    await window.cacaduu.url($("url").value);
    return "Cloud URL saved.";
  }, $("save"));
$("pair").onclick = () =>
  run(async () => {
    try {
      return await window.cacaduu.pair($("code").value, $("name").value);
    } finally {
      $("code").value = "";
    }
  }, $("pair"));
$("status").onclick = () => run(() => window.cacaduu.status(), $("status"));
$("heartbeat").onclick = () =>
  run(() => window.cacaduu.heartbeat(), $("heartbeat"));
$("rotate").onclick = () => run(() => window.cacaduu.rotate(), $("rotate"));
$("unpair").onclick = () =>
  run(async () => {
    await window.cacaduu["unpair-local"]();
    return "Local pairing cleared. Remote device was not revoked.";
  }, $("unpair"));
platformFields();
refresh().catch((e) => notice(e.message, true));

const integrationMethods = [
  {
    id: "cloud_api",
    title: "Cloud API",
    icon: "☁",
    subtitle: "Modern POS systems",
    description: "Connect to supported online inventory APIs.",
    path: "POS provider → authenticated API → inventory workspace",
    examples: "WooCommerce, Shopify · Square / Lightspeed need drivers",
    state: "WooCommerce / Shopify implemented",
    vendor: [
      "WooCommerce",
      "Shopify",
      "CACADUU Cloud",
      "Square",
      "Lightspeed",
      "Other cloud POS",
    ],
  },
  {
    id: "local_api",
    title: "Local API / XML",
    icon: "▤",
    subtitle: "Desktop software",
    description: "Connect through a verified local XML/HTTP API.",
    path: "POS software → local API (XML / HTTP) → agent",
    examples: "POHODA (mServer), other desktop APIs",
    state: "Setup required · vendor driver not bundled",
    vendor: ["POHODA (mServer)", "Other local API"],
  },
  {
    id: "file",
    title: "File / Folder",
    icon: "▤",
    subtitle: "CSV, XML, JSON",
    description: "Read a verified export. XLSX / DBF need a parser.",
    path: "POS software → export file → validated stock.csv + manifest",
    examples: "Generic CSV / XML / JSON · MRP DBF needs setup",
    state: "CSV / XML / JSON implemented · manual file selection",
    vendor: [
      "Generic export",
      "MRP (export)",
      "POHODA (export)",
      "Other POS export",
    ],
  },
  {
    id: "command_line",
    title: "Command-line",
    icon: "›_",
    subtitle: "Run export utility",
    description: "Prepare a supported vendor export command.",
    path: "Task scheduler → export utility → file → agent",
    examples: "Inventory software with an export CLI",
    state: "Setup required · no command execution",
    vendor: ["Generic export utility", "Other inventory CLI"],
  },
  {
    id: "gui_automation",
    title: "GUI Automation",
    icon: "➤",
    subtitle: "Automate export steps",
    description: "Fallback when no verified API or export tool exists.",
    path: "Active Windows session → export steps → verified file",
    examples: "Older POS software and custom applications",
    state: "Setup required · no automated clicks",
    vendor: ["Elcom EURO-50", "Other legacy POS"],
  },
  {
    id: "hardware_database",
    title: "Hardware / Database",
    icon: "♆",
    subtitle: "Direct device access",
    description: "Requires a verified protocol and read permissions.",
    path: "POS device → USB / serial / database driver → agent",
    examples: "Elcom registers and legacy inventory databases",
    state: "Setup required · no device or database access",
    vendor: ["Elcom register", "Legacy inventory database", "Other device"],
  },
];
const methodFor = (c) =>
  c.integrationKind ||
  (c.platform === "file"
    ? "file"
    : c.platform === "pos"
      ? "local_api"
      : "cloud_api");
function methodTile(method, onClick) {
  const tile = button("", onClick);
  tile.className = "integration-tile";
  tile.dataset.integration = method.id;
  tile.append(
    element("span", method.icon, "method-icon " + method.id),
    element("strong", method.title),
    element("small", method.subtitle),
    element("small", method.description),
  );
  return tile;
}
function renderIntegrationCatalog() {
  const types = $("integration-types"),
    wizard = $("wizard-types"),
    guides = $("integration-guides");
  integrationMethods.forEach((method, index) => {
    types.append(methodTile(method, () => openPosWizard(method.id)));
    const tile = methodTile(method, () => selectWizardKind(method.id));
    tile.setAttribute("aria-pressed", "false");
    wizard.append(tile);
    const guide = element("article", undefined, "integration-guide");
    guide.append(
      element("span", method.icon, "method-icon " + method.id),
      element("h3", index + 1 + ". " + method.title),
      element("p", method.subtitle),
      element("div", method.path, "guide-path"),
      element("span", method.state, "guide-state"),
      element("p", "Examples: " + method.examples),
    );
    const flow = element("div", undefined, "guide-flow");
    method.path.split(" → ").forEach((step, index) => {
      if (index) flow.append(element("span", "↓", "flow-arrow"));
      flow.append(element("div", step, "flow-node"));
    });
    const oldPath = guide.querySelector(".guide-path");
    oldPath.replaceWith(flow);
    guides.append(guide);
  });
}
function renderPosConnections() {
  const list = $("connection-list");
  list.replaceChildren();
  const type = $("connection-type-filter").value,
    search = $("connection-search").value.toLowerCase().trim();
  const connections = snapshot.connections.filter(
    (c) =>
      (type === "all" || methodFor(c) === type) &&
      [c.name, c.platform, c.vendor]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(search),
  );
  if (!connections.length) {
    list.append(
      element(
        "div",
        snapshot.connections.length
          ? "No connections match this filter."
          : "Add your first POS connection to get started.",
        "empty",
      ),
    );
    return;
  }
  connections.forEach((c) => {
    const method =
        integrationMethods.find((m) => m.id === methodFor(c)) ||
        integrationMethods[0],
      row = element("article", undefined, "connection-row");
    row.dataset.connectionRow = c.id;
    const identity = element("div");
    identity.append(
      element("h3", c.name),
      element(
        "small",
        c.vendor ||
          {
            file: "Verified export schema",
            pos: "Vendor driver required",
            shopify: "Shopify Admin API",
            woocommerce: "WooCommerce REST API",
            shoptet: "Shoptet authorization required",
            cacaduu: "Optional pairing",
          }[c.platform],
      ),
    );
    const status = element(
      "div",
      c.status === "authenticated_read_ok"
        ? "● Read verified"
        : c.status === "setup_required"
          ? "◌ Setup required"
          : c.status === "error"
            ? "● Read failed"
            : c.status === "configure_in_settings"
              ? "◌ Pair in Settings"
              : "◌ Not tested",
      "connection-status" +
        (c.status === "authenticated_read_ok" ? " verified" : ""),
    );
    status.append(
      element(
        "small",
        c.permission === "read" ? "Read only" : "Read / write permission",
      ),
    );
    const groupIds = new Set(
      snapshot.groups
        .filter((g) => g.members.some((m) => m.connectionId === c.id))
        .map((g) => g.id),
    );
    const lastRun = snapshot.history.find((entry) => {
      if (
        !["sync_completed", "sync_failed", "sync_paused"].includes(entry.event)
      )
        return false;
      try {
        return groupIds.has(JSON.parse(entry.detail_json).id);
      } catch {
        return false;
      }
    });
    const sync = element("div", "Last group run", "last-sync");
    sync.append(
      element(
        "small",
        lastRun
          ? new Date(lastRun.created_at).toLocaleString()
          : "No run recorded",
      ),
    );
    const actions = element("div", undefined, "actions");
    actions.append(
      button("Edit", () => editConnection(c)),
      button("Test read", () => window.desktop.testConnection(c.id)),
    );
    if (c.platform === "file")
      actions.append(
        button("Export locally", () => window.desktop.export(c.id)),
      );
    else if (["pos", "shoptet"].includes(c.platform))
      actions.append(
        button("Setup", () => {
          notice(
            "No verified vendor driver is installed. Use a supported file export or API connection.",
          );
        }),
      );
    else
      actions.append(
        button("Sync now", async () => {
          const groups = snapshot.groups.filter(
            (g) => g.enabled && g.members.some((m) => m.connectionId === c.id),
          );
          if (groups.length !== 1) {
            navigate("groups");
            return groups.length
              ? "Choose the group you want to synchronize."
              : "Configure and enable a group with explicit product and warehouse mappings first.";
          }
          if (
            !window.confirm(
              "Run group " +
                groups[0].id +
                "? Configured destinations may be updated.",
            )
          )
            return;
          return window.desktop.sync(groups[0].id);
        }),
      );
    row.append(
      element("span", method.icon, "method-icon " + method.id),
      identity,
      element("span", method.title, "badge type-" + method.id),
      status,
      sync,
      actions,
    );
    list.append(row);
  });
}
$("connection-search").oninput = renderPosConnections;
$("connection-type-filter").onchange = renderPosConnections;
let wizardKind = "local_api",
  wizardStep = 1,
  wizardSaved = null,
  wizardBusy = false;
function clearWizardSecrets() {
  $("wizard-username").value = "";
  $("wizard-password").value = "";
}
function wizardNotice(message) {
  $("wizard-notice").hidden = !message;
  $("wizard-notice").textContent = message || "";
}
function openPosWizard(kind = "local_api") {
  $("wizard-config-form").reset();
  $("wizard-product-mappings").value = "";
  $("wizard-warehouse-mappings").value = "";
  $("wizard-inventory").replaceChildren();
  $("wizard-test-result").textContent = "";
  wizardSaved = null;
  clearWizardSecrets();
  wizardNotice("");
  selectWizardKind(kind);
  setWizardStep(1);
  $("pos-wizard").showModal();
}
function selectWizardKind(kind) {
  wizardKind = kind;
  clearWizardSecrets();
  $("wizard-endpoint").value = "";
  $("wizard-domain").value = "";
  const method = integrationMethods.find((m) => m.id === kind),
    provider = $("wizard-provider");
  provider.replaceChildren();
  method.vendor.forEach((v) => option(provider, v, v));
  document
    .querySelectorAll("#wizard-types [data-integration]")
    .forEach((tile) => {
      const selected = tile.dataset.integration === kind;
      tile.classList.toggle("selected", selected);
      tile.setAttribute("aria-pressed", String(selected));
    });
  wizardFields();
}
function wizardPlatform() {
  if (wizardKind === "file")
    return $("wizard-format").value === "supported" ? "file" : "pos";
  if (wizardKind === "cloud_api")
    return (
      {
        WooCommerce: "woocommerce",
        Shopify: "shopify",
        "CACADUU Cloud": "cacaduu",
      }[$("wizard-provider").value] || "pos"
    );
  return "pos";
}
function wizardFields() {
  const platform = wizardPlatform(),
    supportedCloud = ["woocommerce", "shopify"].includes(platform);
  const visible = {
    "wizard-endpoint-field":
      wizardKind === "local_api" || platform === "woocommerce",
    "wizard-domain-field": platform === "shopify",
    "wizard-file-field": wizardKind === "file",
    "wizard-format-field": wizardKind === "file",
    "wizard-setup-path-field": [
      "command_line",
      "gui_automation",
      "hardware_database",
    ].includes(wizardKind),
    "wizard-username-field": wizardKind === "local_api" || supportedCloud,
    "wizard-password-field":
      wizardKind === "local_api" || platform === "woocommerce",
    "wizard-permission-field": supportedCloud,
  };
  Object.entries(visible).forEach(([id, show]) => ($(id).hidden = !show));
  $("wizard-endpoint").placeholder =
    platform === "woocommerce"
      ? "https://store.example.com"
      : "http://localhost:444/xml";
  const method = integrationMethods.find((m) => m.id === wizardKind);
  $("wizard-config-help").textContent =
    platform === "file"
      ? "Supported CSV / XML / JSON export. Select a file; automatic folder watching is not implemented."
      : supportedCloud
        ? "Supported inventory adapter. The connection test reads stock and never writes inventory."
        : platform === "cacaduu"
          ? "Optional Cloud pairing is completed in Settings. Inventory upload is not an active destination."
          : method.state +
            ". You can save this setup, but it will not connect or synchronize until a verified driver is implemented.";
  $("wizard-preview").hidden = platform !== "file";
  $("wizard-permission").disabled = !supportedCloud;
  if (!supportedCloud) $("wizard-permission").value = "read";
}
function wizardDraft() {
  const name = $("wizard-name").value.trim(),
    platform = wizardPlatform();
  if (!name) throw new Error("Enter a connection name.");
  const draft = {
    name,
    platform,
    integrationKind: wizardKind,
    vendor: $("wizard-provider").value,
    permission: $("wizard-permission").value,
    productMappings: parseMapping($("wizard-product-mappings").value),
    warehouseMappings: parseMapping($("wizard-warehouse-mappings").value),
  };
  if (platform === "file") {
    draft.stockPath = $("wizard-file").value.trim();
    if (!draft.stockPath)
      throw new Error("Choose a CSV, XML or JSON inventory file.");
  } else if (wizardKind === "file")
    draft.setupPath = $("wizard-file").value.trim();
  if (platform === "woocommerce") {
    draft.baseUrl = $("wizard-endpoint").value.trim();
    if (!draft.baseUrl) throw new Error("Enter your store HTTPS URL.");
    draft.token = $("wizard-username").value;
    draft.secret = $("wizard-password").value;
  } else if (platform === "shopify") {
    draft.shopDomain = $("wizard-domain").value.trim();
    if (!draft.shopDomain) throw new Error("Enter your myshopify.com domain.");
    draft.token = $("wizard-username").value;
  } else if (wizardKind === "local_api") {
    if ($("wizard-endpoint").value.trim())
      draft.setupEndpoint = $("wizard-endpoint").value.trim();
    draft.username = $("wizard-username").value;
    draft.password = $("wizard-password").value;
  }
  if (
    ["command_line", "gui_automation", "hardware_database"].includes(wizardKind)
  )
    draft.setupPath = $("wizard-setup-path").value.trim();
  return draft;
}
function setWizardStep(step) {
  wizardStep = step;
  wizardNotice("");
  document
    .querySelectorAll("[data-wizard-step]")
    .forEach(
      (page) => (page.hidden = Number(page.dataset.wizardStep) !== step),
    );
  document.querySelectorAll(".wizard-steps li").forEach((item) => {
    item.classList.toggle("active", Number(item.dataset.step) === step);
    item.classList.toggle("complete", Number(item.dataset.step) < step);
    if (Number(item.dataset.step) === step)
      item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
  $("wizard-back").disabled = step === 1 || Boolean(wizardSaved);
  $("wizard-next").hidden = step === 4;
  $("wizard-save").hidden = step !== 4;
  $("wizard-step-label").textContent = "Step " + step + " of 4";
  $("wizard-save").textContent = wizardSaved
    ? "Done"
    : wizardPlatform() === "pos"
      ? "Save setup required"
      : "Save connection";
  if (step === 4) {
    const draft = wizardDraft(),
      method = integrationMethods.find((m) => m.id === wizardKind);
    $("wizard-review").textContent =
      draft.name +
      "\n" +
      method.title +
      " · " +
      draft.vendor +
      "\n" +
      (draft.baseUrl ||
        draft.shopDomain ||
        draft.stockPath ||
        draft.setupEndpoint ||
        draft.setupPath ||
        "No endpoint configured") +
      "\n" +
      (draft.platform === "pos"
        ? "Setup required — no verified driver installed"
        : draft.platform === "cacaduu"
          ? "Pair in Settings — Cloud is optional"
          : "Read-only test available") +
      "\n" +
      Object.keys(draft.productMappings).length +
      " product mapping(s) · " +
      Object.keys(draft.warehouseMappings).length +
      " warehouse mapping(s)";
    $("wizard-test").textContent =
      draft.platform === "file"
        ? "Test file read"
        : draft.platform === "pos" || draft.platform === "cacaduu"
          ? "Check setup requirements"
          : "Save & Test Connection";
  }
}
async function wizardAction(action) {
  if (wizardBusy) return;
  wizardBusy = true;
  wizardNotice("");
  document
    .querySelectorAll(".wizard-footer button,#wizard-test,#wizard-preview")
    .forEach((b) => (b.disabled = true));
  try {
    await action();
  } catch (error) {
    wizardNotice(error.message);
  } finally {
    wizardBusy = false;
    document
      .querySelectorAll(".wizard-footer button,#wizard-test,#wizard-preview")
      .forEach((b) => (b.disabled = false));
    $("wizard-back").disabled = wizardStep === 1 || Boolean(wizardSaved);
  }
}
async function previewWizardFile() {
  const preview = await window.desktop.previewFile(
    $("wizard-file").value.trim(),
  );
  table(
    "wizard-inventory",
    [
      ["Product ID", "productKey"],
      ["SKU", "sku"],
      ["Warehouse", "location"],
      ["Quantity", "quantity"],
    ],
    preview.rows,
  );
  return preview;
}
async function saveWizard(test = false) {
  if (wizardSaved) {
    if (test) {
      const result = await window.desktop.testConnection(wizardSaved.id);
      showWizardTest(result);
      await refresh();
    } else $("pos-wizard").close();
    return;
  }
  const draft = wizardDraft();
  if (draft.platform === "file") await previewWizardFile();
  try {
    wizardSaved = await window.desktop.saveConnection(draft);
  } finally {
    clearWizardSecrets();
  }
  await refresh();
  $("wizard-back").disabled = true;
  $("wizard-save").textContent = "Done";
  if (test) {
    const result = await window.desktop.testConnection(wizardSaved.id);
    showWizardTest(result);
    await refresh();
  } else {
    notice(
      draft.platform === "pos"
        ? "Setup saved. A verified vendor driver is required before this connection can sync."
        : "Connection and mapping templates saved. Configure a connection group to enable synchronization.",
    );
    $("pos-wizard").close();
  }
}
function showWizardTest(result) {
  $("wizard-test-result").textContent =
    (result.message || result.state) +
    (result.count !== undefined
      ? "\nInventory observations: " + result.count
      : "");
  $("wizard-test-result").className =
    "wizard-test-result " +
    (result.state === "authenticated_read_ok" ? "success" : "pending");
}
$("new-pos-connection").onclick = () => openPosWizard();
$("wizard-next").onclick = () =>
  wizardAction(async () => {
    if (wizardStep === 2) wizardDraft();
    if (wizardStep === 3) {
      parseMapping($("wizard-product-mappings").value);
      parseMapping($("wizard-warehouse-mappings").value);
    }
    setWizardStep(wizardStep + 1);
  });
$("wizard-back").onclick = () => setWizardStep(wizardStep - 1);
$("wizard-close").onclick = () => {
  if (!wizardBusy) $("pos-wizard").close();
};
$("pos-wizard").addEventListener("cancel", (event) => {
  if (wizardBusy) event.preventDefault();
});
$("pos-wizard").addEventListener("close", clearWizardSecrets);
$("wizard-config-form").onsubmit = (event) => {
  event.preventDefault();
  $("wizard-next").click();
};
$("wizard-provider").onchange = () => {
  clearWizardSecrets();
  wizardFields();
};
$("wizard-format").onchange = wizardFields;
$("wizard-preview").onclick = () => wizardAction(previewWizardFile);
$("wizard-choose-file").onclick = () =>
  wizardAction(async () => {
    const path = await window.desktop.chooseFile();
    if (path) $("wizard-file").value = path;
  });
$("wizard-test").onclick = () =>
  wizardAction(async () => {
    if (wizardPlatform() === "file") {
      const preview = await previewWizardFile();
      showWizardTest({
        state: "authenticated_read_ok",
        message: "File read validated. No inventory was changed.",
        count: preview.count,
      });
    } else if (["pos", "cacaduu"].includes(wizardPlatform()))
      showWizardTest({
        state: "setup_required",
        message:
          wizardPlatform() === "cacaduu"
            ? "Use optional pairing in Settings. No pairing or inventory test was performed."
            : "Setup required. No verified driver installed; no API request, command, automated click or device access was performed.",
      });
    else await saveWizard(true);
  });
$("wizard-save").onclick = () => wizardAction(() => saveWizard());
renderIntegrationCatalog();
