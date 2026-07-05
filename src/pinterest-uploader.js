const path = require("path");
const fs = require("fs/promises");
const { chromium } = require("playwright");
const { config } = require("./config");
const uiLabels = require("./platform-ui-labels");
const {
  getActiveAccount,
  getPlatformProfileDir,
  hasSavedPlatformSession,
} = require("./account-manager");

let loginSessionContext = null;
let loginSessionAccountId = null;

async function openPersistentContext(accountId) {
  const profileDir = await getPlatformProfileDir("pinterest", accountId);
  await fs.mkdir(profileDir, { recursive: true });
  return chromium.launchPersistentContext(profileDir, {
    headless: config.headless,
    viewport: { width: 1400, height: 1000 },
    locale: config.browserLocale,
    timezoneId: config.timezone,
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

async function gotoPinterestHome(page) {
  await page.goto("https://www.pinterest.com", { waitUntil: "domcontentloaded" });
}

async function clickFirstVisibleEnabledLocator(page, locator) {
  const total = await locator.count();
  for (let i = 0; i < total; i += 1) {
    const candidate = locator.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const disabled = await candidate.isDisabled().catch(() => false);
    if (disabled) continue;
    try {
      await candidate.scrollIntoViewIfNeeded({ timeout: 3000 });
      await candidate.click({ timeout: 5000 });
      return true;
    } catch {
      try {
        await candidate.click({ timeout: 5000, force: true });
        return true;
      } catch {
        // continue
      }
    }
  }
  return false;
}

async function navigateToCreatePin(page) {
  // Navigate to the pin creation page directly
  await page.goto("https://www.pinterest.com/pin-builder/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  }).catch(async () => {
    // Fallback: try navigating from home
    await gotoPinterestHome(page);
    await page.waitForTimeout(2000);

    // Click the Create button
    const createButtons = [
      page.getByRole("button", { name: /create|new pin/i }),
      page.locator('[data-test-id="header-create-button"]'),
      page.locator('a[href="/pin-builder/"]'),
    ];
    for (const btn of createButtons) {
      const clicked = await clickFirstVisibleEnabledLocator(page, btn);
      if (clicked) {
        await page.waitForTimeout(2000);
        // Look for "Pin" option in dropdown
        const pinOptions = [
          page.getByRole("button", { name: /pin/i }),
          page.locator('[data-test-id="create-pin-button"]'),
          page.locator('a[href="/pin-builder/"]'),
        ];
        for (const opt of pinOptions) {
          if (await clickFirstVisibleEnabledLocator(page, opt)) {
            await page.waitForTimeout(2000);
            break;
          }
        }
        break;
      }
    }
  });
}

async function setMediaFile(page, mediaPath) {
  const ext = path.extname(mediaPath).toLowerCase();
  const isImage = [".jpg", ".jpeg", ".png", ".gif"].includes(ext);

  // Pinterest uses a file input for both images and videos
  const tryViaFileChooser = async () => {
    const fileInputTrigger = page.locator(
      '[data-test-id="pin-builder-file-input"], ' +
      'input[type="file"], ' +
      '[data-test-id="upload-file-input"], ' +
      'div[role="button"]:has-text("Upload"), ' +
      'div[role="button"]:has-text("Select from computer")'
    ).first();

    const chooserPromise = page
      .waitForEvent("filechooser", { timeout: 5000 })
      .catch(() => null);

    const clicked = await clickFirstVisibleEnabledLocator(page, fileInputTrigger);
    if (!clicked) return false;

    const chooser = await chooserPromise;
    if (chooser) {
      await chooser.setFiles(mediaPath);
      return true;
    }
    return false;
  };

  if (await tryViaFileChooser()) return;

  // Direct fallback to file input
  let fileInput = page.locator('input[type="file"]').first();
  if ((await fileInput.count()) > 0) {
    await fileInput.setInputFiles(mediaPath);
    return;
  }

  await page.waitForTimeout(1500);
  if (await tryViaFileChooser()) return;

  fileInput = page.locator('input[type="file"]').first();
  try {
    await fileInput.waitFor({ state: "attached", timeout: 10000 });
    await fileInput.setInputFiles(mediaPath);
  } catch {
    throw new Error(
      `Could not open Pinterest file picker. Current URL: ${page.url()}`
    );
  }

  // Wait for upload to process
  await page.waitForTimeout(3000);
}

async function setPinTitleAndDescription(page, caption, fileNameStem) {
  const effectiveCaption = caption && caption.trim() ? caption.trim() : "";
  const title = effectiveCaption ? effectiveCaption.split("\n")[0].slice(0, 100) : fileNameStem.slice(0, 100);
  const description = effectiveCaption || config.defaultCaption || "";

  // Pinterest title field
  const titleSelectors = [
    page.locator('[data-test-id="pin-builder-title"] input'),
    page.locator('[data-test-id="pin-builder-title"] textarea'),
    page.locator('input[placeholder*="title" i]'),
    page.locator('textarea[placeholder*="title" i]'),
    page.locator('[placeholder*="Add your title"]'),
    page.locator('input[name="title"]'),
  ];

  let titleSet = false;
  for (const sel of titleSelectors) {
    if ((await sel.count()) === 0) continue;
    try {
      await sel.first().click({ timeout: 3000 });
      await sel.first().fill(title);
      titleSet = true;
      break;
    } catch {
      continue;
    }
  }

  // Pinterest description field
  const descSelectors = [
    page.locator('[data-test-id="pin-builder-description"] textarea'),
    page.locator('textarea[placeholder*="description" i]'),
    page.locator('[placeholder*="Tell your story"]'),
    page.locator('textarea[name="description"]'),
    page.locator('[data-test-id="pin-builder-description"] div[contenteditable="true"]'),
  ];

  let descSet = false;
  if (description) {
    for (const sel of descSelectors) {
      if ((await sel.count()) === 0) continue;
      try {
        await sel.first().click({ timeout: 3000 });
        await sel.first().fill(description);
        descSet = true;
        break;
      } catch {
        continue;
      }
    }
  }

  if (!titleSet) {
    // Non-fatal: Pinterest may auto-generate a title
    console.warn("Could not set Pinterest title field.");
  }

  return { titleSet, descSet };
}

async function setDestinationLink(page, link) {
  if (!link) return false;

  const linkSelectors = [
    page.locator('[data-test-id="pin-builder-link"] input'),
    page.locator('input[placeholder*="link" i]'),
    page.locator('input[placeholder*="website" i]'),
    page.locator('input[name="link"]'),
    page.locator('[data-test-id="pin-builder-destination"] input'),
  ];

  for (const sel of linkSelectors) {
    if ((await sel.count()) === 0) continue;
    try {
      await sel.first().click({ timeout: 3000 });
      await sel.first().fill(link);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function selectBoard(page, boardName) {
  if (!boardName) return false;

  const boardSelectors = [
    page.locator('[data-test-id="board-selector"]'),
    page.locator('[data-test-id="pin-builder-board"]'),
    page.locator('select[name="board"]'),
    page.locator('[placeholder*="board" i]'),
    page.locator('div[role="combobox"]:has-text("Board")'),
  ];

  for (const sel of boardSelectors) {
    if ((await sel.count()) === 0) continue;
    try {
      await sel.first().click({ timeout: 3000 });
      await page.waitForTimeout(500);
      // Try selecting by option text
      const option = page.locator(`[role="option"]:has-text("${boardName}"), option:has-text("${boardName}")`).first();
      if ((await option.count()) > 0) {
        await option.click();
        await page.waitForTimeout(500);
        return true;
      }
      break;
    } catch {
      continue;
    }
  }
  return false;
}

async function publishPin(page) {
  const publishSelectors = [
    page.locator('[data-test-id="pin-builder-publish-button"]'),
    page.locator('button:has-text("Publish")'),
    page.locator('button:has-text("Save")'),
    page.locator('button:has-text("Upload")'),
    page.locator('[data-test-id="create-pin-button"]'),
  ];

  for (const sel of publishSelectors) {
    const clicked = await clickFirstVisibleEnabledLocator(page, sel);
    if (clicked) {
      await page.waitForTimeout(3000);
      return true;
    }
  }
  return false;
}

async function waitForPublishConfirmation(page) {
  for (let i = 0; i < 30; i += 1) {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (/pin created|pin saved|successfully|published/i.test(bodyText)) {
      return { ok: true };
    }
    if (/error|something went wrong/i.test(bodyText) && i > 5) {
      return { ok: false, reason: "Pinterest reported an error while publishing." };
    }
    // Check if we were redirected away from pin-builder (success signal)
    if (!page.url().includes("pin-builder") && i > 3) {
      return { ok: true };
    }
    await page.waitForTimeout(1500);
  }
  return { ok: false, reason: "No reliable Pinterest publish confirmation within timeout." };
}

async function startLoginSession() {
  const activeAccount = await getActiveAccount();
  if (loginSessionContext && loginSessionAccountId !== activeAccount.id) {
    const previous = loginSessionContext;
    loginSessionContext = null;
    loginSessionAccountId = null;
    await previous.close().catch(() => {});
  }

  if (loginSessionContext) {
    return { ok: true, alreadyOpen: true };
  }
  const context = await openPersistentContext(activeAccount.id);
  const page = context.pages()[0] || (await context.newPage());
  loginSessionContext = context;
  loginSessionAccountId = activeAccount.id;
  context.on("close", () => {
    if (loginSessionContext === context) {
      loginSessionContext = null;
      loginSessionAccountId = null;
    }
  });
  await gotoPinterestHome(page);
  return { ok: true, alreadyOpen: false, url: page.url() };
}

async function getLoginSessionStatus() {
  const activeAccount = await getActiveAccount();
  const saved = await hasSavedPlatformSession("pinterest", activeAccount.id);
  return {
    open: Boolean(loginSessionContext) && loginSessionAccountId === activeAccount.id,
    saved,
  };
}

async function closeLoginSession() {
  if (!loginSessionContext) {
    return { ok: true, alreadyClosed: true };
  }
  const context = loginSessionContext;
  loginSessionContext = null;
  loginSessionAccountId = null;
  await context.close().catch(() => {});
  return { ok: true, alreadyClosed: false };
}

async function uploadPin({ mediaPath, caption, accountId, boardName, destinationLink }) {
  const absoluteMediaPath = path.resolve(mediaPath);
  const context = await openPersistentContext(accountId);
  const page = context.pages()[0] || (await context.newPage());
  let closeHoldMs = 0;
  try {
    await navigateToCreatePin(page);
    await page.waitForTimeout(2000);

    // Upload the media file
    await setMediaFile(page, absoluteMediaPath);

    // Wait for Pinterest to process the upload
    await page.waitForTimeout(Math.max(config.postDelayMs, 5000));

    // Set title and description
    await setPinTitleAndDescription(page, caption, path.parse(absoluteMediaPath).name);

    // Set destination link if provided
    if (destinationLink) {
      await setDestinationLink(page, destinationLink);
    }

    // Select board if specified
    if (boardName) {
      await selectBoard(page, boardName);
    }

    // Publish
    const published = await publishPin(page);
    if (!published) {
      throw new Error("Could not find/click Pinterest publish button.");
    }

    const confirmation = await waitForPublishConfirmation(page);
    if (!confirmation.ok) {
      throw new Error(confirmation.reason);
    }

    const successScreenshotPath = path.resolve(
      config.projectRoot,
      "last-pinterest-upload-success.png"
    );
    await page.screenshot({ path: successScreenshotPath, fullPage: true }).catch(() => {});
    closeHoldMs = Math.max(config.postPublishHoldMs, 0);
    return { ok: true, board: boardName };
  } catch (error) {
    const screenshotPath = path.resolve(
      config.projectRoot,
      "last-pinterest-upload-error.png"
    );
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    closeHoldMs = Math.max(config.failureHoldMs, 0);
    return {
      ok: false,
      error: error.message,
      screenshotPath,
    };
  } finally {
    await page.waitForTimeout(closeHoldMs).catch(() => {});
    await context.close();
  }
}

module.exports = {
  uploadPin,
  startLoginSession,
  getLoginSessionStatus,
  closeLoginSession,
};
