#!/usr/bin/env node

// This file is dependency-free because it controls the repository boundary
// that decides which dependency code may merge or publish. `validate` is local,
// `audit` is read-only, and `apply` requires an exact repository confirmation.

import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { invariant } from "./shared.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const DEFAULT_POLICY = path.join(ROOT, ".github", "repository-hardening.json");
const API_VERSION = "2026-03-10";

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortedJson(child)]),
    );
  }
  return value;
}

function equivalent(left, right) {
  return JSON.stringify(sortedJson(left)) === JSON.stringify(sortedJson(right));
}

function sortedPolicies(policies) {
  return [...policies]
    .map(({ name, type }) => ({ name, type }))
    .sort((left, right) => `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`));
}

export function loadHardeningPolicy(file = DEFAULT_POLICY) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function rulesByType(policy) {
  return new Map(policy.ruleset.rules.map((rule) => [rule.type, rule]));
}

export function validateHardeningPolicy(policy) {
  invariant(policy?.schemaVersion === 1, "repository hardening policy has an unsupported schema");
  const repository = policy.repository;
  invariant(repository?.fullName === "mirafold/mirafold-desktop", "policy targets the wrong repository");
  invariant(repository.visibility === "public", "artifact attestations require this policy's public repository");
  invariant(repository.defaultBranch === "main", "policy default branch must be main");
  invariant(repository.owner?.login === "kserrec" && repository.owner.userId === 32747715, "policy owner identity changed");
  invariant(policy.integrations?.githubActionsAppId === 15368, "GitHub Actions integration identity changed");
  invariant(
    equivalent(policy.actionsPermissions, {
      default_workflow_permissions: "read",
      can_approve_pull_request_reviews: false,
    }),
    "Actions default permissions are not the reviewed least-privilege policy",
  );
  invariant(
    equivalent(policy.mergePolicy, {
      allow_merge_commit: false,
      allow_squash_merge: true,
      allow_rebase_merge: true,
      allow_auto_merge: false,
      delete_branch_on_merge: true,
    }),
    "merge policy changed without review",
  );
  invariant(policy.security?.vulnerabilityAlerts === true, "Dependabot alerts must be enabled");
  invariant(policy.security.dependabotSecurityUpdates === true, "Dependabot security updates must be enabled");
  invariant(policy.security.privateVulnerabilityReporting === true, "private vulnerability reporting must be enabled");
  invariant(
    equivalent(policy.security.security_and_analysis, {
      secret_scanning: { status: "enabled" },
      secret_scanning_push_protection: { status: "enabled" },
    }),
    "free public-repository secret protections changed without review",
  );
  invariant(
    equivalent(policy.security.unavailableOnCurrentFreeUserOwnedRepository, [
      "secret_scanning_non_provider_patterns",
      "secret_scanning_validity_checks",
    ]),
    "paid/organization-only secret protections must remain explicitly unavailable",
  );

  invariant(Array.isArray(policy.environments) && policy.environments.length === 2, "policy must own exactly two release environments");
  const environments = new Map(policy.environments.map((environment) => [environment.name, environment]));
  invariant(environments.size === 2, "release environment names must be unique");
  const automated = environments.get("automated-release");
  const manual = environments.get("manual-release");
  invariant(automated && manual, "both automated-release and manual-release environments are required");
  for (const environment of [automated, manual]) {
    invariant(environment.wait_timer === 0, `${environment.name} must not add a hidden wait`);
    invariant(environment.prevent_self_review === false, `${environment.name} self-review policy changed`);
    invariant(
      equivalent(environment.deployment_branch_policy, {
        protected_branches: false,
        custom_branch_policies: true,
      }),
      `${environment.name} must use explicit deployment ref patterns`,
    );
  }
  invariant(equivalent(automated.reviewers, []), "routine automated releases must not wait for a reviewer");
  invariant(
    equivalent(automated.branchPolicies, [{ name: "main", type: "branch" }]),
    "automated releases must originate from main",
  );
  invariant(
    equivalent(manual.reviewers, [{ type: "User", id: repository.owner.userId }]),
    "manual release approval must belong to the repository owner",
  );
  invariant(
    equivalent(manual.branchPolicies, [{ name: "v*", type: "tag" }]),
    "manual releases must be limited to v* tags",
  );

  const ruleset = policy.ruleset;
  invariant(ruleset?.name === "main-release-safety", "reviewed ruleset name changed");
  invariant(ruleset.target === "branch" && ruleset.enforcement === "active", "main ruleset must be active and branch-scoped");
  invariant(
    equivalent(ruleset.conditions, { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }),
    "ruleset must target only the default branch",
  );
  invariant(
    equivalent(ruleset.bypass_actors, [{
      actor_id: policy.integrations.githubActionsAppId,
      actor_type: "Integration",
      bypass_mode: "always",
    }]),
    "only the GitHub Actions integration may bypass the main ruleset",
  );
  const byType = rulesByType(policy);
  invariant(byType.size === 5, "main ruleset must contain exactly five reviewed rules");
  for (const type of ["deletion", "non_fast_forward", "required_linear_history", "pull_request", "required_status_checks"]) {
    invariant(byType.has(type), `main ruleset is missing ${type}`);
  }
  invariant(!byType.has("required_signatures"), "commit-signature enforcement is outside the approved key model");
  invariant(
    equivalent(byType.get("pull_request").parameters, {
      allowed_merge_methods: ["squash", "rebase"],
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_approving_review_count: 0,
      required_review_thread_resolution: true,
    }),
    "pull-request policy changed without review",
  );
  invariant(
    equivalent(byType.get("required_status_checks").parameters, {
      do_not_enforce_on_create: false,
      required_status_checks: [
        { context: "test (linux)", integration_id: policy.integrations.githubActionsAppId },
        { context: "test (windows)", integration_id: policy.integrations.githubActionsAppId },
      ],
      strict_required_status_checks_policy: true,
    }),
    "required CI identities changed without review",
  );
  return policy;
}

