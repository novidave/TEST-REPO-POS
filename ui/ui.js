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
let currentPage = "overview";
let language = "en";
function navigate(page) {
  currentPage = page;
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== page));
  document
    .querySelectorAll("[data-page]")
    .forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $("page-title").textContent = t(names[page]);
  if (page === "mapping" && typeof loadProducts === "function")
    loadProducts().catch((e) => notice(e.message, true));
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
    columns.forEach(([, key, cellClass]) => {
      const td = element("td", row[key] ?? "—");
      if (cellClass) td.className = cellClass(row);
      tr.append(td);
    });
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
  const cloudNotes = [];
  if (c.pairAgain)
    cloudNotes.push(
      "CACADUU revoked or replaced this device token. Pair this computer again.",
    );
  if (c.updateRequired)
    cloudNotes.push(
      "CACADUU requires agent version " +
        c.updateRequired +
        " or newer. Cloud calls are stopped until you update.",
    );
  if (Math.abs(c.clockSkewSeconds ?? 0) > 120)
    cloudNotes.push(
      "This computer's clock differs from CACADUU by " +
        c.clockSkewSeconds +
        " s. Correct the Windows time.",
    );
  if (c.paired)
    cloudNotes.push(
      "Last heartbeat: " +
        (c.lastHeartbeatAt
          ? new Date(c.lastHeartbeatAt).toLocaleString()
          : "not yet") +
        (c.nextHeartbeatAt
          ? " · next " + new Date(c.nextHeartbeatAt).toLocaleTimeString()
          : "") +
        (c.lastError ? " · last error " + c.lastError : ""),
    );
  if (c.paired && c.snapshots)
    cloudNotes.push(
      "Snapshots: " +
        String(c.snapshots).replaceAll("_", " ") +
        (c.lastSnapshot
          ? " (last: " + c.lastSnapshot.state.replaceAll("_", " ") + ")"
          : "") +
        " · Commands: " +
        String(c.commands).replaceAll("_", " "),
    );
  $("cloud-health").textContent = cloudNotes.join("\n");
  $("cloud-health").hidden = !cloudNotes.length;
  for (const note of cloudNotes.slice(
    0,
    c.pairAgain || c.updateRequired ? 1 : 0,
  ))
    $("overview-alerts").append(element("div", "◌ " + note, "alert warn"));
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
  const runtime = snapshot.runtime;
  const capacity = runtime
    ? `${runtime.groups.active} / ${runtime.groups.concurrency} sync groups active · ${runtime.groups.pending - runtime.groups.active} waiting · ${runtime.requests.active} / ${runtime.requests.concurrency} provider requests active`
    : "Sync groups use bounded concurrency and staggered polling. Open the desktop app for live capacity metrics.";
  $("runtime-status").textContent = capacity;
  $("capacity-status").textContent = capacity;
  const capabilities = (snapshot.connectorCapabilities ?? []).map((c) => ({
    ...c,
    read: c.read ? "Yes" : "No",
    write: c.write ? "Yes" : "No",
    twoWay: c.twoWay ? "Atomic CAS" : "No",
    state: c.state.replaceAll("_", " "),
  }));
  table(
    "connector-capabilities",
    [
      ["Connector", "name"],
      ["State", "state"],
      ["Read", "read"],
      ["Write", "write"],
      ["Two-way", "twoWay"],
      ["Scope", "detail"],
    ],
    capabilities,
  );
  renderPosConnections();
  renderRegionalConnectors();
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
  const jobs = snapshot.jobs.map((job) => ({
    ...job,
    nextAttempt: job.next_attempt_at
      ? new Date(job.next_attempt_at).toLocaleString()
      : "—",
  }));
  const jobColumns = [
    ["Group", "group_id"],
    ["Destination", "destination"],
    ["Product", "product_key"],
    ["Warehouse", "location"],
    ["Quantity", "quantity"],
    ["State", "state"],
    ["Attempts", "attempts"],
    ["Retry after", "nextAttempt"],
    ["Detail", "last_error"],
  ];
  table("job-table", jobColumns, jobs);
  table(
    "sync-jobs",
    jobColumns,
    jobs.filter((j) => j.state !== "done"),
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
  renderAgent();
}
function csvColumns(prefix = "") {
  const columns = {};
  for (const line of $(prefix + "csv-columns")
    .value.split(/\r?\n/)
    .filter((l) => l.trim())) {
    const index = line.indexOf("="),
      key = line.slice(0, index).trim(),
      rawHeader = line.slice(index + 1).trim(),
      header = rawHeader.startsWith('"') ? JSON.parse(rawHeader) : rawHeader;
    if (
      index < 1 ||
      typeof header !== "string" ||
      !header ||
      Object.hasOwn(columns, key)
    )
      throw new Error("Use one unique field = exact header mapping per line.");
    Object.defineProperty(columns, key, { value: header, enumerable: true });
  }
  return columns;
}
function readCsvProfile(prefix = "") {
  if ($(prefix + "csv-mode").value !== "mapped") return null;
  const columns = csvColumns(prefix);
  if (!$(prefix + "csv-quantity-kind").value)
    throw new Error(
      "Choose whether the source quantity is on hand or available to sell.",
    );
  return {
    version: 1,
    columns,
    delimiter:
      $(prefix + "csv-delimiter").value === "tab"
        ? "\t"
        : $(prefix + "csv-delimiter").value,
    encoding: $(prefix + "csv-encoding").value,
    decimalSeparator: $(prefix + "csv-decimal").value,
    quantityKind: $(prefix + "csv-quantity-kind").value,
  };
}
function csvMappingText(columns) {
  return Object.entries(columns)
    .map(
      ([k, v]) =>
        k +
        " = " +
        (v === v.trim() && !v.startsWith('"') ? v : JSON.stringify(v)),
    )
    .join("\n");
}
function clearCsvHeaders(prefix) {
  $(prefix + "csv-header-selectors").replaceChildren();
  $(prefix + "csv-header-status").textContent = "";
}
function csvInspectionInput(prefix) {
  return {
    path: prefix ? $("wizard-file").value : cf.elements.stockPath.value,
    format: {
      delimiter:
        $(prefix + "csv-delimiter").value === "tab"
          ? "\t"
          : $(prefix + "csv-delimiter").value,
      encoding: $(prefix + "csv-encoding").value,
    },
  };
}
async function loadCsvHeaders(prefix) {
  const input = csvInspectionInput(prefix),
    signature = JSON.stringify(input);
  const result = await window.desktop.csvHeaders(input.path, input.format);
  if (signature !== JSON.stringify(csvInspectionInput(prefix)))
    throw new Error("CSV file or format changed. Read the headers again.");
  const previous = csvColumns(prefix),
    container = $(prefix + "csv-header-selectors");
  container.replaceChildren();
  $(prefix + "csv-header-status").textContent =
    result.headers.length +
    " columns · " +
    result.rowCount +
    " data rows. Format only; stock not yet validated.";
  const fields = {
    source_code: "SKU",
    quantity: "Quantity",
    warehouse: "Warehouse",
    observed_at: "Observed timestamp",
    name: "Product name (optional)",
    price: "Price (optional)",
    currency: "Currency (optional)",
    ean: "EAN (optional)",
  };
  for (const [field, labelText] of Object.entries(fields)) {
    const label = element("label", labelText),
      select = document.createElement("select");
    select.dataset.csvTarget = field;
    select.setAttribute("aria-label", labelText + " column");
    option(select, "", "Choose column");
    for (const header of result.headers)
      option(select, header, JSON.stringify(header));
    select.value = result.headers.includes(previous[field])
      ? previous[field]
      : "";
    select.onchange = () => {
      if (signature !== JSON.stringify(csvInspectionInput(prefix))) {
        clearCsvHeaders(prefix);
        return;
      }
      const columns = Object.fromEntries(
        [...container.querySelectorAll("select")]
          .filter((s) => s.value)
          .map((s) => [s.dataset.csvTarget, s.value]),
      );
      $(prefix + "csv-columns").value = csvMappingText(columns);
    };
    label.append(select);
    container.append(label);
  }
}
function setCsvProfile(prefix, profile) {
  clearCsvHeaders(prefix);
  $(prefix + "csv-mode").value = profile ? "mapped" : "standard";
  $(prefix + "csv-delimiter").value =
    profile?.delimiter === "\t" ? "tab" : (profile?.delimiter ?? ",");
  $(prefix + "csv-encoding").value = profile?.encoding ?? "utf-8";
  $(prefix + "csv-decimal").value = profile?.decimalSeparator ?? ".";
  $(prefix + "csv-quantity-kind").value = profile?.quantityKind ?? "";
  $(prefix + "csv-columns").value = csvMappingText(profile?.columns ?? {});
  $(prefix + "csv-options").hidden = !profile;
}
for (const prefix of ["", "wizard-"]) {
  $(prefix + "csv-load-headers").onclick = () =>
    prefix
      ? wizardAction(() => loadCsvHeaders(prefix))
      : run(() => loadCsvHeaders(prefix), $(prefix + "csv-load-headers"));
  for (const id of ["csv-delimiter", "csv-encoding"])
    $(prefix + id).onchange = () => clearCsvHeaders(prefix);
  $(prefix + "csv-columns").oninput = () => clearCsvHeaders(prefix);
  $(prefix + "csv-mode").onchange = () => {
    clearCsvHeaders(prefix);
    $(prefix + "csv-options").hidden =
      $(prefix + "csv-mode").value !== "mapped";
  };
}
const cf = $("connection-form");
cf.elements.stockPath.addEventListener("input", () => clearCsvHeaders(""));
$("wizard-file").addEventListener("input", () => clearCsvHeaders("wizard-"));
function platformFields() {
  const platform = cf.elements.platform.value;
  const visible = {
    file: ["stockPath", "csvImport", "negativeStock"],
    odoo: ["baseUrl", "database", "username", "password"],
    erpnext: ["baseUrl", "token", "secret"],
    woocommerce: ["baseUrl", "token", "secret"],
    shopify: ["shopDomain", "token"],
    pos: [],
    local: [],
    shoptet: ["shoptetEshopId", "shoptetAccess", "shoptetWrite", "token"],
    cacaduu: [],
  }[platform];
  document.querySelectorAll("[data-field]").forEach((e) => {
    e.hidden = !visible.includes(e.dataset.field);
  });
  const permission = cf.elements.permission;
  permission.disabled = [
    "odoo",
    "erpnext",
    "file",
    "local",
    "pos",
    "cacaduu",
  ].includes(platform);
  if (permission.disabled) permission.value = "read";
  cf.elements.shoptetWriteAcknowledged.disabled =
    platform !== "shoptet" || permission.value !== "read_write";
  if (cf.elements.shoptetWriteAcknowledged.disabled)
    cf.elements.shoptetWriteAcknowledged.checked = false;
  $("platform-help").textContent = {
    odoo: "Odoo 18 read-only internal stock. API access must be permitted by your hosting plan and stock user rights. Enter username and API key; no writes or fractional-unit conversion.",
    erpnext:
      "Read-only Frappe v15 Bin actual stock. API user needs complete Bin/warehouse read permissions. Fractional units are refused; no inventory writes or inferred catalogue prices.",
    file: "CSV/XML handover fields: source_code, name, price, currency, quantity, warehouse, observed_at. JSON stock observations are also supported.",
    woocommerce:
      "Stock-managed products and variants. No atomic compare-and-swap: master mode only. Use sandbox stores to verify write access.",
    shopify:
      "Admin API inventory read/write scopes required. Atomic compareQuantity writes. Test with a development store first.",
    shoptet:
      "API access required: private API (Premium) or an approved add-on API token. Native reads and opt-in master-only available-stock updates; expected e-shop ID is verified first. Whole zero-claim stock only. Writes have no atomic revision check; coordinate other writers. No two-way sync; live staging pending.",
    pos: "Setup required: no vendor driver is bundled. Use a verified CSV/XML export from your POS.",
    local:
      "Built-in local inventory (Products & Mapping). Read-only source for exports and master groups; manage products and quantities there.",
    cacaduu:
      "Optional Phase A pairing is available in Settings. Cloud inventory is not an active group destination.",
  }[platform];
}
function editConnection(c) {
  cf.reset();
  setCsvProfile("", c.csvImport);
  for (const key of [
    "id",
    "name",
    "platform",
    "baseUrl",
    "database",
    "shopDomain",
    "shoptetEshopId",
    "shoptetAccess",
    "stockPath",
    "permission",
  ])
    if (c[key] !== undefined) cf.elements[key].value = c[key];
  cf.elements.negativeStock.value = c.negativeStock || "reject";
  cf.elements.shoptetWriteAcknowledged.checked =
    c.shoptetWriteAcknowledged === true;
  cf.elements.platform.disabled = true;
  cf.elements.database.readOnly = true;
  cf.elements.shoptetEshopId.readOnly = true;
  cf.elements.shoptetAccess.disabled = true;
  cf.elements.baseUrl.readOnly = true;
  cf.elements.shopDomain.readOnly = true;
  cf.hidden = false;
  $("connection-heading").textContent = "Edit connection";
  platformFields();
}
$("new-connection").onclick = () => {
  cf.reset();
  setCsvProfile("", null);
  cf.elements.id.value = "";
  cf.elements.platform.disabled = false;
  cf.elements.database.readOnly = false;
  cf.elements.shoptetEshopId.readOnly = false;
  cf.elements.shoptetAccess.disabled = false;
  cf.elements.baseUrl.readOnly = false;
  cf.elements.shopDomain.readOnly = false;
  cf.hidden = false;
  $("connection-heading").textContent = "Add connection";
  platformFields();
};
cf.elements.platform.onchange = platformFields;
cf.elements.permission.onchange = platformFields;
$("cancel-connection").onclick = () => {
  cf.reset();
  cf.hidden = true;
};
$("preview-import").onclick = () =>
  run(async () => {
    const result = await window.desktop.previewFile(
      cf.elements.stockPath.value,
      readCsvProfile(),
    );
    return (
      "Validated " +
      result.count +
      " stock rows. Preview only; no connection saved or export written."
    );
  });
