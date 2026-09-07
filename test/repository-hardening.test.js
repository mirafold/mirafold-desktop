import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyHardening,
  auditHardening,
  compatibilityDemonstration,
  createGhClient,
  hardeningMutations,
  loadHardeningPolicy,
  mainRuleset,
  requireSuccessfulPolicyChecks,
  validateHardeningPolicy,
} from "../scripts/repository-hardening.mjs";

function clone(value) {
  return structuredClone(value);
}

function releaseDeployKey(policy, overrides = {}) {
  return {
    id: 71,
    title: policy.releaseWriter.deployKeyTitle,
    key: policy.releaseWriter.deployKeyPublicKey,
    verified: true,
    read_only: false,
    ...overrides,
  };
}

test("source control ignores every dotenv filename family", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const filename of [".env", "project.env", ".env.local", "service.env.local"]) {
    const result = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", filename], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, `${filename} is not ignored: ${result.stderr}`);
  }
});

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

test("only deploy-key pushes receive a bypass, and only on main", () => {
  const policy = loadHardeningPolicy();
  const main = mainRuleset(policy);
  const next = policy.rulesets.find((ruleset) => ruleset.name === "next-staging-safety");
  assert.deepEqual(main.bypass_actors, [{
    actor_id: null,
    actor_type: "DeployKey",
    bypass_mode: "always",
  }]);
  assert.deepEqual(next.bypass_actors, []);
  const broadened = clone(policy);
  mainRuleset(broadened).bypass_actors.push({ actor_id: 32747715, actor_type: "User", bypass_mode: "always" });
  assert.throws(() => validateHardeningPolicy(broadened), /only repository deploy keys/);
  const leaky = clone(policy);
  leaky.rulesets[1].bypass_actors.push({ actor_id: null, actor_type: "DeployKey", bypass_mode: "always" });
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
  const deployKey = mutations.find((value) => value.path.endsWith("/keys"));
  assert.deepEqual(deployKey.body, {
    title: policy.releaseWriter.deployKeyTitle,
    key: policy.releaseWriter.deployKeyPublicKey,
    read_only: false,
  });
});

test("reconciliation is idempotent and refuses to delete an unowned deployment policy", () => {
  const policy = loadHardeningPolicy();
  const state = {
    rulesetIds: { "main-release-safety": 42, "next-staging-safety": 43 },
    branchPoliciesByEnvironment: {
      "automated-release": [{ name: "main", type: "branch" }],
      "manual-release": [{ name: "v*", type: "tag" }],
    },
    deployKeys: [releaseDeployKey(policy)],
  };
  const mutations = hardeningMutations(policy, state);
  assert.deepEqual(mutations.slice(-2).map((value) => [value.method, value.path]), [
    ["PUT", "/repos/mirafold/mirafold-desktop/rulesets/42"],
    ["PUT", "/repos/mirafold/mirafold-desktop/rulesets/43"],
  ]);
  assert.equal(mutations.some((value) => value.path.endsWith("/deployment-branch-policies")), false);

  assert.throws(
    () => hardeningMutations(policy, {
      ...state,
      deployKeys: [
        releaseDeployKey(policy),
        releaseDeployKey(policy, {
          id: 72,
          title: "unreviewed writer",
          key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAC3L5BdI1FM5/TyVagfB4DkRA8xWszgdBp4+WgLQl8o unreviewed",
        }),
      ],
    }),
    /unowned writable deploy keys/,
  );

  state.branchPoliciesByEnvironment["automated-release"].push({ name: "release/*", type: "branch" });
  assert.throws(() => hardeningMutations(policy, state), /refusing to delete/);
});

