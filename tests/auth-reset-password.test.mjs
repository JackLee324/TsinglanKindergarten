/**
 * tests/auth-reset-password.test.mjs — the authorization model of
 * POST /api/auth/reset-password (audit finding G-18)
 * =============================================================================
 * Run with:  npm test   (or: node --test tests/auth-reset-password.test.mjs)
 *
 * WHAT THIS PROTECTS, AND WHY IT IS SEPARATE FROM THE HTTP SUITE
 * --------------------------------------------------------------
 * `scripts/verify-authz-http.mjs` (section E) and `scripts/verify-mfa.mjs`
 * (section G) prove the BEHAVIOUR over real HTTP against a running server. This
 * file proves the MODEL deterministically, with no server, no database and no
 * network, so it runs first in the gate and is immune to build staleness — the
 * same two-layer approach `tests/exception-filter-requestid.test.mjs` uses.
 *
 * The defect being locked down:
 *
 *   server/modules/auth/auth.controller.ts had
 *       @Post('reset-password')                     // no @RequirePermission
 *       if (!operator.roles.includes('principal'))  // hard-coded role bypass
 *         throw new NotFoundException();            // 404 for "not permitted"
 *   and then reset whatever `body.teacherId` named. So the RBAC catalog did not
 *   govern the route at all, a `super_admin` that does not also hold `principal`
 *   was refused, and nothing checked that the caller was allowed to manage the
 *   account it was about to take over.
 *
 * The assertions below therefore cover five things that a future edit could
 * quietly undo:
 *
 *   1. `assertRbacCatalogIntegrity()` still passes, and the privileged-reset
 *      permission is granted to super_admin and to NOBODY else — the grant list is
 *      the most likely place for a "temporary" widening.
 *   2. The ceiling rule (`canManageAccount` / `isPrivilegedAccount`) refuses every
 *      direction that would let one account take over a peer or a superior. This is
 *      the rule that makes IDOR through `teacherId` impossible rather than merely
 *      unlikely.
 *   3. The route declares its capability and contains no hard-coded role check.
 *   4. No log line or audit field in the auth module ever interpolates the
 *      generated temporary password or the caller's second factor.
 *   5. The published request/response contract still holds exactly one target
 *      selector and one one-time credential — no field through which a caller could
 *      choose another account's password, and no field that echoes a stored secret.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

register('./helpers/ts-alias-loader.mjs', import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const rbac = await import(new URL('../shared/rbac.ts', import.meta.url).href);
const {
  assertRbacCatalogIntegrity,
  canManageAccount,
  isPrivilegedAccount,
  isKnownPermission,
  getPermissionDefinition,
  ROLE_CODES,
  ROLE_PERMISSIONS,
  SUPER_ADMIN_ROLE,
  PRIVILEGED_ACCOUNT_ROLES,
  RESET_PRIVILEGED_PASSWORD_PERMISSION,
} = rbac;

const RESET_PERMISSION = 'account.reset_password';

/** Source of the auth module, read once — the static guards below scan it. */
function authSource(file) {
  return readFileSync(join(ROOT, 'server', 'modules', 'auth', file), 'utf8');
}

/**
 * Drop comments so a static guard cannot be defeated by, or accidentally trip on,
 * prose. Lines that are entirely a JSDoc/block-comment body are removed, and a
 * trailing `//` comment is stripped from the rest. (This file's own documentation
 * quotes the removed defect verbatim, which is exactly why the scan must ignore
 * comments.)
 */
function stripComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) {
        return '';
      }
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

