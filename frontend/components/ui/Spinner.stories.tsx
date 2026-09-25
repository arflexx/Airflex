import type { Meta, StoryObj } from "@storybook/react";
import { Spinner } from "./Spinner";

const meta: Meta<typeof Spinner> = {
  title: "UI/Spinner",
  component: Spinner,
  tags: ["autodocs"],
  argTypes: {
    size: {
      control: { type: "select" },
      options: ["sm", "md", "lg"],
      description: "Size of the spinner icon",
    },
    label: {
      control: "text",
      description: "Screen reader announcement label",
    },
  },
};

export default meta;
type Story = StoryObj<typeof Spinner>;

export const Small: Story = {
  args: {
    size: "sm",
    label: "Loading small content",
  },
};

export const Medium: Story = {
  args: {
    size: "md",
    label: "Loading content",
  },
};

export const Large: Story = {
  args: {
    size: "lg",
    label: "Loading large content",
  },
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex items-center gap-6">
      <Spinner size="sm" label="Loading small content" />
      <Spinner size="md" label="Loading content" />
      <Spinner size="lg" label="Loading large content" />
    </div>
  ),
};
