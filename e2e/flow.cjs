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
