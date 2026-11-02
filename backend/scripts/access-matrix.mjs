#!/usr/bin/env node
/**
 * Renders docs/security/access-matrix.md from every service's declared access table (src/routes/access.ts).
 *
 * Each service declares who may call each of its routes in src/routes/access.ts, and its
 * tests/route-policies.spec.ts fails when the router and that table disagree. This script is the third leg:
 * it publishes the same tables as one document, so the matrix people read is the one the tests enforce.
 *
 *   node scripts/access-matrix.mjs            # rewrite docs/security/access-matrix.md
 *   node scripts/access-matrix.mjs --check    # exit 1 if the document is out of date (CI)
 *
 * The tables are TypeScript, so they are transpiled in memory (no build step) and evaluated with a require()
 * that serves `@banksphere/common` from its build output. Run `npm run build -w @banksphere/common` first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(here, '..');
const repoDir = path.resolve(backendDir, '..');
const servicesDir = path.join(backendDir, 'services');
const outputFile = path.join(repoDir, 'docs', 'security', 'access-matrix.md');
const nodeRequire = createRequire(path.join(backendDir, 'package.json'));
const ts = nodeRequire('typescript');

/** Where each service's public router is mounted when the table does not say (gateway prefixes) */
const DEFAULT_PREFIX = {
  'auth-service': '/api/v1/auth',
  'customer-service': '/api/v1/customers',
  'account-service': '/api/v1/accounts',
  'transaction-service': '/api/v1/transactions',
  'notification-service': '/api/v1/notifications',
  'fraud-service': '/api/v1/fraud',
  'payment-service': '/api/v1/payments',
  'assistant-service': '/api/v1/assistant',
  'realtime-service': '/api/v1/realtime',
};

const ROLE_ORDER = ['CUSTOMER', 'SUPPORT', 'TELLER', 'KYC_OFFICER', 'FRAUD_ANALYST', 'BANK_ADMIN'];
const METHOD_ORDER = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

const commonDist = path.join(backendDir, 'packages', 'common', 'dist', 'index.js');
if (!fs.existsSync(commonDist)) {
  console.error('packages/common is not built; run: npm run build -w @banksphere/common');
  process.exit(1);
}

/** Transpiles one TypeScript module to CommonJS and evaluates it; relative imports are loaded the same way */
function loadTsModule(file, cache = new Map()) {
  const resolved = path.resolve(file);
  if (cache.has(resolved)) return cache.get(resolved).exports;
  const source = fs.readFileSync(resolved, 'utf8');
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: resolved,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  if (diagnostics?.length) {
    throw new Error(`${path.relative(repoDir, resolved)}: ${diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')}`);
  }
  const module = { exports: {} };
  cache.set(resolved, module);
  const localRequire = (id) => {
    if (id === '@banksphere/common') return nodeRequire(commonDist);
    if (id.startsWith('.')) {
      const base = path.resolve(path.dirname(resolved), id);
      const candidate = ['.ts', '/index.ts', ''].map((ext) => base + ext).find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (!candidate) throw new Error(`${path.relative(repoDir, resolved)} imports ${id}, which was not found`);
      return loadTsModule(candidate, cache);
    }
    return nodeRequire(id);
  };
  new Function('require', 'module', 'exports', outputText)(localRequire, module, module.exports);
  return module.exports;
}

const isRule = (row) => row && typeof row === 'object' && typeof row.method === 'string' && typeof row.path === 'string' && 'roles' in row;
const isInternalTable = (row) => row && typeof row === 'object' && typeof row.prefix === 'string' && Array.isArray(row.routes);

/** One service's tables: public routes grouped by mount prefix, and internal (service-to-service) routers */
function collect(service, exports) {
  const byPrefix = new Map();
  const internal = [];
  const add = (prefix, rules) => {
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(...rules);
  };

  const prefixExport = Object.entries(exports).find(([name, value]) => /_(API_)?PREFIX$/.test(name) && typeof value === 'string');
  const defaultPrefix = prefixExport?.[1] ?? DEFAULT_PREFIX[service] ?? `/${service}`;

  if (exports.ACCESS_TABLE && typeof exports.ACCESS_TABLE === 'object' && !Array.isArray(exports.ACCESS_TABLE)) {
    // The service mapped its routers to mount paths itself; that is the whole public table
    for (const [prefix, rules] of Object.entries(exports.ACCESS_TABLE)) add(prefix, rules.filter(isRule));
  } else {
    for (const [name, value] of Object.entries(exports)) {
      if (!Array.isArray(value) || value.length === 0) continue;
      if (value.every(isInternalTable)) continue; // handled below
      if (value.every(isRule)) add(defaultPrefix, value);
    }
  }
  for (const value of Object.values(exports)) {
    if (Array.isArray(value) && value.length && value.every(isInternalTable)) internal.push(...value);
  }
  return { byPrefix, internal };
}