export function evaluateMainUpdate(policy, scenario) {
  validateHardeningPolicy(policy);
  const rules = rulesByType(policy);
  const actor = scenario.actor ?? {};
  const bypass = policy.ruleset.bypass_actors.some(
    (candidate) => candidate.actor_type === actor.type && candidate.actor_id === actor.id && candidate.bypass_mode === "always",
  );
  if (bypass) return { allowed: true, reason: "reviewed GitHub Actions ruleset bypass" };
  if (scenario.operation === "delete" && rules.has("deletion")) {
    return { allowed: false, reason: "default-branch deletion is blocked" };
  }
  if (scenario.operation === "force" && rules.has("non_fast_forward")) {
    return { allowed: false, reason: "non-fast-forward update is blocked" };
  }
  if (!scenario.viaPullRequest) return { allowed: false, reason: "a pull request is required" };

  const pullRequest = rules.get("pull_request").parameters;
  if (!pullRequest.allowed_merge_methods.includes(scenario.mergeMethod)) {
    return { allowed: false, reason: "merge method is not allowed" };
  }
  if (pullRequest.required_review_thread_resolution && scenario.reviewThreadsResolved !== true) {
    return { allowed: false, reason: "review threads are unresolved" };
  }
  if ((scenario.approvals ?? 0) < pullRequest.required_approving_review_count) {
    return { allowed: false, reason: "required approvals are missing" };
  }
  const statusRule = rules.get("required_status_checks").parameters;
  const successful = new Set(scenario.successfulChecks ?? []);
  const missing = statusRule.required_status_checks
    .map((check) => check.context)
    .filter((context) => !successful.has(context));
  if (missing.length > 0) return { allowed: false, reason: `required checks missing: ${missing.join(", ")}` };
  if (statusRule.strict_required_status_checks_policy && scenario.upToDate !== true) {
    return { allowed: false, reason: "pull-request branch is not up to date" };
  }
  return { allowed: true, reason: "pull request satisfies the reviewed policy" };
}

export function compatibilityDemonstration(policy) {
  const checks = ["test (linux)", "test (windows)"];
  const pullRequest = {
    operation: "update",
    viaPullRequest: true,
    mergeMethod: "squash",
    reviewThreadsResolved: true,
    approvals: 0,
    successfulChecks: checks,
    upToDate: true,
  };
  return {
    humanDirectPush: evaluateMainUpdate(policy, {
      actor: { type: "User", id: policy.repository.owner.userId },
      operation: "update",
      viaPullRequest: false,
    }),
    humanCheckedPullRequest: evaluateMainUpdate(policy, {
      ...pullRequest,
      actor: { type: "User", id: policy.repository.owner.userId },
    }),
    dependabotCheckedPullRequest: evaluateMainUpdate(policy, {
      ...pullRequest,
      actor: { type: "Integration", id: -1 },
    }),
    automatedReleasePush: evaluateMainUpdate(policy, {
      actor: { type: "Integration", id: policy.integrations.githubActionsAppId },
      operation: "update",
      viaPullRequest: false,
    }),
    humanForcePush: evaluateMainUpdate(policy, {
      actor: { type: "User", id: policy.repository.owner.userId },
      operation: "force",
      viaPullRequest: false,
    }),
    humanBranchDeletion: evaluateMainUpdate(policy, {
      actor: { type: "User", id: policy.repository.owner.userId },
      operation: "delete",
      viaPullRequest: false,
    }),
  };
}

