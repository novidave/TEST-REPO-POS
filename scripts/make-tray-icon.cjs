"use strict";
// Generates assets/tray.png (32x32 RGBA) in the dashboard's green brand colour. No dependencies.
const { deflateSync } = require("node:zlib");
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const size = 32;
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) {
  raw[y * (size * 4 + 1)] = 0;
  for (let x = 0; x < size; x++) {
    const o = y * (size * 4 + 1) + 1 + x * 4;
    const cx = x - 15.5,
      cy = y - 15.5;
    // Rounded square
    const qx = Math.max(Math.abs(cx) - 9, 0),
      qy = Math.max(Math.abs(cy) - 9, 0);
    const inside = Math.hypot(qx, qy) <= 6.5;
    if (!inside) continue;
    const t = (x + y) / (2 * size);
    let [r, g, b] = [
      0x42 + (0x15 - 0x42) * t,
      0xc6 + (0x98 - 0xc6) * t,
      0x7a + (0x4a - 0x7a) * t,
    ];
    // White "C" ring with an opening on the right
    const d = Math.hypot(cx, cy),
      angle = Math.atan2(cy, cx);
    if (d >= 6.5 && d <= 10 && Math.abs(angle) > 0.75)
      [r, g, b] = [255, 255, 255];
    raw.set([Math.round(r), Math.round(g), Math.round(b), 255], o);
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr.set([8, 6, 0, 0, 0], 8);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync(join(__dirname, "..", "assets"), { recursive: true });
writeFileSync(join(__dirname, "..", "assets", "tray.png"), png);
console.log("assets/tray.png written (" + png.length + " bytes)");
