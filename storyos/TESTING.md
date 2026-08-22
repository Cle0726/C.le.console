# StoryOS v0.4 verification

StoryOS runs a dedicated GitHub Actions matrix on every stacked PR:

```text
ubuntu-latest  / Python 3.11
ubuntu-latest  / Python 3.13
windows-latest / Python 3.11
windows-latest / Python 3.13
```

Verified v0.4 code result:

```text
34 passed
```

The repository's existing Windows CI also remains separate and checks the desktop application's TypeScript and Rust build path.

## Core CLI checks

```bash
storyos validate examples/demo
storyos index examples/demo
storyos state examples/demo --through 150
storyos canon examples/demo chr_00000000000000000000000000000001 identity.role --through 150
storyos knowledge examples/demo chr_00000000000000000000000000000001 --through 199
storyos claims examples/demo
```

## Retrieval / context checks

```bash
storyos retrieve examples/demo "凯登"
storyos retrieve examples/demo antagonist

storyos context examples/demo \
  --through 150 \
  --participant chr_00000000000000000000000000000001 \
  --pov chr_00000000000000000000000000000001 \
  --mode pov \
  --query protagonist

storyos context-inspect examples/demo \
  --through 150 \
  --participant chr_00000000000000000000000000000001 \
  --pov chr_00000000000000000000000000000001 \
  --mode pov \
  --query protagonist \
  --ref canon_00000000000000000000000000000001
```

## Expected demo data

```text
2 entities
2 canonical events
1 locked Canon Fact
1 staged Candidate Claim
0 reference errors
```

## Regression expectations

- sequence 150: Kaden is at the demo workshop, but the staged `identity.role` claim has no projected-state effect;
- the staged claim says `status: approved` and proposes `antagonist`, yet `storyos retrieve ... antagonist` returns no staged-claim hit;
- searching `凯登` returns the stable character ref;
- searching Canon can nominate the locked role fact, but POV context at sequence 150 still excludes it as `not_revealed`;
- sequence 199: Kaden does not yet know the demo Canon Fact;
- sequence 200: Kaden knows it after `knowledge.gained`, and the same retrieved fact can enter POV context;
- Context Inspector reports the retrieval score plus the exact inclusion/exclusion reason for a ref;
- retrieval order is deterministic for identical index/query inputs;
- deleting or invalidating the disposable SQLite index can be repaired by rebuilding it from canonical source files;
- staged Candidate Claims and Story Events are not part of the v0.4 retrieval corpus.
