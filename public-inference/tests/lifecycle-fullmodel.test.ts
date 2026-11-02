import test from "node:test";
import assert from "node:assert/strict";
import {
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  type Address,
} from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { loadTarget } from "../reference/load-target";
import { loadPublicReference } from "../reference/deepseek2";
import { compilePublicModel } from "../compiler/compile";
import {
  buildArtifacts,
  decodeCommand,
  encodeModelBinding,
  modelCommitment,
  sha256,
  type ModelBinding,
} from "../protocol";
import { createLifecycleHarness } from "../harness/local-sbf";
import { publicClient, u32 } from "../harness/client";
import { recoveryPlan } from "../coordinator/recovery";
import { canonical } from "../../lib/model/manifest";
const enc = getAddressEncoder();
const fullUpload = process.env.SLM_PUBLIC_FULL_UPLOAD === "1";
test(
  (fullUpload
    ? "FULL MODEL UPLOAD/EXECUTION/REFUND"
    : "INFERENCE-ONLY preload fixture") +
    ": complete selected model executes every command in compiled SBF and matches independent reference",
  { timeout: 180000 },
  async () => {
    const progress = (s: string) =>
      process.stderr.write("[public full-model SBF] " + s + "\n");
    const traces: {
      position: number;
      layer: number;
      phase: string;
      values: readonly number[];
    }[] = [];
    const bytes = await loadTarget(progress),
      compiled = await compilePublicModel(bytes),
      reference = await loadPublicReference(
        bytes,
        "ggml-scalar-reference",
        (e) => traces.push(e),
      ),
      h = await createLifecycleHarness(),
      nonce = Buffer.alloc(32, 7),
      client = await publicClient(
        h.program,
        h.owner.address,
        nonce,
        Buffer.alloc(32, 8),
      );
    const artifacts = buildArtifacts([
      ...compiled.weights.pages.map((payload) => ({
        kind: 1 as const,
        payload,
      })),
      ...compiled.planPages.map((payload) => ({ kind: 2 as const, payload })),
    ]);
    const binding: ModelBinding = {
      nonce: nonce.toString("hex"),
      sourceSha: compiled.plan.source.sha256,
      inventoryRoot: compiled.planRoot,
      artifactRoot: artifacts.root,
      numericRoot: sha256(canonical(compiled.plan.numeric)),
      totalPages: artifacts.pages.length,
      weightPages: compiled.weights.pages.length,
      planPageStart: compiled.weights.pages.length,
      planPages: compiled.planPages.length,
      commandCount: compiled.commands.length,
      context: 16,
      vocab: 8196,
      layers: 4,
      dim: 128,
      maxTokens: 16,
    };
    const bind = Buffer.from(modelCommitment(binding), "hex");
    let maxCu = 0,
      transactions = 0;
    const initialBalance = h.svm.getBalance(h.owner.address)!;
    const send = async (ix: Parameters<typeof h.execute>[0]) => {
      const r = await h.execute(ix);
      if (r.result instanceof FailedTransactionMetadata)
        throw Error(
          "SBF failure " +
            r.result.err() +
            " " +
            r.result.meta().logs().join(" "),
        );
      maxCu = Math.max(maxCu, Number(r.result.computeUnitsConsumed()));
      transactions++;
      return Number(r.result.computeUnitsConsumed());
    };
    if (fullUpload) {
      await send(client.createModel(binding));
      for (const page of artifacts.pages) {
        await send(await client.allocateArtifact(page));
        for (let offset = 0; offset < page.payload.length; offset += 700)
          await send(
            await client.writeArtifact(
              page.index,
              offset,
              page.payload.subarray(offset, offset + 700),
            ),
          );
        await send(await client.sealArtifact(page.index));
        if (page.index % 50 === 0)
          progress(
            `Uploaded/sealed ${page.index + 1}/${artifacts.pages.length} complete model pages`,
          );
      }
      await send(client.sealModel());
    } else {
      const [modelAddress, modelBump] = await getProgramDerivedAddress({
        programAddress: h.program,
        seeds: [
          Buffer.from("slm-pu-model"),
          enc.encode(h.owner.address),
          nonce,
        ],
      });
      assert.equal(modelAddress, client.model);
      // Explicit inference-only fixture: preload public immutable model bytes to isolate
      // evaluator tests from thousands of upload tx. Separate lifecycle tests upload/seal.
      const registry = Buffer.alloc(384);
      registry.write("SLMPUM01");
      registry[8] = 1;
      registry[9] = 1;
      registry[10] = 1;
      registry[11] = modelBump;
      Buffer.from(enc.encode(h.owner.address)).copy(registry, 16);
      nonce.copy(registry, 48);
      bind.copy(registry, 80);
      Buffer.from(artifacts.root, "hex").copy(registry, 112);
      [
        artifacts.pages.length,
        artifacts.pages.length,
        artifacts.pages.length,
      ].forEach((v, i) => registry.writeUInt32LE(v, 144 + i * 4));
      encodeModelBinding(binding).copy(registry, 160);
      const put = (address: Address, data: Uint8Array) =>
        h.svm.setAccount({
          address,
          data,
          programAddress: h.program,
          space: BigInt(data.length),
          lamports: lamports(100000000n),
          executable: false,
        });
      put(client.model, registry);
      for (const page of artifacts.pages) {
        const [address, bump] = await getProgramDerivedAddress({
            programAddress: h.program,
            seeds: [
              Buffer.from("slm-pu-artifact"),
              enc.encode(client.model),
              u32(page.index),
            ],
          }),
          data = Buffer.alloc(192 + page.payload.length);
        data.write("SLMPUA01");
        data[8] = 1;
        data[9] = 2;
        data[10] = 1;
        data[11] = bump;
        Buffer.from(enc.encode(h.owner.address)).copy(data, 16);
        Buffer.from(enc.encode(client.model)).copy(data, 48);
        [
          page.index,
          page.payload.length,
          page.payload.length,
          page.kind,
        ].forEach((v, i) => data.writeUInt32LE(v, 80 + i * 4));
        Buffer.from(page.hash, "hex").copy(data, 96);
        bind.copy(data, 128);
        data.set(page.payload, 192);
        put(address, data);
      }
    }
    const get = (a: Address) => {
      const v = h.svm.getAccount(a);
      assert.ok(v.exists);
      return Buffer.from(v.data);
    };
    await send(client.createSession([1], 2, h.svm.getClock().slot + 1000000n));
    for (let i = 0; i < 5; i++) await send(client.allocateState(i));
    await send(client.start());
    const perOp = new Map<number, number>();
    let expected = reference.step(1).token,
      maxAbsoluteError = 0;
    const compare = (
      actual: readonly number[],
      expected: readonly number[],
    ) => {
      assert.equal(actual.length, expected.length);
      for (let i = 0; i < actual.length; i++) {
        const error = Math.abs(actual[i] - expected[i]);
        maxAbsoluteError = Math.max(maxAbsoluteError, error);
        assert.ok(
          error <= 0.0002 * Math.max(1, Math.abs(expected[i])),
          `numeric parity index ${i} absolute error ${error}`,
        );
      }
    };
    for (let tokenIndex = 0; tokenIndex < 2; tokenIndex++) {
      let residuals = 0;
      for (let pc = 0; pc < compiled.commands.length; pc++) {
        const session = get(client.session),
          global = get(client.states[0]);
        assert.equal(session.readUInt32LE(176), pc);
        const stepIx = await client.step(
          session,
          global,
          compiled.commands[pc],
          compiled.weights.pages.length,
        );
        const cu = await send(stepIx);
        if (tokenIndex === 0 && pc === 0) {
          const before = get(client.session);
          const replay = await h.execute(stepIx);
          assert.ok(replay.result instanceof FailedTransactionMetadata);
          assert.ok(before.equals(get(client.session)));
          const wrong = {
            ...stepIx,
            accounts: stepIx.accounts!.map((a, i) =>
              i === 3 ? { ...a, address: client.states[1] } : a,
            ),
          };
          const substituted = await h.execute(wrong);
          assert.ok(substituted.result instanceof FailedTransactionMetadata);
          assert.ok(before.equals(get(client.session)));
        }
        const c = decodeCommand(compiled.commands[pc]),
          after = get(client.states[0]);
        perOp.set(c.op, Math.max(perOp.get(c.op) ?? 0, cu));
        if (c.op === 10) {
          const kv = get(client.states[c.aux0 + 1]);
          compare(
            Array.from({ length: 48 }, (_, i) =>
              kv.readFloatLE(192 + (tokenIndex * 48 + i) * 4),
            ),
            traces.find(
              (t) =>
                t.position === tokenIndex &&
                t.layer === c.aux0 &&
                t.phase === "kv",
            )!.values,
          );
        }
        if (c.op === 7 && c.src === 0 && c.aux0 === 128 && c.dst === 0) {
          residuals++;
          if (residuals % 2 === 0)
            compare(
              Array.from({ length: 128 }, (_, i) =>
                after.readFloatLE(192 + i * 4),
              ),
              traces.find(
                (t) =>
                  t.position === tokenIndex &&
                  t.layer === residuals / 2 - 1 &&
                  t.phase === "layer-output",
              )!.values,
            );
        }
        if (c.op === 16 || c.op === 19) {
          const count = c.op === 19 ? c.rows : c.len,
            src = c.op === 19 ? c.dst : c.src;
          compare(
            Array.from({ length: count }, (_, i) =>
              after.readFloatLE(192 + (src + i) * 4),
            ),
            traces
              .find((t) => t.position === tokenIndex && t.phase === "logits")!
              .values.slice(c.rowStart, c.rowStart + count),
          );
        }
        if (pc % 250 === 0)
          progress(
            `token ${tokenIndex + 1}/2 command ${pc + 1}/${compiled.commands.length}; max CU ${maxCu}`,
          );
        if (pc === 700) h.restart();
      }
      const session = get(client.session);
      assert.equal(session.readUInt32LE(320 + tokenIndex * 4), expected);
      if (tokenIndex === 0) expected = reference.step(expected).token;
    }
    assert.equal(get(client.session)[10], 3);
    assert.ok(maxCu <= 200000);
    progress(
      `PASS 2 tokens; ${transactions} transactions; max ${maxCu} CU; max absolute numeric error ${maxAbsoluteError}; ${fullUpload ? "full upload executed; no finality claim" : "no upload/finality claim"}`,
    );
    progress("Per-op max CU " + JSON.stringify(Object.fromEntries(perOp)));
    for (let i = 0; i < 5; i++) await send(client.closeState(i));
    await send(client.closeSession());
    assert.equal(h.svm.getAccount(client.session).exists, false);
    const partial = await publicClient(
      h.program,
      h.owner.address,
      nonce,
      Buffer.alloc(32, 9),
    );
    await send(
      partial.createSession(
        [1],
        1,
        h.svm.getClock().slot + 1000000n,
        h.other.address,
      ),
    );
    await send(partial.allocateState(0));
    const close = partial.closeState(0),
      unauthorized = {
        ...close,
        accounts: close.accounts!.map((a, i) =>
          i === 0 ? { ...a, address: h.other.address } : a,
        ),
      };
    assert.ok(
      (await h.execute(unauthorized, h.other)).result instanceof
        FailedTransactionMetadata,
    );
    h.restart();
    const inventory = [partial.session, partial.states[0]].map((address) => {
      const a = h.svm.getAccount(address);
      assert.ok(a.exists);
      return {
        address,
        owner: a.programAddress,
        data: a.data,
        lamports: a.lamports,
      };
    });
    for (const ix of await recoveryPlan(h.program, h.owner.address, inventory))
      await send(ix);
    assert.equal(h.svm.getAccount(partial.session).exists, false);
    if (fullUpload) {
      for (const page of artifacts.pages)
        await send(await client.closeArtifact(page.index));
      await send(client.closeModel());
      assert.equal(h.svm.getAccount(client.model).exists, false);
      assert.equal(
        h.svm.getBalance(h.owner.address),
        initialBalance - BigInt(transactions + 2) * 5000n,
      );
      progress(
        `PASS complete upload/inference/refund ${transactions} successful tx +2 owner-rejected and1 delegate-rejected tests; exact fixture fee accounting`,
      );
    }
  },
);
