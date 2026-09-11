# Futsal — équipes équilibrées (webapp)

Même appli que l'artefact Claude (notes attaque/défense, génération
d'équipes équilibrées, MVP, historique, export/import), mais hébergée
sur un vrai lien accessible à toute l'équipe, avec une base de données
partagée (Supabase) au lieu du stockage lié à ton compte Claude.

## 1. Créer la base de données (Supabase, gratuit)

1. Va sur https://supabase.com, crée un compte, puis "New project".
2. Une fois le projet créé, ouvre **SQL Editor > New query**, colle le
   contenu de `supabase-schema.sql` (fourni dans ce dossier), et clique
   **Run**. Ça crée la table `app_data` qui stocke l'effectif, les
   matchs et les réglages.
3. Va dans **Project Settings > API**. Note deux valeurs :
   - **Project URL**
   - **anon public key**

## 2. Configurer le projet en local

1. Installe Node.js (https://nodejs.org) si ce n'est pas déjà fait
   (tu l'as sûrement déjà pour DIUNotes/Expo).
2. Dans ce dossier, copie `.env.example` en `.env.local` et remplis les
   deux valeurs récupérées à l'étape 1 :
   ```
   VITE_SUPABASE_URL=https://xxxxxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=xxxxxxxxxxxxxxxxxxxx
   ```
3. Installe les dépendances et lance en local pour tester :
   ```
   npm install
   npm run dev
   ```
   Ouvre le lien affiché (en général http://localhost:5173) — l'appli
   doit se charger et fonctionner comme l'artefact.

## 3. Mettre en ligne

Deux options, choisis selon ce que tu préfères :

### Option simple — Netlify Drop (aucun compte Git nécessaire)

1. `npm run build` — crée un dossier `dist/`.
2. Va sur https://app.netlify.com/drop et glisse-dépose le dossier
   `dist` dans la page.
3. Netlify te donne un lien public immédiatement (renommable).

Attention : avec cette méthode, les variables d'environnement sont
"figées" dans le build au moment du `npm run build` — si tu changes de
projet Supabase plus tard, il faudra refaire un build et un nouveau
dépôt du dossier `dist`.

### Option avec mises à jour automatiques — Vercel + GitHub

1. Crée un dépôt GitHub avec ce dossier (ou demande-moi de t'aider à
   le pousser).
2. Va sur https://vercel.com, "Add New Project", importe le dépôt.
3. Dans les réglages du projet Vercel, ajoute les deux variables
   d'environnement (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`).
4. Vercel détecte Vite automatiquement et déploie. Tu obtiens un lien
   du type `futsal-equipe.vercel.app`, réutilisable et mis à jour à
   chaque nouveau push.

## Notes

- Toute l'équipe qui ouvre le lien voit et modifie **la même donnée**
  (pas de compte utilisateur séparé) — pratique pour un usage
  hebdomadaire partagé, mais ça veut aussi dire qu'il n'y a pas de
  protection contre une modification accidentelle par quelqu'un
  d'autre. Si besoin d'un contrôle d'accès plus strict plus tard
  (mot de passe, comptes), on peut l'ajouter.
- Le bouton **Exporter (JSON)** dans l'appli fonctionne pareil que
  dans l'artefact — pratique pour une sauvegarde manuelle en plus de
  la base Supabase.
