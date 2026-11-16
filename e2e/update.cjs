// Ouvre l'appli (version A), publie une version B, simule le retour à l'écran : l'appli doit se recharger en B.
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');
const { chromium } = require('playwright');

const out = process.argv[2];
const APP = 'http://127.0.0.1:4174/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: 'fr-FR', timezoneId: 'Europe/Paris' })).newPage();
  const version = async () => {
    try {
      return await page.locator('[data-testid=version]').innerText({ timeout: 1000 });
    } catch {
      return '';
    }
  };

  await page.goto(APP);
  await page.locator('[data-testid=version]').waitFor({ timeout: 15000 });
  const a = await version();
  assert.match(a, /1 janv\. à 11:00/, 'version A attendue, lue : ' + a);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
  console.log('  ✓ version A installée : ' + a);

  // Une nouvelle version est publiée pendant que l'appli reste ouverte.
  execSync(`npx vite build --outDir "${out}/dist" --emptyOutDir`, { env: { ...process.env, BUILD_STAMP: '2026-02-02T10:00:00.000Z' }, stdio: 'ignore' });
  await sleep(1500);
  assert.equal(await version(), a, "sans retour à l'écran, l'appli ne doit pas avoir bougé");

  // L'appli revient à l'écran (réouverture depuis l'écran d'accueil).
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  let b = a;
  for (let i = 0; i < 60 && (b === a || !b); i++) {
    await sleep(500);
    b = await version();
  }
  assert.match(b, /2 févr\. à 11:00/, "l'appli devait se recharger dans la nouvelle version, lue : " + b);
  console.log('  ✓ au retour à l\'écran, l\'appli est passée seule à la version B : ' + b);

  await browser.close();
  console.log('Mise à jour automatique : OK');
})().catch((e) => {
  console.error('\nÉCHEC : ' + (e && e.message ? e.message : e));
  process.exit(1);
});
