/* Headless verification: load the app in real Chrome, wait for live data,
 * screenshot map mode and AR mode. */
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--window-size=900,900', '--use-fake-ui-for-media-stream'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 900 });
  page.on('console', m => console.log('[page]', m.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));

  await page.goto('http://localhost:8000', { waitUntil: 'networkidle2' });

  // wait for first successful board fetch
  await page.waitForFunction('lastFetch > 0', { timeout: 30000 });
  const state = await page.evaluate(() => ({
    mode,
    trains: trains.size,
    fetchError,
    active: activeTrains(Date.now()).map(t =>
      `${t.badge} -> ${t.to} | ${t.corridor} ${t.dir} ${Math.round(t.frac * 100)}% ${Math.round(t.depth)}m`),
  }));
  console.log('STATE', JSON.stringify(state, null, 1));

  // map screenshot
  await page.evaluate(() => map && map.setView([47.385, 8.55], 14));
  await new Promise(r => setTimeout(r, 3000)); // let tiles load
  await page.screenshot({ path: 'shot_map.png' });
  console.log('map screenshot saved');

  // AR mode (no sensors in headless -> mouse-look fallback, simulated position)
  await page.evaluate(() => { document.getElementById('btn-ar').click(); });
  await new Promise(r => setTimeout(r, 1500));
  // look north-down a bit toward the tunnels
  await page.evaluate(() => { mouseLook.yaw = 3.14; mouseLook.pitch = -0.35; });
  await new Promise(r => setTimeout(r, 500));
  const arState = await page.evaluate(() => ({
    mode, arBuilt, sceneChildren: scene ? scene.children.length : 0,
    trainMeshes: trainMeshes.size,
  }));
  console.log('AR STATE', JSON.stringify(arState));
  await page.screenshot({ path: 'shot_ar.png' });
  console.log('ar screenshot saved');

  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
