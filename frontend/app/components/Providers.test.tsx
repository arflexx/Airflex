import React from "react";
import { render, screen } from "@testing-library/react";
import { Providers } from "./Providers";

describe("Providers", () => {
  it("renders children", () => {
    render(
      <Providers>
        <p>child content</p>
      </Providers>,
    );
    expect(screen.getByText("child content")).toBeInTheDocument();
  });
});