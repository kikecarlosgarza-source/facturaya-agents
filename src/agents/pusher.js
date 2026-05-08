const fs = require('fs/promises');
const path = require('path');
const simpleGit = require('simple-git');

const SANDBOX_DIR = '/tmp/sandbox-clone';
const SANDBOX_REPO_HOST = 'github.com/kikecarlosgarza-source/facturaya-sandbox.git';

async function pathExists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

async function ensureSandboxClone(remoteWithAuth) {
  if (await pathExists(SANDBOX_DIR)) {
    const git = simpleGit(SANDBOX_DIR);
    await git.remote(['set-url', 'origin', remoteWithAuth]);
    await git.pull('origin', 'main');
    return git;
  }
  await simpleGit().clone(remoteWithAuth, SANDBOX_DIR);
  const git = simpleGit(SANDBOX_DIR);
  await git.remote(['set-url', 'origin', remoteWithAuth]);
  return git;
}

async function actualizarPortalsJson(portalNombre, handlerKey) {
  const portalsDir = path.join(SANDBOX_DIR, 'portals');
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

async function commitHandler({ handler, portalNombre, repoTarget = 'sandbox' }) {
  if (repoTarget !== 'sandbox') {
    throw new Error(`pusher: repoTarget="${repoTarget}" no soportado todavía (solo "sandbox")`);
  }

  const pat = process.env.GITHUB_PAT;
  if (!pat) throw new Error('GITHUB_PAT no configurada');

  const remoteWithAuth = `https://x-access-token:${pat}@${SANDBOX_REPO_HOST}`;
  const git = await ensureSandboxClone(remoteWithAuth);

  // Configurar autor del commit
  await git.addConfig('user.email', 'reino-b@facturaya.local').catch(() => {});
  await git.addConfig('user.name', 'Reino B Bot').catch(() => {});

  // Escribir handler
  const handlersDir = path.join(SANDBOX_DIR, 'services', 'handlers');
  await fs.mkdir(handlersDir, { recursive: true });
  const handlerPath = path.join(handlersDir, handler.filename);
  await fs.writeFile(handlerPath, handler.contenido);

  // Registrar en portals.json
  const handlerKey = handler.filename.replace(/\.js$/, '');
  await actualizarPortalsJson(portalNombre, handlerKey);

  // Stage + commit + push
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

module.exports = { commitHandler };
