// Pins the exported ledger-tree path constants to the compiler's recorded
// field indexes. Any ledger declaration change re-chunks the state tree and
// silently moves every path (see the CAUTION over the ledger block in
// erc20-vault.compact), so this is the tripwire that turns that drift into a
// unit-test failure instead of an MPC that never answers requests.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { VAULT_DEPOSIT_REQUESTS_PATH } from "../src/index.ts";

interface LedgerFieldInfo {
  readonly name: string;
  readonly index: readonly number[];
}

const contractInfo = JSON.parse(
  readFileSync(
    new URL("../src/managed/erc20-vault/compiler/contract-info.json", import.meta.url),
    "utf8",
  ),
) as { readonly ledger: readonly LedgerFieldInfo[] };

const compiledFieldIndex = (name: string): readonly number[] => {
  const field = contractInfo.ledger.find((candidate) => candidate.name === name);
  if (!field) {
    throw new Error(`contract-info.json records no ledger field named "${name}"`);
  }
  return field.index;
};

describe("exported ledger paths match the compiled contract-info.json", () => {
  it.each([
    ["bidirectionalDepositMap", VAULT_DEPOSIT_REQUESTS_PATH, [1, 12]],
    // The literal column is deliberate: the notification vectors in
    // erc20-vault.compact are hand-written, so a re-chunk that moves a path
    // must fail here even when the exported constant was updated with it.
  ] as const)("%s", (fieldName, exportedPath, compiledPath) => {
    expect(compiledFieldIndex(fieldName)).toEqual(compiledPath);
    expect(exportedPath).toEqual(compiledPath);
  });
});

describe("the admin-updateable gas parameters sit in chunk 0", () => {
  it.each([
    ["vaultMaxFeePerGas", [0, 2]],
    ["vaultMaxPriorityFeePerGas", [0, 3]],
    ["vaultGasLimits", [0, 4]],
  ] as const)("%s", (fieldName, compiledPath) => {
    expect(compiledFieldIndex(fieldName)).toEqual(compiledPath);
  });
});

describe("the state tree stays TWO chunks deep", () => {
  it("holds at most 30 fields, the two chunks' worth", () => {
    expect(contractInfo.ledger.length).toBeLessThanOrEqual(30);
  });

  it("uses exactly two chunks, at depth 2", () => {
    const chunks = new Set(contractInfo.ledger.map((field) => field.index[0]));
    const depths = new Set(contractInfo.ledger.map((field) => field.index.length));

    expect([...chunks].sort()).toEqual([0, 1]);
    expect([...depths]).toEqual([2]);
  });
});