const sortRules = (rules) =>
  [...rules].sort((a, b) => a.path.localeCompare(b.path) || METHOD_ORDER.indexOf(a.method.toUpperCase()) - METHOD_ORDER.indexOf(b.method.toUpperCase()));

const escapeCell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function rolesCell(roles) {
  if (roles === 'public') return '_public_';
  const list = [...roles].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
  if (list.length === ROLE_ORDER.length) return 'every signed-in role';
  return list.map((r) => `\`${r}\``).join(', ');
}

function render(services) {
  const lines = [];
  lines.push('# Access matrix');
  lines.push('');
  lines.push(
    'Who may call each API route, by service. **Generated** by `backend/scripts/access-matrix.mjs` from each service\'s',
    '`src/routes/access.ts`; do not edit by hand. Every service\'s `tests/route-policies.spec.ts` fails when its router and',
    'its table disagree, so this document is what the code enforces, not a description of it.',
    '',
    'Roles are the exact set the router admits. "every signed-in role" means any authenticated user, and the note then says',
    'what the service decides per resource on top of that (ownership, staff audit logging, step-up). _public_ routes',
    'carry their own proof (a one-time token, a webhook signature). Internal routes are reachable only on the backend',
    'network with the named credential; the gateway never routes them.',
    ''
  );

  // Role summary first: how many routes each role may reach, per service
  lines.push('## Routes per role');
  lines.push('');
  lines.push(`| Service | ${ROLE_ORDER.map((r) => `\`${r}\``).join(' | ')} | public |`);
  lines.push(`|---|${ROLE_ORDER.map(() => '---:').join('|')}|---:|`);
  for (const { service, byPrefix } of services) {
    const all = [...byPrefix.values()].flat();
    const counts = ROLE_ORDER.map((role) => all.filter((r) => r.roles !== 'public' && r.roles.includes(role)).length);
    lines.push(`| ${service} | ${counts.join(' | ')} | ${all.filter((r) => r.roles === 'public').length} |`);
  }
  lines.push('');

  for (const { service, byPrefix, internal } of services) {
    lines.push(`## ${service}`);
    lines.push('');
    for (const [prefix, rules] of [...byPrefix.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`Mounted at \`${prefix}\`.`);
      lines.push('');
      lines.push('| Method | Path | Who | Note |');
      lines.push('|---|---|---|---|');
      for (const rule of sortRules(rules)) {
        lines.push(`| ${rule.method.toUpperCase()} | \`${escapeCell(rule.path)}\` | ${rolesCell(rule.roles)} | ${escapeCell(rule.note)} |`);
      }
      lines.push('');
    }
    if (internal.length) {
      lines.push('Internal (service-to-service):');
      lines.push('');
      lines.push('| Method | Path | Caller | Credential |');
      lines.push('|---|---|---|---|');
      for (const table of internal) {
        for (const route of sortRules(table.routes)) {
          lines.push(`| ${route.method.toUpperCase()} | \`${table.prefix}${route.path}\` | ${escapeCell(table.caller)} | \`${escapeCell(table.credential)}\` |`);
        }
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

const services = fs
  .readdirSync(servicesDir)
  .filter((name) => fs.existsSync(path.join(servicesDir, name, 'src', 'routes', 'access.ts')))
  .sort()
  .map((service) => {
    const exports = loadTsModule(path.join(servicesDir, service, 'src', 'routes', 'access.ts'));
    const { byPrefix, internal } = collect(service, exports);
    const routes = [...byPrefix.values()].flat().length;
    if (routes === 0 && internal.length === 0) throw new Error(`${service}/src/routes/access.ts exports no access table`);
    return { service, byPrefix, internal, routes };
  });

if (services.length === 0) {
  console.error('No service declares src/routes/access.ts');
  process.exit(1);
}

const markdown = `${render(services)}\n`;
const check = process.argv.includes('--check');
const current = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : null;
if (check) {
  if (current !== markdown) {
    console.error(`${path.relative(repoDir, outputFile)} is out of date; run node backend/scripts/access-matrix.mjs`);
    process.exit(1);
  }
  console.log(`${path.relative(repoDir, outputFile)} is up to date`);
} else {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, markdown);
  for (const s of services) console.log(`${s.service}: ${s.routes} public routes, ${s.internal.reduce((n, t) => n + t.routes.length, 0)} internal`);
  console.log(`wrote ${path.relative(repoDir, outputFile)}`);
}
