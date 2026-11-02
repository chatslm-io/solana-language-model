import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  timeout: 90000,
  use: { baseURL: "http://127.0.0.1:3000", headless: true },
  webServer: [
    {
      command: "npm run start",
      url: "http://127.0.0.1:3000",
      reuseExistingServer: false,
      env: {
        HF_DOWNLOAD_DIR: "/tmp/slm-browser-models",
        // Tests must never load the operator's actual signing configuration.
        SLM_SIGNER_ENV_FILE: "/intentionally-unconfigured-slm/operator.env",
      },
    },
    {
      command: "npm run recovery",
      url: "http://127.0.0.1:3001",
      reuseExistingServer: false,
    },
  ],
});
