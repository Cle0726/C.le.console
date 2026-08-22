# StoryOS v0.2 verification

Verified against a local source mirror with Python 3.13:

```bash
cd storyos
PYTHONPATH=. pytest -q
```

Result:

```text
9 passed
```

The repository also contains a dedicated GitHub Actions matrix:

```text
ubuntu-latest  / Python 3.11
ubuntu-latest  / Python 3.13
windows-latest / Python 3.11
windows-latest / Python 3.13
```

CLI smoke checks:

```bash
PYTHONPATH=. python -m storyos.cli validate examples/demo
PYTHONPATH=. python -m storyos.cli index examples/demo
PYTHONPATH=. python -m storyos.cli state examples/demo --through 150
PYTHONPATH=. python -m storyos.cli canon examples/demo chr_00000000000000000000000000000001 identity.role --through 150
PYTHONPATH=. python -m storyos.cli knowledge examples/demo chr_00000000000000000000000000000001 --through 199
PYTHONPATH=. python -m storyos.cli claims examples/demo
```

Expected demo data:

```text
2 entities
2 canonical events
1 locked Canon Fact
1 staged Candidate Claim
0 reference errors
```

Important regression expectations:

- sequence 150: Kaden is at the demo workshop, but `identity.role` is not projected from the staged claim;
- the staged claim says `status: approved`, yet still conflicts with locked Canon and has no state effect;
- sequence 199: Kaden does not yet know the demo Canon Fact;
- sequence 200: Kaden knows the fact after `knowledge.gained`;
- deleting the SQLite index and rebuilding it reproduces the same indexed counts.
