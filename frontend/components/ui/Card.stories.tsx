import type { Meta, StoryObj } from "@storybook/react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "./Card";
import { Button } from "./Button";

const meta: Meta<typeof Card> = {
  title: "UI/Card",
  component: Card,
  tags: ["autodocs"],
  argTypes: {
    noPadding: {
      control: "boolean",
      description: "Toggles outer card padding",
    },
  },
};

export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  render: () => (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Trade Details</CardTitle>
        <CardDescription>Escrow-protected airtime purchase</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex justify-between py-2 text-sm">
          <span className="text-gray-500 dark:text-gray-400">Asset</span>
          <span className="font-semibold text-gray-900 dark:text-gray-100">MTN Airtime</span>
        </div>
        <div className="flex justify-between py-2 text-sm">
          <span className="text-gray-500 dark:text-gray-400">Amount</span>
          <span className="font-semibold text-gray-900 dark:text-gray-100">₦5,000</span>
        </div>
      </CardContent>
      <CardFooter>
        <Button variant="secondary" size="sm">Cancel</Button>
        <Button variant="primary" size="sm">Buy Now</Button>
      </CardFooter>
    </Card>
  ),
};
