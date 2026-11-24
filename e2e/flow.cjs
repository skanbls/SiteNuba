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

  // Demandes à valider : à partir de 6 personnes, la réservation en ligne attend la réponse de l'équipe.
  await boss.getByRole('button', { name: 'Réglages et lien de réservation' }).click();
  await boss.selectOption('#bk-review', '6');
  await boss.getByRole('button', { name: 'Enregistrer les réglages' }).click();
  await see(boss, 'Réglages des réservations enregistrés');
  await client.goto(APP + '#/reserver');
  await client.reload();
  await client.getByRole('button', { name: '7 personnes', exact: true }).click();
  await client.fill('#book-day', bookDay);
  await hours.getByRole('button', { name: '19:30' }).click();
  await client.locator('#book-review').getByText("l'équipe confirme chaque réservation").waitFor();
  await client.fill('#book-name', 'Groupe Lefèvre');
  await client.fill('#book-phone', '06 22 33 44 55');
  await client.fill('#book-email', 'lefevre@exemple.fr');
  await client.getByRole('button', { name: /Demander une table pour 7 personnes/ }).click();
  await see(client, 'Demande envoyée');
  await shot(client, '13q2-demande-envoyee');
  const follow = await client.getByRole('link', { name: 'Suivre ma demande' }).getAttribute('href');
  await client.goto(follow);
  await see(client, 'Demande en attente');
  await theo.goto(APP + '#/reservations');
  await theo.reload();
  const ask = theo.locator('#res-pending [data-ask="Groupe Lefèvre"]');
  await ask.getByText('Groupe Lefèvre · 7 pers.').waitFor();
  await see(theo, 'Demandes à valider · 1');
  await noOverflow(theo, 'demandes à valider');
  await shot(theo, '13q3-demandes-a-valider');
  await ask.getByRole('button', { name: 'Accepter' }).click();
  await see(theo, 'Groupe Lefèvre : réservation confirmée');
  await theo.locator('#res-pending').waitFor({ state: 'detached' });
  await client.reload();
  await see(client, 'Votre réservation confirmée');
  step("à partir de 6 personnes, la réservation en ligne est une demande : l'équipe l'accepte, le client le voit");

  await theo.getByRole('button', { name: 'Réservation', exact: true }).click();
  await theo.fill('#res-d', bookDay);
  await theo.fill('#res-name', 'Famille Roche');
  await theo.fill('#res-party', '3');
  await theo.fill('#res-slot', '12:30');
  await theo.fill('#res-email', 'roche@exemple.fr');
  assert.ok(await theo.locator('#res-notify').isChecked(), 'la confirmation par e-mail est proposée');
  await shot(theo, '13q4-reservation-telephone');
  await theo.getByRole('button', { name: 'Enregistrer' }).click();
  await see(theo, 'Réservation ajoutée, confirmation envoyée par e-mail');
  await theo.fill('#res-day', bookDay);
  await theo.locator('[data-res="Famille Roche"]').getByText('Famille Roche · 3 pers.').waitFor();
  step("une réservation prise au téléphone part avec sa confirmation par e-mail");

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
  assert.ok(await boss.locator('#mail-remind').isChecked(), 'le rappel de la veille est proposé');
  await boss.getByRole('button', { name: 'Planifier les rappels' }).click();
  await see(boss, "pg_cron n'est pas activé");
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
  await boss.fill('#merc-nuba', 'https://docs.google.com/spreadsheets/d/NB_feuille_test_789/edit');
  await boss.fill('#merc-tableau', 'https://docs.google.com/spreadsheets/d/TB_feuille_test_321/edit');
  await boss.fill('#merc-site', 'https://docs.google.com/spreadsheets/d/ST_feuille_test_654/edit');
  await boss.getByRole('button', { name: 'Créer le script' }).click();
  const script = await boss.inputValue('#merc-script');
  assert.match(script, /"cleSynchro": "nuba_[0-9a-f]{64}"/);
  assert.match(script, /"saveurs_nomades": "SN_feuille_test_123"/);
  assert.match(script, /"nuba": "NB_feuille_test_789"/);
  assert.match(script, /"tableau": "TB_feuille_test_321"/);
  assert.match(script, /"site": "ST_feuille_test_654"/);
  await shot(boss, '13za-script-mercuriales');
  await boss.getByRole('button', { name: "C'est fait" }).click();
  // Tant que le script n'est pas collé et lancé, chaque feuille dit qu'elle l'attend.
  await boss.locator('[data-merc-wait="saveurs_nomades"]').getByText('En attente du nouveau script').waitFor();
  await boss.locator('[data-merc-wait="tableau"]').waitFor();
  await boss.getByTestId('merc-key').waitFor();

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
    // Le tableau de bord financier (gérants seulement) : texte affiché et valeurs brutes, données inventées.
    TB_feuille_test_321: { name: 'TABLEAU DE BORD TEST', tabs: (() => {
      const e = (n) => ({ d: `${Math.round(n).toLocaleString('fr-FR').replace(/\u202f/g, ' ')} €`, v: n });
      const weeks = ['01/12', '08/12', '15/12', '22/12', '29/12', '05/01', '12/01', '19/01', '26/01', '02/02', '09/02', '16/02', '23/02'];
      const wk = [20000, 18000, 15000, 12500, 11000, 9500, 8200, 9000, 10500, 12000, 13500, 15500, 17000];
      const months = ['déc. 2026', 'janv. 2027', 'févr. 2027', 'mars 2027', 'avr. 2027', 'mai 2027'];
      const mo = [15000, 9800, 11000, 14000, 18000, 23000];
      return {
        'Tableau de bord': [
          ['Société test : tableau de bord financier'],
          ['Solde de référence du 01/12/2026.'],
          [],
          ['Trésorerie'],
          ['Solde bancaire retenu', e(20000), '01/12/2026'],
          ['Statut sur 13 semaines', 'ORANGE'],
          ['Marge de manœuvre', e(-1200), 'DÉPASSEMENT'],
          ['Seuil vert / seuil rouge', e(10000), e(5000)],
          ["Budget d'ouverture"],
          ['Encore disponible dans l\'enveloppe', e(3000), 'OK'],
          [],
          ['Alertes', '', '2 alerte(s) active(s)'],
          [],
          ['Trésorerie sous le seuil vert la semaine du 12/01 : pas de nouvelle dépense.'],
          ['Une échéance importante à régler sous 30 jours.'],
          [],
          ['Prochaines échéances (30 jours)'],
          ['Date', 'Libellé', 'Montant'],
          [{ d: '10/12/2026', v: new Date(Date.UTC(2026, 11, 10)) }, 'Assurance test', { d: '-300,00 €', v: -300 }],
          [{ d: '05/12/2026', v: new Date(Date.UTC(2026, 11, 5)) }, 'Loyer test', { d: '-1 200,00 €', v: -1200 }],
        ],
        'Tréso 13 semaines': [
          ['Trésorerie test (13 semaines)'], [],
          ['Début de semaine', '', ...weeks],
          ['Solde fin de semaine', '', ...wk.map(e)],
          ['Seuil vert', '', ...wk.map(() => e(10000))],
          ['Seuil rouge', '', ...wk.map(() => e(5000))],
          ['Statut', '', ...wk.map((v) => (v < 10000 ? 'ORANGE' : 'VERT'))],
        ],
        'Prévisionnel 12 mois': [
          ['Prévisionnel test'], [],
          ['Mois', '', ...months],
          ['Solde fin de mois', '', ...mo.map(e)],
          ['Seuil vert', '', ...mo.map(() => e(10000))],
          ['Seuil rouge', '', ...mo.map(() => e(5000))],
          ['Solde fin si le CA est inférieur de 30 % (test de résistance)', '', ...mo.map((v) => e(v * 0.7))],
        ],
        'Historique KPI': [['Date', 'Solde retenu', 'Statut 13 semaines'], ['24/11/2026', e(21000), 'VERT'], ['01/12/2026', e(20000), 'ORANGE']],
      };
    })() },
    // Le contenu du site web : programmation, rendez-vous, exposition (données inventées).
    ST_feuille_test_654: { name: 'Contenu du site test', tabs: {
      Programmation: [
        ['Date', 'Type', 'Titre', 'Description', 'Horaire', 'Entrée', 'Visible', 'Titre EN', 'Réf. Titre', 'Affiche'],
        [{ d: 'date', v: iso(5) }, 'DJ set', 'Soirée test DJ', 'House et disco.', '22h → 2h', 'Entrée libre', '', 'Test DJ night', 'Soirée test DJ', 'https://drive.google.com/file/d/AfficheTest123456/view?usp=sharing'],
        [{ d: 'date', v: iso(6) }, 'Concert', 'Concert test', 'Un trio.', '21h → 23h30', '5 €', 'OUI', '', '', ''],
        [{ d: 'date', v: iso(7) }, 'Quiz', 'Quiz masqué', '', '20h30', '', 'NON', '', '', ''],
      ],
      'Chaque semaine': [['Jour', 'Rendez-vous', 'Horaire', 'Visible'], ['Jeudi', 'Quiz test du jeudi', 'dès 20h30', 'OUI'], ['Samedi', 'Caché', '', 'NON']],
      Exposition: [['Champ', 'Français'], ["Afficher l'exposition", 'OUI'], ['Titre', 'Expo test'], ['Artiste', 'Artiste test, peintures'],
        ['Début', { d: 'date', v: iso(-2) }], ['Fin', { d: 'date', v: iso(40) }], ['Accès', 'Entrée libre']],
      'Œuvres': [['Titre', 'Technique', 'Dimensions', 'Image', 'Visible'], ['Toile test', 'Acrylique', '60 × 60 cm', '', '']],
    } },
    // La mercuriale Nuba : la carte du restaurant, en blocs (données inventées).
    NB_feuille_test_789: { name: 'MERCURIALE NUBA', tabs: {
      'FICHES PLATS': [
        ['Fiches techniques cuisine'], [],
        ['Plat', 'Velouté test', '', '', 'État de la fiche', '', 'OK'],
        ['Catégorie', 'Entrée', '', '', 'Coût matière / portion (€)', '', 1.25, 'Allergènes', 'Lait'],
        ['Portions produites par la fiche', 2, '', '', 'Prix de vente HT (€)', '', 6.363636, 'Marge brute / portion (€)', 5.11],
        ['Prix de vente TTC carte (€)', 7, '', '', 'Coût matière %', '', 0.1964, 'Coefficient (prix TTC / coût)', 5.6],
        ['Taux de TVA (selon la catégorie)', 0.1, '', '', 'Objectif coût matière %', '', 0.25, 'Prix TTC conseillé (€)', 5.5],
        ['Ingrédient', 'Quantité nette pour la fiche', 'Unité', 'Pertes', 'Quantité brute à sortir', 'Prix unitaire (€)', 'Coût avec pertes (€)', 'Fournisseur', 'Allergènes'],
        ['Légume test', 300, 'g', 0.2, 360, 0.002, 0.72, 'Primeur', ''],
        ['Crème test', '', 'ml', 0.05, '', 0.004, '', 'Grossiste', 'Lait'],
        ['Sauce test (maison)', 40, 'g', 0, 40, 0.0025, 0.1, 'Maison', 'Lait'],
        [], [],
        ['Plat', 'Burger test', '', '', 'État de la fiche', '', 'Quantités à saisir'],
        ['Catégorie', 'Plat', '', '', 'Coût matière / portion (€)', '', '', 'Allergènes', 'Gluten, Œufs'],
        ['Portions produites par la fiche', 1, '', '', 'Prix de vente HT (€)', '', 15, 'Marge brute / portion (€)', ''],
        ['Prix de vente TTC carte (€)', 16.5, '', '', 'Coût matière %', '', '', 'Coefficient (prix TTC / coût)', ''],
        ['Taux de TVA (selon la catégorie)', 0.1, '', '', 'Objectif coût matière %', '', 0.3, 'Prix TTC conseillé (€)', ''],
        ['Ingrédient', 'Quantité nette pour la fiche', 'Unité', 'Pertes', 'Quantité brute à sortir', 'Prix unitaire (€)', 'Coût avec pertes (€)', 'Fournisseur', 'Allergènes'],
        ['Pain test', '', 'pièce', 0, '', 0.5, '', 'Boulanger', 'Gluten, Œufs'],
        [], [],
        ['Plat', '', '', '', 'État de la fiche', '', ''],
      ],
      'FICHES BOISSONS': [
        ['Boisson', 'Cocktail test', '', '', 'État de la fiche', '', 'Doses à saisir'],
        ['Catégorie', 'Cocktail', '', '', 'Coût matière / portion (€)', '', '', 'Allergènes', 'Aucun déclaré'],
        ['Portions produites par la fiche', 1, '', '', 'Prix de vente HT (€)', '', 7.5],
        ['Prix de vente TTC carte (€)', 9],
        ['Ingrédient', 'Dose (cl, g ou pièce)', 'Unité', 'Pertes', 'Quantité brute', 'Prix unitaire (€)', 'Coût avec pertes (€)', 'Fournisseur', 'Allergènes'],
        ['Rhum test', '', 'cl', 0.02, '', 0.3, '', 'Cave', ''],
      ],
      'PREPARATIONS MAISON': [
        ['Préparation', 'Sauce test (maison)', '', '', 'État de la fiche', '', 'OK'],
        ['Rendement : quantité finale obtenue', 1.2, '', '', 'Coût matière total (€)', '', 3, 'Allergènes', 'Lait'],
        ['Unité du rendement (kg, L ou pièce)', 'kg', '', '', 'Coût par kg, L ou pièce (€)', '', 2.5, 'Utilisée dans', 'Velouté test'],
        ['Unité dans les fiches', 'g', '', '', 'Coût par unité dans les fiches (€)', '', 0.0025],
        ['Rendement : poids (kg), volume (L) ou nombre de portions (pièce) obtenu en fin de recette, pesé ou compté.'],
        ['Ingrédient', 'Quantité nette pour la fiche', 'Unité', 'Pertes', 'Quantité brute à sortir', 'Prix unitaire (€)', 'Coût avec pertes (€)', 'Fournisseur', 'Allergènes'],
        ['Yaourt test', 1000, 'g', 0.05, 1050, 0.0028, 2.94, 'Grossiste', 'Lait'],
      ],
      CALCUL: [
        ['Ingrédient (base de prix)', 'Unité cuisine', 'Prix / unité cuisine (€)', 'Unité bar', 'Prix / unité bar (€)', 'Pertes', 'Fournisseur', 'Allergènes', 'Allergènes à vérifier'],
        ['Yaourt test', 'g', 0.0028, 'g', 0.0028, 0.05, 'Grossiste', 'Lait', "Vérifier l'étiquette"],
      ],
    } },
  };
  const props = new Map();
  const google = {
    SpreadsheetApp: { openById: (id) => ({ getName: () => sheets[id].name, getSheetByName: (n) => {
      const t = sheets[id].tabs[n];
      if (!t) return null;
      // Une case peut donner sa valeur et son texte affiché, comme Google Sheets.
      const shown = (c) => c !== null && typeof c === 'object' && !(c instanceof Date);
      return { getDataRange: () => ({ getValues: () => t.map((r) => r.map((c) => (shown(c) ? c.v : c))), getDisplayValues: () => t.map((r) => r.map((c) => (shown(c) ? c.d : String(c)))) }) };
    } }) },
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
  await boss.locator('[data-merc="nuba"]').getByText('2 plats, 1 boisson, 1 préparation maison · 2 fiches à compléter').waitFor();
  await boss.locator('[data-merc="tableau"]').getByText(/Reçu .* gérants seulement/).waitFor();
  await boss.locator('[data-merc="site"]').getByText('2 soirées, 1 rendez-vous de la semaine, une exposition').waitFor();
  step('le gérant relie les mercuriales : le script Google généré envoie fiches, commandes et prix');

  // La programmation du site arrive dans Événements, affiche comprise.
  await theo.goto(APP + '#/evenements');
  await theo.reload();
  const dj = theo.locator('[data-event="Soirée test DJ"]');
  await dj.getByText('DJ set').waitFor();
  await dj.getByText(/22h → 2h/).waitFor();
  await theo.locator('[data-event="Concert test"]').waitFor();
  await theo.locator('[data-event="Expo test"]').waitFor();
  assert.equal(await theo.locator('[data-event="Quiz masqué"]').count(), 0, 'une soirée masquée dans le fichier ne vient pas');
  await theo.locator('#weekly [data-weekly="Quiz test du jeudi"]').getByText('Jeudi · dès 20h30').waitFor();
  await noOverflow(theo, 'programmation');
  await shot(theo, '13zaa-programmation');
  await dj.click();
  const djSheet = theo.getByRole('dialog');
  await djSheet.locator('[data-site-event]').waitFor();
  await djSheet.locator('img.poster, a:has-text("Voir l\'affiche")').first().waitFor();
  await djSheet.getByText('House et disco.').waitFor();
  await djSheet.getByText('Animateur ou DJ confirmé').waitFor();
  await shot(theo, '13zab-soiree-du-site');
  await djSheet.getByRole('button', { name: 'Fermer' }).click();
  step("la programmation du site arrive toute seule dans Événements : soirées, affiche, exposition, rendez-vous de la semaine");

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
  // Classée par famille ; une case cochée sur le téléphone l'est aussi sur les autres appareils.
  await theo.locator('[data-family="Crèmerie"] [data-buy="Beurre"]').waitFor();
  await theo.locator('[data-family="Fruits et légumes"] [data-buy="Patate douce"]').waitFor();
  await theo.getByLabel('Beurre dans le panier').check();
  await theo.getByTestId('courses-progression').getByText(/^1 sur \d+ dans le panier$/).waitFor();
  assert.equal(await theo.locator('[data-buy="Semoule"]').count(), 0, "le taboulé du Comptoir est livré un autre jour");
  await noOverflow(theo, 'production');
  await shot(theo, '13zc-production-courses');
  step("l'équipe voit, pour chaque commande, les quantités à produire et la liste de courses par fournisseur");

  // Fiches process : le gérant importe le fichier préparé (étapes, dressage, photo) ; l'équipe l'ouvre depuis la commande.
  const procFile = 'e2e/.out/fiches-process-test.json';
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAMCAIAAADkharWAAAAF0lEQVR4nGPc5mXGQApgIkn1qIYRpAEA5BYBTmaiENwAAAAASUVORK5CYII=';
  fs.writeFileSync(procFile, JSON.stringify({ format: 'nuba-process-1', items: [
    { brand: 'saveurs_nomades', name: 'Purée de patate douce + Poulet Moutarde Miel (Mariné)', dressing: 'Purée au fond de la barquette.\nPoulet tranché par-dessus.', haccp: 'Fermer et étiqueter aussitôt.', photo: pixel },
    { brand: 'saveurs_nomades', name: 'Purée de patate douce', steps: '# Cuisson\nÉplucher les patates douces test.\n2. Cuire à l\'eau salée.\n# Finition\nMixer avec le beurre.', haccp: 'Refroidir sous 10 °C en moins de 2 h.' },
    { brand: 'saveurs_nomades', name: 'Poulet Moutarde Miel (Mariné)', steps: 'Mariner 12 h au froid.\nCuire à cœur à 75 °C.' },
    { brand: 'nuba', name: 'Ignorée' },
  ] }));
  await boss.goto(APP + '#/production');
  await boss.reload();
  await boss.getByRole('button', { name: 'Fiches', exact: true }).click();
  await boss.getByRole('button', { name: 'Importer des fiches process' }).click();
  await boss.setInputFiles('#process-import', procFile);
  await boss.getByTestId('process-import-count').getByText('3 fiches dans le fichier, dont 1 avec photo.').waitFor();
  await boss.getByRole('dialog').getByRole('button', { name: 'Importer', exact: true }).click();
  await see(boss, '3 fiches process importées');
  await theo.goto(APP + '#/production');
  await theo.reload();
  await theo.locator('[data-order="Purée de patate douce + Poulet Moutarde Miel (Mariné)"]').click();
  await theo.getByRole('link', { name: 'Fiche process : étapes et dressage' }).click();
  await see(theo, 'Éplucher les patates douces test.');
  await theo.locator('.process-phase h3', { hasText: 'Cuisson' }).first().waitFor();
  await theo.locator('[data-process-qty="Purée de patate douce"]').getByText('17,00 kg').waitFor();
  await see(theo, 'Cuire à cœur à 75 °C.');
  await see(theo, 'Poulet tranché par-dessus.');
  await see(theo, 'Refroidir sous 10 °C en moins de 2 h.');
  await theo.waitForFunction(() => { const i = document.querySelector('.process-figure img'); return !!i && i.complete && i.naturalWidth > 0; });
  assert.equal(await theo.getByRole('button', { name: 'Modifier' }).count(), 0, 'un équipier ne modifie pas les fiches process');
  await noOverflow(theo, 'fiche process');
  await shot(theo, '13zca-fiche-process');
  await theo.goto(APP + '#/production');
  await theo.locator('[data-order="Purée de patate douce + Poulet Moutarde Miel (Mariné)"]').waitFor();
  step('fiches process : importées par le gérant, ouvertes par l\'équipe depuis la commande, avec étapes, quantités, dressage et photo');

  await boss.goto(APP + '#/production');
  await boss.getByRole('button', { name: 'Liste de courses', exact: true }).first().click();
  await see(boss, 'Coût total estimé');
  await boss.locator('input[aria-label="Beurre dans le panier"]:checked').waitFor();   // la case cochée par Théo l'est aussi pour le gérant
  await boss.getByRole('button', { name: 'Par fournisseur' }).click();
  await boss.locator('[data-family="Metro"] [data-buy="Beurre"]').waitFor();
  await boss.getByRole('button', { name: 'Par famille' }).click();
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

  // Bons de livraison : le gérant remplit l'en-tête une fois ; le bon de chaque jour se fabrique tout seul.
  await boss.goto(APP + '#/reglages');
  await boss.getByTestId('bl-reglages').getByText('En-tête à remplir').waitFor();
  await boss.getByRole('button', { name: "Modifier l'en-tête" }).click();
  await boss.fill('#bl-sender_name', 'Société Test');
  await boss.fill('#bl-sender_siret', '000 000 000 00000');
  await boss.fill('#bl-client_name', 'Client Test');
  await boss.fill('#bl-place_name', 'Cuisine du client');
  await boss.fill('#bl-slot', '06h30');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'En-tête des bons de livraison enregistré');
  await boss.getByTestId('bl-reglages').getByText('Société Test → Client Test').waitFor();
  await boss.goto(APP + '#/');   // quitter Administration : la revisiter plus loin la rechargera

  const blDay = iso(2).toISOString().slice(0, 10);
  const pad2 = (n) => String(n).padStart(2, '0');
  const veille = new Date(iso(1)), dlc = new Date(iso(5));
  const lot = `L${String(veille.getUTCFullYear()).slice(2)}${pad2(veille.getUTCMonth() + 1)}${pad2(veille.getUTCDate())}`;
  await theo.goto(APP + '#/production');
  await theo.locator(`[data-bl-day="${blDay}"]`).click();
  await theo.locator('[data-bl]').waitFor();
  assert.equal(await theo.locator('[data-bl]').getAttribute('data-bl'), `BL-${blDay.slice(0, 4)}-${blDay.slice(5, 7)}${blDay.slice(8)}-01`);
  const surMesure = theo.locator('[data-bl-line="Purée de patate douce / Poulet Moutarde Miel (Mariné)"]');
  await surMesure.getByText('Allergènes : Lait, Moutarde').waitFor();
  await surMesure.getByText('Sur mesure · Barquettes scellées').waitFor();
  await theo.locator('[data-bl-line="Brownie"]').getByText(lot).waitFor();
  await theo.locator('[data-bl-line="Brownie"]').getByText(`${pad2(dlc.getUTCDate())}/${pad2(dlc.getUTCMonth() + 1)}/${dlc.getUTCFullYear()}`).waitFor();   // DLC : livraison + 3 jours
  await see(theo, 'Société Test');
  await theo.fill('#bl-temp', '2');
  await theo.locator('[data-bl-line="Brownie"]').getByText('+2,0 °C').waitFor();
  await theo.getByLabel('Quantité livrée, Brownie').fill('78');
  await theo.getByTestId('bl-total').getByText('198').waitFor();   // 120 + 78
  await noOverflow(theo, 'bon de livraison');
  await shot(theo, '13zba-bon-de-livraison');
  await theo.evaluate(() => { window.print = () => { window.__printed = document.title; }; });
  await theo.getByRole('button', { name: 'Imprimer' }).click();
  assert.match(await theo.evaluate(() => window.__printed), /^BL-\d{4}-\d{4}-01$/, 'le PDF prend le numéro du bon pour nom');
  await theo.emulateMedia({ media: 'print' });
  assert.equal(await theo.locator('.bl-bar').isVisible(), false, "la barre d'outils ne s'imprime pas");
  const pdf = await theo.pdf({ path: `${SHOTS}/13zba-bon-de-livraison.pdf`, format: 'A4', printBackground: true });
  assert.equal((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length, 1, 'le bon tient sur une page A4');
  await theo.emulateMedia({ media: 'screen' });
  await theo.getByRole('group', { name: 'Marque' }).getByRole('button', { name: 'Comptoir' }).click();
  await see(theo, 'Aucune commande à cette date.');
  assert.match(await theo.locator('[data-bl]').getAttribute('data-bl'), /-CM$/);
  step('bon de livraison du jour, prêt à imprimer en A4 : lot, DLC, allergènes, température et quantités livrées');

  // Un envoi refusé se voit dans Administration, sous la mercuriale concernée.
  const conf = JSON.parse(/var NUBA = (\{[\s\S]*?\n\});/.exec(script)[1]);
  execFileSync('curl', ['-s', '-X', 'POST', conf.adresse, '-H', 'Content-Type: application/json', '-H', `apikey: ${conf.clePublique}`,
    '--data-binary', JSON.stringify({ p_key: 'nuba_ancienne_cle', p_payload: { brand: 'saveurs_nomades', recipes: [], lines: [], orders: [] } })]);
  await boss.goto(APP + '#/reglages');
  await boss.locator('[data-merc-error="saveurs_nomades"]').getByText(/Clé refusée.*n'a pas la dernière clé/).waitFor();
  assert.equal(await boss.locator('[data-merc-error="comptoir"]').count(), 0, 'le Comptoir n\'a pas d\'erreur');
  step("un envoi refusé est expliqué sous la mercuriale concernée");

  // 13 decies bis. La carte Nuba : fiches pour la cuisine et le bar, allergènes pour la salle, quantités pour la mise en place.
  await theo.goto(APP + '#/fiches');
  await theo.locator('[data-carte="Velouté test"]').getByText('7,00 €').waitFor();
  await theo.locator('[data-carte="Burger test"]').getByText('Quantités à saisir').waitFor();
  assert.equal(await theo.getByTestId('carte-synthese').count(), 0, "un équipier ne voit pas la synthèse des coûts");
  await theo.locator('[data-carte="Velouté test"]').click();
  await theo.getByTestId('fiche-allergenes').getByText('Lait').waitFor();
  await theo.fill('#carte-qty', '10');
  await theo.locator('[data-line="Légume test"]').getByText('1,5 kg').waitFor();             // 300 g pour 2 portions, 10 portions
  await theo.locator('[data-line="Légume test"]').getByText('à sortir : 1,8 kg').waitFor();
  await theo.locator('[data-line="Crème test"]').getByText('à saisir').waitFor();
  assert.equal(await theo.getByTestId('fiche-couts').count(), 0, "un équipier ne voit pas les coûts");
  await noOverflow(theo, 'fiche de la carte');
  await shot(theo, '13zd-carte-fiche');
  await theo.getByRole('button', { name: 'Sauce test (maison)' }).click();
  await theo.locator('[data-line="Yaourt test"]').getByText('1 kg').waitFor();
  await see(theo, "Vérifier l'étiquette");
  await theo.getByRole('button', { name: /Retour à Velouté test/ }).click();
  await theo.locator('[data-line="Légume test"]').waitFor();
  await theo.getByRole('button', { name: 'Fermer' }).click();

  await theo.getByRole('button', { name: 'Allergènes', exact: true }).click();
  const allergic = theo.getByRole('group', { name: 'Allergènes du client' });
  await allergic.getByRole('button', { name: 'Œufs' }).click();
  await theo.getByTestId('allergenes-ok').locator('[data-allergen-row="Cocktail test"]').waitFor();
  await theo.getByTestId('allergenes-check').locator('[data-allergen-row="Velouté test"]').waitFor();   // yaourt de la sauce à vérifier
  await theo.getByTestId('allergenes-non').locator('[data-allergen-row="Burger test"]').waitFor();
  await allergic.getByRole('button', { name: 'Lait' }).click();
  await theo.getByTestId('allergenes-non').locator('[data-allergen-row="Velouté test"]').waitFor();
  await noOverflow(theo, 'allergènes de la carte');
  await shot(theo, '13zd-carte-allergenes');

  await theo.getByRole('button', { name: 'Quantités', exact: true }).click();
  await theo.selectOption('#qty-pick', { label: 'Velouté test' });
  await theo.fill('#qty-n', '10');
  await theo.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await theo.locator('[data-prep="Sauce test (maison)"]').getByText('200 g').waitFor();          // 40 g pour 2 portions, 10 portions
  await theo.locator('[data-raw="Légume test"]').getByText('1,8 kg').waitFor();
  await theo.locator('[data-raw="Yaourt test"]').getByText('175 g').waitFor();                    // 1 050 g pour 1,2 kg de sauce, 200 g de sauce
  await theo.getByTestId('quantites-manques').getByText(/Crème test/).waitFor();
  assert.equal(await theo.getByText('Coût matière estimé').count(), 0, "un équipier ne voit pas les coûts");
  await noOverflow(theo, 'quantités de la carte');
  await shot(theo, '13zd-carte-quantites');
  await theo.reload();
  await theo.getByRole('button', { name: 'Quantités', exact: true }).click();
  await theo.locator('[data-want="Velouté test"]').waitFor();
  await theo.getByRole('button', { name: "Fiches de l'appli" }).click();
  await theo.locator('[data-recipe="Gin tonic"]').waitFor();
  await ines.goto(APP + '#/fiches');
  await ines.reload();   // déjà sur cette page : même adresse, pas de rechargement
  await ines.locator('[data-carte="Velouté test"]').waitFor();
  assert.equal(await ines.getByTestId('carte-synthese').count(), 0, "sans l'accès fiches techniques, pas de coûts");
  step("la carte Nuba : fiches à l'échelle, préparations maison, allergènes pour la salle, quantités pour la mise en place");

  await boss.goto(APP + '#/fiches');
  await boss.getByTestId('carte-synthese').getByText('1 / 2').waitFor();
  await boss.locator('[data-carte="Velouté test"]').getByText('19,6 %').waitFor();
  await boss.locator('[data-carte="Velouté test"]').click();
  await boss.getByTestId('fiche-couts').getByText('objectif 25,0 %').waitFor();
  await boss.locator('[data-line="Légume test"]').getByText(/2,00\s€ le kg/).waitFor();
  await boss.locator('[data-line="Légume test"]').getByText(/0,72\s€/).waitFor();
  await shot(boss, '13zd-carte-gerant');
  await boss.getByRole('button', { name: 'Fermer' }).click();
  await boss.getByRole('button', { name: 'Quantités', exact: true }).click();
  await boss.selectOption('#qty-pick', { label: 'Velouté test' });
  await boss.fill('#qty-n', '10');
  await boss.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await see(boss, 'Coût matière estimé');
  step('le gérant voit coûts, marges et objectif de chaque fiche de la carte');

  // 13 decies quater. Tableau de bord financier : les gérants seulement.
  await boss.goto(APP + '#/tableau-de-bord');
  await boss.getByTestId('dash-hero').getByText('20 000 €').waitFor();
  await boss.getByTestId('dash-hero').locator('[data-status="ORANGE"]').waitFor();
  await boss.getByTestId('dash-alertes').getByText('pas de nouvelle dépense').waitFor();
  await boss.locator('[data-kpi="Marge de manœuvre"]').locator('[data-status="DÉPASSEMENT"]').waitFor();
  await boss.locator('[data-kpi="Seuil vert / seuil rouge"]').getByText('10 000 € / 5 000 €').waitFor();
  assert.deepEqual(await boss.getByTestId('dash-echeances').locator('[data-due]').evaluateAll((els) => els.map((e) => e.getAttribute('data-due'))), ['Loyer test', 'Assurance test'], 'échéances par date');
  const chart13 = boss.getByTestId('chart-13');
  await chart13.locator('path.line.is-main').waitFor();
  await chart13.getByText(/plus bas 8\s200\s€/).waitFor();
  const plot = await chart13.locator('svg rect').boundingBox();
  await boss.mouse.move(plot.x + plot.width / 2, plot.y + plot.height / 2);
  await chart13.locator('.chart-tip').getByText('État : ORANGE').waitFor();
  await boss.getByTestId('chart-12').locator('.chart-legend').getByText('Si le CA est 30 % plus bas').waitFor();
  await boss.getByTestId('chart-12').getByText('Voir les chiffres').click();
  await boss.getByTestId('chart-12').locator('table').getByText('janv. 2027').waitFor();
  await shot(boss, '13zf-tableau-de-bord');
  await bossPhone.goto(APP + '#/tableau-de-bord');
  await bossPhone.getByTestId('chart-13').locator('path.line.is-main').waitFor();
  await noOverflow(bossPhone, 'tableau de bord');
  await shot(bossPhone, '13zf-tableau-de-bord-telephone');
  await boss.goto(APP + '#/');
  await boss.getByTestId('today-tresorerie').getByText('ORANGE').waitFor();
  for (const [who, page] of [['un équipier', theo], ['une responsable', ines]]) {
    await page.goto(APP + '#/tableau-de-bord');
    await page.waitForFunction(() => location.hash === '#/');
    assert.equal(await page.getByRole('link', { name: 'Tableau de bord' }).count(), 0, `${who} n'a pas le tableau de bord dans le menu`);
  }
  step('tableau de bord financier : alertes, trésorerie et échéances, pour les gérants seulement');

  // 13 undecies. Numéros utiles : la responsable en ajoute un, l'équipier l'appelle d'un geste.
  await ines.goto(APP + '#/numeros');
  await ines.locator('[data-contact="SAMU, urgence médicale"]').waitFor();
  await ines.getByRole('button', { name: 'Numéro', exact: true }).click();
  await ines.fill('#ct-name', 'Plombier Garcia');
  await ines.fill('#ct-phone', '06 12 34 56 78');
  await ines.fill('#ct-note', 'Fuite, évacuation bouchée');
  await ines.getByRole('button', { name: 'Enregistrer' }).click();
  await see(ines, 'Numéro ajouté');
  await theo.goto(APP + '#/numeros');
  assert.equal(await theo.locator('[data-contact="Plombier Garcia"] a').getAttribute('href'), 'tel:0612345678');
  assert.equal(await theo.locator('[data-contact="SAMU, urgence médicale"] a').getAttribute('href'), 'tel:15');
  assert.equal(await theo.getByRole('button', { name: 'Numéro', exact: true }).count(), 0, "un équipier n'ajoute pas de numéro");
  assert.equal(await theo.getByRole('button', { name: 'Modifier Plombier Garcia' }).count(), 0, "un équipier ne modifie pas de numéro");
  await noOverflow(theo, 'numéros utiles');
  await shot(theo, '13zd-numeros');
  step("les numéros utiles s'appellent d'un geste ; seuls gérant et responsables les modifient");

  // 13 undecies bis. Documents : Théo envoie son arrêt de travail depuis son téléphone.
  const sick = new Date();
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await theo.goto(APP + '#/compte');
  await theo.getByTestId('mes-documents').getByText('Aucun document envoyé.').waitFor();
  await theo.getByRole('button', { name: 'Envoyer un document' }).click();
  await theo.selectOption('#doc-category', 'arret');
  await theo.setInputFiles('#doc-file', { name: 'arret.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 arrêt de test') });
  await theo.fill('#doc-start', ymd(sick));
  await theo.fill('#doc-end', ymd(sick));
  await shot(theo, '13zg-envoyer-arret');
  await theo.getByRole('dialog').getByRole('button', { name: 'Envoyer', exact: true }).click();
  await see(theo, 'Arrêt envoyé');
  await theo.getByTestId('mes-documents').getByText('Arrêt de travail (maladie)').waitFor();
  await theo.goto(APP + '#/planning');
  await theo.getByText(/Théo Martin · Arrêt maladie/).first().waitFor();
  await ines.goto(APP + '#/planning');
  await ines.reload();
  await ines.locator('.week [data-away]').first().waitFor();
  // L'équipe sait qui est absent ; le motif, seulement les responsables et le gérant.
  await boss.goto(APP + '#/equipe');
  await boss.locator('button.row', { hasText: 'Théo Martin' }).click();
  await boss.getByTestId('membre-documents').getByText('Arrêt de travail (maladie)').waitFor();
  await boss.getByRole('button', { name: 'Fermer' }).click();
  step("un employé envoie son arrêt de travail depuis l'appli : noté dans le planning, rangé dans ses documents");

  // 13 duodecies. Accès comptable : récap du mois, documents de l'équipe, caisse.
  await boss.goto(APP + '#/reglages');
  await boss.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await boss.fill('#acc-name', 'Cabinet Durand');
  await boss.fill('#acc-email', 'Compta@Cabinet.test');
  await boss.getByRole('button', { name: 'Enregistrer' }).click();
  await see(boss, 'Accès créé');
  await boss.locator('[data-accountant="compta@cabinet.test"]').getByText("En attente d'inscription").waitFor();
  const compta = await open('comptable', { width: 1180, height: 820 });
  await signup(compta, 'Claire', 'compta@cabinet.test');
  await compta.getByRole('heading', { name: 'Espace comptable' }).waitFor();
  await compta.getByRole('button', { name: 'Ce mois', exact: true }).click();
  await compta.locator('[data-person="Théo Martin"]').waitFor();
  await compta.locator('[data-person="Théo Martin"] summary').click();
  await compta.locator('[data-absences="Théo Martin"]').getByText('Arrêt maladie').waitFor();
  assert.equal(await compta.locator('nav.side').count(), 0, "la comptable n'a pas le menu de l'équipe");
  const [hoursFile] = await Promise.all([compta.waitForEvent('download'), compta.getByRole('button', { name: /Détail des pointages/ }).click()]);
  const hoursCsv = fs.readFileSync(await hoursFile.path(), 'utf8');
  assert.ok(hoursCsv.includes('Théo Martin') && hoursCsv.includes('Total par personne'), 'le détail des pointages');
  const [recapFile] = await Promise.all([compta.waitForEvent('download'), compta.getByRole('button', { name: /Télécharger le récap/ }).click()]);
  const recapCsv = fs.readFileSync(await recapFile.path(), 'utf8');
  assert.ok(recapCsv.includes('Récapitulatif') && recapCsv.includes('Martin') && recapCsv.includes('Arrêt maladie (jours calendaires)'), 'le récap du mois pour la paie');
  await shot(compta, '13ze-comptable');
  await compta.getByRole('button', { name: 'Documents', exact: true }).click();
  const recent = compta.getByTestId('docs-recents').locator('[data-doc="Arrêt de travail (maladie)"]');
  await recent.getByText('Théo Martin').waitFor();
  // La fenêtre s'ouvre vide au toucher (sinon l'iPhone la bloque), puis reçoit le lien temporaire du fichier.
  const docRequest = compta.context().waitForEvent('request', (r) => /\/storage\/v1\/object\/sign\/staff-docs\//.test(r.url()) && r.method() === 'GET');
  const [docTab] = await Promise.all([compta.waitForEvent('popup'), recent.getByRole('button', { name: /Ouvrir/ }).click()]);
  const docUrl = (await docRequest).url();
  const fetched = await compta.request.get(docUrl);
  assert.ok((await fetched.body()).toString().includes('arrêt de test'), 'le lien temporaire donne le fichier envoyé');
  await docTab.close().catch(() => {});
  await shot(compta, '13ze-comptable-documents');
  await compta.getByRole('button', { name: 'Caisse', exact: true }).click();
  await compta.getByTestId('caisse').getByText("Le gérant n'a pas encore ajouté le lien de la caisse.").waitFor();
  await compta.goto(APP + '#/planning');
  await compta.getByRole('heading', { name: 'Espace comptable' }).waitFor();
  assert.equal(await compta.getByText('Bonjour').count(), 0, "aucun autre écran de l'appli");
  await boss.reload();
  await boss.locator('[data-accountant="compta@cabinet.test"]').getByText('Compte créé').waitFor();
  step("la comptable a son espace : récap du mois avec les absences, documents de l'équipe, caisse ; rien d'autre");

  // Bulletins de paie : la comptable dépose celui de Théo, qui le retrouve dans son compte.
  const payMonth = ymd(new Date()).slice(0, 7);
  await compta.getByRole('button', { name: 'Documents', exact: true }).click();
  await compta.getByRole('button', { name: 'Déposer les bulletins de paie' }).click();
  await compta.fill('#paie-month', payMonth);
  await compta.getByLabel('Bulletin de Théo Martin').setInputFiles({ name: 'bulletin.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 bulletin de test') });
  await shot(compta, '13zh-deposer-bulletins');
  await compta.getByRole('button', { name: 'Déposer 1 bulletin' }).click();
  await see(compta, 'bulletin de');
  const slip = compta.locator(`[data-person-docs="Théo Martin"] [data-month="${payMonth}"]`);
  await slip.waitFor();
  await theo.goto(APP + '#/compte');
  await theo.getByTestId('mes-bulletins').locator(`[data-month="${payMonth}"]`).getByText('Bulletin de paie').waitFor();
  assert.equal(await theo.getByTestId('mes-documents').getByText('Bulletin de paie').count(), 0, 'les bulletins ont leur propre rubrique');
  await shot(theo, '13zh-mes-bulletins');
  await slip.getByRole('button', { name: /Supprimer/ }).click();
  await see(compta, 'Bulletin retiré');
  await slip.waitFor({ state: 'detached' });
  step('la comptable dépose les bulletins de paie du mois ; chaque salarié retrouve le sien dans son compte');

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
  await dark.goto(APP + '#/compte');
  await dark.getByRole('button', { name: 'Clair', exact: true }).click();
  assert.equal(await dark.evaluate(() => document.documentElement.dataset.theme), 'light');
  await dark.reload();
  await see(dark, 'Apparence');
  assert.equal(await dark.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(247, 237, 225)', 'le choix « Clair » tient après rechargement');
  await shot(dark, '16b-compte-clair');
  await dark.getByRole('button', { name: "Comme l'appareil" }).click();
  assert.equal(await dark.evaluate(() => document.documentElement.dataset.theme ?? ''), '');
  step('chacun choisit le thème clair ou sombre sur son appareil');

  // 17. Installer l'appli : page publique avec QR code, étapes adaptées à l'appareil.
  const phone = await open('téléphone', { width: 390, height: 844 }, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  await phone.goto(APP);
  await phone.getByRole('link', { name: "Installer l'appli sur cet appareil" }).click();
  await phone.getByRole('heading', { name: "Installer l'appli" }).waitFor();
  await shot(phone, '17-installer');
  assert.equal(await phone.locator('details[data-device="ios"]').getAttribute('open'), '', "les étapes de l'iPhone sont ouvertes");
  await phone.locator('details[data-device="ios"]').getByText(/Sur l.écran d.accueil/).waitFor();
  await phone.locator('.install-qr svg').waitFor();
  await noOverflow(phone, "page d'installation");
  await shot(phone, '17-installer');
  step("la page d'installation guide pas à pas et donne le QR code de l'appli");

  // 18. Le guide de l'appli, lisible sans compte.
  await phone.getByRole('link', { name: "Ensuite : lire le guide de l'appli" }).click();
  await phone.getByRole('heading', { name: "Bienvenue dans l'appli de la Nuba" }).waitFor();
  await phone.locator('#g-debut').getByText('Créer mon compte').waitFor();
  assert.equal(await phone.locator('#g-hygiene').getAttribute('open'), null, 'les parties sont repliées au départ');
  await phone.getByRole('navigation', { name: 'Sommaire' }).getByText('Hygiène', { exact: true }).click();
  await phone.locator('#g-hygiene').getByText('Relever').waitFor();
  await noOverflow(phone, "guide de l'appli");
  await shot(phone, '18-guide');
  step("le guide explique l'appli pas à pas, partie par partie");

  await browser.close();
  assert.deepEqual(errors, [], 'erreurs dans le navigateur :\n' + errors.join('\n'));
  console.log('Parcours complet : OK');
}

main().catch((e) => {
  console.error('\nÉCHEC : ' + (e && e.message ? e.message : e));
  if (errors.length) console.error('Erreurs du navigateur :\n' + errors.join('\n'));
  process.exit(1);
});
