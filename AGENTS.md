# Workflow Guide

This is a TanStack Start website that is configured to be a SPA website. It prerenders routes that don't make API calls. To contribute safely and consistently, follow these guidelines whenever you work on the repository:

## General Guidelines

Stuff available to you
- This project uses the Bun runtime
- The classnames package is available to concatenate multiple classNames
- The motion (previously Framer Motion) package is available to animate elements
- Base UI is available to you to create good, accessible components
- TanStack Query is available to you to make and cache API calls
- `@/src/styles/_colors.css` contains color tokens that you should not use directly
- `@/src/styles/_variables.css` contains CSS variables you should for consistent styling
- `@/src/styles/_globals.scss` contains global classes you can use

Research the codebase
- Inspect the files relevant to your task before editing. Trace current implementations to understand existing behavior and dependencies.

Plan appropriately
- For large changes, draft a clear plan and get confirmation from the requester before coding.
- For small or straightforward tasks, form a quick mental or written plan and move straight to implementation.

Execute the plan
- Apply the necessary code changes, keeping diffs focused and well-explained with minimal but helpful comments only when needed.

Verify your changes are fine
- Execute `bun check` if you made any changes to Typescript files. Address any failures before proceeding. You do NOT need to run this if all you did was CSS changes.

## Components

Components go in the ./src/components folder. They follow this file structure:

./src/components
-> ComponentName
->-> index.tsx
->-> styles.module.scss
->-> (any other components or assets directly related to this component that would not be shared with others)

Components should follow this coding style:
```tsx
import classNames from "classnames";
import styles from "./styles.module.css";

interface ComponentNameProps extends React.HTMLAttributes<HTMLDivElement> {}

export default function ComponentName({
  children,
  className,
  ...props
}: ComponentNameProps) {
  return (
    <div {...props} className={classNames(className, styles.wrapper)}>
      <p className={styles.multiWordClassName}>placeholder</p>
      {children}
    </div>
  );
}
```
In this example, notice the naming conventions, how the component props extends HTMLAttributes, spreads the props, and can take a className for the root element.

## Pages
This project is configured to build a static website by prerendering routes. For pages that make API calls, you should follow this example:
```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import Button from "@/components/Button"

// this route will load when the user visits `wardwise.org/map?ward=42`
export const Route = createFileRoute("/map")({
  // this is explained more in the next section
  // you will usually want this to be false
  ssr: false,
  
  // validates the search params and converts them to the correct type (a number)
  validateSearch: (search: Record<string, unknown>) => ({
    ward: Number(search.ward) || 1, // if the user visits `/map?ward=foo`, `ward` will be 1
  }),

  // our page content
  component: WardMap,
});

function WardMap() {
  // grab the requested ward from the url search params
  const { ward } = Route.useSearch();

  // use TanStack Query to cache data and make it reuseable in other places
  const { data, isPending, isError } = useQuery({
    // key that identifies this query in the cache
    queryKey: ["ward-map", ward],
    // the function that actually makes the API call
    queryFn: () => fetch(`/api/map?ward=${ward}`).then((r) => r.json()),
  });

  if (isPending) return <p>Loading map for Ward {ward}...</p>;
  if (isError) return <p>Failed to load map data.</p>;

  // usual JSX stuff
  return (
    <main>
      <h1>Ward {ward} Landmarks</h1>
      <p>This ward {data.hasBean ? "does" : "does not"} include The Bean.</p>

      <Button>Show full report</Button>
    </main>
  );
}
```
It is important that you set `ssr` to `false` on routes that make API calls. 

## CSS files

CSS files related to components should be within the component's folder, named styles.module.scss.

CSS files related to pages are in the ./src/styles folder.

## Additional rules

Never run `bun install`. The dependencies are already installed and up to date. Should you require a dependency, ask before installing.
Never run `bun run dev` or `bun run build`. The dev server is handled externally, and `bun check` is used to validate Typescript related changes.

Following these steps helps keep the project stable and makes future collaboration smoother.

This repository contains a `docs/` directory. It is for human maintainers and you don't need to read anything in there. This workflow guideline contains everything you need to know from the `docs/` directory. If you need more information on TanStack Start, TanStack Router, or TanStack Query, or any other dependency, do a search online and view the respective library's documentation.
