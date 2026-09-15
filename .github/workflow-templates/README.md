# GitHub Actions templates

These are unchanged copies of the project's CI and release workflows. They are
stored as templates because the GitHub CLI credential used for the initial
private backup does not have the `workflow` scope. No Actions workflows are
enabled by this upload.

To enable them later, use a GitHub credential authorized to write workflows,
copy `ci.yml` and `release.yml` from this directory into `.github/workflows/`,
then commit and push those files. They may also be added through GitHub's web UI
by an authorized repository owner. If working in the original local checkout,
which preserves `.github/workflows/`, use `git add -f .github/workflows/*.yml`
after obtaining the appropriate authorization.