function environmentBody(environment) {
  return {
    wait_timer: environment.wait_timer,
    prevent_self_review: environment.prevent_self_review,
    reviewers: environment.reviewers,
    deployment_branch_policy: environment.deployment_branch_policy,
  };
}

function rulesetBody(ruleset) {
  return {
    name: ruleset.name,
    target: ruleset.target,
    enforcement: ruleset.enforcement,
    bypass_actors: ruleset.bypass_actors,
    conditions: ruleset.conditions,
    rules: ruleset.rules,
  };
}

export function hardeningMutations(policy, state = {}) {
  validateHardeningPolicy(policy);
  const repository = policy.repository.fullName;
  const requests = [
    {
      method: "PATCH",
      path: `/repos/${repository}`,
      body: {
        ...policy.mergePolicy,
        security_and_analysis: policy.security.security_and_analysis,
      },
    },
    { method: "PUT", path: `/repos/${repository}/vulnerability-alerts` },
    { method: "PUT", path: `/repos/${repository}/automated-security-fixes` },
    { method: "PUT", path: `/repos/${repository}/private-vulnerability-reporting` },
    {
      method: "PUT",
      path: `/repos/${repository}/actions/permissions/workflow`,
      body: policy.actionsPermissions,
    },
  ];

  for (const environment of policy.environments) {
    const encodedName = encodeURIComponent(environment.name);
    requests.push({
      method: "PUT",
      path: `/repos/${repository}/environments/${encodedName}`,
      body: environmentBody(environment),
    });
    const existing = sortedPolicies(state.branchPoliciesByEnvironment?.[environment.name] ?? []);
    const desired = sortedPolicies(environment.branchPolicies);
    const unexpected = existing.filter(
      (candidate) => !desired.some((wanted) => equivalent(candidate, wanted)),
    );
    invariant(unexpected.length === 0, `${environment.name} has unowned deployment branch policies; refusing to delete them`);
    for (const branchPolicy of desired) {
      if (!existing.some((candidate) => equivalent(candidate, branchPolicy))) {
        requests.push({
          method: "POST",
          path: `/repos/${repository}/environments/${encodedName}/deployment-branch-policies`,
          body: branchPolicy,
        });
      }
    }
  }

  requests.push({
    method: state.rulesetId === undefined ? "POST" : "PUT",
    path: state.rulesetId === undefined
      ? `/repos/${repository}/rulesets`
      : `/repos/${repository}/rulesets/${state.rulesetId}`,
    body: rulesetBody(policy.ruleset),
  });
  return requests;
}

