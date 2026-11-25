import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About | Ward Wise" },
      {
        name: "description",
        content: "Our mission and team.",
      },
    ],
  }),
  component: About,
});

function About() {
  return <main>About us and stuff.</main>;
}
