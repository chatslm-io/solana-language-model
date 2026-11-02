![Solana Language Model](slm-banner.png)

# Solana Language Model

SLM (Solana Language Model) is the first LLM with its weights stored and its inference generated entirely on the Solana blockchain.

SLM provides fully working on-chain inference. Model weights reside in Solana accounts, and the Solana program executes the model computations that generate output tokens. The client prepares and submits transactions, while validators execute the inference instructions and commit the resulting state on-chain.

This repository provides the program, model compiler, transaction client, local-validator verification harness, and local storage/operator interface for running SLM yourself. Configure your own checkpoint, wallets, RPC endpoints, and deployment addresses using the included examples.

## Requirements

- Node.js 24 and npm; install dependencies with `npm ci`.
- For program builds: Solana platform-tools **v1.58**, including Rust `1.95.0-dev (1e20dd0d5…)`. Supply its installation directory explicitly.
- For local-clone runs: `solana-test-validator` **3.1.10** on `PATH`. The harness verifies this version.
- A compatible GGUF checkpoint and its immutable identity. The current compiler targets the layout enforced in `public-inference/compiler/model.ts` and the program: four layers, hidden dimension 128, vocabulary 8196, and a 16-token context. Use a checkpoint matching this supported architecture and tensor layout.

## Configuration

Run commands from the repository root. Start with:

```sh
mkdir -m 700 .local
cp .env.example .env.local
cp config/operator.env.example .local/operator.env
cp config/model-identity.example.json .local/model-identity.json
chmod 600 .env.local .local/operator.env .local/model-identity.json
```

Fill in the placeholders before running the corresponding feature. `.env.example` lists the settings for inference, cloning, builds, storage, and deployment. `config/operator.env.example` holds the signer and operator settings. Choose either `SLM_KEYPAIR_PATH` or `SLM_PRIVATE_KEY`, never both. Nonblank settings in the operator file override the corresponding environment values; blank entries leave environment values intact. Supply your own wallet; no command automatically selects your Solana CLI wallet.

All configured paths may be absolute or relative to the working directory. Environment files do not expand `~`, `$HOME`, or other variables inside values. Protected files must be owned by the current user with mode `600`, and state directories must have mode `700`. Use ignored `.local/` or a directory outside Git checkouts. Do not publish filled configuration, journals, model data, or test output.

`SLM_SIGNER_ENV_FILE` selects the operator file; nothing refers to a machine-specific configuration location. `SLM_MODEL_IDENTITY_FILE` selects a JSON object with `repo`, a 40-character immutable `revision`, `file`, a 64-character `sha256`, and exact positive `bytes`. Fill in the example with your checkpoint’s exact identity. The compiler downloads and verifies the checkpoint, then constructs the weights and execution plan for publication to Solana. Inference executes in the on-chain program. Keep model identity in the protected file, not source control.

Next.js loads `.env.local`. For other scripts, use Node's `--env-file` option. To use a different file, substitute its path in these commands:

```sh
node --env-file=.env.local --run public-inference:build
```

Set `SLM_SBF_PLATFORM_TOOLS`, `CARGO_HOME`, and both `SLM_APPROVED_SIGNER_1` and `SLM_APPROVED_SIGNER_2` before building. The signer variables are **public addresses** compiled into the existing two-address allowlist, not private keys. A mainnet wallet must be authorized by the deployed program. Build outputs go to the configured build directories; no deployment occurs during a build.

## Mainnet-beta inference

Run inference directly on Solana mainnet using the `mainnet-beta` cluster. Local-clone testing is an optional verification workflow.

The mainnet command uses a deployed compatible inference program and an **already uploaded and sealed model**. Configure:

- `SOLANA_CLUSTER=mainnet-beta` and your HTTPS `SOLANA_RPC_URL`.
- `SLM_INFERENCE_PROGRAM_ID`, `SLM_MODEL_OWNER`, and the model's 64-character hexadecimal `SLM_MODEL_NONCE`.
- The matching `SLM_MODEL_IDENTITY_FILE`, your signer configuration, and `SLM_INFERENCE_STATE_DIR`.
- `SLM_PROMPT_TOKENS`, a JSON array of token IDs, and `SLM_OUTPUT_TOKENS`. Prompt plus requested output must fit the 16-token context.
- `SLM_INFERENCE_MAX_LAMPORTS`, an explicit total reservation limit covering transaction fees, session/state rent, and cleanup reserve. One SOL is 1,000,000,000 lamports. The wallet must already be funded.

```sh
npm run inference:mainnet
```

This command **signs and submits real mainnet transactions**. It verifies the network, executable program, and finalized model account contents before inference. It simulates transactions before submission, journals exact signed bytes before broadcast, waits for finality, returns output token IDs, and closes temporary session/state accounts to recover their rent. The sealed model remains on-chain and available for subsequent inference sessions.

Use a dedicated wallet while a run is active: balance and refund verification assumes no concurrent wallet activity. Each run writes a protected directory containing session addresses, transaction journals, and its final result. If a run stops with uncertain transactions, preserve that directory and reconcile signatures on the configured RPC before starting another run. The command does not automatically resume an interrupted session or replace ambiguous transactions.

The mainnet command accepts token IDs and returns tokens generated by the on-chain model. The local raw-text workflow also exercises on-chain tokenization. Publish a new model with the mainnet upload command below before running inference. The mainnet uploader and local acceptance harness share the same model create/write/seal sequence.

