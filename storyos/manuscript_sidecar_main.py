"""Desktop entry point for the narrowly scoped StoryOS manuscript writer.

This executable may replace an existing manuscript working-copy file after a
SHA precondition succeeds. It intentionally does not import the general StoryOS
CLI, Claim Review, Materialization or Canon Commit command surfaces.
"""

from storyos.manuscript_working_copy_cli import main


if __name__ == "__main__":
    main()
