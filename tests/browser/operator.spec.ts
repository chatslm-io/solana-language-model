import { test, expect } from "@playwright/test";
import { operatorFixture } from "../operator-fixture";
import type { Network } from "../../lib/operator/config";
import type { Mode } from "../../lib/operator/types";

test("minimal operator runs a test, chooses a GGUF, deploys and withdraws with no wallet prompts", async ({
  page,
  context,
}) => {
  const f = await operatorFixture();
  let selectedFile = "",
    starts = 0;
  const statusRequests: string[] = [];
  const config = f.deps.config;
  f.deps.config = (cluster) =>
    cluster === "mainnet-beta"
      ? { ...config(cluster), program: null }
      : config(cluster);
  await context.route("**/api/operator", async (route) => {
    const p = route.request().postDataJSON();
    try {
      let result;
      if (p.action === "status") {
        statusRequests.push(p.cluster);
        result = await f.engine.status(
          p.cluster as Network,
          p.refresh === true,
        );
      } else if (p.action === "prepare") {
        selectedFile = p.file || selectedFile;
        result = await f.engine.prepare(
          p.cluster,
          p.mode as Mode,
          p.mode === "upload"
            ? { repo: p.repo, revision: p.revision, file: p.file }
            : undefined,
        );
      } else if (p.action === "start") {
        starts++;
        result = await f.engine.start(p.id, p.cluster);
      } else if (p.action === "rpcSettings")
        result = await f.engine.configureRpc(p.cluster, {
          mode: p.mode,
          rps: p.rps,
          sendRps: p.sendRps,
          scanRps: p.scanRps,
        });
      else result = f.engine.pause(p.id);
      await route.fulfill({ json: result });
    } catch (e) {
      await route.fulfill({
        status: 400,
        json: { error: (e as Error).message },
      });
    }
  });
  await context.route("**/api/model", async (route) => {
    const p = route.request().postDataJSON();
    if (p.action !== "resolve")
      throw new Error("Browser must not receive or sign model transactions");
    await route.fulfill({
      json: {
        repo: p.repo,
        revision: "a".repeat(40),
        files: [
          { name: "tiny-Q4_0.gguf", size: 1000 },
          { name: "tiny-Q8_0.gguf", size: 2000 },
        ],
      },
    });
  });
  try {
    await page.goto("/");
    await expect(page.locator("body")).toHaveCSS(
      "background-color",
      "rgb(0, 0, 0)",
    );
    const runTest = page.getByRole("button", { name: "Run test", exact: true });
    await expect(runTest).toBeEnabled({ timeout: 15000 });
    await page.locator(".operator-rpc summary").click();
    await page.getByRole("button", { name: "Paid RPC", exact: true }).click();
    await expect(page.getByLabel("RPC requests per second")).toHaveValue("50");
    await expect(page.getByLabel("Transaction sends per second")).toHaveValue(
      "5",
    );
    await expect(page.getByLabel("Account scans per second")).toHaveValue("25");
    await page.getByLabel("RPC requests per second").fill("0");
    await page.getByRole("button", { name: "Apply RPC settings" }).click();
    await expect(page.locator(".operator-rpc [role=alert]")).toContainText(
      "whole numbers between 1 and 1000",
    );
    await page.getByRole("button", { name: "Free RPC", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Apply RPC settings" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Paid RPC", exact: true }).click();
    await expect(page.getByLabel("RPC requests per second")).toHaveValue("50");
    await page.getByLabel("RPC requests per second").fill("60");
    await page.getByLabel("Transaction sends per second").fill("6");
    await page.getByLabel("Account scans per second").fill("30");
    await page.getByRole("button", { name: "Apply RPC settings" }).click();
    await expect(page.locator(".operator-rpc summary")).toContainText(
      "Paid · 60 requests/sec",
    );
    expect(f.store.rpcSettings.devnet).toEqual({
      mode: "paid",
      rps: 60,
      sendRps: 6,
      scanRps: 30,
    });
    const testProgress = page.getByRole("progressbar", {
      name: "Test progress",
      exact: true,
    });
    await expect(testProgress).toHaveAttribute("value", "0");
    await expect(
      page.getByRole("region", { name: "Test progress details" }),
    ).toContainText("0 / 7");
    expect(starts).toBe(0);
    expect(f.sends()).toBe(0);
    await runTest.click();
    await expect(page.getByRole("status")).toContainText("Test passed", {
      timeout: 15000,
    });
    expect(starts).toBe(1);
    expect(f.sends()).toBe(7);
    await expect(testProgress).toHaveAttribute("value", "100");
    await expect(
      page.getByRole("region", { name: "Test progress details" }),
    ).toContainText("7 / 7");
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByLabel("GGUF file")).toBeEnabled();
    await page.getByLabel("GGUF file").selectOption("tiny-Q8_0.gguf");
    const deploy = page.getByRole("button", { name: "Deploy", exact: true });
    await expect(deploy).toBeEnabled({ timeout: 15000 });
    expect(selectedFile).toBe("tiny-Q8_0.gguf");
    // Editing the source invalidates the old quote even when a status poll returns it.
    await page.getByLabel("Hugging Face repository").fill("changed/repository");
    await expect(deploy).toBeDisabled();
    await expect(page.getByLabel("GGUF file")).toBeEnabled();
    await page.getByLabel("GGUF file").selectOption("tiny-Q8_0.gguf");
    await expect(deploy).toBeEnabled({ timeout: 15000 });
    const progress = page.getByRole("progressbar", {
      name: "Upload progress",
      exact: true,
    });
    const details = page.getByRole("region", {
      name: "Upload progress details",
    });
    await expect(progress).toHaveAttribute("value", "0");
    await expect(details).toContainText("0 / 1");
    await expect(details).toContainText("0 / 5");
    await expect(details).toContainText("5 left");
    await page.screenshot({
      path: "/tmp/slm-local-upload.png",
      fullPage: true,
    });
    // Pause after the first real transaction so in-flight progress is visible.
    f.afterSend(() => {
      if (f.sends() === 8) f.engine.pause(f.store.load().at(-1)!.id);
    });
    await deploy.click();
    await expect(progress).toHaveAttribute("value", "20", { timeout: 15000 });
    await expect(details).toContainText("1 / 5");
    await expect(details).toContainText("4 left");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "/tmp/slm-upload-progress-mobile.png",
      fullPage: true,
    });
    await page.reload();
    await expect(page.locator(".operator-rpc summary")).toContainText(
      "Paid · 60 requests/sec",
    );
    await expect(
      page.getByRole("progressbar", { name: "Upload progress", exact: true }),
    ).toHaveAttribute("value", "20");
    f.afterSend(() => {});
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "Deployment verified",
      { timeout: 15000 },
    );
    await expect(progress).toHaveAttribute("value", "100");
    await expect(details).toContainText("1 / 1");
    await expect(details).toContainText("5 / 5");
    expect(starts).toBe(3);
    expect(f.sends()).toBe(12);
    f.loseModels();
    await page.getByRole("button", { name: "Withdraw", exact: true }).click();
    const withdraw = page.getByRole("button", {
      name: "Withdraw all",
      exact: true,
    });
    await expect(withdraw).toBeEnabled({ timeout: 15000 });
    const withdrawalProgress = page.getByRole("progressbar", {
      name: "Withdrawal progress",
      exact: true,
    });
    const withdrawalDetails = page.getByRole("region", {
      name: "Withdrawal progress details",
    });
    await expect(withdrawalProgress).toHaveAttribute("value", "0");
    await expect(withdrawalDetails).toContainText("0 / 2");
    f.afterSend(() => {
      if (f.sends() === 13) f.engine.pause(f.store.load().at(-1)!.id);
    });
    await withdraw.click();
    await expect(withdrawalProgress).toHaveAttribute("value", "50", {
      timeout: 15000,
    });
    await expect(withdrawalDetails).toContainText("1 / 2");
    await expect(withdrawalDetails).toContainText("1 left");
    f.afterSend(() => {});
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "Withdrawal complete",
      { timeout: 15000 },
    );
    await expect(withdrawalProgress).toHaveAttribute("value", "100");
    await expect(withdrawalDetails).toContainText("2 / 2");
    expect(starts).toBe(5);
    expect(f.sends()).toBe(14);
    expect((await f.engine.status("devnet", true)).accounts).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: "/tmp/slm-local-withdraw-mobile.png",
      fullPage: true,
    });
    await page.locator(".operator-rpc summary").click();
    await expect(page.getByLabel("Account scans per second")).toBeVisible();
    await page.screenshot({
      path: "/tmp/slm-paid-rpc-mobile.png",
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Mainnet", exact: true }).click();
    await expect(page.locator(".operator-rpc summary")).toContainText(
      "Free mode",
    );
    await expect(
      page.getByText("MAINNET · Real SOL.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Deploy storage program", exact: true }),
    ).toBeVisible();
    statusRequests.length = 0;
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Mainnet", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: "Deploy storage program", exact: true }),
    ).toBeVisible();
    expect(statusRequests[0]).toBe("mainnet-beta");
    await page.getByRole("button", { name: "Devnet", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Devnet", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Devnet", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(starts).toBe(5);
  } finally {
    await f.engine.wait();
    await f.close();
  }
});

