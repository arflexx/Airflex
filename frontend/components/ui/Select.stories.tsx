import type { Meta, StoryObj } from "@storybook/react";
import { Select } from "./Select";

const meta: Meta<typeof Select> = {
  title: "UI/Select",
  component: Select,
  tags: ["autodocs"],
  argTypes: {
    label: {
      control: "text",
      description: "Label above the select element",
    },
    error: {
      control: "text",
      description: "Error message indicating invalid state",
    },
    helperText: {
      control: "text",
      description: "Helpful text below the select",
    },
    disabled: {
      control: "boolean",
      description: "Disables the select element",
    },
    required: {
      control: "boolean",
      description: "Whether a selection is required",
    },
  },
};

export default meta;
type Story = StoryObj<typeof Select>;

const bankOptions = [
  { value: "058", label: "GTBank" },
  { value: "011", label: "First Bank of Nigeria" },
  { value: "033", label: "United Bank for Africa (UBA)" },
  { value: "057", label: "Zenith Bank" },
  { value: "044", label: "Access Bank" },
];

export const Default: Story = {
  args: {
    label: "Destination Bank",
    options: bankOptions,
    helperText: "Select your registered Nigerian bank account.",
  },
};

export const WithError: Story = {
  args: {
    label: "Destination Bank",
    options: [{ value: "", label: "-- Select a bank --" }, ...bankOptions],
    error: "Please select a valid bank.",
  },
};

export const Disabled: Story = {
  args: {
    label: "Settlement Currency",
    options: [{ value: "NGN", label: "Nigerian Naira (NGN)" }],
    disabled: true,
  },
};
