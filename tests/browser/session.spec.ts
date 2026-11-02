import { test, expect } from "@playwright/test";
import {
  generateKeyPairSigner,
  getAddressEncoder,
  getTransactionDecoder,
  getTransactionEncoder,
  signTransaction,
  lamports,
} from "@solana/kit";
import { vmRpc, TEST_PROGRAM } from "../vm-rpc";
import { base64, sha256, decodeHeader } from "../../lib/chain/protocol";
import { canonical } from "../../lib/model/manifest";
import { applyPhantomPriorityFees } from "../phantom-fees";

for (const { interrupted, injected, panelRecovery } of [
  { interrupted: false, injected: false, panelRecovery: false },
  { interrupted: true, injected: false, panelRecovery: false },
  { interrupted: false, injected: true, panelRecovery: false },
  { interrupted: false, injected: true, panelRecovery: true },
])
  test(`delegated browser upload ${panelRecovery ? "reclaims through Close All in the control panel" : injected ? "broadcasts the injected Phantom response and recovers rent" : interrupted ? "loses its key and owner recovers independently" : "needs one owner signature and refunds unused fees"}`, async ({
    page,
    context,
  }) => {
    const { svm, request } = vmRpc(),
      owner = await generateKeyPairSigner();
    svm.airdrop(owner.address, lamports(1000000000n));
    const bytes = new Uint8Array(78).fill(42),
      digest = await sha256(bytes);
    const manifest = {
      version: 1,
      source: { repo: "synthetic/browser-session", revision: "0".repeat(40) },
      tensors: [],
      artifacts: [
        { name: "proof", length: 78, payloadOffset: 0, sha256: digest },
      ],
      payloadBytes: 78,
      shards: [{ index: 0, offset: 0, length: 78, sha256: digest }],
    };
    const id = await sha256(new TextEncoder().encode(canonical(manifest)));
    let approvals = 0,
      landed = 0,
      attempts = 0,
      height = 1;
    let rejectSetup = !interrupted,
      throttlePreview = !interrupted;
    let releaseSignature = () => {};
    const signatureGate = new Promise<void>((r) => {
      releaseSignature = r;
    });
    await context.exposeBinding(
      "__ownerSign",
      async (_source, wires: number[][]) => {
        if (rejectSetup) {
          rejectSetup = false;
          throw new Error("Rejected session setup");
        }
        if (injected && approvals === 0) await signatureGate;
        approvals++;
        return Promise.all(
          wires.map(async (wire) => [
            ...getTransactionEncoder().encode(
              await signTransaction(
                [owner.keyPair],
                getTransactionDecoder().decode(
                  applyPhantomPriorityFees(Uint8Array.from(wire)),
                ),
              ),
            ),
          ]),
        );
      },
    );
    await context.addInitScript(
      ({ publicAddress, publicBytes, injected }) => {
        if (injected) {
          type Tx = {
            version: number;
            serialize(): Uint8Array;
            message: { serialize(): Uint8Array };
          };
          const sign = async (transactions: Tx[]) => {
            if (
              transactions.some(
                (tx) =>
                  tx.version !== 0 ||
                  typeof tx.message.serialize !== "function",
              )
            )
              throw new Error("Expected a typed versioned transaction");
            const wires = await (
              window as unknown as {
                __ownerSign: (w: number[][]) => Promise<number[][]>;
              }
            ).__ownerSign(transactions.map((tx) => [...tx.serialize()]));
            return wires.map((wire) => ({
              serialize: () => new Uint8Array(wire),
            }));
          };
          Object.defineProperty(window, "phantom", {
            value: {
              solana: {
                isPhantom: true,
                publicKey: { toString: () => publicAddress },
                connect: async () => ({
                  publicKey: { toString: () => publicAddress },
                }),
                disconnect: async () => {},
                on: () => {},
                removeListener: () => {},
                request: async () => {
                  throw new Error("Raw request API must not be used");
                },
                signTransaction: async (tx: Tx) => (await sign([tx]))[0],
                signAllTransactions: sign,
              },
            },
          });
          return;
        }
        const account = {
          address: publicAddress,
          publicKey: new Uint8Array(publicBytes),
          chains: ["solana:devnet"],
          features: ["solana:signTransaction"],
        };
        const wallet = {
          version: "1.0.0",
          name: "Phantom",
          icon: "data:image/svg+xml,<svg/>",
          chains: account.chains,
          accounts: [account],
          features: {
            "standard:connect": {
              version: "1.0.0",
              connect: async () => ({ accounts: [account] }),
            },
            "standard:disconnect": {
              version: "1.0.0",
              disconnect: async () => {},
            },
            "standard:events": { version: "1.0.0", on: () => () => {} },
            "solana:signTransaction": {
              version: "1.0.0",
              supportedTransactionVersions: [0],
              signTransaction: async (
                ...inputs: { transaction: Uint8Array }[]
              ) => {
                const wires = await (
                  window as unknown as {
                    __ownerSign: (w: number[][]) => Promise<number[][]>;
                  }
                ).__ownerSign(inputs.map((i) => [...i.transaction]));
                return wires.map((w) => ({
                  signedTransaction: new Uint8Array(w),
                }));
              },
            },
          },
        };
        const register = (api: { register: (w: unknown) => void }) =>
          api.register(wallet);
        window.addEventListener("wallet-standard:app-ready", (e) =>
          register((e as CustomEvent).detail),
        );
        window.dispatchEvent(
          new CustomEvent("wallet-standard:register-wallet", {
            detail: register,
          }),
        );
      },
      {
        publicAddress: owner.address,
        injected,
        publicBytes: [...getAddressEncoder().encode(owner.address)],
      },
    );
    await context.route("**/api/config", (r) =>
      r.fulfill({
        json: {
          cluster: "devnet",
          program: TEST_PROGRAM,
          rpcDisplay: "VM",
          maxDeposit: "100000000",
          maxTransactions: 100,
        },
      }),
    );
    await context.route("**/api/price", (r) =>
      r.fulfill({ json: { usd: null, timestamp: null, stale: true } }),
    );
    await context.route("**/api/model", (r) =>
      r.fulfill({
        json:
          r.request().postDataJSON().action === "shard"
            ? { bytes: base64(bytes) }
            : { id, manifest },
      }),
    );
    let release = () => {},
      blocked = () => {};
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      waiting = new Promise<void>((r) => {
        blocked = r;
      });
    await context.route("**/api/rpc", async (route) => {
      const p = route.request().postDataJSON();
      if (p.method === "simulateTransaction" && throttlePreview) {
        throttlePreview = false;
        await route.fulfill({
          status: 429,
          json: { error: "RPC request failed (429)" },
        });
        return;
      }
      try {
        if (p.method === "sendTransaction" && ++attempts === 3 && interrupted) {
          blocked();
          await gate;
          throw new Error("Injected unavailable RPC");
        }
        const result =
          p.method === "getBlockHeight"
            ? height
            : await request(p.method, p.params);
        if (p.method === "sendTransaction") landed++;
        await route.fulfill({ json: { jsonrpc: "2.0", id: p.id, result } });
      } catch (e) {
        await route.fulfill({
          json: {
            jsonrpc: "2.0",
            id: p.id,
            error: { code: -32002, message: (e as Error).message },
          },
        });
      }
    });
    await page.goto("/advanced");
    await page.getByRole("button", { name: "Connect Phantom" }).click();
    await page
      .getByRole("button", { name: "Use tiny synthetic proof" })
      .click();
    await expect(
      page.getByText("Manifest prepared locally.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Verify from Solana" }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Review one-approval upload" })
      .click();
    if (!interrupted) {
      await expect(page.locator(".error[role=alert]")).toContainText(
        "Solana RPC rate limit reached (429)",
      );
      expect(approvals).toBe(0);
      expect(landed).toBe(0);
      await page
        .getByRole("button", { name: "Review one-approval upload" })
        .click();
    }
    expect(approvals).toBe(0);
    expect(landed).toBe(0);
    await expect(
      page.getByRole("button", { name: "Approve once in Phantom and upload" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Review upload budget", { exact: true }),
    ).toBeFocused();
    await page.getByRole("button", { name: "View upload budget" }).click();
    expect(approvals).toBe(0);
    await page
      .getByLabel(/I authorize this entire devnet upload budget/)
      .check();
    if (injected) {
      await page.evaluate(async () => {
        const deploymentKey = Object.keys(localStorage).find((k) =>
          k.startsWith("slm-deployment-v1:"),
        )!;
        const lock = deploymentKey.replace("slm-deployment-v1:", "slm-run-v1:");
        await new Promise<void>((ready) => {
          void navigator.locks.request(lock, async () => {
            ready();
            await new Promise<void>((release) => {
              (
                window as unknown as { releaseTestLock: () => void }
              ).releaseTestLock = release;
            });
          });
        });
      });
      await page
        .getByRole("button", { name: "Approve once in Phantom and upload" })
        .click();
      await expect(page.locator(".error[role=alert]")).toContainText(
        "Another tab is already handling this wallet",
      );
      expect(approvals).toBe(0);
      expect(landed).toBe(0);
      await page.evaluate(() =>
        (
          window as unknown as { releaseTestLock: () => void }
        ).releaseTestLock(),
      );
    }
    await page
      .getByRole("button", { name: "Approve once in Phantom and upload" })
      .click();
    if (!interrupted) {
      await expect(page.locator(".error[role=alert]")).toContainText(
        "Rejected session setup",
      );
      await expect(page.locator(".error[role=alert]")).toBeFocused();
      expect(landed).toBe(0);
      expect(
        svm
          .getProgramAccounts(TEST_PROGRAM)
          .filter((a) => a.data.length >= 192),
      ).toHaveLength(0);
      await page
        .getByRole("button", { name: "Approve once in Phantom and upload" })
        .click();
    }
    if (injected) {
      await expect(page.getByRole("status")).toContainText(
        "Waiting for Phantom to return your signed setup",
      );
      await expect(page.getByRole("status")).toBeInViewport();
      expect(landed).toBe(0);
      releaseSignature();
    }
    if (interrupted) {
      await waiting;
      await page
        .getByRole("button", { name: "Pause / discard preview" })
        .click();
      height = 100001;
      release();
      await expect(page.locator(".error[role=alert]")).toContainText(
        "Batch stopped",
      );
      height = 1;
    } else {
      await expect(page.getByRole("status")).toContainText(
        "Delegated upload verified",
      );
      await expect(
        page
          .getByText("Verified shards", { exact: true })
          .locator("..")
          .locator("strong"),
      ).toHaveText("1");
      await expect(
        page.getByRole("button", { name: "Verify from Solana" }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "Verify from Solana" }).click();
      await expect(page.getByRole("status")).toContainText(
        "All shards verified",
      );
      await page.screenshot({
        path: "/tmp/slm-session-complete.png",
        fullPage: true,
      });
    }
    expect(approvals).toBe(1);
    const session = svm
      .getProgramAccounts(TEST_PROGRAM)
      .find((a) => a.data[9] === 3)!;
    const delegate = decodeHeader(Uint8Array.from(session.data)).session!
      .delegate;
    const stranded = svm.getBalance(delegate) || 0n;
    if (!interrupted) expect(stranded).toBe(0n);
    await context.route("**/api/model", (r) => r.abort());
    if (panelRecovery) {
      await page
        .getByRole("button", { name: "↓ Withdraw", exact: true })
        .click();
    } else {
      // Discard the non-extractable session key by moving to standalone recovery.
      // No manifest, local journal, or running Next app is required.
      await page.goto("http://127.0.0.1:3001");
      await page.getByRole("button", { name: "Connect Phantom" }).click();
    }
    await page.getByRole("button", { name: "Clear selection" }).click();
    const beforeClosure = landed;
    await page.getByRole("button", { name: "Close All / Reclaim All" }).click();
    const review = page.getByRole("region", { name: "Review refund batch" });
    await expect(review).toBeFocused();
    await expect(review).toBeInViewport();
    await expect(page.getByRole("status")).toContainText(
      "Refund preview ready",
    );
    await expect(
      page.getByRole("button", { name: "Sign 2 transactions in Phantom" }),
    ).toBeDisabled();
    expect(approvals).toBe(1);
    expect(landed).toBe(beforeClosure);
    for (const count of [2, 1]) {
      if (count === 1)
        await page
          .getByRole("button", { name: "Prepare / resume next batch" })
          .click();
      await page
        .getByLabel(
          "I reviewed the accounts, receiving wallet, refundable deposit, and spent fee.",
        )
        .check();
      await page
        .getByRole("button", {
          name:
            count === 1
              ? "Sign this transaction in Phantom"
              : `Sign ${count} transactions in Phantom`,
        })
        .click();
      await expect(page.getByRole("status")).toContainText(
        count === 1 ? "Transaction finalized" : "Batch finalized",
      );
    }
    expect(
      svm.getProgramAccounts(TEST_PROGRAM).filter((a) => a.data.length >= 192),
    ).toHaveLength(0);
    expect(svm.getBalance(owner.address)).toBe(
      1000000000n - BigInt(landed) * 5000n - stranded,
    );
    if (panelRecovery) {
      const completedApprovals = approvals;
      await page
        .getByRole("button", { name: "Close All / Reclaim All" })
        .click();
      await expect(page.getByRole("status")).toContainText(
        "All selected accounts are closed",
      );
      expect(approvals).toBe(completedApprovals);
      await expect(review).toHaveCount(0);
    }
  });
