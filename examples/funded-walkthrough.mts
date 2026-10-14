/**
 * wative — interactive funded-wallet walkthrough (TESTNET).
 *
 * Create a workspace, reopen it, derive 20 HD wallets, print their 40 addresses,
 * wait for you to fund Wallet #0 from a faucet, then distribute to Wallets #1–#6.
 *
 *   pnpm exec tsx examples/funded-walkthrough.mts
 *
 * 🚨 Step 8 broadcasts REAL transactions. It is wired to Sepolia (EVM) and Solana
 *    devnet (SVM) ONLY. Never point it at mainnet. It writes a throwaway workspace
 *    to ./.wative2-funded-demo (gitignored); remove it with `rm -rf` when done.
 *
 * Why two accounts from one mnemonic: a wallet has ONE address per VM, on its
 * account's creation network, and sends route by VM to that network. So a single
 * account can't send on both testnets (its other VM would default to MAINNET). We
 * create a `sepolia` account (its EVM side) and a `solana-devnet` account (its SVM
 * side) from the SAME mnemonic — so wallet #i is the same keypair on both, and each
 * column below is the correct, sendable address for its chain.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { newMnemonic } from "wative/core";
import { inspect } from "wative/node/container";
import {
  createWorkspace,
  openLocked,
  unlock,
  close,
  panicLock,
  createAccount,
  expandAccount,
  accounts,
  walletsFor,
  catalogueFor,
  fillBalances,
  prepareSend,
  confirmSend,
  type SendIntent,
} from "wative/node/session";

const WS = path.resolve(".wative2-funded-demo");
const WALLET_COUNT = 20;
const EVM_NET = "sepolia";
const SVM_NET = "solana-devnet";
const EVM_EACH = 20_000_000_000_000n; // 0.00002 ETH per recipient
const SVM_EACH = 2_000_000n; //            0.002 SOL per recipient (above rent)
const DISTRIBUTE_TO = [1, 2, 3, 4, 5, 6] as const;

// ── tiny interactive helpers (a real app would use a hardened reader; see the
//    masked prompt in `wative/node/preflight`) ──────────────────────────────────
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim()))));
}
function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    const wasRaw = stdin.isRaw ?? false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    const onData = (buf: Buffer): void => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return cleanup(), stdout.write("\n"), resolve(value);
        if (ch === "\u0003") return cleanup(), stdout.write("\n"), process.exit(130); // Ctrl+C
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) (value = [...value].slice(0, -1).join("")), stdout.write("\b \b");
        } else if (ch >= " ") (value += ch), stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const addrOf = (slug: string, id: number, vm: "evm" | "svm"): string =>
  (walletsFor(slug) ?? []).find((w) => w.id === id)?.addresses.find((a) => a.vm === vm)?.publicKey ?? "";

/** Wallet #0's native balance on the account's default network (undefined if unread). */
async function nativeBalance(slug: string, walletId: number): Promise<{ raw: bigint; decimals: number; symbol: string } | undefined> {
  const native = (await catalogueFor(slug)).find((a) => a.native);
  if (native === undefined) return undefined;
  let raw: bigint | undefined;
  await fillBalances(slug, [walletId], {
    concurrency: 1,
    timeoutMs: 15_000,
    onUpdate: (_id, state) => {
      if (state.kind === "ready") raw = state.byAsset.get(native.id)?.raw ?? 0n;
    },
  });
  return raw === undefined ? undefined : { raw, decimals: native.decimals, symbol: native.symbol };
}
const human = (raw: bigint, decimals: number): string => {
  if (decimals === 0) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac === "" ? whole : `${whole}.${frac}`;
};

