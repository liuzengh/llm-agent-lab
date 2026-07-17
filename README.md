# LLM Agent Lab

LLM Agent Lab is a personal knowledge base for AI, LLM, agent systems, and post-training practice.

It collects long-form notes, engineering write-ups, and runnable experiments around topics such as:

- LLM post-training, RLHF, RLVR, preference learning, and reward modeling.
- Agent runtime design, tool use, memory, planning, evaluation, and observability.
- Practical engineering patterns for building reliable AI applications.

The site is built with MkDocs Material. Runnable prototypes that accompany articles live under `experiments/`.

## Structure

```text
.
├── docs/
│   ├── mkdocs.yml              # MkDocs configuration
│   └── mkdocs/
│       ├── index.md            # Site home page
│       ├── blog/               # Articles
│       └── assets/             # CSS, JavaScript, and Python requirements
├── experiments/
│   └── dynamic-workflow/        # Runtime prototype for generated workflows
└── .github/workflows/deploy.yml # GitHub Pages deployment workflow
```

## Local Preview

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r docs/mkdocs/assets/requirements.txt
mkdocs serve -f docs/mkdocs.yml
```

Then open:

```text
http://127.0.0.1:8000/llm-agent-lab/
```

## Build

```bash
mkdocs build --strict --site-dir public -f docs/mkdocs.yml
```

The generated site is written to `docs/public/`.

## Publish

The GitHub Actions workflow in `.github/workflows/deploy.yml` builds the site and publishes it to the `gh-pages` branch.

After pushing to GitHub, enable GitHub Pages for this repository and select the `gh-pages` branch as the source.