To deploy a program you control, build first, then obtain a deployment quote:

```sh
node --env-file=.env.local --import tsx scripts/inference-program.ts quote mainnet-beta
```

The deployment tool accepts `deploy mainnet-beta QUOTE_ID` after quote review, and `configure mainnet-beta` writes the verified program address only to your explicit `SLM_DEPLOYMENT_ENV_FILE`. Deployment has separate operator fee/rent/transaction caps. It does not upload a model. No IDL is required by the included client; generate your own interface description if your tooling needs one.

## Publish a model on mainnet

After deploying the inference program, configure `SLM_INFERENCE_PROGRAM_ID`, your mainnet RPC and authorized signer, and `SLM_MODEL_IDENTITY_FILE`. Set `SLM_MODEL_OWNER` to the upload wallet’s public address. Generate a fresh model nonce and place it in `SLM_MODEL_NONCE`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Quote the upload first:

```sh
npm run model:upload:mainnet -- --quote
```

The quote compiles your checkpoint, checks the mainnet program and model address, and reports the account rent, transaction fee allowance, and recovery reserve in lamports. This step performs RPC reads without signing or submitting transactions. Set `SLM_UPLOAD_MAX_LAMPORTS` to your chosen limit covering the quoted total, fund the wallet, and choose `SLM_UPLOAD_STATE_DIR` for the journals. Then upload:

```sh
npm run model:upload:mainnet -- --execute
```

Execution checks the spending limit and wallet balance, creates the model account, uploads the weights and execution-plan pages, and seals them on-chain. Every transaction is simulated, journaled before broadcast, and finalized before the upload is accepted. The command verifies the resulting account contents against the compiled model and prints the model address, owner, and nonce. Keep those owner/nonce values in your configuration, then run `npm run inference:mainnet`.

This publishes the weights and plan used by token-ID inference. The model remains on-chain after the upload and subsequent inference sessions. Its rent stays deposited until the model accounts are closed. The recovery reserve remains in the wallet for later cleanup.

If an upload is interrupted, retain its journals and reconcile the recorded transaction signatures before taking further action. The uploader requires a fresh model address and stops if that address already exists; it does not automatically resume a partial upload. Preserve the nonce and account records for recovery rather than repeatedly starting uploads with new nonces.

## Local mainnet-clone verification

Set `SLM_CLONE_RPC_URL` to your mainnet RPC. The harness reads and freezes the public Memo program account, starts an owned local validator, and loads the inference program and model locally. This runs the inference program in a local Solana validator with a cloned mainnet Memo dependency. The upstream connection is read-only; all signing, funding, and inference transactions target the owned local validator with test SOL.

After configuring the checkpoint and toolchain:

```sh
node --env-file=.env.local --import tsx public-inference/harness/fork.ts --state-dir .local/clone-run
```

The clone command compiles a separate program inside the chosen state directory using the selected wallets' public addresses. It does not overwrite the deployment build. Set `SLM_CLONE_KEYPAIR_PATH_1` and `SLM_CLONE_KEYPAIR_PATH_2` to use your own wallets. Slot 1 also accepts the normal operator `SLM_KEYPAIR_PATH` or `SLM_PRIVATE_KEY`. Each unconfigured slot generates a fresh wallet in memory. If `SLM_APPROVED_SIGNER_1` or `SLM_APPROVED_SIGNER_2` is set, its matching wallet must be supplied; a missing key or mismatched address fails rather than replacing your configuration. Only public addresses are compiled into the program. Mainnet has no random-wallet fallback.

Choose a fresh state directory for each run. The standard run preloads model accounts at genesis, executes inference in the local Solana validator, and verifies session cleanup and rent recovery. To exercise the full transaction-based upload, validator restart, raw-text tokenization, inference, and rent recovery workflow:

```sh
node --env-file=.env.local --import tsx public-inference/harness/fork.ts --state-dir .local/upload-run --upload-restart-text
```

Other supported options include `--text`, `--tokenize-only`, `--strict-finalized`, and `--compare` for batched/unbatched comparison. Upload/restart acceptance cannot be combined with those options. `--ledger-dir .local/retained-ledger` supports retained genesis fixtures only when both clone wallets are explicitly configured and the checkpoint/build pins remain unchanged. Fresh fallback wallets change the binary allowlist and cannot reuse a previous ledger.

Each run records transaction receipts, session transitions, output tokens, and rent recovery in the chosen state directory. Use these records to inspect the program’s execution and verify the results. Generated results stay outside the published source files.

## Source checks and operator interface

```sh
npm run typecheck
npm run lint
npm run audit:secrets
node --import tsx --test public-inference/tests/client-mainnet.test.ts
```

SBF tests require freshly built binaries and the matching configuration. Model-dependent tests also require the checkpoint identity. The mainnet transport unit tests mock network calls and send no transactions. The private-inference and experimental directories contain separate research/test programs.

The optional storage/operator UI is started with `npm run dev`, or `npm run build` followed by `npm start`; it binds to loopback. Configure your storage program IDs, operator state, RPCs, and wallet separately from the inference program. For storage builds, use `node --env-file=.env.local --run program:build`; the configured output includes `build.json` with the binary byte count and SHA-256. `SLM_PROGRAM_BUILD_FILE` selects the reviewed metadata used by the storage deployment tools. `config/program-build.example.json` shows that schema.

The UI is a local operator tool with access to the configured signer. It is not an authenticated public multi-user signing service. Keep it bound to your own machine.
