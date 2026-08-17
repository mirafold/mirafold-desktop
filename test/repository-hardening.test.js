import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditHardening,
  compatibilityDemonstration,
  createGhClient,
  hardeningMutations,
  loadHardeningPolicy,
  mainRuleset,
  validateHardeningPolicy,
} from "../scripts/repository-hardening.mjs";

function clone(value) {
  return structuredClone(value);
}

test("the hardening policy preserves human, Dependabot, and automated release flows", () => {
  const policy = validateHardeningPolicy(loadHardeningPolicy());
  const result = compatibilityDemonstration(policy);
  assert.equal(result.humanDirectPush.allowed, false);
  assert.equal(result.humanCheckedPullRequest.allowed, true);
  assert.equal(result.dependabotCheckedPullRequest.allowed, true);
  assert.equal(result.automatedReleasePush.allowed, true);
  assert.equal(result.humanForcePush.allowed, false);
  assert.equal(result.humanBranchDeletion.allowed, false);
});

test("only the reviewed GitHub Actions integration receives a bypass, and only on main", () => {
  const policy = loadHardeningPolicy();
  const main = mainRuleset(policy);
  const next = policy.rulesets.find((ruleset) => ruleset.name === "next-staging-safety");
  assert.deepEqual(main.bypass_actors, [{
    actor_id: 15368,
    actor_type: "Integration",
    bypass_mode: "always",
  }]);
  assert.deepEqual(next.bypass_actors, []);
  const broadened = clone(policy);
  mainRuleset(broadened).bypass_actors.push({ actor_id: 32747715, actor_type: "User", bypass_mode: "always" });
  assert.throws(() => validateHardeningPolicy(broadened), /only the GitHub Actions integration/);
  const leaky = clone(policy);
  leaky.rulesets[1].bypass_actors.push({ actor_id: 15368, actor_type: "Integration", bypass_mode: "always" });
  assert.throws(() => validateHardeningPolicy(leaky), /nothing may bypass the next ruleset/);
  for (const ruleset of policy.rulesets) {
    assert.equal(ruleset.rules.some((rule) => rule.type === "required_signatures"), false);
  }
});

test("both branch rulesets require the two CI checks and the DCO sign-off check", () => {
  const policy = loadHardeningPolicy();
  for (const ruleset of policy.rulesets) {
    const status = ruleset.rules.find((rule) => rule.type === "required_status_checks").parameters;
    assert.deepEqual(status.required_status_checks, [
      { context: "test (linux)", integration_id: 15368 },
      { context: "test (windows)", integration_id: 15368 },
      { context: "DCO", integration_id: 1861 },
    ]);
    assert.ok(ruleset.rules.some((rule) => rule.type === "pull_request"), `${ruleset.name} must be pull-request-only`);
  }
  // main is the production mirror and demands an up-to-date branch; staging
  // does not, so ordinary merges never queue behind each other.
  assert.equal(mainRuleset(policy).rules.find((rule) => rule.type === "required_status_checks").parameters.strict_required_status_checks_policy, true);
  assert.equal(policy.rulesets[1].rules.find((rule) => rule.type === "required_status_checks").parameters.strict_required_status_checks_policy, false);
  const unsigned = clone(policy);
  const nextStatus = unsigned.rulesets[1].rules.find((rule) => rule.type === "required_status_checks").parameters;
  nextStatus.required_status_checks = nextStatus.required_status_checks.filter((check) => check.context !== "DCO");
  assert.throws(() => validateHardeningPolicy(unsigned), /required CI identities changed/);
});

test("the exact mutation plan enables only available free security controls and activates rules last", () => {
  const policy = loadHardeningPolicy();
  const mutations = hardeningMutations(policy);
  const rulesetMutations = mutations.slice(-2);
  assert.deepEqual(rulesetMutations.map((value) => [value.method, value.path, value.body.name]), [
    ["POST", "/repos/mirafold/mirafold-desktop/rulesets", "main-release-safety"],
    ["POST", "/repos/mirafold/mirafold-desktop/rulesets", "next-staging-safety"],
  ]);
  assert.deepEqual(mutations[0].body.security_and_analysis, {
    secret_scanning: { status: "enabled" },
    secret_scanning_push_protection: { status: "enabled" },
  });
  assert.ok(mutations.some((value) => value.path.endsWith("/vulnerability-alerts")));
  assert.ok(mutations.some((value) => value.path.endsWith("/automated-security-fixes")));
  assert.ok(mutations.some((value) => value.path.endsWith("/private-vulnerability-reporting")));
  assert.equal(
    mutations.some((value) => /non-provider|validity/.test(value.path + JSON.stringify(value.body ?? {}))),
    false,
  );

  const automated = mutations.find((value) => value.path.endsWith("/environments/automated-release"));
  const manual = mutations.find((value) => value.path.endsWith("/environments/manual-release"));
  assert.deepEqual(automated.body.reviewers, []);
  assert.deepEqual(manual.body.reviewers, [{ type: "User", id: 32747715 }]);
  assert.ok(mutations.some((value) => value.body?.name === "main" && value.body?.type === "branch"));
  assert.ok(mutations.some((value) => value.body?.name === "v*" && value.body?.type === "tag"));
});

