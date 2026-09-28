/**
 * Reconnection behaviour of the SSE notification stream (Issue #331).
 *
 * The schedule is asserted with mocked timers and a pinned `Math.random`, so
 * the jitter that exists to desynchronise real clients does not make the
 * expected delays a moving target.
 */

import { act, render, screen } from "@testing-library/react";
import React from "react";

import {
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  MAX_RETRIES,
  backoffDelay,
  useTradeNotifications,
} from "./useTradeNotifications";

jest.mock("./useAuth", () => ({
  useAuth: () => ({ token: "test-token" }),
}));

// ---------------------------------------------------------------------------
// EventSource double
// ---------------------------------------------------------------------------

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  /** Drive the stream into the failure path the hook reconnects from. */
  fail(): void {
    this.onerror?.();
  }
}

function Probe(): JSX.Element {
  const { connectionState } = useTradeNotifications();
  return <span data-testid="state">{connectionState}</span>;
}

/** Delays passed to setTimeout, in the order they were scheduled. */
function scheduledDelays(): number[] {
  const spy = setTimeout as unknown as jest.Mock;
  return spy.mock.calls
    .map((call) => call[1] as number)
    .filter((delay) => typeof delay === "number");
}

describe("backoffDelay", () => {
  afterEach(() => {
    jest.spyOn(Math, "random").mockRestore();
  });

  it("doubles from the base delay and caps at the maximum", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);

    expect(backoffDelay(0)).toBe(1_000);
    expect(backoffDelay(1)).toBe(2_000);
    expect(backoffDelay(2)).toBe(4_000);
    expect(backoffDelay(3)).toBe(8_000);
    expect(backoffDelay(4)).toBe(16_000);
    // 32s would exceed the cap.
    expect(backoffDelay(5)).toBe(MAX_DELAY_MS);
    expect(backoffDelay(9)).toBe(MAX_DELAY_MS);
  });

  it("never exceeds the cap once jitter is applied", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.999);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      expect(backoffDelay(attempt)).toBeLessThanOrEqual(MAX_DELAY_MS);
    }

    // Jitter only ever adds, so the schedule is still the floor.
    expect(backoffDelay(0)).toBeGreaterThanOrEqual(BASE_DELAY_MS);
  });
});

describe("useTradeNotifications reconnection", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
    jest.spyOn(Math, "random").mockReturnValue(0);
    jest.useFakeTimers();
    jest.spyOn(globalThis, "setTimeout");
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("reconnects on the 1s / 2s / 4s schedule after server-side closes", () => {
    render(<Probe />);
    expect(FakeEventSource.instances).toHaveLength(1);

    // Three consecutive drops, each one reconnecting after its own delay.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const source = FakeEventSource.instances[attempt]!;
      act(() => source.fail());

      // The dead stream is closed rather than left to EventSource's own retry.
      expect(source.closed).toBe(true);
      expect(screen.getByTestId("state")).toHaveTextContent("reconnecting");

      act(() => {
        jest.advanceTimersByTime(backoffDelay(attempt));
      });
      expect(FakeEventSource.instances).toHaveLength(attempt + 2);
    }

    expect(scheduledDelays().slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
  });

  it("resets the schedule once a connection opens successfully", () => {
    render(<Probe />);

    act(() => FakeEventSource.instances[0]!.fail());
    act(() => {
      jest.advanceTimersByTime(BASE_DELAY_MS);
    });

    act(() => FakeEventSource.instances[1]!.onopen?.());
    expect(screen.getByTestId("state")).toHaveTextContent("open");

    act(() => FakeEventSource.instances[1]!.fail());
    // Back to the first rung, not the second.
    expect(scheduledDelays().slice(0, 2)).toEqual([1_000, 1_000]);
  });

  it("gives up after the maximum number of attempts", () => {
    render(<Probe />);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      act(() => FakeEventSource.instances[attempt]!.fail());
      act(() => {
        jest.advanceTimersByTime(MAX_DELAY_MS);
      });
    }

    expect(FakeEventSource.instances).toHaveLength(MAX_RETRIES + 1);

    // The attempt after the last one is not retried.
    act(() => FakeEventSource.instances[MAX_RETRIES]!.fail());
    expect(screen.getByTestId("state")).toHaveTextContent("failed");

    act(() => {
      jest.advanceTimersByTime(MAX_DELAY_MS * 2);
    });
    expect(FakeEventSource.instances).toHaveLength(MAX_RETRIES + 1);
  });

  it("clears a pending retry when the component unmounts", () => {
    const { unmount } = render(<Probe />);

    act(() => FakeEventSource.instances[0]!.fail());
    unmount();

    act(() => {
      jest.advanceTimersByTime(MAX_DELAY_MS);
    });
    // The scheduled reconnect must not outlive the component.
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
