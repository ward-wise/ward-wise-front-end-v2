import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";
import Header from "@/components/Navbar";
import Footer from "@/components/Footer";

import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";

import colorsCss from "@/styles/_colors.css?url";
import variablesCss from "@/styles/_variables.css?url";
import globalsCss from "@/styles/_globals.css?url";

import type { QueryClient } from "@tanstack/react-query";

interface MyRouterContext {
  queryClient: QueryClient;
}

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var theme=(stored==='light'||stored==='dark')?stored:(prefersDark?'dark':'light');var root=document.documentElement;root.classList.toggle('dark',theme==='dark');root.setAttribute('data-theme',theme);root.style.colorScheme=theme;}catch(e){}})();`;

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Ward Wise",
      },
    ],
    links: [
      { rel: "stylesheet", href: colorsCss },
      { rel: "stylesheet", href: variablesCss },
      { rel: "stylesheet", href: globalsCss },
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/** biome-ignore lint/security/noDangerouslySetInnerHtml: recommended approach to avoid theme flashes */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        <div className="root">
          <Header />
          {children}
          <Footer />
        </div>
        <TanStackDevtools
          config={{
            position: "bottom-right",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
            TanStackQueryDevtools,
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
