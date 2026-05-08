// Pusher — escribe el handler nuevo en un repo. 2 modos:
//   - sandbox: clone de facturaya-sandbox, push directo a main (Reino C, ahora apagado)
//   - production: clone de facturasat-backend (Reino A), branch nueva, push, abrir PR vía
//                  GitHub API. NUNCA push directo a main de Reino A.

const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const simpleGit = require('simple-git');

const SANDBOX_DIR = '/tmp/sandbox-clone';
const SANDBOX_REPO_HOST = 'github.com/kikecarlosgarza-source/facturaya-sandbox.git';

const PRODUCTION_DIR = '/tmp/production-clone';
const PRODUCTION_REPO_HOST = 'github.com/kikecarlosgarza-source/facturasat-backend.git';
const PRODUCTION_REPO_OWNER = 'kikecarlosgarza-source';
const PRODUCTION_REPO_NAME = 'facturasat-backend';

const GITHUB_API = 'https://api.github.com';

async function pathExists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function ensureClone(remoteWithAuth, dir) {
  if (await pathExists(dir)) {
    const git = simpleGit(dir);
    await git.remote(['set-url', 'origin', remoteWithAuth]);
    await git.fetch('origin');
    await git.checkout('main');
    await git.pull('origin', 'main');
    return git;
  }
  await simpleGit().clone(remoteWithAuth, dir);
  const git = simpleGit(dir);
  await git.remote(['set-url', 'origin', remoteWithAuth]);
  return git;
}

async function actualizarPortalsJson(workingDir, portalNombre, handlerKey) {
  const portalsDir = path.join(workingDir, 'portals');
  await fs.mkdir(portalsDir, { recursive: true });
  const portalsPath = path.join(portalsDir, 'portals.json');
  let portals = [];
  try {
    const raw = await fs.readFile(portalsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) portals = parsed;
  } catch {
    portals = [];
  }
  if (!portals.some(p => p && p.nombre === portalNombre)) {
    portals.push({ nombre: portalNombre, handler: handlerKey });
    await fs.writeFile(portalsPath, JSON.stringify(portals, null, 2) + '\n');
    return true;
  }
  return false;
}

async function commitASandbox({ handler, portalNombre, pat }) {
  const remoteWithAuth = `https://x-access-token:${pat}@${SANDBOX_REPO_HOST}`;
  const git = await ensureClone(remoteWithAuth, SANDBOX_DIR);

  await git.addConfig('user.email', 'reino-b@facturaya.local').catch(() => {});
  await git.addConfig('user.name', 'Reino B Bot').catch(() => {});

  const handlersDir = path.join(SANDBOX_DIR, 'services', 'handlers');
  await fs.mkdir(handlersDir, { recursive: true });
  await fs.writeFile(path.join(handlersDir, handler.filename), handler.contenido);

  const handlerKey = handler.filename.replace(/\.js$/, '');
  await actualizarPortalsJson(SANDBOX_DIR, portalNombre, handlerKey);

  await git.add('.');
  const summary = await git.diffSummary(['--cached']);
  if (!summary.files.length) {
    return { commitHash: null, filesPushed: [], skipped: true };
  }

  const commitResult = await git.commit(`feat: handler ${portalNombre} generado por Reino B`);
  await git.push('origin', 'main');

  return {
    commitHash: commitResult.commit,
    filesPushed: summary.files.map(f => f.file)
  };
}

async function commitAProduction({ handler, portalNombre, pat, uuid, screenshots }) {
  if (!uuid) throw new Error('Pusher production: uuid requerido para nombrar el branch');

  const remoteWithAuth = `https://x-access-token:${pat}@${PRODUCTION_REPO_HOST}`;
  const git = await ensureClone(remoteWithAuth, PRODUCTION_DIR);

  await git.addConfig('user.email', 'reino-b@facturaya.local').catch(() => {});
  await git.addConfig('user.name', 'Reino B Bot').catch(() => {});

  const uuidShort = String(uuid).replace(/-/g, '').slice(0, 8);
  const branch = `reino-b/${portalNombre}-handler-${uuidShort}`;

  // Crear branch nueva desde main. Si ya existe localmente (re-run), checkout simple.
  try {
    await git.checkoutLocalBranch(branch);
  } catch (err) {
    await git.checkout(branch);
    await git.reset(['--hard', 'origin/main']);
  }

  const handlersDir = path.join(PRODUCTION_DIR, 'services', 'handlers');
  await fs.mkdir(handlersDir, { recursive: true });
  await fs.writeFile(path.join(handlersDir, handler.filename), handler.contenido);

  await git.add('.');
  const summary = await git.diffSummary(['--cached']);
  if (!summary.files.length) {
    throw new Error('Pusher production: nada que commitear (handler ya existe igual en main)');
  }

  const commitResult = await git.commit(`feat(${portalNombre}): handler nuevo generado por Reino B (UUID ${uuid})`);
  await git.push(['-u', 'origin', branch]);

  // PR vía GitHub API
  const screenshotInfo = (screenshots && screenshots.length)
    ? `\n## Screenshots\n\n${screenshots.length} capturas disponibles en logs de Reino B (no incluidas inline por tamaño/límite GitHub PR body).`
    : '';

  const prBody = [
    '## Handler generado automáticamente por Reino B',
    '',
    `**Portal:** \`${portalNombre}\``,
    `**UUID timbrado:** \`${uuid}\``,
    `**Branch:** \`${branch}\``,
    `**Commit:** \`${commitResult.commit}\``,
    '',
    '## Origen',
    '',
    'Este handler fue generado tras una sesión exitosa del Scout Visual (Computer Use API) que logró timbrar una factura real. Las acciones grabadas se convirtieron a Playwright code reproducible vía Generator (Claude text-mode).',
    '',
    '## Validación pendiente',
    '',
    '- [ ] Revisión humana del código',
    '- [ ] Pruebas con tickets adicionales del mismo portal',
    '- [ ] Merge a main',
    screenshotInfo
  ].join('\n');

  const prResp = await axios.post(
    `${GITHUB_API}/repos/${PRODUCTION_REPO_OWNER}/${PRODUCTION_REPO_NAME}/pulls`,
    {
      title: `feat(${portalNombre}): handler generado por Reino B (UUID ${uuidShort})`,
      head: branch,
      base: 'main',
      body: prBody
    },
    {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      timeout: 30000,
      validateStatus: () => true
    }
  );

  if (prResp.status >= 400) {
    throw new Error(`GitHub API ${prResp.status}: ${JSON.stringify(prResp.data).substring(0, 300)}`);
  }

  return {
    commitHash: commitResult.commit,
    branch,
    prUrl: prResp.data.html_url,
    prNumber: prResp.data.number
  };
}

async function commitHandler({ handler, portalNombre, repoTarget = 'sandbox', uuid, screenshots }) {
  const pat = process.env.GITHUB_PAT;
  if (!pat) throw new Error('GITHUB_PAT no configurada');

  if (repoTarget === 'sandbox') {
    return await commitASandbox({ handler, portalNombre, pat });
  }
  if (repoTarget === 'production') {
    return await commitAProduction({ handler, portalNombre, pat, uuid, screenshots });
  }
  throw new Error(`pusher: repoTarget="${repoTarget}" no soportado`);
}

module.exports = { commitHandler };
