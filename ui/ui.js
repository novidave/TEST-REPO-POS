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
  connections: "Connections",
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
  const list = $("connection-list");
  list.replaceChildren();
  if (!snapshot.connections.length)
    list.append(
      element("div", "Add your first connection to get started.", "empty"),
    );
  snapshot.connections.forEach((c) => {
    const card = element("article", undefined, "card");
    card.append(
      element("span", c.platform.toUpperCase(), "badge"),
      element("h3", c.name),
      element("p", c.status.replaceAll("_", " "), "muted"),
      element(
        "p",
        c.permission === "read" ? "Read only" : "Read & write enabled",
        "hint",
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
    card.append(actions);
    list.append(card);
  });
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
      ["product-map", "Product IDs → shared product IDs", g?.mappings[c.id]],
      [
        "warehouse-map",
        "Warehouse IDs → shared warehouse IDs",
        g?.locationMappings?.[c.id],
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
