const http = require("node:http");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
http
  .createServer(async (req, res) => {
    const name = {
      "/": "index.html",
      "/ui.js": "ui.js",
      "/style.css": "style.css",
    }[req.url];
    if (!name) {
      res.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(join(__dirname, "../ui", name));
      res.setHeader(
        "Content-Type",
        name.endsWith(".js")
          ? "text/javascript"
          : name.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      res.end(data);
    } catch {
      res.writeHead(500).end();
    }
  })
  .listen(3199, "127.0.0.1");
