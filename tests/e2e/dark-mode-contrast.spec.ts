import { expect, type Page, test } from "@playwright/test";

test.use({ colorScheme: "dark" });

// Chromium reports computed colors as oklch()/rgb()/hex depending on how the
// value was authored. Rather than chase every serialization, read the
// perceptual lightness (0 = black, 1 = white) from whichever format shows up
// so this stays a lightweight "is this light-on-dark or dark-on-light"
// smoke check, not a full WCAG contrast audit.
function lightnessOf(value: string): number {
  const oklch = value.match(/oklch\(([\d.]+)/);

  if (oklch) {
    return Number(oklch[1]);
  }

  const hex = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  const rgbMatch = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  const [r, g, b] = hex
    ? [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)]
    : rgbMatch
      ? [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])]
      : (() => {
          throw new Error(`Unable to parse color value: ${value}`);
        })();

  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

async function readTextAndBackgroundLightness(page: Page, locator: string) {
  const [color, background] = await page.locator(locator).first().evaluate((element) => {
    let node: Element | null = element;
    let backgroundColor = "rgba(0, 0, 0, 0)";

    while (node) {
      const resolved = getComputedStyle(node).backgroundColor;

      if (resolved && resolved !== "rgba(0, 0, 0, 0)" && resolved !== "transparent") {
        backgroundColor = resolved;
        break;
      }

      node = node.parentElement;
    }

    return [getComputedStyle(element).color, backgroundColor];
  });

  return { textLightness: lightnessOf(color), backgroundLightness: lightnessOf(background) };
}

// A user with no saved appearance preference defaults to theme "system"
// (DEFAULT_USER_PREFERENCES in lib/domain/user-preferences-types.ts,
// shipped 2026-09-07 with Personal Settings/dark mode -- this spec predates
// that by two weeks and was never updated for it). "system" means the app
// deliberately follows the browser's prefers-color-scheme, so with a dark
// browser preference the workspace shell (the .theme-root-scoped content
// area, via app/components/user-display-preferences.tsx) is SUPPOSED to
// render dark -- that is the feature working correctly, not a defect. The
// outer <body> itself sits outside .theme-root and always keeps the base
// light :root tokens (no dark override targets a bare :root), which is why
// its own background stays light even in dark mode; that part of the
// original assertion was accurate and is kept.
test("workspace home follows the default (system) theme into dark mode, with readable contrast", async ({
  page,
}) => {
  await page.goto("/");

  const bodyBackground = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  expect(lightnessOf(bodyBackground)).toBeGreaterThan(0.9);

  const { textLightness, backgroundLightness } = await readTextAndBackgroundLightness(page, "h1");
  expect(backgroundLightness).toBeLessThan(0.2);
  expect(textLightness).toBeGreaterThan(0.85);
});

test("search page text stays readable against its dark background when the browser prefers dark", async ({
  page,
}) => {
  await page.goto("/search");

  await expect(page.getByRole("heading", { name: "Search", exact: true })).toBeVisible();

  const heading = await readTextAndBackgroundLightness(page, "h1");
  expect(heading.backgroundLightness).toBeLessThan(0.2);
  expect(heading.textLightness).toBeGreaterThan(0.85);

  const prompt = await readTextAndBackgroundLightness(page, "text=Enter a search term");
  expect(prompt.backgroundLightness).toBeLessThan(0.2);
  expect(prompt.textLightness).toBeGreaterThan(0.5);
});
