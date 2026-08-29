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

test("workspace home stays on the light theme when the browser prefers dark", async ({
  page,
}) => {
  await page.goto("/");

  const bodyBackground = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  );
  expect(lightnessOf(bodyBackground)).toBeGreaterThan(0.9);

  const { textLightness, backgroundLightness } = await readTextAndBackgroundLightness(page, "h1");
  expect(backgroundLightness).toBeGreaterThan(0.85);
  expect(textLightness).toBeLessThan(0.3);
});

test("search page text stays readable against its background when the browser prefers dark", async ({
  page,
}) => {
  await page.goto("/search");

  await expect(page.getByRole("heading", { name: "Search", exact: true })).toBeVisible();

  const heading = await readTextAndBackgroundLightness(page, "h1");
  expect(heading.backgroundLightness).toBeGreaterThan(0.85);
  expect(heading.textLightness).toBeLessThan(0.3);

  const prompt = await readTextAndBackgroundLightness(page, "text=Enter a search term");
  expect(prompt.backgroundLightness).toBeGreaterThan(0.85);
  expect(prompt.textLightness).toBeLessThan(0.6);
});
