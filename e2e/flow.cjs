// Parcours complet joué dans un vrai navigateur contre la base locale :
// le gérant s'inscrit, compose l'équipe, crée la borne ; un équipier s'inscrit et pointe avec le code de la borne.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
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

  // 3. Il crée la borne : l'appli lui donne un code de liaison à 6 chiffres.
  await boss.goto(APP + '#/reglages');
  await boss.getByRole('button', { name: 'Ajouter une borne' }).click();
  await boss.getByRole('button', { name: 'Créer la borne' }).click();
  await see(boss, 'Relier « iPad du bar »');
  const pairCode = await boss.locator('[data-testid=pair-code]').innerText();
  assert.match(pairCode, /^\d{6}$/);
  await shot(boss, '03-borne-code');
  await boss.getByRole('button', { name: "C'est fait" }).click();
  await see(boss, "aucun appareil relié pour l'instant");
  step('le gérant crée la borne et reçoit un code de liaison');

  // 4. Sur l'iPad, sans compte : « Cet appareil est une borne », on tape le code, la borne s'affiche.
  const ipad = await open('borne', { width: 1024, height: 768 });
  await ipad.goto(APP);
  await ipad.getByRole('link', { name: 'Cet appareil est une borne de pointage' }).click();
  await see(ipad, 'Relier cette borne');
  await ipad.fill('#pair-code', String((Number(pairCode) + 1) % 1000000).padStart(6, '0'));
  await ipad.getByRole('button', { name: 'Relier' }).click();
  await see(ipad, 'Code refusé ou expiré');
  await shot(ipad, '04a-relier-borne');
  await ipad.fill('#pair-code', pairCode);
  await ipad.getByRole('button', { name: 'Relier' }).click();
  await see(ipad, 'Scanne ce code pour pointer');
  const code = () => ipad.locator('[data-testid=code]').innerText();
  assert.match(await code(), /^\d{6}$/);
  await see(ipad, 'La Nuba');
  await shot(ipad, '04-borne-ipad');
  step('la borne se relie par son code et affiche le QR code sans compte');

  // 4 bis. Une seconde borne sur un appareil où le gérant se connecte aussi :
  // l'appli s'y rouvre toujours sur la borne, et le code ne sert qu'une fois.
  await boss.getByRole('button', { name: 'Ajouter une borne' }).click();
  await boss.fill('#kiosk-label', 'iPad cuisine');
  await boss.getByRole('button', { name: 'Créer la borne' }).click();
  await see(boss, 'Relier « iPad cuisine »');
  const pairCode2 = await boss.locator('[data-testid=pair-code]').innerText();
  await boss.getByRole('button', { name: "C'est fait" }).click();
  const installed = await open('iPad installé', { width: 1024, height: 768 });
  await installed.goto(APP);
  await installed.getByRole('link', { name: 'Cet appareil est une borne de pointage' }).click();
  await installed.fill('#pair-code', pairCode);            // code déjà utilisé par le premier iPad
  await installed.getByRole('button', { name: 'Relier' }).click();
  await see(installed, 'Code refusé ou expiré');
  await installed.fill('#pair-code', pairCode2);
  await installed.getByRole('button', { name: 'Relier' }).click();
  await see(installed, 'Scanne ce code pour pointer');
  await installed.goto('about:blank');
  await installed.goto(APP);                      // relance de l'appli : directement la borne
  await see(installed, 'Scanne ce code pour pointer');
  await installed.getByRole('button', { name: 'Connexion du gérant, avec e-mail' }).click();
  await see(installed, "Connecte-toi pour accéder à l'appli");
  await installed.getByRole('link', { name: 'Revenir à la borne de pointage' }).click();
  await see(installed, 'Scanne ce code pour pointer');
  // Le gérant se connecte sur cet appareil, ferme l'appli, la rouvre : c'est encore la borne.
  await installed.getByRole('button', { name: 'Connexion du gérant, avec e-mail' }).click();
  await installed.fill('#login-email', 'boss@nuba.test');
  await installed.fill('#login-pw', PW);
  await installed.getByRole('button', { name: 'Se connecter' }).click();
  await see(installed, 'Bonjour Sam');
  await installed.goto('about:blank');
  await installed.goto(APP);
  await see(installed, 'Scanne ce code pour pointer');
  await installed.getByRole('button', { name: 'Connexion du gérant, avec e-mail' }).click();
  await see(installed, 'Bonjour Sam');
  await installed.goto(APP + '#/compte');
  await see(installed, 'Afficher la borne');
  await shot(installed, '04c-compte-borne');
  await installed.goto('about:blank');
  await installed.goto(APP + '#/pointeuse');      // un lien précis garde sa destination
  await installed.getByRole('heading', { name: 'Pointeuse' }).waitFor({ timeout: 8000 });
  step("l'appli installée se relie à la borne et s'y rouvre toujours, même avec quelqu'un de connecté");

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

  // 13 bis. Planning : le gérant planifie, Théo demande un congé et cède un service, le gérant décide.
  await boss.goto(APP + '#/planning');
  await boss.getByRole('heading', { name: 'Planning' }).waitFor({ timeout: 8000 });
  const plan = await boss.evaluate(() => {
    const pad = (n) => String(n).padStart(2, '0');
    const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const monday = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
    const now = new Date();
    const at = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
    const tom = at(1);
    return { tom: key(tom), num: tom.getDate(), label: tom.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }), nextWeek: monday(tom) !== monday(now), from: key(at(10)), to: key(at(12)) };
  });
  const toWeek = async (page) => { if (plan.nextWeek) await page.getByRole('button', { name: 'Semaine suivante' }).click(); };
  const pickDay = (page) => page.getByRole('group', { name: 'Jour' }).getByRole('button', { name: new RegExp(` ${plan.num}(,|$)`) }).first().click();
  await toWeek(boss);
  await boss.getByRole('button', { name: 'Service', exact: true }).click();
  await boss.selectOption('#shift-who', { label: 'Théo Martin' });
  await boss.fill('#shift-day', plan.tom);
  await boss.fill('#shift-start', '18:00');
  await boss.fill('#shift-end', '01:00');
  await boss.fill('#shift-area', 'Salle');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Service ajouté');
  await pickDay(boss);
  await see(boss, '18:00 – 01:00');
  await see(boss, '7 h 00');
  await boss.getByRole('button', { name: 'Service', exact: true }).click();
  await boss.selectOption('#shift-who', { label: 'Théo Martin' });
  await boss.fill('#shift-day', plan.tom);
  await boss.fill('#shift-start', '23:00');
  await boss.fill('#shift-end', '02:00');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'déjà un service sur ce créneau');
  await boss.getByRole('button', { name: 'Fermer' }).click();
  await boss.getByRole('button', { name: `Ajouter un service pour Inès le ${plan.label}` }).click();
  assert.equal(await boss.inputValue('#shift-day'), plan.tom, 'la case touchée doit préremplir le jour');
  await boss.fill('#shift-start', '17:00');
  await boss.fill('#shift-end', '23:00');
  await boss.fill('#shift-area', 'Bar');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Service ajouté');
  await shot(boss, '13b-planning-gerant');
  step('le gérant planifie, les chevauchements sont refusés');

  await theo.goto(APP + '#/planning');
  await toWeek(theo);
  await pickDay(theo);
  await see(theo, 'Théo Martin (toi)');
  assert.equal(await theo.getByRole('button', { name: 'Service', exact: true }).count(), 0, 'un équipier ne doit pas pouvoir ajouter de service');
  await theo.getByRole('button', { name: 'Demander un congé' }).click();
  await theo.fill('#leave-from', plan.from);
  await theo.fill('#leave-to', plan.to);
  await theo.fill('#leave-note', 'Mariage');
  await theo.getByRole('button', { name: 'Envoyer la demande' }).click();
  await see(theo, 'Demande envoyée au gérant');
  await theo.getByRole('button', { name: 'Céder un service' }).click();
  await theo.selectOption('#swap-shift', { index: 1 });
  await theo.selectOption('#swap-to', { label: 'Inès Durand' });
  await theo.getByRole('button', { name: 'Envoyer la demande' }).click();
  await see(theo, 'Théo Martin cède à Inès Durand');
  await noOverflow(theo, 'planning équipier');
  await shot(theo, '13c-planning-equipier');
  step('un équipier voit le planning, demande un congé et propose de céder un service');

  await boss.reload();
  await toWeek(boss);
  await see(boss, 'Demandes à traiter');
  const swapRow = boss.locator('.row', { hasText: 'Théo Martin cède à Inès Durand' }).first();
  await swapRow.getByRole('button', { name: 'Accepter' }).click();
  await see(boss, 'déjà un service sur ce créneau');   // Inès travaille déjà ce soir-là
  await boss.getByRole('button', { name: /^Inès, / }).click();
  await boss.getByRole('button', { name: 'Supprimer ce service' }).click();
  await boss.getByRole('button', { name: 'Supprimer définitivement' }).click();
  await see(boss, 'Service supprimé');
  await swapRow.getByRole('button', { name: 'Accepter' }).click();
  await see(boss, 'Échange accepté');
  await boss.getByRole('button', { name: /^Inès, .*18:00 – 01:00/ }).waitFor({ timeout: 8000 });
  await boss.locator('.row', { hasText: 'Théo Martin · Congé' }).first().getByRole('button', { name: 'Accepter' }).click();
  await see(boss, 'Demande acceptée');
  await theo.reload();
  await theo.locator('.row', { hasText: 'Théo Martin · Congé' }).first().getByText('Acceptée').waitFor({ timeout: 8000 });
  await boss.getByRole('button', { name: 'Semaine suivante' }).click();
  await boss.getByRole('button', { name: 'Recopier la semaine précédente' }).click();
  await see(boss, '1 service recopié');
  await shot(boss, '13d-planning-semaine-suivante');
  await boss.goto(APP + '#/');
  await see(boss, 'Équipe du jour');
  await see(boss, 'Mes prochains services');
  step('le gérant décide : un échange impossible est refusé, puis accepté ; la semaine se recopie');

  // 13 ter. iPad partagé : un extra sans e-mail reçoit un code PIN, ouvre l'appli sur la borne et y pointe.
  await boss.goto(APP + '#/equipe');
  await boss.getByRole('button', { name: 'Ajouter' }).click();
  await boss.fill('#m-first', 'Hugo');
  await boss.fill('#m-job', 'Extra bar');
  await boss.selectOption('#m-contract', 'extra');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Indique une adresse e-mail, ou donne un code PIN');
  await boss.fill('#m-pin', '0000');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'trop facile à deviner');
  await boss.fill('#m-pin', '2580');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, "Hugo peut utiliser l'iPad avec son code PIN");
  await see(boss, 'iPad, avec code PIN');
  assert.equal(await boss.locator('button.row', { hasText: 'Hugo' }).count(), 1, 'une seule fiche Hugo, même après un code refusé');

  await theo.goto(APP + '#/compte');
  await theo.fill('#acc-pin', '2468');
  await theo.getByRole('button', { name: 'Enregistrer mon code PIN' }).click();
  await see(theo, 'Code PIN enregistré');

  await ipad.getByRole('button', { name: "Utiliser l'appli sur cet appareil" }).click();
  await see(ipad, 'Qui es-tu ?');
  await ipad.getByRole('dialog').getByRole('button', { name: /Hugo/ }).click();
  await ipad.fill('#pin-code', '9999');
  await see(ipad, 'Code incorrect');
  await ipad.fill('#pin-code', '2580');
  await see(ipad, 'Bonjour Hugo');
  assert.equal(await ipad.getByRole('link', { name: 'Équipe' }).count(), 0, 'une session à code PIN ne doit pas voir les écrans du gérant');
  await ipad.evaluate(() => { window.location.hash = '#/reglages'; });
  await see(ipad, 'Bonjour Hugo');
  await ipad.getByRole('link', { name: 'Pointeuse' }).first().click();
  await ipad.getByRole('button', { name: 'Pointer mon arrivée' }).click();
  await see(ipad, 'Arrivée pointée');
  await see(ipad, 'En service');
  await shot(ipad, '13e-ipad-code-pin');
  await ipad.getByRole('button', { name: /Terminer/ }).click();
  await see(ipad, 'Scanne ce code pour pointer');
  await boss.goto(APP + '#/');
  await see(boss, 'Présent sans service prévu');
  step("sur l'iPad, un extra sans e-mail s'identifie par code PIN et pointe");

  // Verrouillage automatique : Théo ouvre sa session sur la borne, puis ne touche plus à rien.
  await ipad.getByRole('button', { name: "Utiliser l'appli sur cet appareil" }).click();
  await ipad.getByRole('dialog').getByRole('button', { name: /Théo/ }).click();
  await ipad.fill('#pin-code', '2468');
  await see(ipad, 'Bonjour Théo');
  await ipad.getByText('Scanne ce code pour pointer').waitFor({ timeout: 20_000 });
  step("la session à code PIN se referme seule sans activité");

  // 13 quater. Checklists et hygiène, sur le téléphone, sur l'iPad par code PIN, puis l'export du gérant.
  await theo.goto(APP + '#/checklists');
  await see(theo, 'Ouverture bar');
  await theo.locator('button.row', { hasText: 'Machine à glaçons' }).click();
  await see(theo, 'Fait par Théo');
  await noOverflow(theo, 'checklists');
  await shot(theo, '13f-checklists');
  await boss.goto(APP + '#/');
  await see(boss, "À faire aujourd'hui");
  await see(boss, 'cases cochées');
  await boss.goto(APP + '#/checklists');
  await boss.locator('button.row', { hasText: 'Machine à glaçons' }).waitFor();
  await boss.getByRole('button', { name: 'Nouvelle liste' }).click();
  await boss.fill('#cl-name', 'Brunch');
  await boss.getByLabel('Case 1').fill('Dresser le buffet');
  await boss.getByRole('button', { name: 'Ajouter une case' }).click();
  await boss.getByLabel('Case 2').fill('Presser les oranges');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Liste créée');
  await boss.locator('button.row', { hasText: 'Dresser le buffet' }).waitFor();
  await shot(boss, '13g-checklists-gerant');
  step('chacun coche ses checklists, le gérant compose ses listes');

  await theo.goto(APP + '#/hygiene');
  await theo.getByLabel('Température de Frigo bar').fill('3,4');
  await theo.locator('[data-unit="Frigo bar"]').getByRole('button', { name: 'Relever' }).click();
  await see(theo, 'Relevé enregistré');
  const vitrine = theo.locator('[data-unit="Vitrine desserts"]');
  await theo.getByLabel('Température de Vitrine desserts').fill('6');
  await vitrine.getByRole('button', { name: 'Relever' }).click();
  await see(theo, 'Hors limite');
  await theo.getByLabel('Action corrective pour Vitrine desserts').fill('Porte refermée, recontrôle dans 30 min');
  await vitrine.getByRole('button', { name: 'Noter' }).click();
  await see(theo, 'Action corrective enregistrée');
  await vitrine.getByText('Corrigé').waitFor();
  await noOverflow(theo, 'hygiène, températures');
  await shot(theo, '13h-hygiene-temperatures');
  await theo.getByRole('button', { name: 'Dates limites', exact: true }).click();
  await theo.fill('#trace-name', 'Chimichurri maison');
  await theo.getByRole('button', { name: '+3 j' }).click();
  await theo.getByRole('button', { name: "Enregistrer l'étiquette" }).click();
  await see(theo, 'Étiquette enregistrée');
  await see(theo, 'Encore 3 j');
  await noOverflow(theo, 'hygiène, dates limites');
  await theo.locator('[data-trace="Chimichurri maison"]').getByRole('button', { name: 'Terminé' }).click();
  await see(theo, 'Chimichurri maison : terminé');
  await theo.getByRole('button', { name: 'Friteuse', exact: true }).click();
  await theo.fill('#oil-pct', '27');
  await theo.getByRole('button', { name: 'Noter le test' }).click();
  await see(theo, "l'huile est à changer");
  await theo.getByRole('button', { name: 'Huile changée' }).click();
  await see(theo, "Huile changée aujourd'hui");
  await theo.getByRole('button', { name: 'Nettoyage', exact: true }).click();
  await see(theo, 'Nettoyage du jour');
  await theo.locator('button.row', { hasText: 'Sanitaires' }).click();
  await see(theo, 'Fait par Théo');
  step('hygiène : relevé conforme, hors limite corrigé, date limite, friteuse, nettoyage');

  await ipad.getByRole('button', { name: "Utiliser l'appli sur cet appareil" }).click();
  await ipad.getByRole('dialog').getByRole('button', { name: /Hugo/ }).click();
  await ipad.fill('#pin-code', '2580');
  await see(ipad, 'Bonjour Hugo');
  await ipad.getByRole('link', { name: 'Checklists' }).first().click();
  await ipad.locator('button.row', { hasText: 'Fûts contrôlés' }).click();
  await see(ipad, 'Fait par Hugo');
  await ipad.getByRole('link', { name: 'Hygiène' }).first().click();
  await ipad.getByLabel('Température de Chambre froide').fill('2,5');
  await ipad.locator('[data-unit="Chambre froide"]').getByRole('button', { name: 'Relever' }).click();
  await see(ipad, 'Relevé enregistré');
  await shot(ipad, '13i-ipad-hygiene');
  await ipad.getByRole('button', { name: /Terminer/ }).click();
  await see(ipad, 'Scanne ce code pour pointer');
  step("sur l'iPad, par code PIN, on coche et on relève aussi");

  await boss.goto(APP + '#/hygiene');
  await boss.locator('[data-unit="Chambre froide"]').getByText('Conforme').waitFor();
  const [hyg] = await Promise.all([boss.waitForEvent('download'), boss.getByRole('button', { name: /Exporter le dossier/ }).click()]);
  const hygCsv = fs.readFileSync(await hyg.path(), 'utf8');
  for (const part of ['RELEVÉS DE TEMPÉRATURE', 'Vitrine desserts;6;Non;Porte refermée, recontrôle dans 30 min;Théo Martin', 'Chambre froide;2,5;Oui;;Hugo', 'PLAN DE NETTOYAGE', 'Nettoyage du jour;Sanitaires;Théo Martin', 'Chimichurri maison;Préparation', 'HUILE DE FRITURE', 'Test;27;Théo Martin']) {
    assert.ok(hygCsv.includes(part), "l'export d'hygiène doit contenir : " + part + '\n' + hygCsv);
  }
  step("le gérant exporte le dossier d'hygiène");

  // 13 quinquies. Stocks et commandes.
  await boss.goto(APP + '#/commandes');
  await see(boss, 'Aucun fournisseur. Ajoute le premier');
  await boss.getByRole('button', { name: 'Ajouter un fournisseur' }).click();
  await boss.fill('#sup-name', 'Cave Garonne');
  await boss.fill('#sup-phone', '06 12 34 56 78');
  await boss.fill('#sup-email', 'commandes@cave.test');
  await boss.fill('#sup-days', 'Mardi et vendredi');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Fournisseur ajouté');
  await boss.goto(APP + '#/stocks');
  for (const [name, unit, threshold, target, price] of [['Gin', 'bouteille 70 cl', '3', '8', '21'], ['Vin blanc', 'bouteille', '12', '', '6,5']]) {
    await boss.getByRole('button', { name: 'Produit', exact: true }).click();
    await boss.fill('#prod-name', name);
    await boss.fill('#prod-unit', unit);
    await boss.fill('#prod-threshold', threshold);
    await boss.fill('#prod-target', target);
    await boss.fill('#prod-price', price);
    await boss.selectOption('#prod-supplier', { label: 'Cave Garonne' });
    await boss.getByRole('button', { name: 'Enregistrer' }).click();
    await see(boss, 'Produit ajouté');
    await boss.locator(`[data-product="${name}"]`).waitFor();
  }
  await boss.locator('[data-product="Gin"]').getByText('Rupture').waitFor();
  await shot(boss, '13j-stocks-gerant');
  step('le gérant crée un fournisseur et ses produits');

  await theo.goto(APP + '#/stocks');
  const gin = theo.locator('[data-product="Gin"]');
  await gin.getByRole('button', { name: 'Ajouter 1 Gin' }).click();
  await gin.getByLabel('Quantité de Gin').getByText('1', { exact: true }).waitFor();
  await gin.getByText('Bas').waitFor();
  await theo.getByRole('button', { name: "Faire l'inventaire" }).click();
  await theo.getByLabel('Quantité comptée de Vin blanc').fill('9');
  await theo.getByRole('button', { name: /Enregistrer l'inventaire \(1\)/ }).click();
  await see(theo, 'Inventaire enregistré : 1 quantité mise à jour');
  await noOverflow(theo, 'stocks');
  await shot(theo, '13k-stocks');
  await theo.getByRole('link', { name: /Préparer les commandes \(2 à commander\)/ }).click();
  await theo.locator('[data-suggest="Cave Garonne"]').getByRole('button', { name: 'Préparer la commande' }).click();
  await see(theo, 'Cave Garonne · brouillon');
  await theo.locator('[data-line="Gin"]').getByText('7', { exact: true }).waitFor();          // 8 voulues − 1 en stock
  await theo.locator('[data-line="Vin blanc"]').getByText('15', { exact: true }).waitFor();   // 2 × 12 − 9
  await theo.getByRole('button', { name: 'Commander 1 Gin de moins' }).click();
  await theo.fill('#order-note', 'Livraison avant 16 h');
  assert.match(await theo.getByRole('link', { name: 'Par WhatsApp' }).getAttribute('href'), /^https:\/\/wa\.me\/33612345678\?text=.*6%20%C3%97%20Gin/);
  await noOverflow(theo, 'commande');
  await shot(theo, '13l-commande');
  await theo.getByRole('button', { name: 'Commande envoyée' }).click();
  await see(theo, 'Commande notée comme envoyée');
  await theo.locator('[data-order="Cave Garonne"]').getByText('Envoyée', { exact: true }).waitFor();
  step("un équipier ajuste le stock, fait l'inventaire, prépare et envoie la commande");

  // La livraison arrive : Hugo la réceptionne sur l'iPad, avec un manquant.
  await ipad.getByRole('button', { name: "Utiliser l'appli sur cet appareil" }).click();
  await ipad.getByRole('dialog').getByRole('button', { name: /Hugo/ }).click();
  await ipad.fill('#pin-code', '2580');
  await see(ipad, 'Bonjour Hugo');
  await see(ipad, '1 livraison attendue');
  await ipad.getByRole('link', { name: 'Commandes' }).first().click();
  await ipad.locator('[data-order="Cave Garonne"]').click();
  await ipad.getByRole('button', { name: 'Réceptionner la livraison' }).click();
  await ipad.getByLabel('Quantité reçue de Vin blanc').fill('12');
  await ipad.selectOption('#rec-ok', 'non');
  await ipad.getByRole('button', { name: 'Valider la réception' }).click();
  await see(ipad, 'Décris le problème constaté');
  await ipad.fill('#rec-note', '3 bouteilles manquantes');
  await ipad.getByRole('button', { name: 'Valider la réception' }).click();
  await see(ipad, 'Livraison réceptionnée, stock mis à jour');
  await ipad.getByRole('link', { name: 'Stocks' }).first().click();
  await ipad.locator('[data-product="Gin"]').getByLabel('Quantité de Gin').getByText('7', { exact: true }).waitFor();          // 1 + 6
  await ipad.locator('[data-product="Vin blanc"]').getByLabel('Quantité de Vin blanc').getByText('21', { exact: true }).waitFor();   // 9 + 12
  await shot(ipad, '13m-ipad-stocks');
  await ipad.getByRole('button', { name: /Terminer/ }).click();
  await see(ipad, 'Scanne ce code pour pointer');
  await boss.goto(APP + '#/commandes');
  await boss.locator('[data-order="Cave Garonne"]').getByText('Problème signalé').waitFor();
  step("sur l'iPad, la livraison est réceptionnée et le stock mis à jour");

  // 13 sexies. Réservations : un client réserve sur la page publique, l'équipe suit, le client annule, le gérant règle.
  const client = await open('client', { width: 390, height: 844 });
  await client.goto(APP + '#/reserver');
  await see(client, 'Réserver une table');
  await client.getByRole('button', { name: '10 ou plus' }).click();
  await see(client, 'À partir de 10 personnes');
  await client.getByRole('button', { name: '4 personnes', exact: true }).click();
  const bookDay = await client.evaluate(() => {
    const now = new Date();
    let n = 1;
    while (new Date(now.getFullYear(), now.getMonth(), now.getDate() + n).getDay() !== 2) n++;   // prochain mardi
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await client.fill('#book-day', bookDay);
  const hours = client.getByRole('group', { name: 'Heure' });
  await hours.getByRole('button', { name: '22:00' }).waitFor();
  assert.equal(await hours.getByRole('button', { name: '22:30' }).count(), 0, 'le mardi, le dernier créneau est 22 h');
  assert.equal(await hours.getByRole('button', { name: '14:30' }).count(), 0, 'le mardi, la cuisine ferme à 14 h 30 : dernier créneau du midi à 14 h');
  assert.equal(await hours.getByRole('button', { name: '17:00' }).count(), 0, "pas de créneau l'après-midi");
  await hours.getByRole('button', { name: '19:00' }).waitFor();
  await hours.getByRole('button', { name: '20:00' }).click();
  await client.fill('#book-name', 'Camille Roux');
  await client.fill('#book-phone', '06 11 22 33 44');
  await client.fill('#book-note', 'Anniversaire');
  await noOverflow(client, 'page publique de réservation');
  await shot(client, '13n-reserver');
  await client.getByRole('button', { name: /Réserver pour 4 personnes/ }).click();
  await see(client, "C'est réservé");
  await shot(client, '13o-reserve');
  const manage = await client.getByRole('link', { name: 'Voir ou annuler ma réservation' }).getAttribute('href');
  assert.match(manage, /#\/reservation\?r=[0-9a-f-]{36}&c=[0-9a-f]{20}$/);
  step('un client réserve en ligne, sans compte, et reçoit son lien');

  await theo.goto(APP + '#/reservations');
  await theo.fill('#res-day', bookDay);
  const camille = theo.locator('[data-res="Camille Roux"]');
  await camille.getByText('Camille Roux · 4 pers.').waitFor();
  await camille.getByText(/En ligne · 0611223344/).waitFor();
  await camille.getByText('Anniversaire').waitFor();
  await theo.getByRole('button', { name: 'Réservation', exact: true }).click();
  await theo.fill('#res-name', 'Table Martin');
  await theo.fill('#res-party', '12');
  await theo.fill('#res-slot', '21:00');
  await theo.fill('#res-table', 'Grande table');
  await theo.getByRole('button', { name: 'Enregistrer' }).click();
  await see(theo, 'Réservation ajoutée');
  await theo.locator('[data-res="Table Martin"]').getByText('Table Martin · 12 pers.').waitFor();
  await see(theo, 'Soir · 16 couverts');
  await noOverflow(theo, 'réservations');
  await shot(theo, '13p-reservations');

  await client.goto(manage);
  await see(client, 'Votre réservation');
  await client.getByRole('button', { name: 'Annuler ma réservation' }).click();
  await client.getByRole('button', { name: 'Oui, annuler' }).click();
  await see(client, 'Votre réservation est bien annulée');
  await theo.reload();
  await theo.fill('#res-day', bookDay);
  await theo.locator('[data-res="Camille Roux"]').getByText('Annulée').waitFor();
  await theo.locator('[data-res="Camille Roux"]').getByRole('button', { name: 'Rétablir' }).click();
  await see(theo, 'Camille Roux : de nouveau attendu');
  await theo.locator('[data-res="Table Martin"]').getByRole('button', { name: 'Arrivés' }).click();
  await theo.locator('[data-res="Table Martin"]').getByText('À table').waitFor();
  step("l'équipe voit la réservation en ligne, en saisit une, le client annule avec son lien");

  await boss.goto(APP + '#/reservations');
  await boss.getByRole('button', { name: 'Réglages et lien de réservation' }).click();
  assert.match(await boss.inputValue('#bk-link'), /#\/reserver$/);
  await boss.fill('#bk-phone', '05 61 00 00 00');
  await boss.fill('#bk-cap', '14');
  await boss.getByLabel('Mardi, dernier créneau').fill('21:00');
  await shot(boss, '13q-reglages-reservations');
  await boss.getByRole('button', { name: 'Enregistrer les réglages' }).click();
  await see(boss, 'Réglages des réservations enregistrés');
  await client.goto(APP + '#/reserver');
  await client.getByRole('button', { name: '10 ou plus' }).click();
  await see(client, '05 61 00 00 00');
  await client.getByRole('button', { name: '4 personnes', exact: true }).click();
  await client.fill('#book-day', bookDay);
  await hours.getByRole('button', { name: '20:30' }).waitFor();
  assert.equal(await hours.getByRole('button', { name: '21:00' }).count(), 0, 'à 21 h, 12 couverts sur 14 : plus de place pour 4');
  assert.equal(await hours.getByRole('button', { name: '21:30' }).count(), 0, 'le gérant a ramené le dernier créneau du mardi à 21 h');
  step('le gérant règle la capacité et les créneaux ; la page publique suit');

  // 13 septies. Événements et fichier clients.
  await client.goto(APP + '#/privatiser');
  await see(client, 'Votre événement à la Nuba');
  const evtDay = await client.evaluate(() => { const d = new Date(Date.now() + 30 * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await client.fill('#pe-day', evtDay);
  await client.fill('#pe-guests', '40');
  await client.fill('#pe-name', 'Nadia Benali');
  await client.fill('#pe-phone', '12');
  await client.fill('#pe-message', 'Anniversaire, cocktail dînatoire');
  await noOverflow(client, 'demande de privatisation');
  await client.getByRole('button', { name: 'Envoyer ma demande' }).click();
  await see(client, 'Indiquez votre nom et un numéro de téléphone valide');
  await client.fill('#pe-phone', '06 55 44 33 22');
  await client.getByRole('button', { name: 'Envoyer ma demande' }).click();
  await see(client, 'Demande envoyée');
  step('un client envoie une demande de privatisation depuis la page publique');

  await boss.goto(APP + '#/');
  await see(boss, "Demandes d'événement");
  await boss.goto(APP + '#/evenements');
  await boss.locator('[data-event="Privatisation, Nadia Benali"]').click();
  await boss.fill('#evt-title', 'Anniversaire de Nadia');
  await boss.selectOption('#evt-status', 'acompte');
  await boss.fill('#evt-time', '19:30');
  await boss.fill('#evt-amount', '1280');
  await boss.fill('#evt-deposit', '384');
  await boss.check('#evt-paid');
  await boss.fill('#evt-details', 'Cocktail dînatoire, 32 € par personne');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Événement enregistré');
  const nadia = boss.locator('[data-event="Anniversaire de Nadia"]');
  await nadia.getByText('Acompte reçu').waitFor();
  await nadia.getByText(/40 pers\. · Nadia Benali · préparation 0\/5/).waitFor();
  await nadia.click();
  await boss.fill('#evt-task', 'Gâteau du client : prévoir le frigo');
  await boss.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await boss.locator('button.row', { hasText: 'Gâteau du client' }).waitFor();
  await shot(boss, '13r-evenement');
  await boss.getByRole('button', { name: 'Fermer' }).click();
  await boss.getByRole('button', { name: 'Événement', exact: true }).click();
  await boss.selectOption('#evt-kind', 'exposition');
  await boss.fill('#evt-title', 'Lignes de nuit');
  const todayKey = await boss.evaluate(() => { const d = new Date(Date.now() - 5 * 3600000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await boss.fill('#evt-day', todayKey);
  await boss.fill('#evt-end', evtDay);
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Événement créé');
  await boss.goto(APP + '#/');
  await see(boss, "Exposition, aujourd'hui");
  step('le gérant chiffre la demande, complète la préparation, crée une exposition');

  await theo.goto(APP + '#/evenements');
  await theo.locator('[data-event="Anniversaire de Nadia"]').click();
  await see(theo, 'Cocktail dînatoire, 32 € par personne');
  assert.equal(await theo.locator('#evt-amount').count(), 0, "un équipier ne voit pas le formulaire du gérant");
  await theo.locator('button.row', { hasText: 'Menu validé avec la cuisine' }).click();
  await see(theo, 'Fait par Théo');
  await noOverflow(theo, 'événement');
  await shot(theo, '13s-evenement-equipier');
  await theo.getByRole('button', { name: 'Fermer' }).click();
  await theo.goto(APP + '#/clients');
  await theo.locator('[data-customer="Nadia Benali"]').getByText('0655443322').waitFor();
  await theo.getByRole('button', { name: 'Fiche', exact: true }).click();
  await theo.fill('#cust-name', 'Trio Django');
  await theo.selectOption('#cust-kind', 'artiste');
  await theo.fill('#cust-phone', '06 99 88 77 66');
  await theo.getByRole('button', { name: 'Enregistrer' }).click();
  await see(theo, 'Fiche ajoutée');
  await theo.getByRole('button', { name: 'Artistes' }).click();
  await theo.locator('[data-customer="Trio Django"]').waitFor();
  await noOverflow(theo, 'clients');
  step("l'équipe lit l'événement, coche la préparation et tient le fichier clients");

  // 13 octies. Pilotage : fiches techniques, pannes et échéances, procédures.
  await boss.goto(APP + '#/fiches');
  await boss.getByRole('button', { name: 'Fiche', exact: true }).click();
  await boss.fill('#rec-name', 'Gin tonic');
  await boss.fill('#rec-category', 'Cocktails');
  await boss.fill('#rec-sale', '9');
  await boss.selectOption('#rec-vat', '20');
  await boss.getByRole('button', { name: 'Ajouter un ingrédient' }).click();
  await boss.getByLabel('Ingrédient 1, produit du stock').selectOption({ label: 'Gin (bouteille 70 cl)' });
  await boss.getByLabel('Ingrédient 1, quantité').fill('4');
  await boss.getByLabel('Ingrédient 1, unité').fill('cl');
  await boss.getByLabel('Ingrédient 1, contenance du produit').fill('70');
  await boss.getByRole('button', { name: 'Ajouter un ingrédient' }).click();
  await boss.getByLabel('Ingrédient 2, nom').fill('Tonic');
  await boss.getByLabel('Ingrédient 2, quantité').fill('12');
  await boss.getByLabel('Ingrédient 2, unité').fill('cl');
  await boss.getByLabel('Ingrédient 2, coût').fill('0,30');
  // Gin : 4 cl sur 70 à 21 € = 1,20 € ; tonic 0,30 € ; prix hors taxe 9 / 1,2 = 7,50 € ; coût 20 %.
  await boss.locator('.stat', { hasText: 'coût par portion' }).getByText('1,50 €').waitFor();
  await boss.locator('.stat', { hasText: 'du prix hors taxe' }).getByText('20 %').waitFor();
  await boss.locator('.stat', { hasText: 'marge par portion' }).getByText('6,00 €').waitFor();
  await boss.fill('#rec-method', 'Verre rempli de glace, gin, tonic, zeste de citron vert.');
  await boss.getByRole('group', { name: 'Allergènes' }).getByRole('button', { name: 'sulfites' }).click();
  await shot(boss, '13t-fiche-technique');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Fiche créée');
  await boss.locator('[data-recipe="Gin tonic"]').getByText('20 % de coût').waitFor();
  await theo.goto(APP + '#/fiches');
  await theo.locator('[data-recipe="Gin tonic"]').click();
  await see(theo, 'Verre rempli de glace');
  assert.equal(await theo.getByText('coût par portion').count(), 0, "un équipier ne voit pas les coûts");
  await noOverflow(theo, 'fiche technique');
  await theo.getByRole('button', { name: 'Fermer' }).click();
  await theo.getByRole('button', { name: 'Tableau des allergènes' }).click();
  await theo.getByRole('dialog').getByText('sulfites').waitFor();
  await theo.getByRole('button', { name: 'Fermer' }).click();
  step('fiches techniques : coût et marge pour le gérant, recette et allergènes pour l\'équipe');

  await theo.goto(APP + '#/maintenance');
  await theo.getByRole('button', { name: 'Signaler une panne' }).click();
  await theo.fill('#iss-title', 'Frigo du bar qui goutte');
  await theo.fill('#iss-place', 'Bar');
  await theo.check('#iss-urgent');
  await theo.getByRole('button', { name: 'Signaler', exact: true }).click();
  await see(theo, 'Panne signalée');
  assert.equal(await theo.getByRole('button', { name: 'Échéances', exact: true }).count(), 0, "un équipier ne voit pas les échéances");
  await noOverflow(theo, 'maintenance');
  await boss.goto(APP + '#/');
  await see(boss, 'Pannes en cours');
  await see(boss, '1 urgente');
  await boss.goto(APP + '#/maintenance');
  await boss.locator('[data-issue="Frigo du bar qui goutte"]').click();
  await boss.fill('#iss-resolution', 'Joint remplacé');
  await boss.getByRole('button', { name: 'Réparée', exact: true }).click();
  await see(boss, 'Panne réparée');
  await boss.getByRole('button', { name: 'Échéances', exact: true }).click();
  await boss.getByRole('button', { name: 'Extincteurs : vérification' }).click();
  const due10 = await boss.evaluate(() => { const d = new Date(Date.now() - 5 * 3600000 + 10 * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  await boss.fill('#dl-due', due10);
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Échéance ajoutée');
  const ext = boss.locator('[data-deadline="Extincteurs : vérification"]');
  await ext.getByText('Dans 10 j').waitFor();
  await shot(boss, '13u-echeances');
  await boss.goto(APP + '#/');
  await see(boss, '1 échéance dans les 30 jours');
  await boss.goto(APP + '#/maintenance');
  await boss.getByRole('button', { name: 'Échéances', exact: true }).click();
  await ext.getByRole('button', { name: 'Fait' }).click();
  await see(boss, 'prochaine échéance reportée');
  step("pannes signalées par l'équipe, échéances suivies par le gérant");

  await theo.goto(APP + '#/');
  await see(theo, 'Procédures à lire');
  await theo.goto(APP + '#/procedures');
  await theo.locator('[data-procedure="Hygiène : les gestes de base"]').click();
  await theo.getByRole('button', { name: "J'ai lu et compris" }).click();
  await see(theo, 'Lecture confirmée');
  await theo.locator('[data-procedure="Hygiène : les gestes de base"]').getByText('Lue', { exact: true }).waitFor();
  await noOverflow(theo, 'procédures');
  await boss.goto(APP + '#/procedures');
  await boss.locator('[data-procedure="Hygiène : les gestes de base"]').click();
  await boss.getByRole('dialog').locator('.row', { hasText: 'Théo Martin' }).getByText(/Lue le/).waitFor();
  await boss.getByRole('dialog').locator('.row', { hasText: 'Inès Durand' }).getByText('Pas encore').waitFor();
  await boss.getByRole('button', { name: 'Fermer' }).click();
  await boss.getByRole('button', { name: 'Procédure', exact: true }).click();
  await boss.fill('#proc-title', 'Fermeture de la caisse');
  await boss.fill('#proc-category', 'Service');
  await boss.fill('#proc-body', 'Compter le fond de caisse.\nRanger l\'enveloppe au coffre.');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Procédure créée');
  await boss.locator('[data-procedure="Fermeture de la caisse"]').waitFor();
  step('procédures : lecture confirmée par chacun, suivie par le gérant');

  // 13 nonies. Administration : le gérant confie des accès à Inès, range le lien Drive de Théo, règle les e-mails.
  await ines.goto(APP + '#/checklists');
  await ines.locator('button.row', { hasText: 'Machine à glaçons' }).waitFor();
  assert.equal(await ines.getByRole('button', { name: 'Nouvelle liste' }).count(), 0, 'sans accès, une responsable ne compose pas de liste');
  await boss.goto(APP + '#/reglages');
  await see(boss, 'Accès des responsables');
  await boss.locator('[data-lead="Inès Durand"]').getByText("Ne modifie rien pour l'instant").waitFor();
  await boss.locator('[data-lead="Inès Durand"]').click();
  await boss.locator('input[data-area="checklists"]').check();
  await boss.locator('input[data-area="stocks"]').check();
  await shot(boss, '13x-acces-responsable');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Accès de Inès enregistrés');
  await boss.locator('[data-lead="Inès Durand"]').getByText('Checklists, Stocks et commandes').waitFor();
  await ines.reload();
  await ines.getByRole('button', { name: 'Nouvelle liste' }).click();
  await ines.fill('#cl-name', 'Terrasse');
  await ines.getByLabel('Case 1').fill('Sortir les parasols');
  await ines.getByRole('button', { name: 'Enregistrer' }).click();
  await see(ines, 'Liste créée');
  await ines.goto(APP + '#/stocks');
  await ines.getByRole('button', { name: 'Produit', exact: true }).waitFor();
  await ines.goto(APP + '#/fiches');
  await ines.getByRole('heading', { name: 'Fiches techniques' }).waitFor();
  assert.equal(await ines.getByRole('button', { name: 'Fiche', exact: true }).count(), 0, 'pas de fiche technique sans cet accès');
  assert.equal(await ines.getByRole('link', { name: 'Administration' }).count(), 0, "une responsable ne voit pas l'administration");
  step('le gérant confie checklists et stocks à une responsable, qui les tient, et rien de plus');

  await boss.goto(APP + '#/equipe');
  await boss.locator('button.row', { hasText: 'Inès Durand' }).getByText('Gère : Checklists, Stocks et commandes').waitFor();
  await boss.locator('button.row', { hasText: 'Théo Martin' }).click();
  await boss.fill('#m-folder', 'https://drive.google.com/drive/folders/exemple');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Fiche enregistrée');
  await boss.locator('button.row', { hasText: 'Théo Martin' }).click();
  assert.equal(await boss.getByRole('link', { name: 'Ouvrir son dossier' }).getAttribute('href'), 'https://drive.google.com/drive/folders/exemple');
  await boss.getByRole('button', { name: 'Fermer' }).click();
  step("le lien du dossier Drive de chacun est rangé dans sa fiche");

  await boss.goto(APP + '#/reglages');
  await see(boss, 'Envoi coupé');
  await boss.getByRole('button', { name: 'Régler' }).click();
  await boss.locator('#mail-enabled').check();
  await boss.fill('#mail-from', 'reservations@nuba.test');
  await boss.fill('#mail-notify', 'boss@nuba.test');
  await shot(boss, '13y-emails');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Réglages des e-mails enregistrés');
  await see(boss, 'De La Nuba <reservations@nuba.test>');
  await boss.getByRole('button', { name: 'Envoyer un essai' }).click();
  await see(boss, 'nom attendu : brevo_api_key');
  await boss.locator('.pill.bad', { hasText: 'Échec' }).first().waitFor();
  await shot(boss, '13z-administration');
  const bossPhone = await open('gérant téléphone', { width: 390, height: 844 });
  await bossPhone.goto(APP);
  await bossPhone.fill('#login-email', 'boss@nuba.test');
  await bossPhone.fill('#login-pw', PW);
  await bossPhone.getByRole('button', { name: 'Se connecter' }).click();
  await see(bossPhone, 'Bonjour Sam');
  await bossPhone.goto(APP + '#/reglages');
  await see(bossPhone, 'Accès des responsables');
  await noOverflow(bossPhone, 'administration');
  await shot(bossPhone, '13z-administration-telephone');
  step("e-mails : sans la clé dans le coffre de Supabase, l'essai dit ce qui manque");

  // 13 decies. Production : le gérant relie les mercuriales Google Sheets ; le script généré envoie fiches et commandes.
  await boss.goto(APP + '#/reglages');
  await boss.locator('[data-merc="saveurs_nomades"]').getByText('Jamais reçue').waitFor();
  await boss.getByRole('button', { name: 'Relier', exact: true }).click();
  await boss.fill('#merc-sn', 'pas un lien');
  await boss.getByRole('button', { name: 'Créer le script' }).click();
  await see(boss, 'Lien non reconnu pour Saveurs Nomades');
  await boss.fill('#merc-sn', 'https://docs.google.com/spreadsheets/d/SN_feuille_test_123/edit#gid=9006');
  await boss.fill('#merc-cm', 'https://docs.google.com/spreadsheets/d/CM_feuille_test_456/edit');
  await boss.getByRole('button', { name: 'Créer le script' }).click();
  const script = await boss.inputValue('#merc-script');
  assert.match(script, /"cleSynchro": "nuba_[0-9a-f]{64}"/);
  assert.match(script, /"saveurs_nomades": "SN_feuille_test_123"/);
  await shot(boss, '13za-script-mercuriales');
  await boss.getByRole('button', { name: "C'est fait" }).click();

  // Faux Google Sheets : deux mercuriales réduites ; les envois partent vraiment vers la base locale.
  const iso = (n) => { const d = new Date(Date.now() + n * 86400000); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); };
  const sheets = {
    SN_feuille_test_123: { name: 'MERCURIALE SAVEURS NOMADES', tabs: {
      RECETTES: [['Recette', 'Catégorie', 'Portions produites par la fiche', 'Coût matière / portion (€)', 'Coût / portion avec pertes (€)', 'Prix de vente HT (€)', 'Coût matière %', 'État de la fiche', 'Allergènes'],
        ['Purée de patate douce', 'BASE', 1, 0.5, 0.62, '', '', 'OK', 'Lait'], ['Poulet Moutarde Miel (Mariné)', 'PROTEINE', 1, 0.9, 0.95, '', '', 'OK', 'Moutarde'], ['Brownie', 'Dessert', 10, 0.7, 0.74, 1.8, 0.41, 'OK', 'Gluten, Œufs']],
      'COMPOSITION CALCUL': [['Recette', 'Ingrédient', 'Quantité', 'Unité', 'Prix unitaire (€)', 'Coût (€)', 'Fournisseur', 'Quantité pour la liste de courses', 'Allergènes', 'Coefficient de pertes'],
        ['Purée de patate douce', 'Patate douce', 200, 'g', 0.002, 0.4, 'Primeur', 0, '', 0.25], ['Purée de patate douce', 'Beurre', 10, 'g', 0.0064, 0.064, 'Metro', 0, 'Lait', 0.05],
        ['Poulet Moutarde Miel (Mariné)', 'Cuisse de poulet s/os', 100, 'g', 0.0072, 0.72, 'Boucherie', 0, '', 0.05],
        ['Brownie', 'Oeufs', 5, 'pièce', 0.272, 1.36, 'Metro', 0, 'Œufs', 0.05], ['Brownie', 'Beurre', 200, 'g', 0.0064, 1.28, 'Metro', 0, 'Lait', 0.05]],
      PRESTATIONS: [['Date de livraison', 'Type de formule', 'Plat', 'Portions', 'Contrôle des fiches', 'Facteur base', 'Facteur protéine', 'Facteur légume', 'Facteur sauce'],
        [iso(2), 'Sur mesure', 'Purée de patate douce + Poulet Moutarde Miel (Mariné)', 100, 'OK', 0.85, 0.7, 0, 0], [iso(2), 'Dessert', 'Brownie', 80, 'OK', '', '', '', ''], [iso(-20), 'Dessert', 'Brownie', 30, 'OK', '', '', '', '']],
      'GRAMMAGES SUR MESURE': [['Grammages du plat sur mesure'], [], [], ['Recette', 'Rôle', 'Type'], ['Purée de patate douce', 'BASE', 'Purée'], ['Poulet Moutarde Miel (Mariné)', 'PROTEINE', 'Sauce incluse']],
      'PRIX INGREDIENTS': [['Catégorie', 'Ingrédient', 'Fournisseur retenu (le moins cher, automatique)', "Prix d'achat HT retenu (€, automatique)", "Unité d'achat", "Poids d'une pièce (g)", 'Prix unitaire recette (€)', 'Unité en recette'],
        ['LEGUMES', 'Patate douce', 'Primeur', 2, 'kg', '', 0.002, 'g'], ['CREMERIE', 'Beurre', 'Metro', 6.4, 'kg', '', 0.0064, 'g'],
        ['VIANDES', 'Cuisse de poulet s/os', 'Boucherie', 7.2, 'kg', '', 0.0072, 'g'], ['EPICERIE', 'Oeufs', 'Metro', 0.272, 'pièce', '', 0.272, 'pièce']],
    } },
    CM_feuille_test_456: { name: 'MERCURIALE COMPTOIR MEDITERRANEEN', tabs: {
      RECETTES: [['Recette', 'Catégorie', 'Portions produites par la fiche', 'État de la fiche'], ['Taboulé oriental', 'Entrée', 1, 'OK']],
      'COMPOSITION CALCUL': [['Recette', 'Ingrédient', 'Quantité pour la fiche', 'Unité', 'Fournisseur', 'Coefficient de pertes'], ['Taboulé oriental', 'Semoule', 40, 'g', 'Metro', 0.05]],
      PRESTATIONS: [['Date de livraison', 'Catégorie', 'Plat', 'Portions', 'Contrôle des fiches'], [iso(3), 'Entrée', 'Taboulé oriental', 40, 'OK']],
    } },
  };
  const props = new Map();
  const google = {
    SpreadsheetApp: { openById: (id) => ({ getName: () => sheets[id].name, getSheetByName: (n) => (sheets[id].tabs[n] ? { getDataRange: () => ({ getValues: () => sheets[id].tabs[n] }) } : null) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) ?? null, setProperty: (k, v) => props.set(k, v) }) },
    UrlFetchApp: { fetch: (url, o) => {
      const out = execFileSync('curl', ['-s', '-w', '\n%{http_code}', '-X', 'POST', url, '-H', 'Content-Type: application/json', ...Object.entries(o.headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]), '--data-binary', '@-'], { input: o.payload }).toString();
      const i = out.lastIndexOf('\n');
      return { getResponseCode: () => Number(out.slice(i + 1)), getContentText: () => out.slice(0, i) };
    } },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), computeDigest: (_a, t) => [...createHash('sha256').update(t).digest()], base64Encode: (b) => Buffer.from(b).toString('base64'), DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 } },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }) },
    console: { log: () => {} },
  };
  const gs = new Function(...Object.keys(google), `${script}\nreturn { installer, envoyerSiChangement };`)(...Object.values(google));
  gs.installer();
  await boss.reload();
  await boss.locator('[data-merc="saveurs_nomades"]').getByText('3 fiches, 3 commandes').waitFor();
  await boss.locator('[data-merc="comptoir"]').getByText('1 fiche, 1 commande').waitFor();
  step('le gérant relie les mercuriales : le script Google généré envoie fiches, commandes et prix');

  await theo.goto(APP + '#/production');
  await theo.locator('[data-order="Purée de patate douce + Poulet Moutarde Miel (Mariné)"]').click();
  await theo.getByRole('dialog').locator('[data-need="Patate douce"]').getByText('17,00 kg').waitFor();   // 200 g × 0,85 × 100
  await theo.getByRole('dialog').getByText('à acheter, pertes comprises : 21,25 kg').waitFor();
  await theo.getByRole('dialog').locator('[data-need="Cuisse de poulet s/os"]').getByText('7,00 kg').waitFor();
  assert.equal(await theo.getByText('Coût matière estimé').count(), 0, "un équipier ne voit pas les coûts");
  await shot(theo, '13zb-production-commande');
  await theo.getByRole('button', { name: /^Liste de courses du/ }).click();
  await theo.locator('[data-buy="Beurre"]').getByText('2,57 kg').waitFor();   // (10 × 0,85 × 100 + 200 ÷ 10 × 80) × 1,05 = 2 572,5 g
  await theo.locator('[data-buy="Oeufs"]').getByText('42 pièces').waitFor();
  assert.equal(await theo.locator('[data-buy="Semoule"]').count(), 0, "le taboulé du Comptoir est livré un autre jour");
  await noOverflow(theo, 'production');
  await shot(theo, '13zc-production-courses');
  step("l'équipe voit, pour chaque commande, les quantités à produire et la liste de courses par fournisseur");

  await boss.goto(APP + '#/production');
  await boss.getByRole('button', { name: 'Liste de courses', exact: true }).first().click();
  await see(boss, 'Coût total estimé');
  await boss.locator('[data-buy="Patate douce"]').getByText(/42,50/).waitFor();   // 21,25 kg × 2 €
  await boss.getByRole('button', { name: 'Fiches', exact: true }).click();
  await boss.locator('[data-merc-recipe="Brownie"]').click();
  await boss.fill('#merc-portions', '30');
  await boss.getByRole('dialog').getByText('15 pièces').waitFor();
  await boss.getByRole('dialog').getByText('coût matière 41,0 %').waitFor();
  await boss.getByRole('button', { name: 'Fermer' }).click();
  step('le gérant voit les prix, les coûts et met une fiche à l\'échelle');

  sheets.SN_feuille_test_123.tabs.PRESTATIONS[1][3] = 120;
  gs.envoyerSiChangement();
  await theo.reload();
  await theo.locator('[data-order="Purée de patate douce + Poulet Moutarde Miel (Mariné)"]').getByText('120 portions').waitFor();
  step('une commande modifiée dans la feuille arrive toute seule dans l\'appli');

  // Un envoi refusé se voit dans Administration, sous la mercuriale concernée.
  const conf = JSON.parse(/var NUBA = (\{[\s\S]*?\n\});/.exec(script)[1]);
  execFileSync('curl', ['-s', '-X', 'POST', conf.adresse, '-H', 'Content-Type: application/json', '-H', `apikey: ${conf.clePublique}`,
    '--data-binary', JSON.stringify({ p_key: 'nuba_ancienne_cle', p_payload: { brand: 'saveurs_nomades', recipes: [], lines: [], orders: [] } })]);
  await boss.goto(APP + '#/reglages');
  await boss.locator('[data-merc-error="saveurs_nomades"]').getByText('Clé refusée').waitFor();
  assert.equal(await boss.locator('[data-merc-error="comptoir"]').count(), 0, 'le Comptoir n\'a pas d\'erreur');
  step("un envoi refusé est expliqué sous la mercuriale concernée");

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
  await boss.locator('.row', { hasText: 'iPad du bar' }).getByRole('button', { name: 'Désactiver' }).click();
  await see(boss, 'Borne désactivée');
  await ipad.getByText('Borne désactivée').waitFor({ timeout: 45_000 });
  await shot(ipad, '15-borne-desactivee');
  await ipad.getByRole('button', { name: 'Relier à une nouvelle borne' }).click();
  await see(ipad, 'Relier cette borne');
  step("une borne désactivée n'affiche plus de code");

  // 15 bis. Relier un autre appareil à la borne de la cuisine : il remplace l'ancien.
  await boss.locator('.row', { hasText: 'iPad cuisine' }).getByRole('button', { name: 'Relier un appareil' }).click();
  await see(boss, 'Relier « iPad cuisine »');
  const pairCode3 = await boss.locator('[data-testid=pair-code]').innerText();
  await boss.getByRole('button', { name: "C'est fait" }).click();
  await ipad.fill('#pair-code', pairCode3);
  await ipad.getByRole('button', { name: 'Relier' }).click();
  await see(ipad, 'Scanne ce code pour pointer');
  await installed.goto(APP + '#/borne');
  await installed.getByText('Borne désactivée').waitFor({ timeout: 45_000 });
  step("relier un nouvel appareil remplace l'ancien");

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
