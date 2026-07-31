import type { Meta, StoryObj } from "@storybook/react-vite";
import { TrainingEconomicsSection } from "@/components/TrainingEconomicsSection";

const meta: Meta<typeof TrainingEconomicsSection> = {
  title: "Training Economics / Dashboard Panels",
  component: TrainingEconomicsSection,
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  name: "Training economics panels",
  parameters: {
    docs: {
      description: {
        story:
          "Training economics summary rendered within the Costs surface. Includes provenance badges, lane margins, node utilization, train-vs-inference recommendation, and the financial benchmark that excludes spark training.",
      },
    },
  },
};
