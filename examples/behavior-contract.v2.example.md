# Behavior Contract: Installable workflow control plane

## REQ-001: Install only the control-plane surface

### Behavior

The initializer installs the configuration, plan directory, planning skill, and reusable-workflow caller needed by a target repository.

### Boundaries

- Existing repository structure and instruction files remain owned by the target repository.
- Installed files stay below `.github` and `.codex/skills/iwf-plan`.

### Exceptions

- A byte-identical existing file is treated as already installed.
- A conflicting file stops initialization unless replacement was explicitly requested.

### Unacceptable behavior

- Copying the complete kit repository into the target repository.
- Replacing an `AGENTS.md` file.

## REQ-002: Reject untraceable execution evidence

### Behavior

Every task, acceptance result, verification result, and final evidence record identifies the requirement it proves.

### Boundaries

- Requirement IDs are stable `REQ-NNN` identifiers.
- Evidence is accepted only for the immutable task envelope.

### Exceptions

- A blocked result may explain missing evidence but cannot be treated as completion.

### Unacceptable behavior

- Treating natural-language completion claims as structured evidence.
- Changing requirements or allowed paths after plan approval.
