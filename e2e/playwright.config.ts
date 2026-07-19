import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  retries: 0,
  use: {
    headless: true,
    // Prefer a pre-provisioned Chromium (CHROMIUM_PATH) over Playwright's
    // own download — keeps the suite runnable in containers where
    // `playwright install` is unavailable or a different version is baked in.
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {},
  },
  reporter: [["list"]],
});
