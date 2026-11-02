import { test, expect } from "@playwright/test";
import { address, lamports } from "@solana/kit";
import { operatorFixture } from "../operator-fixture";
import { OperatorEngine } from "../../lib/operator/engine";

test("program setup previews mainnet costs, pauses across reload, pins the real binary and enables tiny recovery", async ({
  page,
  context,
}) => {
  const f = await operatorFixture({
    stableBlockhash: true,
    genesis: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  });
  f.config.program = null;
  f.config.maxDeposit = "2000000000";
  f.config.maxTransactions = 1000;
  f.config.rpcPolicy = { mode: "paid", rps: 50, sendRps: 5, scanRps: 25 };
  f.vm.svm.airdrop(f.signer.address, lamports(3000000000n));
  let engine = f.engine;
  await context.route("**/api/operator", async (route) => {
    const p = route.request().postDataJSON();
    try {
      const result =
        p.action === "status"
          ? await engine.status(p.cluster, p.refresh === true)
          : p.action === "programPrepare"
            ? await engine.prepareProgram(p.cluster)
            : p.action === "programStart"
              ? await engine.startProgram(p.id, p.cluster)
              : p.action === "programRecover"
                ? await engine.startProgram(p.id, p.cluster, true)
                : p.action === "prepare"
                  ? await engine.prepare(p.cluster, p.mode)
                  : p.action === "start"
                    ? await engine.start(p.id, p.cluster)
                    : engine.pause(p.id);
      await route.fulfill({ json: result });
    } catch (error) {
      await route.fulfill({
        status: 400,
        json: { error: (error as Error).message },
      });
    }
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Mainnet", exact: true }).click();
    await page
      .getByRole("button", { name: "Deploy storage program", exact: true })
      .click();
    const approve = page.getByRole("button", {
      name: "Approve and deploy program on mainnet",
      exact: true,
    });
    await expect(approve).toBeEnabled();
    expect(f.sends()).toBe(0);
    await expect(
      page.getByText("Program ID deposit", { exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "/tmp/slm-program-mainnet-preview.png",
      fullPage: true,
    });
    const p = f.store.programJobs.at(-1)!;
    f.afterSend(() => {
      if (f.sends() === 1) engine.pause(p.id);
    });
    await approve.click();
    await expect(
      page.getByRole("button", {
        name: "Resume program deployment",
        exact: true,
      }),
    ).toBeEnabled({ timeout: 15000 });
    await engine.wait();
    engine = new OperatorEngine(f.deps);
    // An unfinished approved operation restores its own network even when
    // another tab last saved a different preference.
    await page.evaluate(() =>
      localStorage.setItem("slm:operator:network", "devnet"),
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Mainnet", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    f.afterSend(() => {
      const deployed = f.vm.svm.getAccount(address(p.program));
      if (deployed.exists && deployed.executable)
        f.vm.svm.warpToSlot(f.vm.svm.getClock().slot + 1n);
    });
    await page
      .getByRole("button", { name: "Resume program deployment", exact: true })
      .click();
    const tiny = page.getByRole("button", { name: "Run test", exact: true });
    await expect(tiny).toBeEnabled({ timeout: 30000 });
    expect(f.store.programs["mainnet-beta"]).toBe(p.program);
    await assertMainnetGate();
    await tiny.click();
    await expect(page.getByRole("status")).toContainText("Test passed", {
      timeout: 15000,
    });
    expect((await engine.status("mainnet-beta", true)).accounts).toBe(0);
    async function assertMainnetGate() {
      await expect(
        engine.prepare("mainnet-beta", "upload", {
          repo: "test/model",
          revision: "a".repeat(40),
          file: "tiny.gguf",
        }),
      ).rejects.toThrow("Run Test on mainnet");
    }
  } finally {
    await engine.wait();
    await f.close();
  }
});
