# Publish and Marketplace checklist

1. Push this repository to `github.com/UsePolyLingo/translate-action` (if not already).
2. On GitHub: **Releases → Create a new release →** tag `v1.0.0`, publish.
3. Create or update the `v1` branch to point at the same commit as `v1.0.0` (common pattern for Actions consumers: `uses: UsePolyLingo/translate-action@v1`).
4. Open **Settings → General →** enable **GitHub Actions** as the source for the Marketplace listing if prompted.
5. Submit the action: repository **Settings →** (under **Code and automation**) **Actions → General →** **Publish in GitHub Marketplace** (category **Utilities**).
6. Optional: seed visibility with `gh repo star UsePolyLingo/translate-action` from an org owner account.

Workflows that push commits need:

```yaml
permissions:
  contents: write
```

and a checkout with sufficient token scope (default `GITHUB_TOKEN` is enough for the same repository).
