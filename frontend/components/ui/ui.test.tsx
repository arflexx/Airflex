import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Button } from "./Button";
import { Input } from "./Input";
import { Select } from "./Select";
import { Badge } from "./Badge";
import { Modal } from "./Modal";
import { Spinner } from "./Spinner";
import { DisputeModal } from "../../app/trades/[id]/dispute/DisputeModal";

describe("UI Primitives", () => {
  describe("Button", () => {
    it("renders children and handles click events", () => {
      const handleClick = jest.fn();
      render(<Button onClick={handleClick}>Click me</Button>);
      const btn = screen.getByRole("button", { name: "Click me" });
      fireEvent.click(btn);
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it("displays loading spinner and text when isLoading is true", () => {
      render(<Button isLoading loadingText="Saving…">Save</Button>);
      expect(screen.getByRole("button")).toBeDisabled();
      expect(screen.getByText("Saving…")).toBeInTheDocument();
    });

    it("applies danger variant classes", () => {
      render(<Button variant="danger">Delete</Button>);
      const btn = screen.getByRole("button", { name: "Delete" });
      expect(btn.className).toContain("bg-red-600");
    });
  });

  describe("Input", () => {
    it("renders label, placeholder, and helper text", () => {
      render(
        <Input
          label="Email Address"
          id="email-input"
          placeholder="user@example.com"
          helperText="We will not share your email."
        />
      );
      expect(screen.getByLabelText("Email Address")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("user@example.com")).toBeInTheDocument();
      expect(screen.getByText("We will not share your email.")).toBeInTheDocument();
    });

    it("renders error message with alert role and invalid state", () => {
      render(<Input label="Username" id="user-input" error="Username already taken" />);
      const input = screen.getByLabelText("Username");
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("alert")).toHaveTextContent("Username already taken");
    });
  });

  describe("Select", () => {
    it("renders options and selects a value", () => {
      const handleChange = jest.fn();
      render(
        <Select
          label="Country"
          id="country-select"
          options={[
            { value: "NG", label: "Nigeria" },
            { value: "GH", label: "Ghana" },
          ]}
          onChange={handleChange}
        />
      );
      const select = screen.getByLabelText("Country") as HTMLSelectElement;
      fireEvent.change(select, { target: { value: "GH" } });
      expect(handleChange).toHaveBeenCalled();
      expect(select.value).toBe("GH");
    });
  });

  describe("Badge", () => {
    it("renders status badges with appropriate labels and dot indicators", () => {
      const { rerender } = render(<Badge variant="Open" />);
      expect(screen.getByText("Open")).toBeInTheDocument();

      rerender(<Badge variant="Locked" />);
      expect(screen.getByText("Locked")).toBeInTheDocument();

      rerender(<Badge variant="Completed" />);
      expect(screen.getByText("Completed")).toBeInTheDocument();

      rerender(<Badge variant="Cancelled" />);
      expect(screen.getByText("Cancelled")).toBeInTheDocument();

      rerender(<Badge variant="Disputed" />);
      expect(screen.getByText("Disputed")).toBeInTheDocument();
    });
  });

  describe("Modal", () => {
    it("renders accessible modal with title and trap and closes on ESC", () => {
      const handleClose = jest.fn();
      render(
        <Modal isOpen={true} onClose={handleClose} title="Test Modal">
          <p>Modal content</p>
        </Modal>
      );
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Test Modal")).toBeInTheDocument();
      expect(screen.getByText("Modal content")).toBeInTheDocument();

      // Press ESC key
      fireEvent.keyDown(window, { key: "Escape" });
      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it("does not render when isOpen is false", () => {
      render(
        <Modal isOpen={false} onClose={jest.fn()} title="Hidden Modal">
          <p>Hidden</p>
        </Modal>
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("Spinner", () => {
    it("renders with role status and accessible label", () => {
      render(<Spinner label="Processing trade…" />);
      const spinner = screen.getByRole("status");
      expect(spinner).toHaveAttribute("aria-label", "Processing trade…");
    });
  });

  describe("DisputeModal", () => {
    it("renders confirmation modal, validates character count, and submits dispute", async () => {
      const handleClose = jest.fn();
      const handleSuccess = jest.fn();
      const handleError = jest.fn();

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          message: "Dispute submitted successfully",
          data: { id: "trade-123", status: "Disputed" },
        }),
      }) as jest.Mock;

      render(
        <DisputeModal
          isOpen={true}
          onClose={handleClose}
          tradeId="trade-123"
          onDisputeSuccess={handleSuccess}
          onError={handleError}
        />
      );

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Raise a Trade Dispute")).toBeInTheDocument();
      expect(screen.getByText("0/500")).toBeInTheDocument();

      const textarea = screen.getByPlaceholderText(/explain what went wrong/i);
      fireEvent.change(textarea, { target: { value: "Airtime was not received after 2 hours." } });
      expect(screen.getByText("39/500")).toBeInTheDocument();

      const submitBtn = screen.getByRole("button", { name: "Confirm Dispute" });
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(handleSuccess).toHaveBeenCalled();
        expect(handleClose).toHaveBeenCalled();
      });
    });
  });
});
