import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditHardening,
  compatibilityDemonstration,
  createGhClient,
  hardeningMutations,
  loadHardeningPolicy,
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

test("only the reviewed GitHub Actions integration receives a ruleset bypass", () => {
  const policy = loadHardeningPolicy();
  assert.deepEqual(policy.ruleset.bypass_actors, [{
    actor_id: 15368,
    actor_type: "Integration",
    bypass_mode: "always",
  }]);
  const broadened = clone(policy);
  broadened.ruleset.bypass_actors.push({ actor_id: 32747715, actor_type: "User", bypass_mode: "always" });
  assert.throws(() => validateHardeningPolicy(broadened), /only the GitHub Actions integration/);
  assert.equal(policy.ruleset.rules.some((rule) => rule.type === "required_signatures"), false);
});

test("the exact mutation plan enables only available free security controls and activates rules last", () => {
  const policy = loadHardeningPolicy();
  const mutations = hardeningMutations(policy);
  assert.equal(mutations.at(-1).method, "POST");
  assert.equal(mutations.at(-1).path, "/repos/mirafold/mirafold-desktop/rulesets");
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
    rulesetId: 42,
    branchPoliciesByEnvironment: {
      "automated-release": [{ name: "main", type: "branch" }],
      "manual-release": [{ name: "v*", type: "tag" }],
    },
  };
  const mutations = hardeningMutations(policy, state);
  assert.equal(mutations.at(-1).method, "PUT");
  assert.equal(mutations.at(-1).path, "/repos/mirafold/mirafold-desktop/rulesets/42");
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
  const ruleset = { id: 42, source_type: "Repository", ...clone(policy.ruleset) };
  const routes = new Map([
    [`GET /repos/${repository}`, {
      full_name: repository,
      visibility: "public",
      default_branch: "main",
      ...policy.mergePolicy,
      security_and_analysis: clone(policy.security.security_and_analysis),
    }],
    [`GET /repos/${repository}/actions/permissions/workflow`, clone(policy.actionsPermissions)],
    [`GET /repos/${repository}/rulesets?per_page=100`, [{
      id: 42,
      name: policy.ruleset.name,
      source_type: "Repository",
      enforcement: "active",
    }]],
    [`GET /repos/${repository}/rulesets/42`, ruleset],
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
});