test("reconciliation is idempotent and refuses to delete an unowned deployment policy", () => {
  const policy = loadHardeningPolicy();
  const state = {
    rulesetIds: { "main-release-safety": 42, "next-staging-safety": 43 },
    branchPoliciesByEnvironment: {
      "automated-release": [{ name: "main", type: "branch" }],
      "manual-release": [{ name: "v*", type: "tag" }],
    },
  };
  const mutations = hardeningMutations(policy, state);
  assert.deepEqual(mutations.slice(-2).map((value) => [value.method, value.path]), [
    ["PUT", "/repos/mirafold/mirafold-desktop/rulesets/42"],
    ["PUT", "/repos/mirafold/mirafold-desktop/rulesets/43"],
  ]);
  assert.equal(mutations.some((value) => value.path.endsWith("/deployment-branch-policies")), false);

  state.branchPoliciesByEnvironment["automated-release"].push({ name: "release/*", type: "branch" });
  assert.throws(() => hardeningMutations(policy, state), /refusing to delete/);
});

test("the GitHub client sends JSON without a shell and distinguishes enabled empty responses from 404", async () => {
  const calls = [];
  const client = createGhClient({
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(await client.request("GET", "/repos/example/project/vulnerability-alerts"), {});
  await client.request("PATCH", "/repos/example/project", { allow_merge_commit: false });
  assert.equal(calls[0].command, "gh");
  assert.equal(calls[0].args.includes("--input"), false);
  assert.equal(calls[1].args.includes("--input"), true);
  assert.equal(calls[1].options.input, '{"allow_merge_commit":false}');

  const missing = createGhClient({
    spawn() {
      return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    },
  });
  assert.equal(
    await missing.request("GET", "/repos/example/project/vulnerability-alerts", undefined, { allowNotFound: true }),
    null,
  );
});

test("a live-state-shaped response audits cleanly and any security drift is named", async () => {
  const policy = loadHardeningPolicy();
  const repository = policy.repository.fullName;
  const [mainPolicy, nextPolicy] = policy.rulesets;
  const main = { id: 42, source_type: "Repository", ...clone(mainPolicy) };
  const next = { id: 43, source_type: "Repository", ...clone(nextPolicy) };
  const routes = new Map([
    [`GET /repos/${repository}`, {
      full_name: repository,
      visibility: "public",
      default_branch: "main",
      ...policy.mergePolicy,
      security_and_analysis: clone(policy.security.security_and_analysis),
    }],
    [`GET /repos/${repository}/actions/permissions/workflow`, clone(policy.actionsPermissions)],
    [`GET /repos/${repository}/rulesets?per_page=100`, [
      { id: 42, name: mainPolicy.name, source_type: "Repository", enforcement: "active" },
      { id: 43, name: nextPolicy.name, source_type: "Repository", enforcement: "active" },
    ]],
    [`GET /repos/${repository}/rulesets/42`, main],
    [`GET /repos/${repository}/rulesets/43`, next],
    [`GET /repos/${repository}/vulnerability-alerts`, {}],
    [`GET /repos/${repository}/automated-security-fixes`, { enabled: true, paused: false }],
    [`GET /repos/${repository}/private-vulnerability-reporting`, { enabled: true }],
    [`GET /repos/${repository}/environments/automated-release`, {
      protection_rules: [],
      deployment_branch_policy: clone(policy.environments[0].deployment_branch_policy),
    }],
    [`GET /repos/${repository}/environments/automated-release/deployment-branch-policies?per_page=100`, {
      branch_policies: [{ name: "main", type: "branch" }],
    }],
    [`GET /repos/${repository}/environments/manual-release`, {
      protection_rules: [{
        type: "required_reviewers",
        prevent_self_review: false,
        reviewers: [{ type: "User", reviewer: { id: 32747715 } }],
      }],
      deployment_branch_policy: clone(policy.environments[1].deployment_branch_policy),
    }],
    [`GET /repos/${repository}/environments/manual-release/deployment-branch-policies?per_page=100`, {
      branch_policies: [{ name: "v*", type: "tag" }],
    }],
  ]);
  const client = {
    async request(method, route) {
      const key = `${method} ${route}`;
      assert.ok(routes.has(key), `unexpected fake GitHub request ${key}`);
      return clone(routes.get(key));
    },
  };
  const clean = await auditHardening(policy, client);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.mismatches, []);
  routes.get(`GET /repos/${repository}`).security_and_analysis.secret_scanning.status = "disabled";
  const drift = await auditHardening(policy, client);
  assert.equal(drift.ok, false);
  assert.ok(drift.mismatches.includes("repository security_and_analysis.secret_scanning is not enabled"));

  // A missing staging ruleset, or a stray unmanaged one, is named as drift.
  routes.set(`GET /repos/${repository}/rulesets?per_page=100`, [
    { id: 42, name: mainPolicy.name, source_type: "Repository", enforcement: "active" },
    { id: 99, name: "someone-clicked-this", source_type: "Repository", enforcement: "active" },
  ]);
  const partial = await auditHardening(policy, client);
  assert.ok(partial.mismatches.includes(`ruleset ${nextPolicy.name} is absent`));
  assert.ok(partial.mismatches.some((value) => value.startsWith("unowned active branch rulesets exist: someone-clicked-this")));
});
