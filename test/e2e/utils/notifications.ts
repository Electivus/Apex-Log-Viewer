import type { Page } from '@playwright/test';
import { runCommand } from './commandPalette';

const notificationSelectors = ['.notifications-toasts .notification-list-item', '.notifications-center .notification-list-item'];
const notificationCloseSelectors = [
  '.notifications-toasts .notification-list-item [aria-label*="Hide Notification"]',
  '.notifications-toasts .notification-list-item [aria-label*="Clear Notification"]',
  '.notifications-toasts .notification-list-item [aria-label*="Close"]',
  '.notifications-toasts .notification-list-item .codicon-close',
  '.notifications-center .notification-list-item [aria-label*="Hide Notification"]',
  '.notifications-center .notification-list-item [aria-label*="Clear Notification"]',
  '.notifications-center .notification-list-item [aria-label*="Close"]',
  '.notifications-center .notification-list-item .codicon-close'
];

async function countVisibleNotifications(page: Page): Promise<number> {
  return await page.evaluate(selectors => {
    const isVisible = (node: Element): boolean => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };

    return selectors
      .flatMap(selector => Array.from(document.querySelectorAll(selector)))
      .filter(node => isVisible(node))
      .length;
  }, notificationSelectors);
}

async function clickVisibleNotificationCloseButton(page: Page): Promise<boolean> {
  return await page.evaluate(selectors => {
    const isVisible = (node: Element): boolean => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };

    for (const selector of selectors) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        if (!isVisible(node)) {
          continue;
        }
        if (node instanceof HTMLElement) {
          node.click();
          return true;
        }
      }
    }

    return false;
  }, notificationCloseSelectors);
}

export async function closeQuickInputIfOpen(page: Page): Promise<void> {
  const widget = page.locator('div.quick-input-widget');
  const visible = await widget.isVisible().catch(() => false);
  if (!visible) {
    return;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await widget.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => {});
}

export async function dismissAllNotifications(page: Page, options?: { timeoutMs?: number }): Promise<void> {
  const deadline = Date.now() + (options?.timeoutMs ?? 5_000);

  while (Date.now() < deadline) {
    const visibleCount = await countVisibleNotifications(page).catch(() => 0);
    if (visibleCount === 0) {
      return;
    }

    let acted = false;

    try {
      await runCommand(page, 'Notifications: Clear All Notifications');
      await closeQuickInputIfOpen(page);
      acted = true;
    } catch {
      // Fall through to direct interaction.
    }

    if (!acted) {
      acted = await clickVisibleNotificationCloseButton(page).catch(() => false);
    }

    if (!acted) {
      await page.keyboard.press('Escape').catch(() => {});
    }

    await page.waitForTimeout(150);
  }

  await closeQuickInputIfOpen(page);
}
