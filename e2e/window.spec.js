// End-to-end: window size/position memory and the answer/transcript divider.
// Each test launches the real app with its own empty profile (--user-data-dir),
// so nothing touches the user's real settings, resume or window position.
const base = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { expect, _electron: electron } = base;
const ROOT = path.join(__dirname, '..');
const DEFAULT = { width: 460, height: 680 };
const MIN_PANEL_PX = 80; // same as src/renderer/split.js
const BORDER_ALLOWANCE = 4; // section borders are inside the measured box
const TOLERANCE_PX = 1;

// ---------- page object ----------

class CopilotApp {
  static async launch(profileDir) {
    const app = await electron.launch({ args: [ROOT, `--user-data-dir=${profileDir}`], cwd: ROOT });
    const page = await app.firstWindow();
    await page.locator('#splitter').waitFor({ state: 'attached' });
    return new CopilotApp(app, page);
  }

  constructor(app, page) {
    this.app = app;
    this.page = page;
    this.closed = false;
    this.splitter = page.locator('#splitter');
    this.answer = page.locator('section.answer');
    this.transcript = page.locator('section.transcript');
  }

  bounds() {
    return this.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  }

  setBounds(b) {
    return this.app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), b);
  }

  workArea() {
    return this.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  }

  async storedSplit() {
    return Number(await this.page.evaluate(() => localStorage.getItem('answerSplit')));
  }

  async panelHeights() {
    const [a, t] = await Promise.all([this.answer.boundingBox(), this.transcript.boundingBox()]);
    return { answer: a.height, transcript: t.height };
  }

  async dragSplitterBy(dy) {
    const box = await this.splitter.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this.page.mouse.move(x, y);
    await this.page.mouse.down();
    await this.page.mouse.move(x, y + dy, { steps: 8 });
    await this.page.mouse.up();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.app.close();
  }
}

// ---------- fixtures: a temp profile, and apps that are always closed ----------

const test = base.test.extend({
  profile: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-e2e-'));
    await use(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },
  launchApp: async ({ profile }, use) => {
    const launched = [];
    await use(async () => {
      const app = await CopilotApp.launch(profile);
      launched.push(app);
      return app;
    });
    for (const app of launched) await app.close().catch(() => {});
  },
});

const writeState = (dir, data) => fs.writeFileSync(path.join(dir, 'window-state.json'), typeof data === 'string' ? data : JSON.stringify(data));
const inside = (b, area) => b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height;

function expectBoundsClose(actual, wanted) {
  for (const k of ['x', 'y', 'width', 'height']) {
    expect(Math.abs(actual[k] - wanted[k]), `${k}: ${actual[k]} vs ${wanted[k]}`).toBeLessThanOrEqual(TOLERANCE_PX);
  }
}

// ---------- window size and position ----------

test.describe('window size and position', () => {
  test('first launch uses the default size, fully on screen', async ({ launchApp }) => {
    const app = await launchApp();
    const b = await app.bounds();
    expect({ width: b.width, height: b.height }).toEqual(DEFAULT);
    expect(inside(b, await app.workArea())).toBe(true);
  });

  test('size and position are restored after a restart', async ({ launchApp, profile }) => {
    let app = await launchApp();
    const area = await app.workArea();
    const wanted = { x: area.x + 40, y: area.y + 30, width: Math.min(520, area.width - 80), height: Math.min(640, area.height - 60) };
    await app.setBounds(wanted);
    await expect.poll(async () => {
      const b = await app.bounds();
      return Math.max(...['x', 'y', 'width', 'height'].map((k) => Math.abs(b[k] - wanted[k])));
    }).toBeLessThanOrEqual(TOLERANCE_PX);
    const before = await app.bounds();
    await app.close();

    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'window-state.json'), 'utf8'));
    expectBoundsClose(saved, before);

    app = await launchApp();
    expectBoundsClose(await app.bounds(), before);
  });

  test('a window saved on a screen that is gone opens on the main screen', async ({ launchApp, profile }) => {
    writeState(profile, { x: -9000, y: -9000, width: 500, height: 700 });
    const app = await launchApp();
    const b = await app.bounds();
    expect(inside(b, await app.workArea())).toBe(true);
    expect({ width: b.width, height: b.height }).toEqual(DEFAULT);
  });

  test('a damaged state file is ignored', async ({ launchApp, profile }) => {
    writeState(profile, '{"x": "left", oops');
    const app = await launchApp();
    const b = await app.bounds();
    expect({ width: b.width, height: b.height }).toEqual(DEFAULT);
  });
});