describe('reset-password authorization model (G-18)', () => {
  test('the RBAC catalog is still internally consistent', () => {
    // Throws on a duplicate code, an unknown permission referenced by a role, a
    // super_admin that does not hold everything, or a missing rank — including the
    // privileged-reset grant rule added with this fix.
    assert.doesNotThrow(() => assertRbacCatalogIntegrity());
  });

  test('account.reset_privileged_password exists and is a high-risk account permission', () => {
    assert.ok(
      isKnownPermission(RESET_PRIVILEGED_PASSWORD_PERMISSION),
      `${RESET_PRIVILEGED_PASSWORD_PERMISSION} must be in the catalog`,
    );
    const def = getPermissionDefinition(RESET_PRIVILEGED_PASSWORD_PERMISSION);
    assert.equal(def.group, 'account');
    assert.equal(def.dataScoped, false, 'an administrative permission is not data-scoped');
    assert.equal(def.highRisk, true, 'taking over a privileged account is high risk');
  });

  test('resetting a password is a role default of exactly super_admin + principal', () => {
    const holders = ROLE_CODES.filter((role) => ROLE_PERMISSIONS[role].includes(RESET_PERMISSION));
    assert.deepEqual(
      holders.slice().sort(),
      [SUPER_ADMIN_ROLE, 'principal'].sort(),
      'only the business administrator and the system administrator may reset passwords',
    );
  });

  test('resetting a PRIVILEGED account password is super_admin only', () => {
    const holders = ROLE_CODES.filter((role) =>
      ROLE_PERMISSIONS[role].includes(RESET_PRIVILEGED_PASSWORD_PERMISSION),
    );
    assert.deepEqual(
      holders,
      [SUPER_ADMIN_ROLE],
      'no other role may ever be granted the privileged-account reset capability',
    );
    // State the consequence explicitly: a principal, which legitimately holds the
    // ordinary reset capability, does NOT hold this one.
    assert.equal(
      ROLE_PERMISSIONS.principal.includes(RESET_PRIVILEGED_PASSWORD_PERMISSION),
      false,
    );
  });

  test('permissions can be granted to a role without silently widening the catalog', () => {
    // A cheap tripwire for the shape of a "broad grant" edit: every permission code
    // a role lists must still exist (assertRbacCatalogIntegrity also checks this,
    // here so a failure names the role directly).
    for (const role of ROLE_CODES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        assert.ok(isKnownPermission(permission), `${role} references unknown permission ${permission}`);
      }
    }
  });

  describe('privileged accounts', () => {
    test('the privileged set is exactly the two system roles', () => {
      assert.deepEqual(
        PRIVILEGED_ACCOUNT_ROLES.slice().sort(),
        [SUPER_ADMIN_ROLE, 'principal'].sort(),
      );
    });

    test('isPrivilegedAccount matches a held role, not the first one', () => {
      assert.equal(isPrivilegedAccount(['super_admin']), true);
      assert.equal(isPrivilegedAccount(['principal']), true);
      assert.equal(isPrivilegedAccount(['curriculum_director', 'principal']), true);
      assert.equal(isPrivilegedAccount(['principal', 'prek_head']), true);
      assert.equal(isPrivilegedAccount(['curriculum_director']), false);
      assert.equal(isPrivilegedAccount(['prek_head', 'prek_assistant']), false);
      assert.equal(isPrivilegedAccount(['visitor']), false);
      assert.equal(isPrivilegedAccount([]), false);
    });
  });

  // ===========================================================================
  // The ceiling rule — "who may reset whose password"
  // ===========================================================================
  describe('canManageAccount (the rule that removes the IDOR)', () => {
    const cases = [
      // [actorRoles, targetRoles, allowed, why]
      [['principal'], ['prek_head'], true, 'an administrator manages teaching accounts'],
      [['principal'], ['curriculum_director'], true, 'the ceiling allows strictly lower roles'],
      [['principal'], ['prek_assistant'], true, 'assistants are below a principal'],
      [['principal'], ['visitor'], true, 'a visitor is the lowest rank'],
      [['principal'], [], true, 'an account with no roles can be repaired by an administrator'],
      [['principal'], ['principal'], false, 'a principal must not take over a PEER principal'],
      [['principal'], ['super_admin'], false, 'a principal must never touch a super_admin'],
      [['principal'], ['curriculum_director', 'principal'], false, 'a multi-role target is ranked by its highest role'],
      [['curriculum_director'], ['prek_head'], true, 'a director may manage a head teacher'],
      [['curriculum_director'], ['curriculum_director'], false, 'never a peer'],
      [['curriculum_director'], ['principal'], false, 'never a superior'],
      [['prek_head'], ['prek_assistant'], true, 'a head teacher may manage an assistant'],
      [['prek_head'], ['prek_head'], false, 'never a peer'],
      [['prek_assistant'], ['prek_head'], false, 'never a superior'],
      [['prek_assistant'], ['prek_assistant'], false, 'never a peer'],
      [['visitor'], ['visitor'], false, 'a visitor manages nobody'],
      [['visitor'], ['prek_assistant'], false, 'a visitor manages nobody'],
      [[SUPER_ADMIN_ROLE], ['super_admin'], true, 'a super_admin may manage a super_admin'],
      [[SUPER_ADMIN_ROLE], ['principal'], true, 'the highest tier may manage the business administrator'],
      [[SUPER_ADMIN_ROLE], ['visitor'], true, 'and every ordinary account'],
    ];

    for (const [actor, target, allowed, why] of cases) {
      test(`${JSON.stringify(actor)} -> ${JSON.stringify(target)} = ${allowed} (${why})`, () => {
        assert.equal(canManageAccount(actor, target), allowed, why);
      });
    }
  });

  // ===========================================================================
  // Static guards on the route itself
  // ===========================================================================
  describe('the route is governed by the permission catalog', () => {
    const controller = authSource('auth.controller.ts');
    const controllerCode = stripComments(controller);

    test('reset-password declares account.reset_password', () => {
      const routeAt = controllerCode.indexOf("@Post('reset-password')");
      assert.notEqual(routeAt, -1, "the route must still exist at @Post('reset-password')");
      const route = controllerCode.slice(routeAt, routeAt + 1500);
      assert.match(
        route,
        /@RequirePermission\('account\.reset_password'\)/,
        'the route must be enforced by PermissionGuard through @RequirePermission',
      );
    });

    test('no hard-coded role check survives in the controller', () => {
      assert.doesNotMatch(
        controllerCode,
        /roles\.includes\(/,
        'authorization must be expressed as a permission, never as a role string (G-18)',
      );
    });

    test('the privileged reset permission is not required unconditionally', () => {
      // It is a TARGET-dependent capability: requiring it on the route would have
      // to be granted to principal too, which would defeat its purpose.
      assert.doesNotMatch(
        controllerCode,
        /@RequirePermission\([^)]*reset_privileged_password/,
        'account.reset_privileged_password is decided per target inside the service',
      );
    });
  });

  describe('no credential can reach a log line, an audit field or an error message', () => {
    /** Lines that write a log record or an audit field. */
    const writers = /logger\.(log|warn|error|debug|verbose)|detail:|errorMessage:|console\./;

    for (const file of ['auth.service.ts', 'auth.controller.ts', 'mfa.service.ts', 'auth.guard.ts']) {
      test(`${file}: no log/audit line interpolates a password or a second factor`, () => {
        const offenders = stripComments(authSource(file))
          .split('\n')
          .map((line, i) => [i + 1, line])
          .filter(([, line]) => writers.test(line))
          .filter(([, line]) => /temp(orary)?Password|mfaCode|recoveryCodes|passwordHash|\bsecret\b/.test(line));
        assert.deepEqual(
          offenders,
          [],
          `credential material must never be logged:\n${offenders.map(([n, l]) => `${n}: ${l.trim()}`).join('\n')}`,
        );
      });
    }

    /**
     * Every handler that reads a credential from the request body must REMOVE it
     * once consumed.
     *
     * WHY: the platform's HTTP trace logging writes the request body of every
     * successful request into the server log (verified live: 28 plaintext login
     * passwords and every MFA code of a gate run). Scrubbing is what keeps that
     * from persisting a credential, so a new handler — or a refactor that drops
     * the call — must fail here rather than silently reintroduce the leak.
     */
    const CREDENTIAL_FIELDS = [
      'password',
      'currentPassword',
      'newPassword',
      'code',
      'challengeToken',
      'mfaCode',
    ];

    test('auth.controller.ts: every consumed credential is dropped from the request', () => {
      const code = stripComments(authSource('auth.controller.ts'));
      // Split into route bodies at each HTTP-method decorator.
      const blocks = code.split(/(?=@(?:Post|Get)\()/).slice(1);
      assert.ok(blocks.length >= 8, 'expected the auth routes to be discoverable');

      const problems = [];
      for (const block of blocks) {
        const route = (block.match(/@(?:Post|Get)\('([^']*)'\)/) ?? [])[1] ?? '?';
        for (const field of CREDENTIAL_FIELDS) {
          // Is this field READ from the parsed body in this handler?
          const read = new RegExp(
            String.raw`(?:body|raw)\??\.${field}\b`,
          ).test(block);
          if (!read) continue;
          // ...and is it in a dropConsumedCredentials() call in the same handler?
          const scrubbed = [...block.matchAll(/dropConsumedCredentials\(\s*req\s*,\s*\[([^\]]*)\]/g)]
            .some((m) => m[1].includes(`'${field}'`));
          if (!scrubbed) problems.push(`${route}: body.${field} is read but never scrubbed`);
        }
      }
      assert.deepEqual(problems, [], problems.join('\n'));
    });
  });

  // ===========================================================================
  // The published contract
  // ===========================================================================
  describe('the API contract stays minimal', () => {
    const api = readFileSync(join(ROOT, 'shared', 'api.interface.ts'), 'utf8');

    function interfaceBody(name) {
      const start = api.indexOf(`export interface ${name} {`);
      assert.notEqual(start, -1, `${name} must exist`);
      const end = api.indexOf('}', start);
      return api.slice(start + `export interface ${name} {`.length, end);
    }

    test('ResetPasswordRequest accepts exactly one target selector', () => {
      const fields = interfaceBody('ResetPasswordRequest')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
        .map((l) => l.split(':')[0].trim());
      assert.deepEqual(
        fields,
        ['teacherId'],
        'the caller selects ONE account by id; there is no second selector and no ' +
          'caller-chosen password',
      );
    });

    test('ResetPasswordResponse carries only the one-time credential', () => {
      const fields = interfaceBody('ResetPasswordResponse')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))
        .map((l) => l.split(':')[0].trim());
      assert.deepEqual(
        fields,
        ['temporaryPassword'],
        'a reset must not return a stored hash, the account record or a session',
      );
    });
  });
});
