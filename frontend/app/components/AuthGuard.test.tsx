import React from "react";
import { render, screen } from "@testing-library/react";

import { AuthGuard } from "./AuthGuard";

const mockReplace = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));

jest.mock("../hooks/useAuth", () => ({
  useAuth: jest.fn(),
}));

import { useAuth } from "../hooks/useAuth";

const mockUseAuth = useAuth as unknown as jest.Mock;

function setAuth(state: { role: "admin" | "user" | null; isLoading: boolean }) {
  mockUseAuth.mockReturnValue(state);
}

describe("AuthGuard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("redirects a non-admin to / and hides the protected children", () => {
    setAuth({ role: "user", isLoading: false });

    render(
      <AuthGuard role="admin">
        <p>secret admin panel</p>
      </AuthGuard>,
    );

    expect(mockReplace).toHaveBeenCalledWith("/");
    expect(screen.queryByText("secret admin panel")).not.toBeInTheDocument();
  });

  it("renders the children for an admin", () => {
    setAuth({ role: "admin", isLoading: false });

    render(
      <AuthGuard role="admin">
        <p>secret admin panel</p>
      </AuthGuard>,
    );

    expect(screen.getByText("secret admin panel")).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("treats a null role as non-admin", () => {
    setAuth({ role: null, isLoading: false });

    render(
      <AuthGuard role="admin">
        <p>secret admin panel</p>
      </AuthGuard>,
    );

    expect(mockReplace).toHaveBeenCalledWith("/");
    expect(screen.queryByText("secret admin panel")).not.toBeInTheDocument();
  });

  it("renders a placeholder while loading and does not redirect yet", () => {
    setAuth({ role: null, isLoading: true });

    render(
      <AuthGuard role="admin">
        <p>secret admin panel</p>
      </AuthGuard>,
    );

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText("secret admin panel")).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("lets an admin satisfy a user-level guard but not the reverse", () => {
    setAuth({ role: "admin", isLoading: false });
    const { unmount } = render(
      <AuthGuard role="user">
        <p>signed-in area</p>
      </AuthGuard>,
    );
    expect(screen.getByText("signed-in area")).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
    unmount();

    setAuth({ role: "user", isLoading: false });
    render(
      <AuthGuard role="admin">
        <p>signed-in area</p>
      </AuthGuard>,
    );
    expect(mockReplace).toHaveBeenCalledWith("/");
  });
});
