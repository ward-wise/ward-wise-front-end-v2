import { NavigationMenu } from "@base-ui/react/navigation-menu";
import { Link } from "@tanstack/react-router";
import ThemeToggle from "../ThemeToggle";
import styles from "./styles.module.css";

interface NavItem {
  label: string;
  to: "/about";
  badge?: string;
}

const NAV_ITEMS: readonly NavItem[] = [
  { label: "Mayor quiz", to: "/about", badge: "NEW" },
  { label: "Map", to: "/about" },
  { label: "Your ward", to: "/about" },
  { label: "Menu money", to: "/about" },
  { label: "Alerts", to: "/about" },
  { label: "Data", to: "/about" },
  { label: "About", to: "/about" },
];

const MORE_ITEMS: readonly NavItem[] = [
  { label: "My index", to: "/about" },
  { label: "Metrics near you", to: "/about" },
  { label: "Index of fifty", to: "/about" },
];

function ChevronDownIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4 6L8 10L12 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Header() {
  return (
    <header className={styles.wrapper}>
      <div className={styles.inner}>
        <Link to="/" className={styles.brand}>
          Ward Wise
        </Link>

        <NavigationMenu.Root className={styles.navRoot} aria-label="Main">
          <NavigationMenu.List className={styles.navList}>
            {NAV_ITEMS.map((item) => (
              <NavigationMenu.Item key={item.label} className={styles.navItem}>
                <NavigationMenu.Link
                  className={styles.navLink}
                  render={<Link to={item.to} />}
                >
                  <span>{item.label}</span>
                  {item.badge ? (
                    <span className={styles.badge}>{item.badge}</span>
                  ) : null}
                </NavigationMenu.Link>
              </NavigationMenu.Item>
            ))}

            <NavigationMenu.Item className={styles.navItem}>
              <NavigationMenu.Trigger className={styles.trigger}>
                <span>More</span>
                <NavigationMenu.Icon className={styles.chevron}>
                  <ChevronDownIcon />
                </NavigationMenu.Icon>
              </NavigationMenu.Trigger>

              <NavigationMenu.Content className={styles.content}>
                <div className={styles.dropdownSection}>
                  <span className={styles.dropdownHeading}>Explore</span>
                  <ul className={styles.dropdownList}>
                    {MORE_ITEMS.map((item) => (
                      <li key={item.label}>
                        <NavigationMenu.Link
                          closeOnClick
                          className={styles.dropdownLink}
                          render={<Link to={item.to} />}
                        >
                          {item.label}
                        </NavigationMenu.Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </NavigationMenu.Content>
            </NavigationMenu.Item>
          </NavigationMenu.List>

          <NavigationMenu.Portal>
            <NavigationMenu.Positioner
              className={styles.positioner}
              sideOffset={8}
              align="start"
              collisionPadding={{ top: 8, bottom: 8, left: 16, right: 16 }}
            >
              <NavigationMenu.Popup className={styles.popup}>
                <NavigationMenu.Viewport className={styles.viewport} />
              </NavigationMenu.Popup>
            </NavigationMenu.Positioner>
          </NavigationMenu.Portal>
        </NavigationMenu.Root>

        <div className={styles.actions}>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
