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
test("synthetic upload verifies; independent recovery discovers and reclaims without local manifests", async ({
  page,
  context,
}) => {
  const { svm, request } = vmRpc();
  const signer = await generateKeyPairSigner();
  svm.airdrop(signer.address, lamports(1000000000n));
  const initial = svm.getBalance(signer.address)!;
  let signatures = 0;
  let rejectNext = true,
    loseReply = true;
  await context.exposeBinding("__slmSign", async (_source, wire: number[]) => {
    if (rejectNext) {
      rejectNext = false;
      throw new Error("Operator rejected test prompt");
    }
    signatures++;
    return [
      ...getTransactionEncoder().encode(
        await signTransaction(
          [signer.keyPair],
          getTransactionDecoder().decode(Uint8Array.from(wire)),
        ),
      ),
    ];
  });
  await context.addInitScript(
    ({ publicAddress, publicBytes }) => {
      const account = {
        address: publicAddress,
        publicKey: new Uint8Array(publicBytes),
        chains: ["solana:devnet"],
        features: ["solana:signTransaction"],
      };
      const wallet = {
        version: "1.0.0",
        name: "Phantom",
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
        chains: ["solana:devnet"],
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
            signTransaction: async (input: { transaction: Uint8Array }) => [
              {
                signedTransaction: new Uint8Array(
                  await (
                    window as unknown as {
                      __slmSign: (wire: number[]) => Promise<number[]>;
                    }
                  ).__slmSign([...input.transaction]),
                ),
              },
            ],
          },
        },
      };
      const register = (api: { register: (wallet: unknown) => void }) =>
        api.register(wallet);
      window.addEventListener("wallet-standard:app-ready", (event) =>
        register((event as CustomEvent).detail),
      );
      window.dispatchEvent(
        new CustomEvent("wallet-standard:register-wallet", {
          detail: register,
        }),
      );
    },
    {
      publicAddress: signer.address,
      publicBytes: [...getAddressEncoder().encode(signer.address)],
    },
  );
  await context.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        cluster: "devnet",
        program: TEST_PROGRAM,
        rpcDisplay: "local LiteSVM test harness",
        maxDeposit: "10000000",
        maxTransactions: 100,
      },
    }),
  );
  await context.route("**/api/price", (route) =>
    route.fulfill({ json: { usd: null, timestamp: null, stale: true } }),
  );
  await context.route("**/api/rpc", async (route) => {
    const input = route.request().postDataJSON();
    try {
      const result = await request(input.method, input.params);
      if (input.method === "sendTransaction" && loseReply) {
        loseReply = false;
        throw new Error("Injected lost submission response");
      }
      await route.fulfill({
        json: {
          jsonrpc: "2.0",
          id: input.id,
          result,
        },
      });
    } catch (e) {
      await route.fulfill({
        json: {
          jsonrpc: "2.0",
          id: input.id,
          error: { code: -32002, message: (e as Error).message },
        },
      });
    }
  });
  await page.goto("/advanced");
  await expect(
    page.getByRole("heading", {
      name: "Weights onchain. Control in your wallet.",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Connect Phantom" }).click();
  await expect(
    page.getByRole("button", { name: "Disconnect Phantom" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Use tiny synthetic proof" }).click();
  await expect(
    page.getByText("synthetic/recovery-proof", { exact: true }),
  ).toBeVisible();
  async function signNext(alreadyPrepared = false) {
    if (!alreadyPrepared)
      await page
        .getByRole("button", { name: "Prepare / resume next batch" })
        .click();
    await expect(page.getByText("Simulation passed · prepared")).toBeVisible();
    await page
      .getByLabel(
        "I reviewed the accounts, receiving wallet, refundable deposit, and spent fee.",
      )
      .check();
    await page
      .getByRole("button", { name: "Sign this transaction in Phantom" })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Transaction finalized",
    );
    await expect(page.locator(".error[role=alert]")).toHaveCount(0);
  }
  await page
    .getByRole("button", { name: "Prepare / resume next batch" })
    .click();
  await expect(page.getByText("Simulation passed · prepared")).toBeVisible();
  await page
    .getByLabel(
      "I reviewed the accounts, receiving wallet, refundable deposit, and spent fee.",
    )
    .check();
  await page
    .getByRole("button", { name: "Sign this transaction in Phantom" })
    .click();
  await expect(page.locator(".error[role=alert]")).toContainText(
    "Operator rejected test prompt",
  );
  expect(
    svm.getProgramAccounts(TEST_PROGRAM).filter((a) => a.data.length >= 192),
  ).toHaveLength(0);
  for (let i = 0; i < 5; i++) {
    await signNext();
    if (i === 1) {
      await page.reload();
      await page.getByRole("button", { name: "Connect Phantom" }).click();
      await expect(
        page.getByRole("button", { name: "Disconnect Phantom" }),
      ).toBeEnabled();
      await expect(
        page.getByText("synthetic/recovery-proof", { exact: true }),
      ).toBeVisible();
    }
  }
  await page.getByRole("button", { name: "Verify from Solana" }).click();
  await expect(page.getByRole("status")).toContainText("All shards verified");
  expect(
    svm.getProgramAccounts(TEST_PROGRAM).filter((a) => a.data.length >= 192),
  ).toHaveLength(2);
  // A fresh standalone recovery origin has no local storage or model endpoint.
  await context.route("**/api/model", (route) => route.abort());
  await page.goto("http://127.0.0.1:3001");
  await page.getByRole("button", { name: "Connect Phantom" }).click();
  await expect(
    page.getByRole("button", { name: "Disconnect Phantom" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Close All / Reclaim All" }).click();
  await signNext(true);
  await signNext();
  expect(
    svm.getProgramAccounts(TEST_PROGRAM).filter((a) => a.data.length >= 192),
  ).toHaveLength(0);
  expect(svm.getBalance(signer.address)).toBe(
    initial - BigInt(signatures) * 5000n,
  );
  await page.getByRole("button", { name: "Rescan Solana" }).click();
  await expect(
    page.getByText("No accounts discovered.", { exact: false }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/slm-withdraw.png", fullPage: true });
});
test("local API rejects cross-origin requests and an unconfigured console has no enabled signing", async ({
  page,
  request,
}) => {
  const r = await request.post("/api/model", {
    headers: { Origin: "https://evil.example", "X-SLM-Local": "1" },
    data: { action: "synthetic" },
  });
  expect(r.status()).toBe(400);
  await page.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        cluster: "devnet",
        program: null,
        rpcDisplay: "unconfigured test fixture",
        maxDeposit: "10000000",
        maxTransactions: 100,
      },
    }),
  );
  await page.goto("/advanced");
  await expect(
    page.getByText("No storage program is configured for devnet.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Prepare / resume next batch" }),
  ).toBeDisabled();
  await page.screenshot({ path: "/tmp/slm-upload.png", fullPage: true });
});

test("one Phantom request signs a reviewed batch; rejection sends nothing and standalone recovery refunds it", async ({
  page,
  context,
}) => {
  const { svm, request } = vmRpc(),
    signer = await generateKeyPairSigner();
  svm.airdrop(signer.address, lamports(1000000000n));
  const initial = svm.getBalance(signer.address)!;
  const { sha256, base64 } = await import("../../lib/chain/protocol");
  const { canonical } = await import("../../lib/model/manifest");
  const payload = Uint8Array.from({ length: 384 }, (_, i) => i % 251),
    shards: {
      index: number;
      offset: number;
      length: number;
      sha256: string;
    }[] = [];
  for (let index = 0; index < 4; index++)
    shards.push({
      index,
      offset: index * 96,
      length: 96,
      sha256: await sha256(payload.slice(index * 96, (index + 1) * 96)),
    });
  const manifest = {
    version: 1,
    source: { repo: "synthetic/browser-batch", revision: "0".repeat(40) },
    tensors: [],
    artifacts: [
      {
        name: "proof",
        payloadOffset: 0,
        length: 384,
        sha256: await sha256(payload),
      },
    ],
    payloadBytes: 384,
    shards,
  };
  const id = await sha256(new TextEncoder().encode(canonical(manifest)));
  const sizes: number[] = [];
  let rejectMulti = true,
    submitted = 0;
  await context.exposeBinding(
    "__slmSignMany",
    async (_source, wires: number[][]) => {
      sizes.push(wires.length);
      if (wires.length > 1 && rejectMulti) {
        rejectMulti = false;
        throw new Error("Operator rejected batch");
      }
      return Promise.all(
        wires.map(async (wire) => [
          ...getTransactionEncoder().encode(
            await signTransaction(
              [signer.keyPair],
              getTransactionDecoder().decode(Uint8Array.from(wire)),
            ),
          ),
        ]),
      );
    },
  );
  await context.addInitScript(
    ({ publicAddress, publicBytes }) => {
      const account = {
        address: publicAddress,
        publicKey: new Uint8Array(publicBytes),
        chains: ["solana:devnet", "solana:mainnet"],
        features: ["solana:signTransaction"],
      };
      const wallet = {
        version: "1.0.0",
        name: "Phantom",
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
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
              const result = await (
                window as unknown as {
                  __slmSignMany: (wires: number[][]) => Promise<number[][]>;
                }
              ).__slmSignMany(inputs.map((i) => [...i.transaction]));
              return result.map((wire) => ({
                signedTransaction: new Uint8Array(wire),
              }));
            },
          },
        },
      };
      const register = (api: { register: (wallet: unknown) => void }) =>
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
      publicAddress: signer.address,
      publicBytes: [...getAddressEncoder().encode(signer.address)],
    },
  );
  // Mainnet UI confirmation is exercised against a local VM; no public RPC is used.
  await context.route("**/api/config", (route) =>
    route.fulfill({
      json: {
        cluster: "mainnet-beta",
        program: TEST_PROGRAM,
        rpcDisplay: "local VM",
        maxDeposit: "100000000",
        maxTransactions: 100,
      },
    }),
  );
  await context.route("**/api/price", (route) =>
    route.fulfill({ json: { usd: null, timestamp: null, stale: true } }),
  );
  await context.route("**/api/model", async (route) => {
    const p = route.request().postDataJSON();
    if (p.action === "shard") {
      const s = shards[p.index];
      await route.fulfill({
        json: { bytes: base64(payload.slice(s.offset, s.offset + s.length)) },
      });
    } else await route.fulfill({ json: { id, manifest } });
  });
  await context.route("**/api/rpc", async (route) => {
    const p = route.request().postDataJSON();
    try {
      if (p.method === "sendTransaction") submitted++;
      const result =
        p.method === "getGenesisHash"
          ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
          : await request(p.method, p.params);
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
  await page.getByRole("button", { name: "Use tiny synthetic proof" }).click();
  async function prepareAndReview(count: number, alreadyPrepared = false) {
    if (!alreadyPrepared)
      await page
        .getByRole("button", { name: "Prepare / resume next batch" })
        .click();
    const button = page.getByRole("button", {
      name:
        count === 1
          ? "Sign this transaction in Phantom"
          : `Sign ${count} transactions in Phantom`,
    });
    await expect(button).toBeVisible();
    await page
      .getByLabel(
        "I reviewed the accounts, receiving wallet, refundable deposit, and spent fee.",
      )
      .check();
    await expect(button).toBeDisabled();
    await page.getByLabel("Mainnet confirmation").fill("MAINNET");
    await expect(button).toBeEnabled();
    return button;
  }
  async function signNext(count: number, alreadyPrepared = false) {
    const button = await prepareAndReview(count, alreadyPrepared);
    await button.click();
    await expect(page.getByRole("status")).toContainText(
      count === 1 ? "Transaction finalized" : "Batch finalized",
    );
    await expect(page.locator(".error[role=alert]")).toHaveCount(0);
  }
  await signNext(1);
  const before = submitted;
  await (await prepareAndReview(4)).click();
  await expect(page.locator(".error[role=alert]")).toContainText(
    "Operator rejected batch",
  );
  expect(submitted).toBe(before);
  expect(
    svm.getProgramAccounts(TEST_PROGRAM).filter((a) => a.data.length >= 192),
  ).toHaveLength(1);
  await signNext(4);
  expect(sizes).toEqual([1, 4, 4]);
  await page.reload();
  await page.getByRole("button", { name: "Connect Phantom" }).click();
  await signNext(4);
  await signNext(4);
  await signNext(1);
  await page.getByRole("button", { name: "Verify from Solana" }).click();
  await expect(page.getByRole("status")).toContainText("All shards verified");
  await context.route("**/api/model", (route) => route.abort());
  await page.goto("http://127.0.0.1:3001");
  await page.getByRole("button", { name: "Connect Phantom" }).click();
  await page.getByRole("button", { name: "Close All / Reclaim All" }).click();
  await signNext(4, true);
  await signNext(1);
  expect(sizes).toEqual([1, 4, 4, 4, 4, 1, 4, 1]);
  expect(
    svm.getProgramAccounts(TEST_PROGRAM).filter((a) => a.data.length >= 192),
  ).toHaveLength(0);
  expect(svm.getBalance(signer.address)).toBe(
    initial - BigInt(submitted) * 5000n,
  );
  await page.screenshot({
    path: "/tmp/slm-batch-recovery.png",
    fullPage: true,
  });
});
