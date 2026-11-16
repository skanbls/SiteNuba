// Parcours complet joué dans un vrai navigateur contre la base locale :
// le gérant s'inscrit, compose l'équipe, crée la borne ; un équipier s'inscrit et pointe avec le code de la borne.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

const APP = 'http://127.0.0.1:4173/';
const SHOTS = 'e2e/.out/shots';
const PW = 'motdepasse123';
const errors = [];

async function main() {
  const browser = await chromium.launch();
  const open = async (name, viewport, extra = {}) => {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'fr-FR', timezoneId: 'Europe/Paris', serviceWorkers: 'block', acceptDownloads: true, ...extra });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${name} console: ${m.text()}`));
    return page;
  };
  const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const noOverflow = async (page, where) => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `${where} : la page déborde de ${over}px en largeur`);
  };
  const signup = async (page, name, email) => {
    await page.goto(APP);
    await page.getByRole('button', { name: 'Créer mon compte' }).click();
    await page.fill('#login-name', name);
    await page.fill('#login-email', email);
    await page.fill('#login-pw', PW);
    await page.locator('form button').click();
  };
  const see = (page, text) => page.getByText(text, { exact: false }).first().waitFor({ timeout: 8000 });
  const step = (s) => console.log('  ✓ ' + s);

  // 1. Le premier compte devient gérant.
  const boss = await open('gérant', { width: 1180, height: 820 });
  await boss.goto(APP);
  await see(boss, "Connecte-toi pour accéder à l'appli");
  await shot(boss, '01-connexion');
  await signup(boss, 'Sam', 'boss@nuba.test');
  await see(boss, 'Bonjour Sam');
  await see(boss, 'Pas encore pointé');
  step('le premier compte devient gérant');

  // 2. Il compose l'équipe.
  await boss.goto(APP + '#/equipe');
  for (const [first, last, email, role, job, hours] of [['Théo', 'Martin', 'Theo@Nuba.test', 'equipier', 'Serveur', '30'], ['Inès', 'Durand', 'ines@nuba.test', 'responsable', 'Responsable salle', '35']]) {
    await boss.getByRole('button', { name: 'Ajouter' }).click();
    await boss.fill('#m-first', first);
    await boss.fill('#m-last', last);
    await boss.fill('#m-email', email);
    await boss.selectOption('#m-role', role);
    await boss.fill('#m-job', job);
    await boss.fill('#m-hours', hours);
    await boss.getByRole('button', { name: 'Enregistrer' }).click();
    await see(boss, `${first} ${last}`);
  }
  await see(boss, "En attente d'inscription");
  await boss.getByRole('button', { name: 'Ajouter' }).click();
  await boss.fill('#m-first', 'Doublon');
  await boss.fill('#m-email', 'theo@nuba.test');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, "a déjà cette adresse e-mail");
  await boss.getByRole('button', { name: 'Fermer' }).click();
  await shot(boss, '02-equipe');
  step("le gérant compose l'équipe, les doublons d'adresse sont refusés");

  // 3. Il crée la borne et récupère son lien.
  await boss.goto(APP + '#/reglages');
  await boss.getByRole('button', { name: 'Ajouter une borne' }).click();
  await boss.getByRole('button', { name: 'Créer la borne' }).click();
  await see(boss, 'Borne créée');
  const kioskLink = await boss.inputValue('#kiosk-link');
  assert.match(kioskLink, /#\/borne\?t=[0-9a-f]{64}$/);
  await shot(boss, '03-borne-creee');
  await boss.getByRole('button', { name: 'Fermer' }).click();
  await see(boss, 'iPad du bar');
  step('le gérant crée la borne');

  // 4. L'iPad ouvre le lien : il affiche le code, sans compte, et le jeton quitte la barre d'adresse.
  const ipad = await open('borne', { width: 1024, height: 768 });
  await ipad.goto(kioskLink);
  await see(ipad, 'Scanne ce code pour pointer');
  const code = () => ipad.locator('[data-testid=code]').innerText();
  assert.match(await code(), /^\d{6}$/);
  assert.ok(!ipad.url().includes('t='), "le jeton doit disparaître de l'adresse");
  await see(ipad, 'La Nuba');
  await shot(ipad, '04-borne-ipad');
  step('la borne affiche le QR code sans compte');

  // 4 bis. Appli installée sur l'iPad (mémoire séparée de Safari) : on relie la borne depuis l'écran de connexion,
  // puis l'appli s'ouvre directement sur la borne à chaque lancement.
  const installed = await open('iPad installé', { width: 1024, height: 768 });
  await installed.goto(APP);
  await installed.getByRole('link', { name: 'Cet appareil est une borne de pointage' }).click();
  await see(installed, 'Relier cette borne');
  await see(installed, 'Caméra indisponible');   // pas de caméra dans le navigateur de test : on colle le lien
  await installed.fill('#pair-link', 'https://exemple.fr/menu.pdf');
  await installed.getByRole('button', { name: 'Relier' }).click();
  await see(installed, "Ce n'est pas le QR code d'une borne");
  await shot(installed, '04b-relier-borne');
  await installed.waitForTimeout(100);
  await installed.fill('#pair-link', kioskLink);
  await installed.getByRole('button', { name: 'Relier' }).click();
  await see(installed, 'Scanne ce code pour pointer');
  await installed.goto('about:blank');
  await installed.goto(APP);                      // relance de l'appli : directement la borne
  await see(installed, 'Scanne ce code pour pointer');
  await installed.getByRole('button', { name: "Ouvrir l'appli sur cet appareil" }).click();
  await see(installed, "Connecte-toi pour accéder à l'appli");
  await installed.getByRole('link', { name: 'Revenir à la borne de pointage' }).click();
  await see(installed, 'Scanne ce code pour pointer');
  step("l'appli installée se relie à la borne et s'ouvre directement dessus");

  // 5. Théo s'inscrit avec l'adresse enregistrée : son compte se rattache à sa fiche.
  const theo = await open('équipier', { width: 390, height: 844 });
  await signup(theo, 'Peu importe', 'theo@nuba.test');
  await see(theo, 'Bonjour Théo');
  assert.equal(await theo.getByRole('link', { name: 'Équipe' }).count(), 0, "un équipier ne doit pas voir l'onglet Équipe");
  await noOverflow(theo, 'accueil équipier');
  await shot(theo, '05-accueil-equipier');
  step('un équipier se rattache à sa fiche et ne voit pas les écrans du gérant');

  // 6. Arrivée : mauvais code refusé, bon code accepté.
  await theo.goto(APP + '#/pointeuse');
  await theo.getByRole('button', { name: 'Pointer mon arrivée' }).click();
  await see(theo, 'Caméra indisponible');   // pas de caméra dans le navigateur de test : repli sur la saisie
  const good = await code();
  const wrong = String((Number(good) + 1) % 1000000).padStart(6, '0');
  await theo.fill('input.code', wrong);
  await theo.getByRole('dialog').getByRole('button', { name: 'Pointer mon arrivée' }).click();
  await see(theo, 'Code refusé');
  await shot(theo, '06-code-refuse');
  await theo.waitForTimeout(2600);
  await theo.fill('input.code', await code());
  await theo.getByRole('dialog').getByRole('button', { name: 'Pointer mon arrivée' }).click();
  await see(theo, 'Arrivée pointée');
  await see(theo, 'En service');
  await noOverflow(theo, 'pointeuse équipier');
  await shot(theo, '07-en-service');
  step('un mauvais code est refusé, le bon code pointe l\'arrivée');

  // 7. Pause puis reprise.
  await theo.getByRole('button', { name: 'Commencer ma pause' }).click();
  await see(theo, 'En pause');
  await theo.getByRole('button', { name: 'Reprendre le service' }).click();
  await see(theo, 'Service repris');
  step('pause et reprise');

  // 8. Le gérant voit Théo présent.
  await boss.goto(APP + '#/');
  await see(boss, 'Théo Martin');
  await shot(boss, '08-accueil-gerant');
  step('le gérant voit qui est présent');

  // 9. Départ par le lien du QR code (comme un scan avec l'appareil photo du téléphone).
  const qrLink = await ipad.locator('.qr').getAttribute('data-link');
  assert.match(qrLink, /#\/pointer\?s=[0-9a-f-]{36}&c=\d{6}$/);
  await theo.goto(qrLink);
  await see(theo, 'La Nuba');
  await theo.getByRole('button', { name: 'Pointer mon départ' }).click();
  await see(theo, 'Départ pointé');
  await see(theo, 'Pas pointé');
  await shot(theo, '09-apres-depart');
  step('le lien du QR code pointe le départ');

  // 10. Un inconnu reste à la porte.
  const intrus = await open('inconnu', { width: 390, height: 844 });
  await signup(intrus, 'Intrus', 'intrus@ailleurs.test');
  await see(intrus, 'Compte en attente');
  await shot(intrus, '10-compte-en-attente');
  step("un compte sans fiche d'équipe n'entre pas");

  // 11. Le gérant corrige le pointage de Théo, en ajoute un pour Inès, puis exporte.
  await boss.goto(APP + '#/pointeuse');
  await boss.getByRole('button', { name: 'Équipe' }).click();
  await boss.locator('button.row', { hasText: 'Théo Martin' }).first().click();
  await see(boss, 'Corriger le pointage');
  await boss.fill('#entry-break', '0');
  await boss.fill('#entry-note', 'Vérifié');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Pointage corrigé');
  await boss.getByRole('button', { name: 'Ajouter un pointage' }).click();
  await boss.selectOption('#entry-who', { label: 'Inès Durand' });
  const d = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await boss.fill('#entry-in', `${d}T17:00`);
  await boss.fill('#entry-out', `${d}T16:00`);
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Le départ est avant');
  await boss.fill('#entry-out', `${d}T23:30`);
  await boss.fill('#entry-break', '30');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Pointage ajouté');
  await see(boss, 'Saisie manuelle');
  await see(boss, '6 h 00');
  const [download] = await Promise.all([boss.waitForEvent('download'), boss.getByRole('button', { name: 'Exporter pour le comptable' }).click()]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  assert.ok(csv.startsWith('﻿Nom;Date;Arrivée'), "l'export doit commencer par les en-têtes");
  assert.match(csv, /Inès Durand;[^\n]*;17:00;23:30;30;6 h 00;6;La Nuba;Manuelle/);
  assert.match(csv, /Théo Martin;[^\n]*;QR code;Vérifié/);
  assert.match(csv, /Total par personne/);
  await shot(boss, '11-pointages-equipe');
  step('le gérant corrige, ajoute et exporte les heures');

  // 12. Une responsable voit l'équipe et peut afficher le QR code, mais ne corrige pas.
  const ines = await open('responsable', { width: 820, height: 1180 });
  await signup(ines, 'Inès', 'ines@nuba.test');
  await see(ines, 'Bonjour Inès');
  await ines.goto(APP + '#/pointeuse');
  await ines.getByRole('button', { name: 'Équipe' }).click();
  await see(ines, 'Théo Martin');
  assert.equal(await ines.getByRole('button', { name: 'Ajouter un pointage' }).count(), 0, 'une responsable ne doit pas ajouter de pointage');
  await ines.getByRole('button', { name: 'Afficher le QR code' }).click();
  await ines.locator('[data-testid=code]').waitFor();
  await shot(ines, '12-qr-responsable');
  await ines.goto(APP + '#/equipe');
  await see(ines, 'Bonjour Inès');   // écran réservé au gérant : retour à l'accueil
  step('une responsable voit les pointages et affiche le QR code, sans droits de gérant');

  // 13. Déconnexion puis reconnexion, mauvais mot de passe refusé.
  await theo.goto(APP + '#/compte');
  await shot(theo, '13-compte');
  await noOverflow(theo, 'compte');
  await theo.getByRole('button', { name: 'Se déconnecter' }).click();
  await see(theo, "Connecte-toi pour accéder à l'appli");
  await theo.fill('#login-email', 'theo@nuba.test');
  await theo.fill('#login-pw', 'mauvais');
  await theo.getByRole('button', { name: 'Se connecter' }).click();
  await see(theo, 'E-mail ou mot de passe incorrect');
  await theo.fill('#login-pw', PW);
  await theo.getByRole('button', { name: 'Se connecter' }).click();
  await theo.getByRole('heading', { name: 'Mon compte' }).waitFor({ timeout: 8000 });
  step('déconnexion, mauvais mot de passe refusé, reconnexion');

  // 14. Le gérant désactive Théo : il perd l'accès.
  await boss.goto(APP + '#/equipe');
  await boss.locator('button.row', { hasText: 'Théo Martin' }).click();
  await boss.getByRole('button', { name: "Désactiver l'accès" }).click();
  await see(boss, 'Accès désactivé');
  await theo.reload();
  await see(theo, 'Compte désactivé');
  step("un membre désactivé perd l'accès");

  // 15. Le gérant désactive la borne : l'iPad n'affiche plus de code.
  await boss.goto(APP + '#/reglages');
  await boss.getByRole('button', { name: 'Désactiver' }).first().click();
  await see(boss, 'Borne désactivée');
  await ipad.getByText('Borne désactivée').waitFor({ timeout: 45_000 });
  await shot(ipad, '15-borne-desactivee');
  await ipad.getByRole('button', { name: 'Relier à une nouvelle borne' }).click();
  await see(ipad, 'Relier cette borne');
  step("une borne désactivée n'affiche plus de code");

  // 16. Thème sombre, pour l'œil.
  const dark = await open('sombre', { width: 390, height: 844 }, { colorScheme: 'dark' });
  await dark.goto(APP);
  await dark.fill('#login-email', 'ines@nuba.test');
  await dark.fill('#login-pw', PW);
  await dark.getByRole('button', { name: 'Se connecter' }).click();
  await see(dark, 'Bonjour Inès');
  await dark.goto(APP + '#/pointeuse');
  await see(dark, 'Mes heures');
  await shot(dark, '16-pointeuse-sombre');

  await browser.close();
  assert.deepEqual(errors, [], 'erreurs dans le navigateur :\n' + errors.join('\n'));
  console.log('Parcours complet : OK');
}

main().catch((e) => {
  console.error('\nÉCHEC : ' + (e && e.message ? e.message : e));
  if (errors.length) console.error('Erreurs du navigateur :\n' + errors.join('\n'));
  process.exit(1);
});
