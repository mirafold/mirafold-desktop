#!/usr/bin/env node

// This file is dependency-free because it controls the repository boundary
// that decides which dependency code may merge or publish. `validate` is local,
// `audit` is read-only, and `apply` requires an exact repository confirmation.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

function repositoryOwnerMatches(repository, repo) {
  return repo?.owner?.login === repository.owner.login
    && repo?.owner?.id === repository.owner.organizationId
    && repo?.owner?.type === "Organization";
}

export function deployKeyFingerprint(publicKey) {
  if (typeof publicKey !== "string") return null;
  const [type, encoded] = publicKey.trim().split(/\s+/);
  if (type !== "ssh-ed25519" || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded ?? "")) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length === 0
    || bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    return null;
  }
  return `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`;
}

function expectedDeployKey(policy, key) {
  const writer = policy.releaseWriter;
  return deployKeyFingerprint(key?.key) === writer.deployKeyFingerprint;
}

function releaseWriterPrerequisiteMismatches(policy, observed, { allowMissingKey = false } = {}) {
  const writer = policy.releaseWriter;
  const keys = Array.isArray(observed.deployKeys) ? observed.deployKeys : [];
  const expected = keys.filter((key) => expectedDeployKey(policy, key));
  const mismatches = [];
  if (expected.length !== 1 && !(allowMissingKey && expected.length === 0)) {
    mismatches.push("the policy-pinned automated release deploy key is absent or duplicated");
  }
  if (expected.some((key) => (
    key.title !== writer.deployKeyTitle
    || key.read_only !== false
    || key.verified !== true
  ))) {
    mismatches.push("the policy-pinned automated release deploy key metadata differs");
  }
  const unexpectedWritable = keys.filter(
    (key) => key.read_only === false && !expectedDeployKey(policy, key),
  );
  if (unexpectedWritable.length > 0) {
    mismatches.push(
      `unowned writable deploy keys exist: ${unexpectedWritable.map((key) => key.title ?? key.id).join(", ")}`,
    );
  }
  const secretNames = new Set((observed.releaseWriterSecrets?.secrets ?? []).map((secret) => secret.name));
  if (!secretNames.has(writer.secretName)) {
    mismatches.push(`${writer.environment} environment secret ${writer.secretName} is absent`);
  }
  return mismatches;
}

export function loadHardeningPolicy(file = DEFAULT_POLICY) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function rulesByType(ruleset) {
  return new Map(ruleset.rules.map((rule) => [rule.type, rule]));
}

/** The default-branch ruleset: the one the automated release writer bypasses. */
export function mainRuleset(policy) {
  return policy.rulesets.find((ruleset) => ruleset.name === "main-release-safety");
}

/** Every ruleset requires the same three checks from the same two GitHub Apps. */
function requiredChecks(policy) {
  return [
    { context: "test (linux)", integration_id: policy.integrations.githubActionsAppId },
    { context: "test (windows)", integration_id: policy.integrations.githubActionsAppId },
    { context: "DCO", integration_id: policy.integrations.dcoAppId },
  ];
}

const PULL_REQUEST_POLICY = {
  allowed_merge_methods: ["squash", "rebase"],
  dismiss_stale_reviews_on_push: false,
  require_code_owner_review: false,
  require_last_push_approval: false,
  required_approving_review_count: 0,
  required_review_thread_resolution: true,
};

function validateRuleset(policy, ruleset, expected) {
  invariant(ruleset.target === "branch" && ruleset.enforcement === "active", `${ruleset.name} must be active and branch-scoped`);
  invariant(equivalent(ruleset.conditions, expected.conditions), `${ruleset.name} must target only ${expected.describe}`);
  invariant(equivalent(ruleset.bypass_actors, expected.bypassActors), expected.bypassMessage);
  const byType = rulesByType(ruleset);
  invariant(byType.size === 5, `${ruleset.name} must contain exactly five reviewed rules`);
  for (const type of ["deletion", "non_fast_forward", "required_linear_history", "pull_request", "required_status_checks"]) {
    invariant(byType.has(type), `${ruleset.name} is missing ${type}`);
  }
  invariant(!byType.has("required_signatures"), "commit-signature enforcement is outside the approved key model");
  invariant(
    equivalent(byType.get("pull_request").parameters, PULL_REQUEST_POLICY),
    `${ruleset.name} pull-request policy changed without review`,
  );
  invariant(
    equivalent(byType.get("required_status_checks").parameters, {
      do_not_enforce_on_create: false,
      required_status_checks: requiredChecks(policy),
      strict_required_status_checks_policy: expected.strict,
    }),
    `${ruleset.name} required CI identities changed without review`,
  );
}

