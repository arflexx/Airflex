import type { Meta, StoryObj } from "@storybook/react";
import React, { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";

const meta: Meta<typeof Modal> = {
  title: "UI/Modal",
  component: Modal,
  tags: ["autodocs"],
  argTypes: {
    isOpen: {
      control: "boolean",
      description: "Controls open visibility of the modal",
    },
    title: {
      control: "text",
      description: "Header title of the dialog",
    },
    description: {
      control: "text",
      description: "Contextual subtitle in the dialog",
    },
    maxWidth: {
      control: "text",
      description: "Tailwind max-width class",
    },
  },
};

export default meta;
type Story = StoryObj<typeof Modal>;

export const Interactive: Story = {
  render: () => {
    const [open, setOpen] = useState(false);

    return (
      <div>
        <Button onClick={() => setOpen(true)}>Open Modal</Button>
        <Modal
          isOpen={open}
          onClose={() => setOpen(false)}
          title="Confirm Action"
          description="Are you sure you want to proceed with this operation?"
          footer={
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => setOpen(false)}>
                Confirm
              </Button>
            </>
          }
        >
          <p className="text-sm text-gray-600 dark:text-gray-300">
            This action will update the contract status on the Stellar network.
          </p>
        </Modal>
      </div>
    );
  },
};
