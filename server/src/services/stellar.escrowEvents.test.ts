/**
 * stellar.escrowEvents.test.ts
 *
 * Escrow state-transition event parsing, pagination and subscription (#638).
 */

const mockGetEvents = jest.fn();
const mockGetLatestLedger = jest.fn();

jest.mock("../config/contracts", () => ({
  ESCROW_CONTRACT_ID: "CCBJ235OCBFZXBFSUUUT4PMG7RRCAXZXMUEB2L7CTTQ5NRSNO4P2SLNP",
  MARKETPLACE_CONTRACT_ID: "",
}));

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      // Resolved lazily: the factory runs before the consts above are assigned.
      Server: jest.fn(() => ({
        getEvents: (...args: unknown[]) => mockGetEvents(...args),
        getLatestLedger: () => mockGetLatestLedger(),
      })),
    },
  };
});

import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  EscrowStateTransitionEvent,
  fetchEscrowEvents,
  parseEscrowEvent,
  startEscrowEventSubscription,
  subscribeToEscrowEvents,
} from "./stellar";

const ACTOR = "GC22X7O3A4GTASUA732CHL6DICNFSO46L5VLYBMRHRUKT5DCBOXHWURF";

type RawEvent = Parameters<typeof parseEscrowEvent>[0];

function rawEvent(topic: string, ledger: number, seq = 1): RawEvent {
  return {
    id: `${String(ledger).padStart(19, "0")}-${String(seq).padStart(10, "0")}`,
    type: "contract",
    ledger,
    txHash: `tx-${ledger}-${seq}`,
    topic: [nativeToScVal(topic, { type: "symbol" })],
    value: xdr.ScVal.scvVec([
      nativeToScVal(7n, { type: "u64" }),
      new Address(ACTOR).toScVal(),
      nativeToScVal(5_000_000_000n, { type: "i128" }),
      nativeToScVal(1_000_000n, { type: "u64" }),
    ]),
  } as unknown as RawEvent;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

beforeEach(() => {
  mockGetEvents.mockReset();
  mockGetLatestLedger.mockReset();
});

describe("parseEscrowEvent", () => {
  it.each(["EscrowCreated", "EscrowReleased", "EscrowRefunded", "EscrowDisputed"])(
    "parses %s",
    (topic) => {
      expect(parseEscrowEvent(rawEvent(topic, 10))).toMatchObject({
        topic,
        escrowId: "7",
        actor: ACTOR,
        amount: "5000000000",
        timestamp: "1000000",
        ledger: 10,
        txHash: "tx-10-1",
      });
    }
  );

  it("ignores the contract's short-form topics", () => {
    expect(parseEscrowEvent(rawEvent("released", 10))).toBeNull();
  });
});

describe("fetchEscrowEvents", () => {
  it("follows pagination with the last event id as cursor", async () => {
    const full = Array.from({ length: 100 }, (_, i) => rawEvent("EscrowCreated", 10, i + 1));
    mockGetEvents
      .mockResolvedValueOnce({ latestLedger: 20, events: full })
      .mockResolvedValueOnce({ latestLedger: 20, events: [rawEvent("EscrowReleased", 11)] });

    const events = await fetchEscrowEvents(5);

    expect(events).toHaveLength(101);
    expect(mockGetEvents).toHaveBeenCalledTimes(2);
    const first = mockGetEvents.mock.calls[0][0];
    const second = mockGetEvents.mock.calls[1][0];
    expect(first.startLedger).toBe(5);
    expect(first.filters[0].topics).toHaveLength(4);
    expect(second.cursor).toBe(full[99]?.id);
    expect(second.startLedger).toBeUndefined();
  });
});

describe("subscribeToEscrowEvents", () => {
  it("delivers each event once even though the boundary ledger is re-read", async () => {
    const a = rawEvent("EscrowCreated", 10);
    const b = rawEvent("EscrowReleased", 12);
    mockGetEvents
      .mockResolvedValueOnce({ latestLedger: 10, events: [a] })
      .mockResolvedValue({ latestLedger: 12, events: [a, b] });

    const seen: EscrowStateTransitionEvent[] = [];
    const subscription = subscribeToEscrowEvents({
      startLedger: 10,
      intervalMs: 1,
      onEvent: (event) => {
        seen.push(event);
      },
    });
    await waitFor(() => mockGetEvents.mock.calls.length >= 4);
    subscription.stop();

    expect(seen.map((event) => event.topic)).toEqual(["EscrowCreated", "EscrowReleased"]);
  });

  it("retries an event whose handler failed and reports the error", async () => {
    mockGetEvents.mockResolvedValue({
      latestLedger: 10,
      events: [rawEvent("EscrowDisputed", 10)],
    });

    const onEvent = jest
      .fn<Promise<void>, [EscrowStateTransitionEvent]>()
      .mockRejectedValueOnce(new Error("handler down"))
      .mockResolvedValue(undefined);
    const onError = jest.fn();
    const subscription = subscribeToEscrowEvents({
      startLedger: 10,
      intervalMs: 1,
      onEvent,
      onError,
    });
    await waitFor(() => onEvent.mock.calls.length >= 2);
    subscription.stop();

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "handler down" }));
  });

  it("starts at the latest ledger by default", async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 42 });
    mockGetEvents.mockResolvedValue({ latestLedger: 42, events: [] });

    const subscription = subscribeToEscrowEvents({ intervalMs: 1, onEvent: jest.fn() });
    await waitFor(() => mockGetEvents.mock.calls.length >= 1);
    subscription.stop();

    expect(mockGetEvents.mock.calls[0][0].startLedger).toBe(42);
  });
});

describe("startEscrowEventSubscription", () => {
  it("is disabled unless ESCROW_EVENTS_ENABLED=true", () => {
    delete process.env["ESCROW_EVENTS_ENABLED"];
    expect(startEscrowEventSubscription()).toBeNull();
    expect(mockGetEvents).not.toHaveBeenCalled();
  });
});
