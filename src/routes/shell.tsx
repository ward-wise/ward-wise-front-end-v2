import { createFileRoute } from "@tanstack/react-router";

// Refer to vite.config.ts to see why this empty route is here.
export const Route = createFileRoute("/shell")({
  ssr: false,
  component: () => null,
});
