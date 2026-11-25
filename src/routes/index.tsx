import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Home | Ward Wise" },
      {
        name: "description",
        content: "We visualize metrics into insightful reports!",
      },
    ],
  }),
  component: App,
});

function App() {
  return <main>Hello from Chicago!</main>;
}
