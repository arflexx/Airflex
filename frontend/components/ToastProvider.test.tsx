import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ToastProvider, ToastContext } from "./ToastProvider";

/** Minimal consumer that exercises the imperative context API. */
function ToastTriggers() {
  const toast = React.useContext(ToastContext);
  if (!toast) throw new Error("ToastContext missing");
  return (
    <div>
      <button onClick={() => toast.success("toast one")}>fire one</button>
      <button onClick={() => toast.info("toast two")}>fire two</button>
      <button onClick={() => toast.warning("toast three")}>fire three</button>
      <button onClick={() => toast.error("toast four")}>fire four</button>
    </div>
  );
}

function renderProvider() {
  return render(
    <ToastProvider>
      <ToastTriggers />
    </ToastProvider>,
  );
}

describe("ToastProvider (Issue #286)", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("caps visible toasts at three and drops the oldest (FIFO)", () => {
    renderProvider();

    fireEvent.click(screen.getByText("fire one"));
    fireEvent.click(screen.getByText("fire two"));
    fireEvent.click(screen.getByText("fire three"));

    expect(screen.getByText("toast one")).toBeInTheDocument();

    // The 4th toast pushes out the oldest, leaving the latest three.
    fireEvent.click(screen.getByText("fire four"));

    expect(screen.queryByText("toast one")).not.toBeInTheDocument();
    expect(screen.getByText("toast two")).toBeInTheDocument();
    expect(screen.getByText("toast three")).toBeInTheDocument();
    expect(screen.getByText("toast four")).toBeInTheDocument();
  });

  it("auto-dismisses a toast after the default 5 second duration", () => {
    jest.useFakeTimers();
    renderProvider();

    act(() => {
      fireEvent.click(screen.getByText("fire one"));
    });
    expect(screen.getByText("toast one")).toBeInTheDocument();

    // Still visible just before the 5s mark.
    act(() => {
      jest.advanceTimersByTime(4_999);
    });
    expect(screen.getByText("toast one")).toBeInTheDocument();

    // At 5s the toast starts closing; the 200ms exit transition completes it.
    act(() => {
      jest.advanceTimersByTime(1 + 200);
    });
    expect(screen.queryByText("toast one")).not.toBeInTheDocument();
  });

  it("announces toasts in a polite role=status live region", () => {
    renderProvider();

    fireEvent.click(screen.getByText("fire one"));

    const region = document.querySelector('[role="status"][aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent("toast one");

    // The per-toast role is reconciled to polite as well — no assertive alerts.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
