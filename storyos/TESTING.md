# StoryOS v0.1 verification

Verified against the current source mirror with Python 3.13:

```bash
cd storyos
PYTHONPATH=. pytest -q
```

Result:

```text
4 passed
```

CLI smoke checks:

```bash
PYTHONPATH=. python -m storyos.cli validate examples/demo
PYTHONPATH=. python -m storyos.cli index examples/demo
PYTHONPATH=. python -m storyos.cli state examples/demo --through 100
```

Expected demo counts are 2 entities and 1 event. The projected state at sequence 100 places the demo character at the demo workshop.
