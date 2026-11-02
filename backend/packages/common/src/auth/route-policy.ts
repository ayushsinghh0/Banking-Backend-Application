import { Request, Response, NextFunction, RequestHandler, Router } from 'express';
import { ROLES, UserRole } from './jwt';

/**
 * Every route must declare who may call it, in code a test can read. Authorization handlers carry a policy
 * tag; `describeRoutes` walks a router and collects, for each route, the tags of the router-level middleware
 * registered before it plus its own. `assertRoutePolicies` then compares that with the service's declared
 * access table, so adding a route without an explicit decision, or loosening one, fails the build.
 */
export const ROUTE_POLICY = Symbol.for('banksphere.routePolicy');

export type PolicyKind = 'roles' | 'permission' | 'authenticated' | 'public';

export interface RoutePolicy {
  kind: PolicyKind;
  /** Roles this policy lets through ('public' lets anyone through, signed in or not) */
  roles: readonly UserRole[] | 'public';
  /** Why a route is public or open to every signed-in role */
  note?: string;
  permissions?: readonly string[];
}

export function tagPolicy<T extends RequestHandler>(handler: T, policy: RoutePolicy): T {
  Object.defineProperty(handler, ROUTE_POLICY, { value: policy, enumerable: false });
  return handler;
}

export function policyOf(handler: unknown): RoutePolicy | undefined {
  return (handler as Record<symbol, RoutePolicy> | undefined)?.[ROUTE_POLICY];
}

const passThrough = (_req: Request, _res: Response, next: NextFunction) => next();

/** A route anyone may call (sign-in, webhooks verified by signature). The reason is part of the access table. */
export function publicRoute(reason: string): RequestHandler {
  return tagPolicy(passThrough.bind(null) as RequestHandler, { kind: 'public', roles: 'public', note: reason });
}

/**
 * A route every signed-in role may call because the service itself scopes the data to the caller (the
 * caller's own profile, own sessions) or decides per resource (owner or staff). The note says which.
 */
export function anyAuthenticated(note: string): RequestHandler {
  return tagPolicy(passThrough.bind(null) as RequestHandler, { kind: 'authenticated', roles: ROLES, note });
}

export interface RouteDescription {
  method: string;
  path: string;
  policies: RoutePolicy[];
  /** Roles that pass every policy on the route, or 'public' */
  effective: UserRole[] | 'public' | 'none';
}

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Layer[] };
  handle: RequestHandler & { stack?: Layer[] };
  name: string;
  regexp?: RegExp & { fast_slash?: boolean };
}

/**
 * The routes of a flat router (no nested routers), each with its policies and effective roles. A nested
 * router throws: Express 4 doesn't keep the mount path, so its routes couldn't be described correctly.
 */
export function describeRoutes(router: Router): RouteDescription[] {
  const routes: RouteDescription[] = [];
  const inherited: RoutePolicy[] = [];
  for (const layer of (router as unknown as { stack: Layer[] }).stack) {
    if (!layer.route) {
      if (layer.handle.stack) throw new Error('describeRoutes: nested routers are not supported; describe them separately');
      // router.use(path, fn) on a sub-path would scope the policy; only global middleware is supported
      if (layer.regexp && !layer.regexp.fast_slash) {
        const policy = policyOf(layer.handle);
        if (policy) throw new Error('describeRoutes: path-scoped policy middleware is not supported; put the policy on the routes');
        continue;
      }
      const policy = policyOf(layer.handle);
      if (policy) inherited.push(policy);
      continue;
    }
    const own = layer.route.stack.map((l) => policyOf(l.handle)).filter((p): p is RoutePolicy => Boolean(p));
    const policies = [...inherited, ...own];
    for (const method of Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m])) {
      routes.push({ method: method.toUpperCase(), path: layer.route.path, policies, effective: effectiveRoles(policies) });
    }
  }
  return routes;
}

function effectiveRoles(policies: RoutePolicy[]): RouteDescription['effective'] {
  const restricting = policies.filter((p) => p.roles !== 'public');
  if (!restricting.length) return policies.length ? 'public' : 'none';
  let roles = new Set<UserRole>(ROLES);
  for (const policy of restricting) {
    const allowed = new Set(policy.roles as readonly UserRole[]);
    roles = new Set([...roles].filter((r) => allowed.has(r)));
  }
  return ROLES.filter((r) => roles.has(r));
}

/** One row of a service's declared access table (src/routes/access.ts) */
export interface AccessRule {
  method: string;
  path: string;
  /** Exactly the roles that may call it, or 'public' */
  roles: readonly UserRole[] | 'public';
  /** Required for public routes and for routes where the service also checks ownership */
  note?: string;
}

/**
 * Throws, listing every difference, unless the router's routes and the access table match exactly: same
 * routes, every route with at least one policy, and the same effective roles.
 */
export function assertRoutePolicies(router: Router, table: readonly AccessRule[], label = 'router'): void {
  const problems: string[] = [];
  const declared = new Map(table.map((rule) => [`${rule.method.toUpperCase()} ${rule.path}`, rule]));
  const seen = new Set<string>();

  for (const route of describeRoutes(router)) {
    const id = `${route.method} ${route.path}`;
    seen.add(id);
    const rule = declared.get(id);
    if (route.effective === 'none') {
      problems.push(`${id}: no authorization policy (add requireRoles, authorize, anyAuthenticated or publicRoute)`);
      continue;
    }
    if (!rule) {
      problems.push(`${id}: not in the access table (roles in code: ${format(route.effective)})`);
      continue;
    }
    if (rule.roles === 'public' && !rule.note) problems.push(`${id}: public routes need a note explaining why`);
    if (format(route.effective) !== format(rule.roles)) {
      problems.push(`${id}: code allows ${format(route.effective)}, access table says ${format(rule.roles)}`);
    }
  }
  for (const id of declared.keys()) {
    if (!seen.has(id)) problems.push(`${id}: in the access table but not in the ${label}`);
  }
  if (problems.length) throw new Error(`Access policy mismatch in ${label}:\n  ${problems.join('\n  ')}`);
}

function format(roles: readonly UserRole[] | 'public'): string {
  return roles === 'public' ? 'public' : ROLES.filter((r) => roles.includes(r)).join(',') || '(nobody)';
}

/** A controller whose every method is a pass-through handler, for building a router in policy tests */
export function stubController<T extends object>(): T {
  return new Proxy({}, { get: () => passThrough }) as T;
}
