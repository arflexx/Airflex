
import React from "react";
import { render } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";
import { Badge, BadgeStatusVariant } from "./Badge";

expect.extend(toHaveNoViolations);

describe("Badge accessibility", () => {
  const variants: BadgeStatusVariant[] = [
    "Open",
    "Active",
    "Locked",
    "Completed",
    "Cancelled",
    "Disputed",
  ];

  it.each(variants)(
    "%s variant has no axe accessibility violations",
    async (variant) => {
      const { container } = render(<Badge variant={variant} />);

      const results = await axe(container);

      expect(results).toHaveNoViolations();
    },
  );
});

