// Offline unit tests of reading an executed swap's amountIn from its attested
// output: the fixtures pack amountIn with the vault's COMPILED respond schema,
// through the same ABI-to-compact pipeline the MPC runs. No stack, no env gate:
// these run in every `yarn test`.

import {
  OutputKind,
  parseRequestIdHex,
  requestIdBytes,
  serializeRespondOutput,
} from "@sig-net/midnight";
import { attestRespondBidirectional } from "@sig-net/midnight/testing";
import { pureCircuits } from "@sig-net/midnight-examples-erc20-vault-contract";
import { describe, expect, it } from "vitest";

import { swapAmountIn } from "../src/flows/complete-swap.ts";
import type { RespondOutcome } from "../src/flows/respond-output.ts";

const REQUEST_ID = requestIdBytes(parseRequestIdHex("ab".repeat(32)));
const MPC_RESPONSE_SECRET = new Uint8Array(32).fill(7);

/** An attested swap outcome over `serializedOutput` under `outputKind`. */
const outcomeOf = (outputKind: OutputKind, serializedOutput: Uint8Array): RespondOutcome => ({
  event: attestRespondBidirectional(
    { requestId: REQUEST_ID, blockHeight: 77n, outputKind, serializedOutput },
    MPC_RESPONSE_SECRET,
  ),
  serializedOutput,
  succeeded: false,
});

describe("swapAmountIn", () => {
  it.each([
    { name: "one base unit", amountIn: 1n },
    { name: "a spend spanning several bytes", amountIn: 990_000n },
    { name: "the Uint<64> maximum", amountIn: 18446744073709551615n },
  ])("reads an executed swap's amountIn: $name", ({ amountIn }) => {
    const output = serializeRespondOutput(pureCircuits.swapRespondSchema(), { amountIn });
    expect(swapAmountIn(outcomeOf(OutputKind.executed, output))).toBe(amountIn);
  });

  it.each([
    { name: "failed", outputKind: OutputKind.failed },
    { name: "unviable", outputKind: OutputKind.unviable },
  ])("has no amountIn for a $name swap", ({ outputKind }) => {
    expect(swapAmountIn(outcomeOf(outputKind, new Uint8Array(0)))).toBeUndefined();
  });

  it("refuses an executed output that is not 8 bytes", () => {
    expect(() => swapAmountIn(outcomeOf(OutputKind.executed, new Uint8Array([0x01])))).toThrow(
      /8-byte amountIn/,
    );
  });
});