$("choose-file").onclick = () =>
  run(async () => {
    const path = await window.desktop.chooseFile();
    if (path) {
      cf.elements.stockPath.value = path;
      clearCsvHeaders("");
    }
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
      "database",
      "username",
      "password",
      "shopDomain",
      "shoptetEshopId",
      "shoptetAccess",
      "stockPath",
      "permission",
      "token",
      "secret",
    ])
      data[key] = cf.elements[key].value;
    try {
      if (data.platform === "file") {
        data.csvImport = readCsvProfile();
        data.negativeStock = cf.elements.negativeStock.value;
      }
      if (data.platform === "shoptet") {
        data.shoptetWriteAcknowledged =
          cf.elements.shoptetWriteAcknowledged.checked;
        if (data.permission === "read_write" && !data.shoptetWriteAcknowledged)
          throw new Error(
            "Acknowledge Shoptet master-only available-stock updates before enabling writes.",
          );
      }
      await window.desktop.saveConnection(data);
      cf.hidden = true;
      return "Connection saved. Run a read test before configuring synchronization.";
    } finally {
      cf.elements.username.value = "";
      cf.elements.password.value = "";
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
    examples: "Shoptet, ERPNext, WooCommerce, Shopify · Odoo in advanced setup",
    state: "Shoptet master updates · ERPNext read-only · WooCommerce / Shopify",
    vendor: [
      "ERPNext",
      "Shoptet",
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
    else if (c.platform === "pos")
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
  setCsvProfile("wizard-", null);
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
  const regional = (snapshot.regionalConnectors ?? [])
    .filter((profile) => kind === "file" || profile.method === kind)
    .map((profile) => profile.name);
  [...new Set([...method.vendor, ...regional])].forEach((v) =>
    option(provider, v, v),
  );
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
        ERPNext: "erpnext",
        Shoptet: "shoptet",
        WooCommerce: "woocommerce",
        Shopify: "shopify",
        "CACADUU Cloud": "cacaduu",
      }[$("wizard-provider").value] || "pos"
    );
  return "pos";
}
function wizardFields() {
  const platform = wizardPlatform(),
    supportedCloud = ["shoptet", "erpnext", "woocommerce", "shopify"].includes(
      platform,
    );
  const visible = {
    "wizard-endpoint-field":
      wizardKind === "local_api" ||
      ["woocommerce", "erpnext"].includes(platform),
    "wizard-domain-field": platform === "shopify",
    "wizard-shoptet-id-field": platform === "shoptet",
    "wizard-shoptet-access-field": platform === "shoptet",
    "wizard-shoptet-write-field": platform === "shoptet",
    "wizard-file-field": wizardKind === "file",
    "wizard-format-field": wizardKind === "file",
    "wizard-csv-import": platform === "file",
    "wizard-setup-path-field": [
      "command_line",
      "gui_automation",
      "hardware_database",
    ].includes(wizardKind),
    "wizard-username-field": wizardKind === "local_api" || supportedCloud,
    "wizard-password-field":
      wizardKind === "local_api" ||
      ["woocommerce", "erpnext"].includes(platform),
    "wizard-permission-field": supportedCloud,
  };
  Object.entries(visible).forEach(([id, show]) => ($(id).hidden = !show));
  $("wizard-endpoint").placeholder = ["woocommerce", "erpnext"].includes(
    platform,
  )
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
  const regional = (snapshot.regionalConnectors ?? []).find(
    (profile) => profile.name === $("wizard-provider").value,
  );
  if (regional)
    $("wizard-config-help").textContent =
      (platform === "file"
        ? "File source only. Choose standard handover or explicitly map your CSV columns and format. Native APIs and vendor XML/DBF/XLSX parsers remain setup required. "
        : "Native driver is setup required. ") +
      regional.access +
      " " +
      regional.stockCaveat;
  if (platform === "shoptet")
    $("wizard-config-help").textContent =
      "API access required: private API (Premium) or an approved add-on API token. Native stock reads and opt-in master-only updates to stock available for ordering, bound to the expected e-shop ID. Whole zero-claim stock only. Writes are not atomic; coordinate other writers. No two-way sync. Without API access you can save setup metadata; no successful connection is claimed.";
  $("wizard-preview").hidden = platform !== "file";
  $("wizard-permission").disabled = !supportedCloud || platform === "erpnext";
  if (!supportedCloud || platform === "erpnext")
    $("wizard-permission").value = "read";
  $("wizard-shoptet-write").disabled =
    platform !== "shoptet" || $("wizard-permission").value !== "read_write";
  if ($("wizard-shoptet-write").disabled)
    $("wizard-shoptet-write").checked = false;
}
function wizardDraft() {
  const name = $("wizard-name").value.trim(),
    platform = wizardPlatform();
  if (!name) throw new Error("Enter a connection name.");
  const regional = (snapshot.regionalConnectors ?? []).find(
    (profile) => profile.name === $("wizard-provider").value,
  );
  const draft = {
    ...(regional ? { regionalVendorId: regional.id } : {}),
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
    draft.csvImport = readCsvProfile("wizard-");
    if (!draft.stockPath)
      throw new Error("Choose a CSV, XML or JSON inventory file.");
  } else if (wizardKind === "file")
    draft.setupPath = $("wizard-file").value.trim();
  if (["woocommerce", "erpnext"].includes(platform)) {
    draft.baseUrl = $("wizard-endpoint").value.trim();
    if (!draft.baseUrl) throw new Error("Enter your store HTTPS URL.");
    draft.token = $("wizard-username").value;
    draft.secret = $("wizard-password").value;
  } else if (platform === "shoptet") {
    draft.shoptetEshopId = $("wizard-shoptet-id").value;
    draft.shoptetAccess = $("wizard-shoptet-access").value;
    draft.shoptetWriteAcknowledged = $("wizard-shoptet-write").checked;
    if (draft.permission === "read_write" && !draft.shoptetWriteAcknowledged)
      throw new Error(
        "Acknowledge Shoptet master-only available-stock updates before enabling writes.",
      );
    draft.token = $("wizard-username").value;
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
    readCsvProfile("wizard-"),
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
$("wizard-permission").onchange = wizardFields;
$("wizard-preview").onclick = () => wizardAction(previewWizardFile);
$("wizard-choose-file").onclick = () =>
  wizardAction(async () => {
    const path = await window.desktop.chooseFile();
    if (path) {
      $("wizard-file").value = path;
      clearCsvHeaders("wizard-");
    }
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

function renderRegionalConnectors() {
  const root = $("regional-connectors");
  root.replaceChildren();
  const country = $("regional-country").value;
  const profiles = (snapshot.regionalConnectors ?? []).filter(
    (profile) => country === "all" || profile.countries.includes(country),
  );
  if (!profiles.length) {
    root.append(
      element(
        "p",
        "Regional profiles are available in the desktop app.",
        "muted",
      ),
    );
    return;
  }
  profiles.forEach((profile) => {
    const card = element("article", undefined, "card");
    card.append(
      element(
        "span",
        profile.priority === 1 ? "FIRST WAVE" : "SETUP REQUIRED",
        "badge",
      ),
      element("h3", profile.name),
      element("p", profile.countries.join(" · "), "muted"),
      element("p", profile.access),
      element("p", profile.stockCaveat, "hint"),
    );
    card.append(
      button("Prepare setup", () => {
        openPosWizard(profile.method);
        $("wizard-provider").value = profile.name;
        $("wizard-name").value = profile.name;
        wizardFields();
        setWizardStep(2);
      }),
    );
    root.append(card);
  });
}
$("regional-country").onchange = renderRegionalConnectors;

// ---------------------------------------------------------------- folder export agent
const translations = {
  sk: {
    Overview: "Prehľad",
    "POS Connections": "Pokladničné pripojenia",
    "Connection Groups": "Skupiny pripojení",
    "Inventory Sync": "Synchronizácia skladu",
    "Products & Mapping": "Produkty a mapovanie",
    "Sync History & Logs": "História a záznamy",
    Settings: "Nastavenia",
    "YOUR INVENTORY, CONNECTED": "VÁŠ SKLAD, PREPOJENÝ",
    "↻ Refresh": "↻ Obnoviť",
    "Automatic folder exports": "Automatický export do priečinka",
    "Export all now": "Exportovať všetko teraz",
    "Stop schedules": "Zastaviť plánovanie",
    "Start schedules": "Spustiť plánovanie",
    "Export history": "História exportov",
    "Connection health": "Stav pripojení",
    "Recent sync history": "Posledné synchronizácie",
    "Save settings": "Uložiť nastavenia",
    "Sync Now": "Synchronizovať teraz",
    "Save schedule": "Uložiť plán",
    "Open folder": "Otvoriť priečinok",
  },
  cs: {
    Overview: "Přehled",
    "POS Connections": "Pokladní připojení",
    "Connection Groups": "Skupiny připojení",
    "Inventory Sync": "Synchronizace skladu",
    "Products & Mapping": "Produkty a mapování",
    "Sync History & Logs": "Historie a záznamy",
    Settings: "Nastavení",
    "YOUR INVENTORY, CONNECTED": "VÁŠ SKLAD, PROPOJENÝ",
    "↻ Refresh": "↻ Obnovit",
    "Automatic folder exports": "Automatický export do složky",
    "Export all now": "Exportovat vše nyní",
    "Stop schedules": "Zastavit plánování",
    "Start schedules": "Spustit plánování",
    "Export history": "Historie exportů",
    "Connection health": "Stav připojení",
    "Recent sync history": "Poslední synchronizace",
    "Save settings": "Uložit nastavení",
    "Sync Now": "Synchronizovat nyní",
    "Save schedule": "Uložit plán",
    "Open folder": "Otevřít složku",
  },
};
function t(text) {
  return translations[language]?.[text] ?? text;
}
const originalText = new WeakMap();
function applyLanguage() {
  const targets = [
    ...document.querySelectorAll("[data-page] span"),
    ...document.querySelectorAll(".view h2, #export-all, #refresh, .eyebrow"),
    document.querySelector("#settings-form [type=submit]"),
  ];
  for (const node of targets) {
    if (!node) continue;
    if (!originalText.has(node))
      originalText.set(node, node.textContent.trim());
    node.textContent = t(originalText.get(node));
  }
  $("page-title").textContent = t(names[currentPage]);
  document.documentElement.lang = language;
}
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
const shortHash = (hash) => (hash ? hash.slice(0, 12) + "…" : "—");
const exportable = (c) =>
  !["pos", "cacaduu"].includes(c.platform) &&
  !["setup_required", "configure_in_settings"].includes(c.status);
const dirtyExportCards = new Set();
let settingsDirty = false;
let productCache = { id: null, rows: [] };
function renderAgent() {
  language = snapshot.settings?.language ?? "en";
  renderOverview();
  renderExports();
  renderLogs();
  renderSettings();
  for (const id of ["normalized-connection", "product-connection"]) {
    const select = $(id),
      old = select.value;
    select.replaceChildren();
    snapshot.connections
      .filter(exportable)
      .forEach((c) => option(select, c.id, c.name));
    if ([...select.options].some((o) => o.value === old)) select.value = old;
  }
  applyLanguage();
}
function renderOverview() {
  const o = snapshot.overview;
  if (!o) return;
  $("stat-last-read").textContent = when(o.lastReadAt);
  $("stat-last-read-detail").textContent = o.lastReadAt
    ? "Latest successful source read"
    : "No source read yet";
  $("stat-last-export").textContent = when(o.lastExportAt);
  $("stat-interval").textContent = o.intervals.length
    ? "Every " +
      o.intervals.join(" / ") +
      " min" +
      (snapshot.settings?.schedulerPaused ? " · stopped" : "")
    : "No scheduled exports";
  $("stat-exported").textContent = o.exportedProducts;
  const alerts = $("overview-alerts");
  alerts.replaceChildren();
  for (const e of o.errors)
    alerts.append(element("div", "● " + e.name + ": " + e.message, "alert"));
  for (const w of o.warnings)
    alerts.append(element("div", "◌ " + w.message, "alert warn"));
  const label = {
    healthy: "● Healthy",
    error: "● Error",
    setup_required: "◌ Setup required",
    unknown: "◌ Not yet read",
  };
  table(
    "overview-health",
    [
      ["Connection", "name"],
      ["Type", "platform"],
      [
        "Health",
        "healthLabel",
        (r) =>
          "level-" +
          (r.health === "error"
            ? "error"
            : r.health === "healthy"
              ? "info"
              : "warning"),
      ],
      ["Last read", "read"],
      ["Last export", "exported"],
      ["Products", "exportedCount"],
      ["Interval", "interval"],
      ["Next run", "next"],
      ["Active error", "lastError"],
    ],
    o.connections.map((c) => ({
      ...c,
      healthLabel: label[c.health],
      read: when(c.lastReadAt),
      exported: when(c.lastExportAt),
      interval: c.intervalMinutes ? c.intervalMinutes + " min" : "Manual",
      next: when(c.nextRunAt),
    })),
  );
  table("recent-exports", exportRunColumns, exportRunRows().slice(0, 5));
}
const exportRunColumns = [
  ["Started", "started"],
  ["Connection", "connection"],
  ["Trigger", "trigger"],
  [
    "Result",
    "state",
    (r) =>
      "level-" +
      (r.state === "ok"
        ? "info"
        : r.state === "held"
          ? "warning"
          : r.state === "running"
            ? "info"
            : "error"),
  ],
  ["Products", "product_count"],
  ["SHA-256", "hash"],
  ["Detail", "message"],
];
function exportRunRows() {
  return (snapshot.exportRuns ?? []).map((r) => ({
    ...r,
    started: when(r.started_at),
    connection: connectionName(r.connection_id),
    hash: shortHash(r.sha256),
  }));
}
function intervalControls(name, minutes) {
  const preset = [5, 15, 30, 60].includes(minutes) ? String(minutes) : "custom";
  const wrap = element("div", undefined, "form-grid");
  const presetLabel = element("label", "Interval"),
    select = document.createElement("select");
  select.name = name + "Preset";
  [
    ["5", "Every 5 minutes"],
    ["15", "Every 15 minutes"],
    ["30", "Every 30 minutes"],
    ["60", "Every 60 minutes"],
    ["custom", "Custom…"],
  ].forEach(([v, text]) => option(select, v, text));
  select.value = preset;
  presetLabel.append(select);
  const customLabel = element("label", "Minutes (5–1440)"),
    custom = document.createElement("input");
  custom.type = "number";
  custom.min = "5";
  custom.max = "1440";
  custom.step = "1";
  custom.name = name + "Custom";
  custom.value = String(minutes);
  customLabel.append(custom);
  customLabel.hidden = preset !== "custom";
  select.onchange = () => (customLabel.hidden = select.value !== "custom");
  wrap.append(presetLabel, customLabel);
  return wrap;
}
function readInterval(root, name) {
  const preset = root.querySelector(`[name="${name}Preset"]`).value;
  const value = Number(
    preset === "custom"
      ? root.querySelector(`[name="${name}Custom"]`).value
      : preset,
  );
  if (!Number.isInteger(value) || value < 5 || value > 1440)
    throw new Error("Choose an interval of 5–1440 whole minutes.");
  return value;
}
function renderExports() {
  const root = $("export-jobs");
  if (!snapshot.exportJobs) {
    root.replaceChildren(
      element(
        "div",
        "Folder exports are available in the desktop app.",
        "empty",
      ),
    );
    return;
  }
  const paused = snapshot.settings?.schedulerPaused;
  $("scheduler-toggle").textContent = t(
    paused ? "Start schedules" : "Stop schedules",
  );
  const status = snapshot.exportStatus ?? { running: [], scheduled: [] };
  $("export-scheduler-status").textContent =
    (paused
      ? "Scheduled exports are stopped. Manual Sync Now still works."
      : `${status.scheduled.length} export schedule(s) active · ${status.running.length} running.`) +
    " Default output: " +
    snapshot.exportDirectory +
    " / <connection ID> / stock.csv + manifest.json";
  // Keep unsaved edits on cards the user is changing.
  const kept = new Map();
  for (const id of dirtyExportCards) {
    const card = root.querySelector(`[data-export-card="${CSS.escape(id)}"]`);
    if (card) kept.set(id, card);
  }
  root.replaceChildren();
  const candidates = snapshot.connections.filter(exportable);
  if (!candidates.length) {
    root.append(
      element(
        "div",
        "Add and test a source connection to configure automatic exports.",
        "empty",
      ),
    );
    return;
  }
  for (const c of candidates) {
    if (kept.has(c.id)) {
      root.append(kept.get(c.id));
      continue;
    }
    const job = snapshot.exportJobs.find((j) => j.connectionId === c.id);
    const last = (snapshot.exportRuns ?? []).find(
      (r) => r.connection_id === c.id,
    );
    const lastOk = (snapshot.exportRuns ?? []).find(
      (r) => r.connection_id === c.id && r.state === "ok",
    );
    const card = element("article", undefined, "card export-card");
    card.dataset.exportCard = c.id;
    const badge = element(
      "span",
      job?.running
        ? "RUNNING"
        : job?.enabled
          ? job.consecutiveFailures
            ? "RETRYING"
            : "SCHEDULED"
          : "MANUAL",
      "badge " +
        (job?.consecutiveFailures ? "error" : job?.enabled ? "ok" : ""),
    );
    card.append(
      badge,
      element("h3", c.name),
      element("p", c.platform + " · " + (c.vendor || c.id), "muted"),
    );
    const details = element("dl");
    for (const [term, value] of [
      ["Last run", last ? when(last.started_at) + " · " + last.state : "Never"],
      ["Last success", lastOk ? when(lastOk.finished_at) : "—"],
      ["Products", lastOk?.product_count ?? "—"],
      ["Checksum", shortHash(lastOk?.sha256)],
      ["Next run", job?.enabled && !paused ? when(job.nextRunAt) : "—"],
      [
        "Folder",
        job?.effectiveDirectory ?? snapshot.exportDirectory + "/" + c.id,
      ],
    ])
      details.append(element("dt", term), element("dd", String(value)));
    if (last && last.state !== "ok" && last.message)
      details.append(element("dt", "Detail"), element("dd", last.message));
    card.append(details);
    const form = element("div");
    form.append(
      intervalControls(
        "interval",
        job?.intervalMinutes ?? snapshot.settings?.defaultIntervalMinutes ?? 15,
      ),
    );
    const grid = element("div", undefined, "form-grid");
    const folderLabel = element("label", "Export folder (optional)"),
      folder = document.createElement("input");
    folder.name = "directory";
    folder.placeholder = "Default export folder";
    folder.value = job?.directory ?? "";
    folderLabel.append(folder);
    const warehouseLabel = element("label", "Warehouse (optional)"),
      warehouse = document.createElement("input");
    warehouse.name = "warehouse";
    warehouse.placeholder = "Required when SKUs repeat across warehouses";
    warehouse.value = job?.warehouse ?? "";
    warehouseLabel.append(warehouse);
    grid.append(folderLabel, warehouseLabel);
    form.append(grid);
    const enabledLabel = element("label", undefined, "check"),
      enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.name = "enabled";
    enabled.checked = Boolean(job?.enabled);
    enabledLabel.append(
      enabled,
      document.createTextNode("Export automatically on this schedule"),
    );
    const guardLabel = element("label", undefined, "check"),
      guard = document.createElement("input");
    guard.type = "checkbox";
    guard.name = "shrinkGuard";
    guard.checked = job ? job.shrinkGuard : true;
    guardLabel.append(
      guard,
      document.createTextNode(
        "Hold exports with fewer than half the previous products",
      ),
    );
    form.append(enabledLabel, guardLabel);
    form.oninput = form.onchange = () => dirtyExportCards.add(c.id);
    card.append(form);
    const actions = element("div", undefined, "actions");
    actions.append(
      button(
        t("Save schedule"),
        async () => {
          await window.desktop.saveExportJob({
            connectionId: c.id,
            enabled: enabled.checked,
            intervalMinutes: readInterval(form, "interval"),
            directory: folder.value.trim() || null,
            warehouse: warehouse.value.trim() || null,
            shrinkGuard: guard.checked,
          });
          dirtyExportCards.delete(c.id);
          return enabled.checked
            ? "Export schedule saved and started."
            : "Export settings saved. Automatic export is off.";
        },
        false,
      ),
      button("Choose folder", async () => {
        const path = await window.desktop.chooseFolder();
        if (path) {
          folder.value = path;
          dirtyExportCards.add(c.id);
        }
      }),
      button(t("Sync Now"), async () =>
        exportMessage(await window.desktop.exportNow(c.id)),
      ),
      button(t("Open folder"), () => window.desktop.openExportFolder(c.id)),
    );
    if (last?.state === "held" && /products vs/.test(last.message || ""))
      actions.append(
        button("Publish held snapshot", async () => {
          if (
            !window.confirm(
              "Publish the smaller snapshot? Review the source first: products missing from a complete export are treated as sold out downstream.",
            )
          )
            return;
          return exportMessage(await window.desktop.exportNow(c.id, true));
        }),
      );
    card.append(actions);
    root.append(card);
  }
  table("export-history", exportRunColumns, exportRunRows());
  const sources = $("cloud-source"),
    current = snapshot.settings?.cloudSourceConnectionId ?? "";
  sources.replaceChildren();
  option(sources, "", "None");
  candidates.forEach((c) => option(sources, c.id, c.name));
  sources.value = current;
}
function exportMessage(result) {
  if (!result) return;
  if (result.state === "ok")
    return `${result.message}. SHA-256 ${shortHash(result.sha256)} → ${result.directory}`;
  const issues = (result.issues ?? [])
    .filter((i) => i.severity === "error")
    .slice(0, 5)
    .map(
      (i) =>
        "• " + (i.sourceProductId ? i.sourceProductId + ": " : "") + i.message,
    )
    .join("\n");
  throw new Error(result.message + (issues ? "\n" + issues : ""));
}
function renderLogs() {
  const logs = snapshot.logs;
  if (!logs) return;
  const category = $("log-category").value,
    level = $("log-level").value,
    search = $("log-search").value.toLowerCase().trim();
  table(
    "history-table",
    [
      ["Time", "time"],
      ["Level", "level", (r) => "level-" + r.level],
      ["Category", "category"],
      ["Event", "event"],
      ["Details", "detail_json"],
    ],
    logs
      .filter(
        (r) =>
          (category === "all" || r.category === category) &&
          (level === "all" || r.level === level) &&
          (!search ||
            (r.event + " " + r.detail_json).toLowerCase().includes(search)),
      )
      .map((r) => ({ ...r, time: new Date(r.created_at).toLocaleString() })),
  );
}
for (const id of ["log-category", "log-level"]) $(id).onchange = renderLogs;
$("log-search").oninput = renderLogs;
const sf = $("settings-form");
function renderSettings() {
  const s = snapshot.settings;
  if (!s) return;
  const app = snapshot.app;
  $("app-version").textContent = app
    ? `Version ${app.version} · ${app.platform}`
    : "Version information is available in the desktop app.";
  $("agent-state").textContent = !app
    ? ""
    : (app.loginItem.supported
        ? app.loginItem.openAtLogin
          ? "Registered to start at sign-in. "
          : "Not registered to start at sign-in. "
        : "Start at sign-in is supported on Windows and macOS only. ") +
      (app.tray
        ? "Tray icon active: closing the window keeps the agent running."
        : "No system tray available: closing the window quits the agent.");
  if (settingsDirty) return;
  const preset = [5, 15, 30, 60].includes(s.defaultIntervalMinutes)
    ? String(s.defaultIntervalMinutes)
    : "custom";
  sf.elements.defaultIntervalPreset.value = preset;
  sf.elements.defaultIntervalCustom.value = s.defaultIntervalMinutes;
  sf.querySelector("[data-custom-interval]").hidden = preset !== "custom";
  sf.elements.language.value = s.language;
  sf.elements.exportRoot.value = s.exportRoot ?? "";
  for (const key of ["openAtLogin", "startInBackground", "closeToTray"])
    sf.elements[key].checked = s[key];
  $("cloud-snapshots").checked = s.cloudSnapshotsEnabled;
  $("cloud-commands").checked = s.cloudCommandsEnabled;
}
sf.oninput = sf.onchange = () => {
  settingsDirty = true;
  sf.querySelector("[data-custom-interval]").hidden =
    sf.elements.defaultIntervalPreset.value !== "custom";
};
sf.onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    const preset = sf.elements.defaultIntervalPreset.value;
    const defaultIntervalMinutes = Number(
      preset === "custom" ? sf.elements.defaultIntervalCustom.value : preset,
    );
    await window.desktop.updateSettings({
      defaultIntervalMinutes,
      language: sf.elements.language.value,
      exportRoot: sf.elements.exportRoot.value.trim() || null,
      openAtLogin: sf.elements.openAtLogin.checked,
      startInBackground: sf.elements.startInBackground.checked,
      closeToTray: sf.elements.closeToTray.checked,
    });
    settingsDirty = false;
    return "Settings saved.";
  }, sf.querySelector("[type=submit]"));
};
$("choose-export-root").onclick = () =>
  run(async () => {
    const path = await window.desktop.chooseFolder();
    if (path) {
      sf.elements.exportRoot.value = path;
      settingsDirty = true;
    }
  });
$("reset-export-root").onclick = () => {
  sf.elements.exportRoot.value = "";
  settingsDirty = true;
};
$("save-cloud-features").onclick = () =>
  run(async () => {
    await window.desktop.updateSettings({
      cloudSnapshotsEnabled: $("cloud-snapshots").checked,
      cloudCommandsEnabled: $("cloud-commands").checked,
      cloudSourceConnectionId: $("cloud-source").value || null,
    });
    return "Cloud options saved.";
  }, $("save-cloud-features"));
$("scheduler-toggle").onclick = () =>
  run(async () => {
    const paused = !snapshot.settings?.schedulerPaused;
    await window.desktop.setSchedulerPaused(paused);
    return paused
      ? "Scheduled exports stopped. Manual Sync Now still works."
      : "Scheduled exports started.";
  }, $("scheduler-toggle"));
$("export-all").onclick = () =>
  run(async () => {
    const ids = (snapshot.exportJobs ?? [])
      .filter((j) => j.enabled)
      .map((j) => j.connectionId);
    if (!ids.length) return "Enable at least one export schedule first.";
    const results = await Promise.all(
      ids.map((id) =>
        window.desktop
          .exportNow(id)
          .catch((e) => ({ state: "failed", message: e.message })),
      ),
    );
    return results
      .map((r, i) => connectionName(ids[i]) + ": " + r.message)
      .join("\n");
  }, $("export-all"));
$("preview-normalized").onclick = () =>
  run(async () => {
    const id = $("normalized-connection").value;
    if (!id) return "Add a readable source connection first.";
    const preview = await window.desktop.previewNormalized(id);
    const list = element("ul", undefined, "issue-list");
    preview.issues.forEach((i) =>
      list.append(
        element(
          "li",
          (i.severity === "error" ? "Error · " : "Warning · ") +
            (i.sourceProductId ? i.sourceProductId + ": " : "") +
            i.message,
          i.severity,
        ),
      ),
    );
    $("normalized-issues").replaceChildren(list);
    table(
      "normalized-table",
      [
        ["SKU", "sku"],
        ["EAN", "ean"],
        ["Name", "name"],
        ["Price", "price"],
        ["Currency", "currency"],
        ["Quantity", "quantity"],
        ["Meaning", "quantityKind"],
        ["Warehouse", "warehouse"],
        ["Availability", "availabilityStatus"],
        ["Source updated", "updated"],
      ],
      preview.items.map((i) => ({ ...i, updated: when(i.sourceUpdatedAt) })),
    );
    return (
      (preview.complete ? "Complete: " : "Would be held: ") +
      preview.count +
      " normalized products from " +
      preview.warehouses.length +
      " warehouse(s). " +
      preview.issues.length +
      " issue(s). Nothing was written."
    );
  }, $("preview-normalized"));
async function loadProducts() {
  const id = $("product-connection").value;
  if (!id || !window.desktop.products) return;
  const result = await window.desktop.products(id);
  const stock = new Map(
    result.lastSnapshot.map((r) => [r.source_product_id, r]),
  );
  productCache = {
    id,
    rows: result.identities.map((p) => ({
      ...p,
      ...stock.get(p.source_product_id),
      seen: when(p.last_seen_at),
    })),
  };
  renderProducts();
}
function renderProducts() {
  const search = $("product-search").value.toLowerCase().trim();
  table(
    "product-table",
    [
      ["SKU", "sku"],
      ["EAN", "ean"],
      ["Name", "name"],
      ["Warehouse", "warehouse"],
      ["Quantity", "quantity"],
      ["Price", "price"],
      ["Currency", "currency"],
      ["Last seen", "seen"],
    ],
    productCache.rows.filter(
      (r) =>
        !search ||
        [r.sku, r.ean, r.name]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(search),
    ),
  );
}
$("product-connection").onchange = () =>
  loadProducts().catch((e) => notice(e.message, true));
$("product-search").oninput = renderProducts;
$("mapping-export").onclick = () =>
  run(async () => {
    const result = await window.desktop.exportMapping();
    return result
      ? "Mapping configuration saved to " +
          result.path +
          ". No credentials included."
      : undefined;
  }, $("mapping-export"));
$("mapping-import").onclick = () =>
  run(async () => {
    const result = await window.desktop.importMapping();
    return result
      ? `Imported mappings for ${result.connections} connection(s) and ${result.exportJobs} export setting(s). Enable imported schedules on the Inventory Sync page.`
      : undefined;
  }, $("mapping-import"));

// ---------------------------------------------------------------- optional local inventory
async function loadLocalInventory() {
  if (!window.desktop.localInventory) {
    $("local-inventory").hidden = true;
    return;
  }
  const inv = await window.desktop.localInventory();
  $("local-summary").textContent =
    `${inv.products} product(s) · ${inv.locations.length} location(s) · ${inv.stock.length} stock line(s)`;
  $("local-locations").replaceChildren(
    ...inv.locations.map((name) => {
      const o = document.createElement("option");
      o.value = name;
      return o;
    }),
  );
  table(
    "local-stock",
    [
      ["SKU", "sku"],
      ["EAN", "ean"],
      ["Name", "name"],
      ["Location", "location"],
      ["Quantity", "quantity"],
      ["Price", "price"],
      ["Currency", "currency"],
      ["Updated", "updated"],
    ],
    inv.stock.map((r) => ({ ...r, updated: when(r.updated_at) })),
  );
  table(
    "local-movements",
    [
      ["Time", "time"],
      ["SKU", "sku"],
      ["Location", "location"],
      ["Change", "change"],
      ["After", "quantity_after"],
      ["Reason", "reason"],
    ],
    inv.movements.map((m) => ({
      ...m,
      time: when(m.created_at),
      change: (m.delta > 0 ? "+" : "") + m.delta,
    })),
  );
}
$("local-inventory").addEventListener("toggle", () => {
  if ($("local-inventory").open)
    loadLocalInventory().catch((e) => notice(e.message, true));
});
$("local-product-form").onsubmit = (event) => {
  event.preventDefault();
  const f = event.target;
  run(async () => {
    const p = await window.desktop.localSaveProduct({
      sku: f.elements.sku.value,
      name: f.elements.name.value,
      ean: f.elements.ean.value,
      price: f.elements.price.value,
      currency: f.elements.currency.value.trim().toUpperCase(),
    });
    f.reset();
    await loadLocalInventory();
    return "Product " + p.sku + " saved.";
  }, f.querySelector("[type=submit]"));
};
$("local-adjust-form").onsubmit = (event) => {
  event.preventDefault();
  const f = event.target;
  run(async () => {
    const r = await window.desktop.localAdjust({
      sku: f.elements.sku.value,
      location: f.elements.location.value,
      delta: f.elements.delta.value,
      set: f.elements.set.value,
      reason: f.elements.reason.value || "adjustment",
    });
    f.elements.sku.value = "";
    f.elements.delta.value = "";
    f.elements.set.value = "";
    $("local-lookup-result").hidden = true;
    await loadLocalInventory();
    return `${r.sku} @ ${r.location}: ${r.before} → ${r.after}`;
  }, f.querySelector("[type=submit]"));
};
// Barcode scanners type the code and press Enter; show what was found before adjusting.
$("local-adjust-form").elements.sku.addEventListener(
  "change",
  async (event) => {
    const value = event.target.value.trim();
    if (!value) return;
    try {
      const p = await window.desktop.localLookup(value);
      $("local-lookup-result").hidden = false;
      $("local-lookup-result").textContent = p
        ? `${p.sku} · ${p.name} · ${p.price} ${p.currency}${p.ean ? " · EAN " + p.ean : ""}`
        : "No product with this barcode or SKU.";
    } catch (e) {
      notice(e.message, true);
    }
  },
);
$("local-import").onclick = () =>
  run(async () => {
    const path = await window.desktop.chooseFile();
    if (!path) return;
    const r = await window.desktop.localImport(path);
    await loadLocalInventory();
    return `Imported ${r.rows} stock line(s) for ${r.products} product(s).`;
  }, $("local-import"));
$("local-use-source").onclick = () =>
  run(async () => {
    const existing = snapshot.connections.find((c) => c.platform === "local");
    if (existing) {
      navigate("sync");
      return "Local inventory is already a connection. Configure its export on this page.";
    }
    await window.desktop.saveConnection({
      name: "Local inventory",
      platform: "local",
      permission: "read",
      integrationKind: "file",
    });
    navigate("sync");
    return "Local inventory added as a source. Enable its automatic export on this page.";
  }, $("local-use-source"));
