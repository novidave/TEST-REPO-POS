"use strict";
const Database = require("better-sqlite3");
const db = new Database(":memory:");
try {
  db.exec("CREATE TABLE smoke(id TEXT PRIMARY KEY, quantity INTEGER NOT NULL)");
  db.transaction(() =>
    db.prepare("INSERT INTO smoke VALUES(?,?)").run("sku", 2),
  )();
  if (db.prepare("SELECT quantity FROM smoke").get().quantity !== 2)
    throw new Error("SQLite native smoke failed");
  console.log(
    `SQLite native check passed (${process.versions.electron ? "Electron " + process.versions.electron : "Node " + process.versions.node}, Node-API ${process.versions.napi})`,
  );
} finally {
  db.close();
}
