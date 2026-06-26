# Autopod Validation Suites

Autopod validation suites control what Autopod runs before handing code to a pull request.
They are independent from GitHub PR checks.

Repos still own:

- PR branch protection and required checks.
- Whether PR checks are thin or fat.
- FAT confidence in main, nightly, release, or certification workflows.

Autopod does not generate repo workflows, tag certified commits, or land code directly on main.

## Suites

| Suite | Intent | Skipped phases |
| --- | --- | --- |
| `off` | No Autopod pre-PR validation. | setup, lint, sast, build, test, health, pages, facts, review, advisory |
| `thin` | Fast pre-PR deterministic checks only. | sast, pages, facts, review, advisory |
| `thin-with-facts` | Fast deterministic checks plus contract facts. | sast, pages, review, advisory |
| `deterministic` | All deterministic validation, no AI review or advisory QA. | review, advisory |
| `full` | Current full Autopod validation behavior. | none |
| `custom` | Use profile `skipValidationPhases` directly. | none by preset |

Profile `skipValidationPhases` is still honored and is merged with the selected suite.

## Configure

Set a profile default:

```bash
ap profile validation-suite my-profile thin-with-facts
```

Or edit a profile:

```yaml
pod:
  agentMode: auto
  output: pr
  validationSuite: thin-with-facts
```

Override one pod:

```bash
ap run my-profile "implement the change" --validation-suite thin-with-facts
ap pod create my-profile --spec specs/my-task --validation-suite deterministic
ap start my-profile "implement the change" --validation-suite full
```

`--skip-validation` is equivalent to selecting the `off` suite for that pod.
