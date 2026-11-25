# Components

## Styling
This project defines the following CSS:
```
src
 > styles
     _colors.css
     _variables.css
     _globals.css
     Home.css
 > components
  > Button
     index.tsx
     styles.module.css
```

The colors file includes tokens for colors. They should not be used directly in your components' CSS, they should only be used in the variables file.

Your components should use tokens from the variables file. This keeps our components looking consistent.

Styling for pages should go in the `src/styles` directory. Component styles should be along side their source.

The globals file contains some global styles that the entire site uses (like fonts, default site margins, etc). There are also some quick utility classes to make text bold and italic and whatnot.

## Components

This project includes the Base UI package. It includes a lot of prebuilt components that are readily accessible for keyboard uses and screen readers. We'll make use of these components where required. You can see an example of a completed component that makes use of all of this with the Navbar in `src/components/Navbar`.

If you find a Base UI component you need, its good to create it in the `src/components` folder instead of repeatedly importing Base UI components in your pages. That way we can edit them up Ward Wise style and use that in our pages instead. 

You can read more about Base UI, what it does, and its included components here: https://base-ui.com/react/overview/quick-start
