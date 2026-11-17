# Pod lifecycle regression runway

Run `bash scripts/test-pod-lifecycle.sh` after the normal frozen install and build.
The gate forces database tests on and requires every selected file to contain
executed passing tests. It covers the runway regressions, state transitions,
composed agent and validation workflows, infrastructure classifiers, and the
ordinary lifecycle e2e using migrated SQLite and mocked infrastructure.

This initial selection is not proof of live containers, external delivery,
platform-specific behavior, or every recovery route. Extend the existing
production fixtures and selection as further lifecycle regressions are added.
