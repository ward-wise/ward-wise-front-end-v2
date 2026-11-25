# Types of Routes

TanStack Start is a framework that incorporates a lot of other kinds of libraries to make a cohesive, useful way to make sites.

TanStack Start uses TanStack Router to let you declare pages using **routes**. A route is a page of our website identified by the url path the user will use to visit the page. A simple route looks like this:
```tsx
import { createFileRoute } from "@tanstack/react-router";
import Button from "@/components/Button"

// define the route information for TanStack Router to know about it
// when the user visits the `wardwise.org/about` page, TanStack Router will render this route
export const Route = createFileRoute("/about")({
  // important SEO stuff that lets people discover this page on search engines and social media
  head: () => ({
    meta: [
      { title: "About | Ward Wise" },
      {
        name: "description",
        content:
          "We visualize metrics into insightful reports!",
      },
    ],
  }),

  // tell TanStack Router what to render for this route
  component: About,
});

function About() {
  // usual HTML stuff
  return (
    <main>
      Hello from Chicago!
      <Button>Right back at ya!</Button>
    </main>
  );
}
```

### Data fetching
Another library TanStack Start integrates well with is TanStack Query, which helps cache data so making the same API call reuses already fetched data. It also abstracts away complicated React state management for fetching data into a simple `useQuery` function. You can fetch data in a route like so:
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

### Data fetching with preload 
Routes can be configured to prefetch data before the user visits the page, specifically when a user hovers over a link, by defining an API call in its route config. This makes pages feel speedy by having all the data there by the time the user clicks the link to get to this page. 

Data heavy pages should use the previous `useQuery` example so the user does not fetch a ton of data by just hovering over a link.

Here's an example of a route loader:
```tsx

import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import Button from "@/components/Button"

const wardReportQuery = (ward: number) =>
  // use TanStack Query to cache data and make it reuseable in other places
  queryOptions({
    // key that identifies this query in the cache
    queryKey: ["ward-report", ward],
    // the function that actually makes the API call
    queryFn: () => fetch(`/api/reports?ward=${ward}`).then((r) => r.json()),
  });

// configure this route to use a "loader" to immediately fetch the data when
// the user visits `wardwise.org/reports?ward=42` where 
// "ward" is a search parameter equal to the string "42"
export const Route = createFileRoute("/reports")({
  // Skips build-time execution; loader runs only in the browser
  ssr: false,

  // validates the search params and converts them to the correct type (a number)
  validateSearch: (search: Record<string, unknown>) => ({
    ward: Number(search.ward) || 1, // if the user visits `/reports?ward=foo`, `ward` will be 1
  }),
  
  // tells the loader that there are search params it can use
  // and re-runs it when `ward` changes
  loaderDeps: ({ search: { ward } }) => ({ ward }),
  
  // the loader function that fetches the data and caches it
  loader: ({ context: { queryClient }, deps: { ward } }) =>
    queryClient.ensureQueryData(wardReportQuery(ward)),
    
  // a placeholder component to show while the data is loading
  pendingComponent: () => <p>Loading report...</p>,

  // our page content
  component: WardReport,
});

function WardReport() {
  // grab the requested ward from the url search params
  const { ward } = Route.useSearch();
  
  // although the loader fetched this data already, only our loader knows about this data
  // this function lets our component read this data as well, specifically from the cache
  // which the loader has placed the data into
  const { data } = useSuspenseQuery(wardReportQuery(ward));

  // usual JSX stuff
  return (
    <main>
      <h1>Ward {ward} Report</h1>
      <p>{data.summary}</p>
      
      <Button>Show full report</Button>
    </main>
  );
}
```

## Routes in our project

This project is configured to build a static website by prerendering routes. This means that pages that make API calls need to opt out of this prerendering behavior, otherwise when the site is built these API calls get triggered and are placed into the static build of the site. This may be desireable in some instances, so here is a table outlining the different configurations you can use to get different types of pages (though usually you will probably want pages that fetch data to not be statically prerendered).

| Route Type | Example | Route Config | Static HTML Output | When API Runs |
| --- | --- | --- | --- | --- |
| **Static SEO page** (no API calls) | `/`, `/about` | `ssr: true` (default) | `index.html`, `about/index.html` (`<head>` meta + includes full content) | Never                                            |
| **Static path + runtime API (using parameters from `searchParams`)** | `/map?ward=42` | `ssr: false` + `useQuery` | `map.html` (`<head>` SEO meta + root shell without data)  | In client browser during runtime |
| **Dynamic path + runtime API (using parameters from route `$param`)** | `/reports/$wardId` | `ssr: false` + `useQuery` | **None** (served via `/_shell.html` with traffic rewrite) | In client browser during runtime |
| **Build-time embedded data page** | `/ward-index` | `ssr: true` | `ward-index.html` (full content with any data included) | Build time (and client runtime under certain conditions) |

tl;dr usually you want to set `ssr: false` on pages that make API calls so data isn't statically inserted into pages which can eventually turn outdated.

> [!IMPORTANT]
> `ssr: false` is inherited by its child routes. Setting `ssr: false` on a route defined as `/parent` will implicitly also define it as false for a route configured to use `/parent/child`. For example, setting `ssr: false` on `src/routes/__root.tsx` would make the entire site opt out of prerendering, because all routes are children of the parent root.

## Opting specific parts out of prerendering

In some cases, you may want parts of a prerendered page to NOT be prerendered. For example, in TanStack Start, `shellComponent` in `src/routes/__root.tsx` is **always** prerendered at build time into every static HTML file (including `_shell.html`). This shell component includes the navbar, which itself includes things you probably don't want statically inserted into the final HTML build like:

- A signed in user's name and profile picture
- Preferences like dark mode or a user's ward

Data like this is usually stored in objects that shouldn't be read during a prerender anyway (like `window`, `localStorage`, cookies, or logged-in user state).

To avoid prerendering parts of a page, wrap it in a `ClientOnly` component. For example:
```tsx
import { ClientOnly } from "@tanstack/react-router";

export default function NavbarComponent() {
  return (
    <header>
      <nav>
        <Link to="/">Home</Link>
        <Link to="/about">About</Link>

        {/* Never prerendered — mounts only in the browser after hydration */}
        <ClientOnly fallback={<LoadingSpinner />}>
          <LocationSelector />
          <UserAvatarMenu />
        </ClientOnly>
      </nav>
    </header>
  );
}
```

If you wanted to, you could wrap the entire navbar in `ClientOnly` either here or wherever it is you end up using `<NavbarComponent />` to opt the entire navbar out of prerendering.
