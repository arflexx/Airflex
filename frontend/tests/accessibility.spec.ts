import { test, expect } from '@playwright/test';
import AxeBuilder from 'axe-playwright';

const routes = [
  '/',
  '/auth/signup',
  '/auth/verify',
  '/profile',
  '/sell',
  '/trades',
  '/wallet'
];

for (const route of routes) {
  test(`${route} should not have any accessibility violations`, async ({ page }) => {
    await page.goto(route);
    
    // Wait for page to be fully loaded
    await page.waitForLoadState('networkidle');
    
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();

    expect(accessibilityScanResults.violations).toEqual([]);
  });
}

// Test color contrast in dark mode
for (const route of routes) {
  test(`${route} should not have color contrast violations in dark mode`, async ({ page }) => {
    // Set dark mode
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(route);
    
    // Wait for page to be fully loaded
    await page.waitForLoadState('networkidle');
    
    const accessibilityScanResults = await new AxeBuilder({ page })
      .withTags(['wcag2aa'])
      .include(['color-contrast'])
      .analyze();

    expect(accessibilityScanResults.violations).toEqual([]);
  });
}

// Test keyboard navigation
test('should support keyboard navigation on interactive elements', async ({ page }) => {
  await page.goto('/');
  
  // Find all focusable elements
  const focusableElements = await page.locator(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ).all();
  
  for (const element of focusableElements) {
    await element.focus();
    // Check if element is visibly focused
    const isFocused = await element.evaluate((el) => el === document.activeElement);
    expect(isFocused).toBe(true);
  }
});

// Test aria-live regions for dynamic content
test('should announce dynamic content changes to screen readers', async ({ page }) => {
  await page.goto('/');
  
  // Check for aria-live regions
  const ariaLiveRegions = await page.locator('[aria-live]').count();
  
  // We expect at least one aria-live region for dynamic content announcements
  expect(ariaLiveRegions).toBeGreaterThan(0);
});