async function main(): Promise<void> {
  // 1 ── Create the workspace (set a password) — or reopen it on a later run.
  mkdirSync(WS, { recursive: true });
  const fresh = (await inspect(WS)).state !== "workspace";
  if (fresh) {
    console.log(`Creating a new workspace at ${WS}`);
    let password = "";
    for (;;) {
      password = await askSecret("Set a workspace password: ");
      if (password === "") console.log("  password cannot be empty.");
      else if ((await askSecret("Confirm the password:      ")) !== password) console.log("  passwords did not match, try again.");
      else break;
    }
    await createWorkspace(WS, password);
    await close(); // 2 ── ...then reopen it, requiring the password again.
    panicLock();
  }

  console.log(fresh ? "\nReopening the workspace." : `\nReopening the existing workspace at ${WS}`);
  for (;;) {
    const password = await askSecret("Workspace password: ");
    try {
      await openLocked(WS);
      await unlock(password);
      break;
    } catch {
      console.log("  wrong password — try again.");
    }
  }

  // 3 ── Create the two HD accounts from ONE plain mnemonic (EVM→Sepolia, SVM→devnet).
  let evmSlug = (accounts() ?? []).find((a) => a.name === "evm")?.slug;
  let svmSlug = (accounts() ?? []).find((a) => a.name === "svm")?.slug;
  if (evmSlug === undefined || svmSlug === undefined) {
    const mnemonic = newMnemonic(12);
    console.log(`\nGenerated a plain mnemonic for this demo (do NOT reuse):\n  ${mnemonic}`);
    const pw = await askSecret("Re-enter the workspace password to create the accounts: ");
    evmSlug = await createAccount("evm", pw, mnemonic, EVM_NET);
    svmSlug = await createAccount("svm", pw, mnemonic, SVM_NET);
    // 4 ── Derive each account to 20 wallets (#0 exists; add the rest).
    await expandAccount(evmSlug, WALLET_COUNT - 1);
    await expandAccount(svmSlug, WALLET_COUNT - 1);
    console.log(`Created 2 accounts, each derived to ${WALLET_COUNT} wallets.`);
  }

  // 5 ── Print the 40 addresses (20 EVM + 20 Solana) in an aligned table.
  const evmWallets = walletsFor(evmSlug) ?? [];
  const svmWallets = walletsFor(svmSlug) ?? [];
  const rows = evmWallets.map((w, i) => ({
    n: `#${w.id}`,
    evm: w.addresses.find((a) => a.vm === "evm")?.publicKey ?? "",
    sol: svmWallets[i]?.addresses.find((a) => a.vm === "svm")?.publicKey ?? "",
  }));
  const wN = Math.max(1, ...rows.map((r) => r.n.length));
  const wE = Math.max(3, ...rows.map((r) => r.evm.length));
  const wS = Math.max(6, ...rows.map((r) => r.sol.length));
  const line = (a: string, b: string, c: string): string => `  ${a.padEnd(wN)}  ${b.padEnd(wE)}  ${c.padEnd(wS)}`;
  console.log(`\n${line("#", "EVM", "Solana")}`);
  console.log(line("-".repeat(wN), "-".repeat(wE), "-".repeat(wS)));
  for (const r of rows) console.log(line(r.n, r.evm, r.sol));

  // ── Choose the chain(s) to fund + test.
  let choice = "";
  while (!["1", "2", "3"].includes(choice)) {
    choice = await ask("\nFund which chain?  [1] Ethereum Sepolia   [2] Solana devnet   [3] Both : ");
  }
  const want = { evm: choice === "1" || choice === "3", svm: choice === "2" || choice === "3" };

  const w0 = evmWallets[0]?.id ?? 0;
  console.log("\nSend testnet funds to Wallet #0:");
  if (want.evm)
    console.log(`  Sepolia ETH  → ${addrOf(evmSlug, w0, "evm")}\n     faucet: https://www.alchemy.com/faucets/ethereum-sepolia`);
  if (want.svm)
    console.log(`  devnet SOL   → ${addrOf(svmSlug, w0, "svm")}\n     faucet: https://faucet.solana.com  (Devnet)   or: solana airdrop 1 <addr> --url devnet`);

  // 6 ── Poll every 5s until Wallet #0 is funded on the chosen chain(s).
  console.log("\nPolling every 5s (Ctrl+C to stop)…");
  const funded = { evm: !want.evm, svm: !want.svm };
  for (let tick = 1; !(funded.evm && funded.svm); tick++) {
    const parts: string[] = [];
    if (want.evm) {
      const b = await nativeBalance(evmSlug, w0);
      if (b && b.raw > 0n) funded.evm = true;
      parts.push(`Sepolia ${b ? `${human(b.raw, b.decimals)} ${b.symbol}` : "read failed"}`);
    }
    if (want.svm) {
      const b = await nativeBalance(svmSlug, w0);
      if (b && b.raw > 0n) funded.svm = true;
      parts.push(`devnet ${b ? `${human(b.raw, b.decimals)} ${b.symbol}` : "read failed"}`);
    }
    console.log(`  poll #${tick}: ${parts.join("  |  ")}${funded.evm && funded.svm ? "  → funded ✓" : ""}`);
    if (funded.evm && funded.svm) break; // 7 ── exit the loop
    await sleep(5_000);
  }

  // 7 ── Ask whether to continue to the distribution step.
  const go = (await ask("\nWallet #0 is funded. Distribute to Wallets #1–#6 now? [y/N]: ")).toLowerCase();
  if (go !== "y" && go !== "yes") {
    console.log("Stopping before distribution.");
  } else {
    // 8 ── Distribute from Wallet #0 to Wallets #1–#6 on each chosen chain.
    for (const [active, slug, vm, each, label] of [
      [want.evm, evmSlug, "evm", EVM_EACH, "Sepolia"] as const,
      [want.svm, svmSlug, "svm", SVM_EACH, "devnet"] as const,
    ]) {
      if (!active) continue;
      console.log(`\nDistributing on ${label} (${vm.toUpperCase()}):`);
      for (const i of DISTRIBUTE_TO) {
        const to = addrOf(slug, i, vm);
        const intent: SendIntent = { accountSlug: slug, walletId: w0, vm, to, amount: each };
        const prepared = await prepareSend(intent);
        if (!prepared.ok) {
          console.log(`  → #${i} ${to}: skipped (${prepared.reason})`);
          continue;
        }
        const overrides =
          prepared.vm === "evm"
            ? { nonce: prepared.nonce, gasLimit: prepared.gasLimit, maxFeePerGas: prepared.maxFeePerGas, maxPriorityFeePerGas: prepared.maxPriorityFeePerGas }
            : {};
        const outcome = await confirmSend(intent, overrides);
        console.log(outcome.ok ? `  → #${i} ${to}: sent ✓ ${outcome.hash}` : `  → #${i} ${to}: failed (${outcome.reason})`);
      }
    }
  }

  await close();
  panicLock();
  console.log(`\nDone. Remove the demo workspace with:  rm -rf ${path.relative(process.cwd(), WS) || WS}`);
}

main().catch((error: unknown) => {
  console.error("walkthrough failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