export function createGhClient({ spawn = spawnSync } = {}) {
  return {
    async request(method, endpoint, body, { allowNotFound = false } = {}) {
      const args = [
        "api",
        "--method",
        method,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        `X-GitHub-Api-Version: ${API_VERSION}`,
        endpoint,
      ];
      if (body !== undefined) args.push("--input", "-");
      const result = spawn("gh", args, {
        encoding: "utf8",
        input: body === undefined ? undefined : JSON.stringify(body),
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.status !== 0) {
        if (allowNotFound && /\(HTTP 404\)/.test(result.stderr ?? "")) return null;
        const detail = String(result.stderr ?? "GitHub API request failed").trim().split("\n")[0];
        throw new Error(`${method} ${endpoint} failed: ${detail}`);
      }
      const output = String(result.stdout ?? "").trim();
      if (output === "") return method === "GET" ? {} : null;
      try {
        return JSON.parse(output);
      } catch {
        throw new Error(`${method} ${endpoint} returned invalid JSON`);
      }
    },
  };
}

function selectedRuleset(value) {
  if (!value) return null;
  return rulesetBody(value);
}

function observedEnvironmentBody(value) {
  const reviewersRule = value.protection_rules?.find((rule) => rule.type === "required_reviewers");
  const waitRule = value.protection_rules?.find((rule) => rule.type === "wait_timer");
  const reviewers = (reviewersRule?.reviewers ?? [])
    .map((entry) => ({ type: entry.type, id: entry.reviewer?.id }))
    .sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
  return {
    wait_timer: waitRule?.wait_timer ?? 0,
    prevent_self_review: reviewersRule?.prevent_self_review ?? false,
    reviewers,
    deployment_branch_policy: value.deployment_branch_policy,
  };
}

export async function observeHardening(policy, client) {
  validateHardeningPolicy(policy);
  const repository = policy.repository.fullName;
  const [repo, actions, rulesets, vulnerabilityAlerts, dependabotSecurityUpdates, privateReporting] = await Promise.all([
    client.request("GET", `/repos/${repository}`),
    client.request("GET", `/repos/${repository}/actions/permissions/workflow`),
    client.request("GET", `/repos/${repository}/rulesets?per_page=100`),
    client.request("GET", `/repos/${repository}/vulnerability-alerts`, undefined, { allowNotFound: true }),
    client.request("GET", `/repos/${repository}/automated-security-fixes`, undefined, { allowNotFound: true }),
    client.request("GET", `/repos/${repository}/private-vulnerability-reporting`),
  ]);
  invariant(Array.isArray(rulesets), "GitHub returned an invalid ruleset list");
  const named = rulesets.filter((candidate) => candidate.name === policy.ruleset.name && candidate.source_type === "Repository");
  invariant(named.length <= 1, `multiple repository rulesets are named ${policy.ruleset.name}`);
  const ruleset = named.length === 0
    ? null
    : await client.request("GET", `/repos/${repository}/rulesets/${named[0].id}`);
  const otherActiveRulesets = rulesets.filter(
    (candidate) => candidate.source_type === "Repository" && candidate.enforcement === "active" &&
      candidate.name !== policy.ruleset.name,
  );

  const environments = {};
  const branchPoliciesByEnvironment = {};
  for (const environment of policy.environments) {
    const encodedName = encodeURIComponent(environment.name);
    const observed = await client.request(
      "GET",
      `/repos/${repository}/environments/${encodedName}`,
      undefined,
      { allowNotFound: true },
    );
    environments[environment.name] = observed;
    if (observed === null) {
      branchPoliciesByEnvironment[environment.name] = [];
    } else {
      const response = await client.request(
        "GET",
        `/repos/${repository}/environments/${encodedName}/deployment-branch-policies?per_page=100`,
      );
      branchPoliciesByEnvironment[environment.name] = sortedPolicies(response.branch_policies ?? []);
    }
  }
  return {
    repo,
    actions,
    ruleset,
    rulesetId: ruleset?.id,
    otherActiveRulesets,
    vulnerabilityAlerts: vulnerabilityAlerts !== null,
    dependabotSecurityUpdates,
    privateReporting,
    environments,
    branchPoliciesByEnvironment,
  };
}

export async function auditHardening(policy, client) {
  const observed = await observeHardening(policy, client);
  const mismatches = [];
  const repository = policy.repository;
  for (const [actualKey, expected] of [
    ["full_name", repository.fullName],
    ["visibility", repository.visibility],
    ["default_branch", repository.defaultBranch],
  ]) {
    if (observed.repo?.[actualKey] !== expected) mismatches.push(`repository ${actualKey} is not ${expected}`);
  }
  for (const [key, expected] of Object.entries(policy.mergePolicy)) {
    if (observed.repo?.[key] !== expected) mismatches.push(`repository ${key} is not ${expected}`);
  }
  for (const [key, expected] of Object.entries(policy.security.security_and_analysis)) {
    if (!equivalent(observed.repo?.security_and_analysis?.[key], expected)) {
      mismatches.push(`repository security_and_analysis.${key} is not ${expected.status}`);
    }
  }
  if (!equivalent(observed.actions, policy.actionsPermissions)) mismatches.push("Actions default permissions differ");
  if (observed.vulnerabilityAlerts !== policy.security.vulnerabilityAlerts) mismatches.push("Dependabot alerts differ");
  if (observed.dependabotSecurityUpdates?.enabled !== true || observed.dependabotSecurityUpdates?.paused === true) {
    mismatches.push("Dependabot security updates are not enabled and unpaused");
  }
  if (observed.privateReporting?.enabled !== policy.security.privateVulnerabilityReporting) {
    mismatches.push("private vulnerability reporting differs");
  }
  if (observed.ruleset === null) {
    mismatches.push(`ruleset ${policy.ruleset.name} is absent`);
  } else if (!equivalent(selectedRuleset(observed.ruleset), rulesetBody(policy.ruleset))) {
    mismatches.push(`ruleset ${policy.ruleset.name} differs`);
  }
  if (observed.otherActiveRulesets.length > 0) {
    mismatches.push(`unowned active branch rulesets exist: ${observed.otherActiveRulesets.map((value) => value.name).join(", ")}`);
  }
  for (const environment of policy.environments) {
    const actual = observed.environments[environment.name];
    if (actual === null) {
      mismatches.push(`environment ${environment.name} is absent`);
      continue;
    }
    if (!equivalent(observedEnvironmentBody(actual), environmentBody(environment))) {
      mismatches.push(`environment ${environment.name} protection differs`);
    }
    if (!equivalent(sortedPolicies(observed.branchPoliciesByEnvironment[environment.name]), sortedPolicies(environment.branchPolicies))) {
      mismatches.push(`environment ${environment.name} deployment refs differ`);
    }
  }
  return { ok: mismatches.length === 0, mismatches, observed };
}

async function requireSuccessfulPolicyChecks(policy, client) {
  const repository = policy.repository.fullName;
  const response = await client.request(
    "GET",
    `/repos/${repository}/commits/${encodeURIComponent(policy.repository.defaultBranch)}/check-runs?per_page=100`,
  );
  const runs = response.check_runs ?? [];
  const required = rulesByType(policy).get("required_status_checks").parameters.required_status_checks;
  for (const check of required) {
    const match = runs.find(
      (run) => run.name === check.context && run.app?.id === check.integration_id && run.conclusion === "success",
    );
    invariant(match, `main has no successful ${check.context} check from GitHub Actions; refusing to activate the ruleset`);
  }
}

export async function applyHardening(policy, client) {
  validateHardeningPolicy(policy);
  const before = await observeHardening(policy, client);
  invariant(before.repo?.full_name === policy.repository.fullName, "authenticated GitHub repository identity differs");
  invariant(before.repo.visibility === policy.repository.visibility, "repository visibility differs from the free public policy");
  invariant(before.repo.default_branch === policy.repository.defaultBranch, "repository default branch differs");
  invariant(before.otherActiveRulesets.length === 0, "unowned active branch rulesets exist; refusing to compound them");
  await requireSuccessfulPolicyChecks(policy, client);
  const mutations = hardeningMutations(policy, {
    rulesetId: before.rulesetId,
    branchPoliciesByEnvironment: before.branchPoliciesByEnvironment,
  });
  for (const mutation of mutations) {
    await client.request(mutation.method, mutation.path, mutation.body);
  }
  const after = await auditHardening(policy, client);
  invariant(after.ok, `repository hardening remains incomplete: ${after.mismatches.join("; ")}`);
  return { mutations: mutations.length, audit: after };
}

function assertDemonstration(results) {
  invariant(results.humanDirectPush.allowed === false, "human direct pushes must be blocked");
  invariant(results.humanCheckedPullRequest.allowed === true, "Kyle's checked pull requests must remain mergeable");
  invariant(results.dependabotCheckedPullRequest.allowed === true, "Dependabot's checked pull requests must remain mergeable");
  invariant(results.automatedReleasePush.allowed === true, "the automated release writer must retain its direct push");
  invariant(results.humanForcePush.allowed === false, "human force pushes must be blocked");
  invariant(results.humanBranchDeletion.allowed === false, "human main deletion must be blocked");
}

async function main(args) {
  const policy = validateHardeningPolicy(loadHardeningPolicy());
  const demonstration = compatibilityDemonstration(policy);
  assertDemonstration(demonstration);
  if (args.length === 1 && args[0] === "validate") {
    process.stdout.write(`${JSON.stringify(demonstration, null, 2)}\nrepository hardening policy validated\n`);
    return;
  }
  if (args.length === 1 && args[0] === "plan") {
    process.stdout.write(`${JSON.stringify(hardeningMutations(policy), null, 2)}\n`);
    return;
  }
  const client = createGhClient();
  if (args.length === 1 && args[0] === "audit") {
    const result = await auditHardening(policy, client);
    if (!result.ok) {
      for (const mismatch of result.mismatches) process.stderr.write(`- ${mismatch}\n`);
      throw new Error("live repository differs from the reviewed hardening policy");
    }
    process.stdout.write("live repository matches the reviewed hardening policy\n");
    return;
  }
  if (
    args.length === 3 && args[0] === "apply" && args[1] === "--confirm" &&
    args[2] === policy.repository.fullName
  ) {
    const result = await applyHardening(policy, client);
    process.stdout.write(`repository hardening applied and verified (${result.mutations} API mutations)\n`);
    return;
  }
  throw new Error(
    "usage: repository-hardening.mjs validate | plan | audit | apply --confirm mirafold/mirafold-desktop",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`repository hardening failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