export function validateHardeningPolicy(policy) {
  invariant(policy?.schemaVersion === 1, "repository hardening policy has an unsupported schema");
  const repository = policy.repository;
  invariant(repository?.fullName === "mirafold/mirafold-desktop", "policy targets the wrong repository");
  invariant(repository.visibility === "public", "artifact attestations require this policy's public repository");
  invariant(repository.defaultBranch === "main", "policy default branch must be main");
  invariant(
    repository.owner?.login === "mirafold" && repository.owner.organizationId === 304260636,
    "policy repository-owner identity changed",
  );
  invariant(
    repository.maintainer?.login === "kserrec" && repository.maintainer.userId === 32747715,
    "policy maintainer identity changed",
  );
  invariant(policy.integrations?.githubActionsAppId === 15368, "GitHub Actions integration identity changed");
  invariant(policy.integrations.dcoAppId === 1861, "DCO GitHub App identity changed");
  invariant(
    equivalent(policy.releaseWriter, {
      deployKeyTitle: "Mirafold automated release writer",
      deployKeyPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAaGIu8fPr9kVYIruh8r2aWMWrlH7xar+LsBLcAmGE9a mirafold-desktop automated release writer",
      deployKeyFingerprint: "SHA256:UJR3Gv0QtEUbOWZeWMDYhGxepjHjR0mDK+vtvOqcVBc",
      environment: "automated-release",
      secretName: "MIRAFOLD_RELEASE_DEPLOY_KEY",
    }),
    "automated release writer identity changed",
  );
  invariant(
    deployKeyFingerprint(policy.releaseWriter.deployKeyPublicKey) === policy.releaseWriter.deployKeyFingerprint,
    "automated release writer public key does not match its fingerprint",
  );
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
    equivalent(policy.security.unavailableOnCurrentPlan, [
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
    equivalent(manual.reviewers, [{ type: "User", id: repository.maintainer.userId }]),
    "manual release approval must belong to the repository owner",
  );
  invariant(
    equivalent(manual.branchPolicies, [{ name: "v*", type: "tag" }]),
    "manual releases must be limited to v* tags",
  );

  invariant(Array.isArray(policy.rulesets) && policy.rulesets.length === 2, "policy must own exactly two branch rulesets");
  const rulesets = new Map(policy.rulesets.map((ruleset) => [ruleset.name, ruleset]));
  const main = rulesets.get("main-release-safety");
  const next = rulesets.get("next-staging-safety");
  invariant(main && next, "both main-release-safety and next-staging-safety rulesets are required");
  // main is the production mirror: pull-request-only for people, up-to-date
  // required, and only the audited automated release writer may push directly.
  validateRuleset(policy, main, {
    describe: "the default branch",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypassActors: [{ actor_id: null, actor_type: "DeployKey", bypass_mode: "always" }],
    bypassMessage: "only repository deploy keys may bypass the main ruleset",
    strict: true,
  });
  // next is staging: pull-request-only for everyone, no bypass at all, and
  // no up-to-date requirement so day-to-day merges do not queue behind each
  // other.
  validateRuleset(policy, next, {
    describe: "the next branch",
    conditions: { ref_name: { include: ["refs/heads/next"], exclude: [] } },
    bypassActors: [],
    bypassMessage: "nothing may bypass the next ruleset",
    strict: false,
  });
  return policy;
}

export function evaluateMainUpdate(policy, scenario) {
  validateHardeningPolicy(policy);
  const main = mainRuleset(policy);
  const rules = rulesByType(main);
  const actor = scenario.actor ?? {};
  const bypass = main.bypass_actors.some(
    (candidate) => candidate.actor_type === actor.type && candidate.actor_id === actor.id && candidate.bypass_mode === "always",
  );
  if (bypass) return { allowed: true, reason: "reviewed automated-release deploy-key bypass" };
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
  const checks = ["test (linux)", "test (windows)", "DCO"];
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
      actor: { type: "User", id: policy.repository.maintainer.userId },
      operation: "update",
      viaPullRequest: false,
    }),
    humanCheckedPullRequest: evaluateMainUpdate(policy, {
      ...pullRequest,
      actor: { type: "User", id: policy.repository.maintainer.userId },
    }),
    dependabotCheckedPullRequest: evaluateMainUpdate(policy, {
      ...pullRequest,
      actor: { type: "Integration", id: -1 },
    }),
    automatedReleasePush: evaluateMainUpdate(policy, {
      actor: { type: "DeployKey", id: null },
      operation: "update",
      viaPullRequest: false,
    }),
    humanForcePush: evaluateMainUpdate(policy, {
      actor: { type: "User", id: policy.repository.maintainer.userId },
      operation: "force",
      viaPullRequest: false,
    }),
    humanBranchDeletion: evaluateMainUpdate(policy, {
      actor: { type: "User", id: policy.repository.maintainer.userId },
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

  const deployKeys = Array.isArray(state.deployKeys) ? state.deployKeys : [];
  const expectedKeys = deployKeys.filter((key) => expectedDeployKey(policy, key));
  const unexpectedWritable = deployKeys.filter(
    (key) => key.read_only === false && !expectedDeployKey(policy, key),
  );
  invariant(unexpectedWritable.length === 0, "unowned writable deploy keys exist; refusing to broaden the ruleset bypass");
  invariant(expectedKeys.length <= 1, "the policy-pinned automated release deploy key is duplicated");
  if (expectedKeys.length === 0) {
    requests.push({
      method: "POST",
      path: `/repos/${repository}/keys`,
      body: {
        title: policy.releaseWriter.deployKeyTitle,
        key: policy.releaseWriter.deployKeyPublicKey,
        read_only: false,
      },
    });
  } else {
    invariant(
      expectedKeys[0].title === policy.releaseWriter.deployKeyTitle
        && expectedKeys[0].read_only === false
        && expectedKeys[0].verified === true,
      "the policy-pinned automated release deploy key metadata differs",
    );
  }

  for (const ruleset of policy.rulesets) {
    const existingId = state.rulesetIds?.[ruleset.name];
    requests.push({
      method: existingId === undefined ? "POST" : "PUT",
      path: existingId === undefined
        ? `/repos/${repository}/rulesets`
        : `/repos/${repository}/rulesets/${existingId}`,
      body: rulesetBody(ruleset),
    });
  }
  return requests;
}

export function createGhClient({ spawn = spawnSync } = {}) {
  return {
    async request(method, endpoint, body, { allowNotFound = false, paginate = false } = {}) {
      invariant(
        paginate === false || paginate === true || typeof paginate === "string",
        "pagination must describe an array response or its item field",
      );
      invariant(
        typeof paginate !== "string" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(paginate),
        "pagination item field is invalid",
      );
      invariant(!paginate || (method === "GET" && body === undefined), "only body-free GET requests may paginate");
      const args = [
        "api",
        "--method",
        method,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        `X-GitHub-Api-Version: ${API_VERSION}`,
      ];
      if (paginate) {
        const items = paginate === true ? ".[]" : `.${paginate}[]`;
        args.push("--paginate", "--jq", `${items} | @json`);
      }
      args.push(endpoint);
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
      if (output === "") {
        if (paginate === true) return [];
        if (typeof paginate === "string") return { [paginate]: [] };
        return method === "GET" ? {} : null;
      }
      try {
        if (!paginate) return JSON.parse(output);
        const items = output.split("\n").map((line) => JSON.parse(line));
        return paginate === true ? items : { [paginate]: items };
      } catch {
        throw new Error(`${method} ${endpoint} returned invalid JSON`);
      }
    },
  };
}

function selectedRuleset(value) {
  if (!value) return null;
  const body = rulesetBody(value);
  if (!Array.isArray(body.rules)) return body;
  // GitHub's 2026-03-10 API added these exact values to both rulesets on
  // 2026-09-07 although the write payload omitted them. Normalize only those
  // observed defaults; changed values and unknown fields still fail audit.
  const responseDefaults = {
    required_reviewers: [],
    dismissal_restriction: { enabled: false, allowed_actors: [] },
    require_extra_approval_for_unattributed_changes: true,
  };
  return {
    ...body,
    rules: body.rules.map((rule) => {
      if (rule.type !== "pull_request" || !rule.parameters) return rule;
      const parameters = { ...rule.parameters };
      for (const [name, expected] of Object.entries(responseDefaults)) {
        if (equivalent(parameters[name], expected)) delete parameters[name];
      }
      return { ...rule, parameters };
    }),
  };
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
  const releaseEnvironment = encodeURIComponent(policy.releaseWriter.environment);
  const [
    repo,
    actions,
    rulesets,
    vulnerabilityAlerts,
    dependabotSecurityUpdates,
    privateReporting,
    deployKeys,
    releaseWriterSecrets,
  ] = await Promise.all([
    client.request("GET", `/repos/${repository}`),
    client.request("GET", `/repos/${repository}/actions/permissions/workflow`),
    client.request("GET", `/repos/${repository}/rulesets?per_page=100`, undefined, { paginate: true }),
    client.request("GET", `/repos/${repository}/vulnerability-alerts`, undefined, { allowNotFound: true }),
    client.request("GET", `/repos/${repository}/automated-security-fixes`, undefined, { allowNotFound: true }),
    client.request("GET", `/repos/${repository}/private-vulnerability-reporting`),
    client.request("GET", `/repos/${repository}/keys?per_page=100`, undefined, { paginate: true }),
    client.request(
      "GET",
      `/repos/${repository}/environments/${releaseEnvironment}/secrets?per_page=100`,
      undefined,
      { allowNotFound: true, paginate: "secrets" },
    ),
  ]);
  invariant(Array.isArray(rulesets), "GitHub returned an invalid ruleset list");
  invariant(Array.isArray(deployKeys), "GitHub returned an invalid deploy-key list");
  invariant(
    releaseWriterSecrets === null || Array.isArray(releaseWriterSecrets.secrets),
    "GitHub returned an invalid release-writer secret list",
  );
  const ownedNames = new Set(policy.rulesets.map((ruleset) => ruleset.name));
  const observedRulesets = {};
  const rulesetIds = {};
  for (const name of ownedNames) {
    const named = rulesets.filter((candidate) => candidate.name === name && candidate.source_type === "Repository");
    invariant(named.length <= 1, `multiple repository rulesets are named ${name}`);
    observedRulesets[name] = named.length === 0
      ? null
      : await client.request("GET", `/repos/${repository}/rulesets/${named[0].id}`);
    if (named.length === 1) rulesetIds[name] = named[0].id;
  }
  const otherActiveRulesets = rulesets.filter(
    (candidate) => candidate.source_type === "Repository" && candidate.enforcement === "active" &&
      !ownedNames.has(candidate.name),
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
        undefined,
        { paginate: "branch_policies" },
      );
      branchPoliciesByEnvironment[environment.name] = sortedPolicies(response.branch_policies ?? []);
    }
  }
  return {
    repo,
    actions,
    rulesets: observedRulesets,
    rulesetIds,
    otherActiveRulesets,
    vulnerabilityAlerts: vulnerabilityAlerts !== null,
    dependabotSecurityUpdates,
    privateReporting,
    deployKeys,
    releaseWriterSecrets: releaseWriterSecrets ?? { secrets: [] },
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
  if (!repositoryOwnerMatches(repository, observed.repo)) {
    mismatches.push("repository owner identity differs");
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
  mismatches.push(...releaseWriterPrerequisiteMismatches(policy, observed));
  for (const ruleset of policy.rulesets) {
    const actual = observed.rulesets[ruleset.name];
    if (actual === null) {
      mismatches.push(`ruleset ${ruleset.name} is absent`);
    } else if (!equivalent(selectedRuleset(actual), rulesetBody(ruleset))) {
      mismatches.push(`ruleset ${ruleset.name} differs`);
    }
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

function hasSuccessfulPolicyChecks(required, runs) {
  return required.every((check) => runs.some(
    (run) => run.name === check.context
      && run.app?.id === check.integration_id
      && run.conclusion === "success",
  ));
}

function protectedBranchNames(policy) {
  const names = new Set([policy.repository.defaultBranch]);
  for (const ruleset of policy.rulesets) {
    for (const include of ruleset.conditions?.ref_name?.include ?? []) {
      if (include === "~DEFAULT_BRANCH") {
        names.add(policy.repository.defaultBranch);
        continue;
      }
      const match = /^refs\/heads\/([A-Za-z0-9._\/-]+)$/.exec(include);
      if (match) names.add(match[1]);
    }
  }
  return names;
}

async function successfulChecksForRef(client, repository, ref, required) {
  const response = await client.request(
    "GET",
    `/repos/${repository}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    undefined,
    { paginate: "check_runs" },
  );
  const runs = Array.isArray(response.check_runs) ? response.check_runs : [];
  return hasSuccessfulPolicyChecks(required, runs);
}

export async function requireSuccessfulPolicyChecks(policy, client) {
  const repository = policy.repository.fullName;
  const required = rulesByType(mainRuleset(policy)).get("required_status_checks").parameters.required_status_checks;
  if (await successfulChecksForRef(
    client,
    repository,
    policy.repository.defaultBranch,
    required,
  )) {
    return { source: "default-branch", ref: policy.repository.defaultBranch };
  }

  // Automated release commits deliberately suppress recursive push workflows;
  // older releases used GITHUB_TOKEN, which GitHub also suppresses. The current
  // main commit can therefore legitimately have no CI or DCO checks. In that
  // state, prove the exact check names and GitHub App identities together on
  // one recent merged PR from this repository into either protected branch.
  const pulls = await client.request(
    "GET",
    `/repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
  );
  invariant(Array.isArray(pulls), "GitHub returned an invalid pull-request list");
  const protectedBranches = protectedBranchNames(policy);
  const checked = new Set();
  for (const pull of pulls) {
    const sha = pull.head?.sha;
    if (
      !pull.merged_at
      || pull.base?.repo?.full_name !== repository
      || !protectedBranches.has(pull.base?.ref)
      || pull.head?.repo?.full_name !== repository
      || typeof sha !== "string"
      || !/^[0-9a-f]{40}$/.test(sha)
      || checked.has(sha)
    ) {
      continue;
    }
    checked.add(sha);
    if (await successfulChecksForRef(client, repository, sha, required)) {
      return { source: "merged-pull-request", number: pull.number, ref: sha };
    }
  }
  throw new Error(
    "neither current main nor any recent canonical merged protected-branch PR head has all required successful policy checks on one commit; refusing to activate the rulesets",
  );
}

export async function applyHardening(policy, client) {
  validateHardeningPolicy(policy);
  const before = await observeHardening(policy, client);
  invariant(before.repo?.full_name === policy.repository.fullName, "authenticated GitHub repository identity differs");
  invariant(repositoryOwnerMatches(policy.repository, before.repo), "repository owner identity differs");
  invariant(before.repo.visibility === policy.repository.visibility, "repository visibility differs from the free public policy");
  invariant(before.repo.default_branch === policy.repository.defaultBranch, "repository default branch differs");
  invariant(before.otherActiveRulesets.length === 0, "unowned active branch rulesets exist; refusing to compound them");
  const writerMismatches = releaseWriterPrerequisiteMismatches(
    policy,
    before,
    { allowMissingKey: true },
  );
  invariant(
    writerMismatches.length === 0,
    `automated release writer is not ready: ${writerMismatches.join("; ")}`,
  );
  await requireSuccessfulPolicyChecks(policy, client);
  const mutations = hardeningMutations(policy, {
    rulesetIds: before.rulesetIds,
    branchPoliciesByEnvironment: before.branchPoliciesByEnvironment,
    deployKeys: before.deployKeys,
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
