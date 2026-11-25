import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import { devtools } from "@tanstack/devtools-vite";

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),

    tanstackStart({
      // TanStack Start uses the "/" route by default to render a SPA shell.
      // Because we want the homepage to prerender, we have to manually generate a shell route.
      //
      // src/routes/shell.tsx manually generates this empty route to be
      // used as the SPA shell entry point for dynamic routes.
      // This part of the config uses the /shell route to render the SPA shell to a _shell.html file.
      spa: {
        enabled: true,
        maskPath: "/shell",
        prerender: {
          outputPath: "/_shell.html",
        },
      },

      // Statically prerenders all static routes into individual HTML files for SEO.
      prerender: {
        enabled: true,

        // Automatically render static routes in ./src/routes
        autoSubfolderIndex: true,
        autoStaticPathsDiscovery: true,

        // Disable link crawling so links to dynamic routes do not
        // get statically prerendered at build time.
        crawlLinks: false,
        failOnError: true,
      },
    }),

    viteReact(),
  ],
});

export default config;
