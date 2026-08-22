"""Standalone read-only desktop sidecar entry point for C.le. StoryOS.

This executable intentionally exposes only the Authoring Workspace CLI. Canon review,
materialization and commit commands are not imported or reachable from this binary.
"""

from storyos.workspace_cli import main


if __name__ == "__main__":
    main()
