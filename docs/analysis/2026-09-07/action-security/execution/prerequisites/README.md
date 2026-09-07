# Dependency prerequisite awaiting scope approval

The required ./scripts/validate.sh run on clean 1ea58def2926636e6ab0159cd258652e89591061 passed install, lint, build, configured typecheck, all tests, and secret scan. Dependency audit failed with 35 high, 26 moderate, and 3 low findings on the unchanged baseline dependency files. Source and lockfile were unchanged during that run.

The other task already authored dependency remediation in commit `83c561e69413c71f1195f436621d2a150162af10`. The attached patch contains exactly its dependency-file changes relative to our shared baseline, excluding its lifecycle/fixture/ledger work. No dependency changes have been applied here. Its current dependency files still match that commit; verify again before reuse.

Files: root package.json, packages/cli/package.json, packages/daemon/package.json, packages/mobile-web/package.json, packages/shared/package.json, and pnpm-lock.yaml.

The diff includes root overrides for sharp, adm-zip, uuid and esbuild; patched package ranges for CLI undici, daemon Fastify/Fastify Static, shared nanoid and mobile React Router; and the resolved lockfile. React Router 6 to 7 and Fastify Static 8 to 10 cross major versions. This exceeds the Goal prompt's exception for a focused transport dependency and touches files owned by the concurrent task. Reusing exact committed changes would avoid competing fixes, but approval to include that prerequisite is needed under this task's explicit scope.

After approval: recheck the owner's dependency state, apply this exact patch in this isolated worktree, verify byte-for-byte equality of these files with the source commit, install frozen dependencies, run compatibility checks for affected dependency consumers, and rerun the full pipeline on a committed combined source. Keep the other task's checkout and branch untouched. Integration with the entire concurrent reliability branch is a separate, unverified state.

Patch uses zero context to keep the review artifact free of trailing context whitespace. `git apply --unidiff-zero --check` validates applicability. Prefer restoring the exact six files from the named commit after approval, then compare their blob IDs.