test("the GitHub client sends JSON without a shell, joins every page, and distinguishes enabled empty responses from 404", async () => {
  const calls = [];
  const client = createGhClient({
    spawn(command, args, options) {
      calls.push({ command, args, options });
      if (args.includes("/repos/example/project/keys?per_page=100")) {
        return {
          status: 0,
          stdout: [
            { id: 1, title: "read-only", read_only: true },
            { id: 2, title: "page-two writer", read_only: false },
          ].map((item) => JSON.stringify(item)).join("\n"),
          stderr: "",
        };
      }
      if (args.includes("/repos/example/project/environments/release/secrets?per_page=100")) {
        return {
          status: 0,
          stdout: [{ name: "FIRST" }, { name: "SECOND" }]
            .map((item) => JSON.stringify(item)).join("\n"),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(await client.request("GET", "/repos/example/project/vulnerability-alerts"), {});
  await client.request("PATCH", "/repos/example/project", { allow_merge_commit: false });
  const deployKeys = await client.request(
    "GET",
    "/repos/example/project/keys?per_page=100",
    undefined,
    { paginate: true },
  );
  assert.deepEqual(deployKeys.map(({ id, title, read_only: readOnly }) => ({ id, title, readOnly })), [
    { id: 1, title: "read-only", readOnly: true },
    { id: 2, title: "page-two writer", readOnly: false },
  ]);
  const secrets = await client.request(
    "GET",
    "/repos/example/project/environments/release/secrets?per_page=100",
    undefined,
    { paginate: "secrets" },
  );
  assert.deepEqual(secrets, {
    secrets: [{ name: "FIRST" }, { name: "SECOND" }],
  });
  assert.equal(calls[0].command, "gh");
  assert.equal(calls[0].args.includes("--input"), false);
  assert.equal(calls[1].args.includes("--input"), true);
  assert.equal(calls[1].options.input, '{"allow_merge_commit":false}');
  for (const call of calls.slice(2)) {
    assert.ok(call.args.includes("--paginate"));
    assert.ok(call.args.includes("--jq"));
    assert.equal(call.args.includes("--slurp"), false);
  }
  assert.ok(calls[2].args.includes(".[] | @json"));
  assert.ok(calls[3].args.includes(".secrets[] | @json"));
  const policy = loadHardeningPolicy();
  assert.throws(
    () => hardeningMutations(policy, { deployKeys }),
    /unowned writable deploy keys/,
    "a writable deploy key from page two must block ruleset activation",
  );

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

test("apply rejects every repository-owner identity mismatch before its first mutation", async () => {
  const policy = loadHardeningPolicy();
  const repository = policy.repository.fullName;
  for (const owner of [
    { login: "lookalike", id: policy.repository.owner.organizationId, type: "Organization" },
    { login: policy.repository.owner.login, id: 999, type: "Organization" },
    { login: policy.repository.owner.login, id: policy.repository.owner.organizationId, type: "User" },
  ]) {
    const mutations = [];
    const client = {
      async request(method, route) {
        if (method !== "GET") {
          mutations.push(`${method} ${route}`);
          return {};
        }
        if (route === `/repos/${repository}`) {
          return {
            full_name: repository,
            visibility: policy.repository.visibility,
            default_branch: policy.repository.defaultBranch,
            owner,
          };
        }
        if (route.endsWith("/actions/permissions/workflow")) return clone(policy.actionsPermissions);
        if (route.includes("/rulesets?")) return [];
        if (route.endsWith("/vulnerability-alerts")) return {};
        if (route.endsWith("/automated-security-fixes")) return { enabled: true, paused: false };
        if (route.endsWith("/private-vulnerability-reporting")) return { enabled: true };
        if (route.includes("/keys?")) return [];
        if (route.includes("/secrets?")) {
          return { secrets: [{ name: policy.releaseWriter.secretName }] };
        }
        if (route.includes("/environments/")) return null;
        assert.fail(`unexpected fake GitHub request ${method} ${route}`);
      },
    };

    await assert.rejects(applyHardening(policy, client), /repository owner identity differs/);
    assert.deepEqual(mutations, [], `owner mismatch ${JSON.stringify(owner)} reached a mutation`);
  }
});

function successfulCheckRuns(policy) {
  return [
    { name: "test (linux)", conclusion: "success", app: { id: policy.integrations.githubActionsAppId } },
    { name: "test (windows)", conclusion: "success", app: { id: policy.integrations.githubActionsAppId } },
    { name: "DCO", conclusion: "success", app: { id: policy.integrations.dcoAppId } },
  ];
}

test("ruleset recovery accepts exact successful checks together on one recent canonical merged PR", async () => {
  const policy = loadHardeningPolicy();
  const repository = policy.repository.fullName;
  const eligibleSha = "b".repeat(40);
  const calls = [];
  const client = {
    async request(method, route) {
      calls.push(`${method} ${route}`);
      assert.equal(method, "GET");
      if (route.includes("/commits/main/check-runs")) {
        return { check_runs: [{ name: "release", conclusion: "success", app: { id: 15368 } }] };
      }
      if (route.includes("/pulls?")) {
        return [
          {
            number: 1,
            merged_at: null,
            base: { ref: "next", repo: { full_name: repository } },
            head: { sha: "1".repeat(40), repo: { full_name: repository } },
          },
          {
            number: 2,
            merged_at: "2026-09-05T00:00:00Z",
            base: { ref: "next", repo: { full_name: repository } },
            head: { sha: "2".repeat(40), repo: { full_name: "attacker/fork" } },
          },
          {
            number: 3,
            merged_at: "2026-09-05T00:00:00Z",
            base: { ref: "unprotected", repo: { full_name: repository } },
            head: { sha: "3".repeat(40), repo: { full_name: repository } },
          },
          {
            number: 4,
            merged_at: "2026-09-05T00:00:00Z",
            base: { ref: "next", repo: { full_name: repository } },
            head: { sha: eligibleSha, repo: { full_name: repository } },
          },
        ];
      }
      if (route.includes(`/commits/${eligibleSha}/check-runs`)) {
        return { check_runs: successfulCheckRuns(policy) };
      }
      assert.fail(`unexpected fake GitHub request ${route}`);
    },
  };

  assert.deepEqual(await requireSuccessfulPolicyChecks(policy, client), {
    source: "merged-pull-request",
    number: 4,
    ref: eligibleSha,
  });
  assert.equal(calls.some((call) => call.includes("/commits/2")), false, "a fork head was queried");
  assert.equal(calls.some((call) => call.includes("/commits/3")), false, "an unprotected base was queried");
});

test("ruleset recovery refuses checks split across commits or supplied by the wrong GitHub App", async () => {
  const policy = loadHardeningPolicy();
  const repository = policy.repository.fullName;
  const firstSha = "a".repeat(40);
  const secondSha = "b".repeat(40);
  const client = {
    async request(_method, route) {
      if (route.includes("/commits/main/check-runs")) return { check_runs: [] };
      if (route.includes("/pulls?")) {
        return [firstSha, secondSha].map((sha, index) => ({
          number: index + 1,
          merged_at: "2026-09-05T00:00:00Z",
          base: { ref: index === 0 ? "main" : "next", repo: { full_name: repository } },
          head: { sha, repo: { full_name: repository } },
        }));
      }
      if (route.includes(`/commits/${firstSha}/check-runs`)) {
        return { check_runs: successfulCheckRuns(policy).slice(0, 2) };
      }
      if (route.includes(`/commits/${secondSha}/check-runs`)) {
        return {
          check_runs: [
            successfulCheckRuns(policy)[2],
            { name: "test (linux)", conclusion: "success", app: { id: 999 } },
            { name: "test (windows)", conclusion: "success", app: { id: 999 } },
          ],
        };
      }
      assert.fail(`unexpected fake GitHub request ${route}`);
    },
  };

  await assert.rejects(
    requireSuccessfulPolicyChecks(policy, client),
    /all required successful policy checks on one commit/,
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
      owner: { login: "mirafold", id: 304260636, type: "Organization" },
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
    [`GET /repos/${repository}/keys?per_page=100`, [releaseDeployKey(policy)]],
    [`GET /repos/${repository}/environments/automated-release/secrets?per_page=100`, {
      total_count: 1,
      secrets: [{ name: policy.releaseWriter.secretName, created_at: "2026-09-06T00:00:00Z" }],
    }],
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

  // Independent fields from the 2026-09-07 GET responses, absent from the
  // submitted policy. GitHub expands omitted defaults when creating rules.
  const responseDefaults = {
    required_reviewers: [],
    dismissal_restriction: { enabled: false, allowed_actors: [] },
    require_extra_approval_for_unattributed_changes: true,
  };
  for (const ruleset of [main, next]) {
    Object.assign(ruleset.rules.find((rule) => rule.type === "pull_request").parameters, clone(responseDefaults));
  }
  const expanded = await auditHardening(policy, client);
  assert.deepEqual(expanded.mismatches, []);
  assert.equal(expanded.ok, true);
  assert.deepEqual(
    expanded.observed.rulesets[main.name], main,
    "comparison must preserve the original observed evidence",
  );
  for (const ruleset of [main, next]) {
    const parameters = ruleset.rules.find((rule) => rule.type === "pull_request").parameters;
    const original = clone(parameters);
    for (const changed of [
      { required_reviewers: [{ reviewer: { id: 32747715, type: "User" }, file_patterns: ["**"] }] },
      { required_reviewers: null },
      { dismissal_restriction: { enabled: true, allowed_actors: [] } },
      { dismissal_restriction: { enabled: false, allowed_actors: [{ id: 5, type: "Team" }] } },
      { dismissal_restriction: { enabled: false, allowed_actors: [], unexpected: false } },
      { require_extra_approval_for_unattributed_changes: false },
      { require_extra_approval_for_unattributed_changes: null },
      { unknown_review_setting: false },
      { required_approving_review_count: 1 },
      { required_review_thread_resolution: false },
    ]) {
      Object.assign(parameters, clone(changed));
      const changedAudit = await auditHardening(policy, client);
      assert.equal(changedAudit.ok, false, `${ruleset.name}: ${JSON.stringify(changed)}`);
      assert.ok(changedAudit.mismatches.includes(`ruleset ${ruleset.name} differs`));
      for (const key of Object.keys(changed)) delete parameters[key];
      Object.assign(parameters, clone(original));
    }
  }

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

  routes.set(`GET /repos/${repository}/keys?per_page=100`, [
    releaseDeployKey(policy),
    releaseDeployKey(policy, {
      id: 72,
      title: "unreviewed writer",
      key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAC3L5BdI1FM5/TyVagfB4DkRA8xWszgdBp4+WgLQl8o unreviewed",
    }),
  ]);
  const unsafeKey = await auditHardening(policy, client);
  assert.ok(unsafeKey.mismatches.some((value) => value.startsWith("unowned writable deploy keys exist:")));
});
