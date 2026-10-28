const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "tests/ui",
  webServer: {
    command: "node scripts/ui-test-server.cjs",
    url: "http://127.0.0.1:3199",
    reuseExistingServer: false,
  },
  fullyParallel: false,
  use: {
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  reporter: "list",
});
