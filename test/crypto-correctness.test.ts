/**
 * Crypto-correctness of the `wative/node/session` export + sign wrappers, for BOTH
 * EVM and SVM.
 *
 * 🚨 wative's suite otherwise never exercises the signing/export paths — they are
 * thin wrappers over wative-core — so a wrapper returning the WRONG key, signing
 * the WRONG message, or acting for the WRONG wallet would ship green. These pin it
 * CRYPTOGRAPHICALLY and OFFLINE (no RPC):
 *   - `exportPrivateKey` returns the key matching the wallet's public key
 *     (EVM: the ethers address; SVM: the ed25519 secret's embedded/derived pubkey);
 *   - `signMessage` produces a signature that recovers/verifies to that wallet
 *     (EVM: EIP-191 recover; SVM: ed25519 verify over the message bytes);
 *   - a wrong password is refused with no key leak.
 *
 * A throwaway $TMPDIR workspace with a fixed BIP39 mnemonic makes it deterministic.
 * (The on-chain send path — confirmSend — needs a live RPC and stays the
 * consumer's integration concern.)
 */
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Wallet, verifyMessage } from "ethers";
import bs58 from "bs58";
import nacl from "tweetnacl";

import { createWorkspace, createAccount, walletsFor, exportPrivateKey, signMessage, lock } from "../src/core/session.js";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "pw-test-123456";
const MESSAGE = "hello wative crypto test";

let dir: string;
let slug: string;
let walletId: number;
let evmPubkey: string;
let svmPubkey: string;

before(async () => {
  await import("wative-core/node"); // register the Node backend
  dir = mkdtempSync(path.join(os.tmpdir(), "wative-crypto-"));
  await createWorkspace(dir, PASSWORD);
  slug = await createAccount("Main", PASSWORD, MNEMONIC);
  const wallet = (walletsFor(slug) ?? [])[0];
  assert.ok(wallet, "a wallet was derived");
  walletId = wallet.id;
  const evm = wallet.addresses.find((a) => a.vm === "evm");
  const svm = wallet.addresses.find((a) => a.vm === "svm");
  assert.ok(evm && svm, "the HD wallet spans an EVM and an SVM address");
  evmPubkey = evm.publicKey;
  svmPubkey = svm.publicKey;
});

after(async () => {
  await lock();
  rmSync(dir, { recursive: true, force: true });
});

test("exportPrivateKey(evm) returns the key for the wallet's EVM address", async () => {
  const out = await exportPrivateKey(slug, walletId, "evm", PASSWORD);
  assert.ok(out.ok, "export succeeded");
  assert.equal(
    new Wallet(out.privateKey).address.toLowerCase(),
    evmPubkey.toLowerCase(),
    "the exported key derives the SAME EVM address as the wallet",
  );
});

test("exportPrivateKey(svm) returns the ed25519 key for the wallet's SVM pubkey", async () => {
  const out = await exportPrivateKey(slug, walletId, "svm", PASSWORD);
  assert.ok(out.ok, "export succeeded");
  const secret = bs58.decode(out.privateKey);
  // bs58 of either the 64-byte secret (last 32 bytes = pubkey) or a 32-byte seed.
  const derivedPub = secret.length === 64 ? secret.slice(32, 64) : nacl.sign.keyPair.fromSeed(secret).publicKey;
  assert.deepEqual(
    Buffer.from(derivedPub),
    Buffer.from(bs58.decode(svmPubkey)),
    "the exported key's public half is the wallet's SVM pubkey",
  );
});

test("exportPrivateKey refuses a wrong password with no key leak", async () => {
  const out = await exportPrivateKey(slug, walletId, "evm", "wrong-password");
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.reason, "wrong-password");
});

test("signMessage(evm) produces an EIP-191 signature recovering to the wallet", () => {
  const out = signMessage(slug, walletId, "evm", MESSAGE);
  assert.ok(out.ok, "sign succeeded");
  assert.equal(
    verifyMessage(MESSAGE, out.signature).toLowerCase(),
    evmPubkey.toLowerCase(),
    "the signature recovers to the wallet's EVM address",
  );
});

test("signMessage(svm) produces an ed25519 signature verifying against the wallet", () => {
  const out = signMessage(slug, walletId, "svm", MESSAGE);
  assert.ok(out.ok, "sign succeeded");
  const ok = nacl.sign.detached.verify(new TextEncoder().encode(MESSAGE), bs58.decode(out.signature), bs58.decode(svmPubkey));
  assert.ok(ok, "the signature verifies against the wallet's SVM pubkey over the message bytes");
});