// ---------- answer / transcript divider ----------

test.describe('answer and transcript divider', () => {
  test('dragging the divider down gives the answer more room, and it is remembered', async ({ launchApp }) => {
    let app = await launchApp();
    const before = await app.panelHeights();
    await app.dragSplitterBy(120);
    const after = await app.panelHeights();
    expect(after.answer).toBeGreaterThan(before.answer + 80);
    expect(after.transcript).toBeLessThan(before.transcript - 80);
    await app.close();

    app = await launchApp();
    await expect(app.splitter).toHaveAttribute('aria-valuenow', String(Math.round((await app.storedSplit()) * 100)));
    // The setup checks finish just after launch; wait for the layout to settle.
    await expect.poll(async () => Math.abs((await app.panelHeights()).answer - after.answer)).toBeLessThanOrEqual(2);
  });

  test('neither panel can be dragged away', async ({ launchApp }) => {
    const app = await launchApp();
    await app.dragSplitterBy(2000);
    expect((await app.panelHeights()).transcript).toBeGreaterThanOrEqual(MIN_PANEL_PX - BORDER_ALLOWANCE);
    await app.dragSplitterBy(-4000);
    expect((await app.panelHeights()).answer).toBeGreaterThanOrEqual(MIN_PANEL_PX - BORDER_ALLOWANCE);
  });

  test('arrow keys adjust the divider and double-click resets it', async ({ launchApp }) => {
    const app = await launchApp();
    await expect(app.splitter).toHaveAttribute('aria-valuenow', '60');
    await app.splitter.focus();
    await app.page.keyboard.press('ArrowUp');
    await app.page.keyboard.press('ArrowUp');
    await expect(app.splitter).toHaveAttribute('aria-valuenow', '50');
    await app.page.keyboard.press('ArrowDown');
    await expect(app.splitter).toHaveAttribute('aria-valuenow', '55');
    await app.splitter.dblclick();
    await expect(app.splitter).toHaveAttribute('aria-valuenow', '60');
  });

  test('arrow keys respect the minimum panel height in a short window', async ({ launchApp }) => {
    const app = await launchApp();
    const b = await app.bounds();
    await app.setBounds({ ...b, height: 300 });
    await expect.poll(async () => (await app.bounds()).height).toBe(300);
    await app.splitter.focus();
    for (let i = 0; i < 12; i++) await app.page.keyboard.press('ArrowUp');
    expect((await app.panelHeights()).answer).toBeGreaterThanOrEqual(MIN_PANEL_PX - BORDER_ALLOWANCE);
  });

  test('the divider is announced as a separator with both panel sizes', async ({ launchApp }) => {
    const app = await launchApp();
    const separator = app.page.getByRole('separator', { name: 'Resize the answer and transcript panels' });
    await expect(separator).toBeVisible();
    await expect(separator).toHaveAttribute('aria-valuetext', 'Answer 60%, transcript 40%');
  });

  test('right-click does not start a drag', async ({ launchApp }) => {
    const app = await launchApp();
    const before = await app.panelHeights();
    const box = await app.splitter.boundingBox();
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.page.mouse.down({ button: 'right' });
    await app.page.mouse.move(box.x + box.width / 2, box.y + 150, { steps: 5 });
    await app.page.mouse.up({ button: 'right' });
    expect((await app.panelHeights()).answer).toBeCloseTo(before.answer, 0);
  });
});
