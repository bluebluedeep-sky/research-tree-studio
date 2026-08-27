import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.RTS_MOBILE_FILE
  ? path.resolve(process.env.RTS_MOBILE_FILE)
  : path.join(root, "dist", "Research-Tree-Mobile-Demo.html");
const artifacts = path.join(root, "test-artifacts");
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
fs.mkdirSync(artifacts, { recursive: true });

const html = fs.readFileSync(target, "utf8");
if (/sk-[a-zA-Z0-9]{20,}/.test(html)) throw new Error("手机版中疑似包含 API Key。");
if (/AppData|codex-clipboard|vd_source/i.test(html)) throw new Error("手机版中疑似包含个人路径或个人参数。");

const browser = await chromium.launch({ executablePath: edge, headless: true });
const errors = [];
try {
  for (const device of [
    { name: "android", viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 },
    { name: "iphone", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }
  ]) {
    const context = await browser.newContext({ viewport: device.viewport, deviceScaleFactor: device.deviceScaleFactor, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(`${device.name}: ${error.message}`));
    console.log(`${device.name}: loading`);
    await page.goto(pathToFileURL(target).href, { waitUntil: "domcontentloaded", timeout: 12000 });
    const baseMapWidth = await page.evaluate(() => Number(document.getElementById("research-map").getAttribute("width")));
    const scrollerBox = await page.locator("#map-scroller").boundingBox();
    const client = await context.newCDPSession(page);
    const centerX = scrollerBox.x + Math.min(scrollerBox.width / 2, 210);
    const centerY = Math.min(device.viewport.height - 55, scrollerBox.y + 120);
    const touchPoint = (id, x, y) => ({ id, x, y, radiusX: 5, radiusY: 5, force: 1 });
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint(0, centerX - 34, centerY), touchPoint(1, centerX + 34, centerY)] });
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [touchPoint(0, centerX - 82, centerY), touchPoint(1, centerX + 82, centerY)] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(100);
    const touchZoom = await page.evaluate(() => ({ width: Number(document.getElementById("research-map").getAttribute("width")), label: document.getElementById("zoom-indicator").textContent }));
    if (touchZoom.width <= baseMapWidth || touchZoom.label === "100%") throw new Error(`${device.name}: 双指缩放没有改变树的比例。`);
    await page.locator("#zoom-indicator").dispatchEvent("click");
    await page.locator('.paper-node[data-paper-id="system-0"]').dispatchEvent("click");
    await page.locator('.paper-node[data-paper-id="system-1"]').dispatchEvent("click");
    const result = await page.evaluate(() => ({
      nodes: document.querySelectorAll(".paper-node").length,
      relations: document.querySelectorAll(".relation").length,
      locked: document.querySelectorAll(".paper-node.locked").length,
      highlighted: document.querySelectorAll(".relation.highlighted").length,
      readerOpen: document.getElementById("reader").classList.contains("open"),
      relationCards: document.querySelectorAll(".relation-card").length,
      horizontalScroll: document.getElementById("map-scroller").scrollWidth > document.getElementById("map-scroller").clientWidth,
      viewportOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      title: document.getElementById("reader-title").textContent
    }));
    if (result.nodes !== 36 || result.relations !== 27) throw new Error(`${device.name}: 树数据数量不正确。`);
    if (result.locked !== 2 || !result.readerOpen || !result.relationCards || !result.highlighted) throw new Error(`${device.name}: 触屏选定或关系详情未正常工作。`);
    if (!result.horizontalScroll || result.viewportOverflow) throw new Error(`${device.name}: 树滚动或页面宽度不符合手机布局。`);
    await page.screenshot({ path: path.join(artifacts, `mobile-share-${device.name}.png`), fullPage: false });
    console.log(JSON.stringify({ device: device.name, touchZoom: touchZoom.label, ...result }));
    await context.close();
  }
} finally {
  await browser.close();
}

if (errors.length) throw new Error(errors.join("\n"));
