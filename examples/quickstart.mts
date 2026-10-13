/**
 * wative — 3-minute quickstart (headless, no UI).
 *
 * Open a workspace, create an account, read its wallets and addresses, and build
 * a transaction — using only the public `wative/*` surface. Run it from the repo:
 *
 *   pnpm exec tsx examples/quickstart.mts          # offline: workspace + wallets
 *   pnpm exec tsx examples/quickstart.mts --send    # ALSO broadcasts a testnet tx
 *
 * (From a fresh project that depends on `wative`: `pnpm dlx tsx quickstart.mts`.)
 *
 * It writes a THROWAWAY workspace to ./.wative2-example (gitignored). The demo
 * password and the generated mnemonic are for that throwaway ONLY — never reuse
 * them, and never point this at your real ~/.wative2. Clean up when done:
 *
 *   rm -rf .wative2-example
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { newMnemonic } from "wative-core";
import { inspect } from "wative/container";
import {
  createWorkspace,
  openLocked,
  unlock,
  status,
  createAccount,
  accounts,
  walletsFor,
  workspaceNetworkChoices,
  prepareSend,
  confirmSend,
  lock,
  close,
  type SendIntent,
} from "wative/session";

const WS = path.resolve(".wative2-example");
const PASSWORD = "demo-password-change-me"; // throwaway only — not a real secret

async function main(): Promise<void> {
  // 1 ── Open the workspace. A wative workspace lives inside an existing folder;
  //      create it on first run, unlock it on later runs. `inspect` tells the two
  //      apart without a password ("workspace" | "empty" | "foreign").
  mkdirSync(WS, { recursive: true });
  if ((await inspect(WS)).state === "workspace") {
    await openLocked(WS);
    await unlock(PASSWORD);
  } else {
    await createWorkspace(WS, PASSWORD); // writes the container, opens it unlocked
    console.log(`created a workspace at ${WS}`);
  }
  console.log(`workspace is ${status()}`);

  // 2 ── Create an HD account if there is none, on the first available network.
  //      `createAccount(name, workspacePassword, secret, networkSlug?)` returns the
  //      new account's slug. The "secret" is a BIP-39 mnemonic for an HD account.
  if ((accounts() ?? []).length === 0) {
    const network = workspaceNetworkChoices()[0];
    const mnemonic = newMnemonic(12); // a fresh 12-word phrase — DEMO ONLY
    console.log(`\ngenerated a demo mnemonic (do NOT reuse): ${mnemonic}`);
    const slug = await createAccount("My First Account", PASSWORD, mnemonic, network?.slug);
    console.log(`created account "${slug}" on ${network?.name ?? "the default network"}`);
  }

  // 3 ── Read accounts → wallets → addresses. Everything comes back as plain data,
  //      never a live library handle (a handle goes stale across a lock).
  console.log("\naccounts:");
  for (const account of accounts() ?? []) {
    console.log(`  • ${account.name} [${account.slug}] — ${account.wallets} wallet(s), default ${account.network}`);
    for (const wallet of walletsFor(account.slug) ?? []) {
      for (const addr of wallet.addresses) {
        console.log(`      #${wallet.id}  ${addr.vm.toUpperCase().padEnd(3)}  ${addr.network.padEnd(16)}  ${addr.publicKey}`);
      }
    }
  }

  // 4 ── Build a transaction. `asset` omitted ⇒ the native coin; set it to send a
  //      token. `prepareSend` is an OFFLINE review (fee, balances, destination
  //      safety); `confirmSend` signs, broadcasts, and tracks it.
  const account = (accounts() ?? [])[0];
  const wallet = account ? (walletsFor(account.slug) ?? [])[0] : undefined;
  const evm = wallet?.addresses.find((a) => a.vm === "evm");
  if (account && wallet && evm) {
    const intent: SendIntent = {
      accountSlug: account.slug,
      walletId: wallet.id,
      vm: "evm",
      to: "0x000000000000000000000000000000000000dEaD", // replace with a real recipient
      amount: 10_000_000_000_000n, // 0.00001 ETH, in wei
    };

    if (process.argv.includes("--send")) {
      // 🚨 This BROADCASTS on the account's network and cannot be undone. Only run
      //    --send against a TESTNET network with a funded wallet.
      const prepared = await prepareSend(intent);
      if (!prepared.ok) {
        console.log(`\nprepareSend declined: ${prepared.reason}`);
      } else {
        console.log(`\nprepared a ${prepared.type} send of ${intent.amount} wei from ${prepared.from}`);
        const outcome = await confirmSend(intent, {}, (s) => console.log(`  …${s}`));
        console.log(outcome.ok ? `sent ✓  ${outcome.hash}` : `send failed: ${outcome.reason} (safe to resend: ${outcome.safeToResend})`);
      }
    } else {
      console.log(`\nbuilt a SendIntent: native ${intent.amount} wei → ${intent.to}`);
      console.log("re-run with --send to prepareSend() + confirmSend() it (testnet + a funded wallet).");
    }
  }

  // 5 ── Lock the secret and close.
  await lock();
  await close();
  console.log(`\nlocked + closed. remove the demo workspace with:  rm -rf ${path.relative(process.cwd(), WS) || WS}`);
}

main().catch((error: unknown) => {
  console.error("quickstart failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
