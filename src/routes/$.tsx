import { createFileRoute, Link } from "@tanstack/react-router";

// This is a dynamic route that matches invalid routes and shows a 404 page.
// This file is a workaround to avoid an error where only using
// src/router.tsx's defaultNotFoundComponent to capture 404 pages will
// create a hydration error. This avoids that error so it doesn't appear in analytics.
export const Route = createFileRoute("/$")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "404 - Page Not Found | Ward Wise" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: NotFoundPage,
});

function NotFoundPage() {
  return (
    <main>
      <section>
        <p>404</p>
        <h1>Page Not Found</h1>
        <p>The page you are looking for does not exist.</p>
        <Link to="/">Back to Home</Link>
      </section>
    </main>
  );
}