test("operator API rejects cross-origin and arbitrary signing payloads; missing key shows setup without a key input", async ({
  page,
  request,
  baseURL,
}) => {
  const cross = await request.post("/api/operator", {
    headers: { Origin: "https://evil.example", "X-SLM-Local": "1" },
    data: { action: "start", cluster: "devnet", id: "a".repeat(64) },
  });
  expect(cross.status()).toBe(400);
  const arbitrary = await request.post("/api/operator", {
    headers: { Origin: baseURL!, "X-SLM-Local": "1" },
    data: {
      action: "start",
      cluster: "devnet",
      id: "a".repeat(64),
      transaction: "not-authorized",
      privateKey: "not-a-key",
    },
  });
  expect(arbitrary.status()).toBe(400);
  expect((await arbitrary.json()).error).toBe("Unsupported operator request");
  const credentials = await request.post("/api/operator", {
    headers: { Origin: baseURL!, "X-SLM-Local": "1" },
    data: {
      action: "rpcSettings",
      cluster: "devnet",
      mode: "paid",
      rps: 50,
      sendRps: 5,
      scanRps: 25,
      rpc: "https://unapproved.example",
    },
  });
  expect(credentials.status()).toBe(400);
  expect((await credentials.json()).error).toBe("Unsupported operator request");
  for (const data of [
    {
      action: "programPrepare",
      cluster: "mainnet-beta",
      binaryPath: "/tmp/arbitrary.so",
    },
    {
      action: "programStart",
      cluster: "mainnet-beta",
      id: "a".repeat(64),
      program: "11111111111111111111111111111111",
    },
    {
      action: "programRecover",
      cluster: "mainnet-beta",
      id: "a".repeat(64),
      recipient: "11111111111111111111111111111111",
    },
  ]) {
    const refused = await request.post("/api/operator", {
      headers: { Origin: baseURL!, "X-SLM-Local": "1" },
      data,
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toBe("Unsupported operator request");
  }
  await page.route("**/api/operator", (r) =>
    r.fulfill({
      json: {
        cluster: "devnet",
        owner: null,
        program: null,
        balance: "0",
        refundable: "0",
        accounts: 0,
        maxDeposit: "0",
        maxFees: "0",
        busy: false,
        job: null,
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("npm run operator:setup")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run test", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("input")).toHaveCount(0);
});
