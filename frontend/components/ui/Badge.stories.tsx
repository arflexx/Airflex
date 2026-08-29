import type { Meta, StoryObj } from "@storybook/react";
import { Badge } from "./Badge";

const meta: Meta<typeof Badge> = {
  title: "UI/Badge",
  component: Badge,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: { type: "select" },
      options: ["Open", "Locked", "Completed", "Cancelled", "Disputed"],
      description: "Trade lifecycle status variant",
    },
    showDot: {
      control: "boolean",
      description: "Toggles the status indicator dot",
    },
    children: {
      control: "text",
      description: "Custom label inside the badge",
    },
  },
};

export default meta;
type Story = StoryObj<typeof Badge>;

export const Open: Story = {
  args: {
    variant: "Open",
  },
};

export const Locked: Story = {
  args: {
    variant: "Locked",
  },
};

export const Completed: Story = {
  args: {
    variant: "Completed",
  },
};

export const Cancelled: Story = {
  args: {
    variant: "Cancelled",
  },
};

export const Disputed: Story = {
  args: {
    variant: "Disputed",
  },
};

export const AllStatuses: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Badge variant="Open" />
      <Badge variant="Locked" />
      <Badge variant="Completed" />
      <Badge variant="Cancelled" />
      <Badge variant="Disputed" />
    </div>
  ),
};
