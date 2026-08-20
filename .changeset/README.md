# Changesets

Add a changeset for every user-visible package change:

```bash
pnpm changeset
```

All public packages in this workspace belong to one fixed group. Releasing any
package therefore releases every package with the same version. The external
`@fraqjs/takumi-builtin-fonts` package is intentionally not part of this group.

Apply pending changesets with `pnpm version-packages`, then publish the prepared
versions with `pnpm release`.
